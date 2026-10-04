import express from 'express'
import db, { ts, now, DEFAULT_WEIGHTS, DEFAULT_KEYWORD_CAP } from './db.js'
import {
  router as crisisRouter, bindCrisisCore, auditPassive, getCrisisState,
  findActiveIncidentForApp
} from './crisis.js'
import { router as scheduleRouter, getScheduleState } from './schedule.js'
import {
  bindScheduleCore, assertNoOpenCandidateNoshow, migrateScheduleRisk
} from './schedule-risk.js'

const app = express()
app.use(express.json())
const PORT = 4160

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseSkills = s => { try { return JSON.parse(s || '[]') } catch { return [] } }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const parseDims = (s, d) => parseJSON(s, parseJSON(d, []))

// Node:sqlite 同步执行；所有“多步业务动作”放进一个事务，保证策略发布/重算/流程推进不会交叉出半条链路
function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const STAGES = ['submitted', 'screening', 'interview', 'offer', 'hired']
const STAGE_LABEL = { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }
const NEXT_STAGE = { submitted: 'screening', screening: 'interview', interview: 'offer', offer: 'hired' }
const PREV_STAGE = { screening: 'submitted', interview: 'screening', offer: 'interview', hired: 'offer' }
const EVENT_LABEL = {
  advance: '阶段推进', reject: '淘汰', offer_accepted: 'Offer 接受',
  offer_rejected: 'Offer 拒绝', rollback: '异常回退'
}
const OFFER_FLOW = ['pending', 'accepted', 'joined']

// 可预期的业务异常：携带 HTTP 状态码与错误码，事务回滚后按 4xx 返回，前端可直接提示
class ApiError extends Error {
  constructor(status, code, msg) {
    super(msg)
    this.status = status
    this.code = code
  }
}
const badRequest = (msg, code = 'invalid') => { throw new ApiError(400, code, msg) }
const conflict = (msg, code = 'conflict') => { throw new ApiError(409, code, msg) }
const forbidden = (msg, code = 'forbidden') => { throw new ApiError(403, code, msg) }

// 危机处置模块回退执行器：在危机模块自己的事务内调用，豁免乐观锁版本（紧急处置可能面对过期页面），
// 但仍走与 /rollback 完全相同的状态机（撤回联动 Offer、rollback 阶段事件、淘汰复活）
function rollbackForIncident(applicationId, operatorName, reason) {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(num(applicationId))
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  const from = a.stage
  const offerBefore = offerOfApp(a.id)
  rollbackStage(a, { operator: operatorName, reason })
  if (a.stage === 'rejected') db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(a.id)
  const offerAfter = offerOfApp(a.id)
  return {
    from, to: a.stage,
    fromLabel: STAGE_LABEL[from] || from, toLabel: STAGE_LABEL[a.stage] || a.stage,
    version: a.version,
    offerWithdrawn: !!offerBefore && offerBefore.status !== 'withdrawn' && offerAfter?.status === 'withdrawn'
  }
}

// ---------------- 角色与审批链 ----------------
const ROLE_LABEL = {
  recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理', hr_director: '招聘总监'
}
// 三类需审批的关键动作及其允许的发起角色；审批链在提交时按类型（+动态规则）固化
const TASK_TYPES = {
  stage_advance: { label: '候选人推进', submitRole: 'recruiter' },
  interview_conclusion: { label: '面试结论', submitRole: 'interviewer' },
  offer_issue: { label: 'Offer 发放', submitRole: 'recruiter' },
  strategy_publish: { label: '匹配策略发布', submitRole: 'recruiter' }
}
// 仅这三类关键动作支持按角色委托与超时升级（策略发布不在本次范围内）
const DELEGATABLE_TYPES = ['stage_advance', 'interview_conclusion', 'offer_issue']

// 身份解析：前端每次请求带 x-user-id；缺省回退招聘负责人，保证旧调用兼容
function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}

// ---------------- 超时升级规则（SLA） ----------------
function getEscalationRule(type, role) {
  return db.prepare('SELECT * FROM approval_escalation_rules WHERE task_type=? AND role=?')
    .get(type, role) || null
}
// 规则在节点生成瞬间快照进审批链：之后改规则只影响新任务/新升级节点，在途节点口径冻结
function ruleSlaSnapshot(type, role) {
  const r = getEscalationRule(type, role)
  if (!r || !r.enabled) return null
  return {
    timeout_hours: Number(r.timeout_hours),
    escalate_to: r.escalate_to,
    rule_updated_at: r.updated_at || ''
  }
}
// 节点进入待审时刻：固化 deadline（本地时间字符串，与 acted_at/submitted_at 同口径可比）
function stampNodeDue(node, at = ts()) {
  const hours = Number(node?.sla?.timeout_hours)
  if (!hours || !(hours > 0)) { node.due_at = ''; return node }
  const d = new Date(Date.now() + hours * 3600 * 1000)
  node.entered_at = at
  node.due_at = d.toLocaleString('zh-CN')
  return node
}

// 审批链规则：推进/结论为单级；Offer 发放由用人经理审批，薪资超职位带宽时自动加签招聘负责人终审
// 每个节点同时快照该「类型×节点角色」的超时升级 SLA（无规则=不超时升级）
function buildChain(type, payload, app = null) {
  let roles = []
  if (type === 'stage_advance') roles = [{ role: 'hiring_manager' }]
  else if (type === 'interview_conclusion') roles = [{ role: 'recruiter' }]
  else if (type === 'strategy_publish') roles = [{ role: 'hiring_manager', reason: '匹配策略影响评分、投递与阶段快照口径' }]
  else if (type === 'offer_issue') {
    roles = [{ role: 'hiring_manager' }]
    const pos = app && db.prepare('SELECT salary_max FROM positions WHERE id=?').get(app.position_id)
    if (pos && num(payload.salary) > num(pos.salary_max)) {
      roles.push({ role: 'recruiter', reason: `月薪超职位带宽上限 ¥${num(pos.salary_max).toLocaleString()}，加签终审` })
    }
  }
  return roles.map(node => {
    const sla = DELEGATABLE_TYPES.includes(type) ? ruleSlaSnapshot(type, node.role) : null
    return sla ? { ...node, sla } : node
  })
}

// ---------------- 按角色审批委托 ----------------
function parseDelegationRow(d) {
  return {
    ...d,
    task_types: parseJSON(d.task_types, []),
    application_ids: parseJSON(d.application_ids, []).map(x => num(x)),
    enabled: !!d.enabled
  }
}
// 该委托当前是否有效：状态 active + 未到期
function delegationActiveAt(d, atMs = Date.now()) {
  if (!d || d.status !== 'active') return null
  if (d.expires_at) {
    const exp = new Date(d.expires_at).getTime()
    if (Number.isFinite(exp) && exp <= atMs) return null
  }
  return d
}
// 解析某人对某任务当前节点是否持有审批权：
// 1) 本人角色即节点角色（直接审批权）；2) 存在有效委托把该角色委托给本人（按类型/应聘范围匹配）。
// 委托在决策瞬间实时解析——撤销/到期立即失效，即便页面过期也会被服务端拒绝。
function resolveStepAuthority(task, step, user, atMs = Date.now()) {
  if (!step) return null
  if (user.role === step.role) return { via: 'direct', role: step.role, delegation: null }
  const rows = db.prepare("SELECT * FROM approval_delegations WHERE delegatee_id=? AND role=? AND status='active' ORDER BY id DESC")
    .all(user.id, step.role)
  for (const raw of rows) {
    const d = parseDelegationRow(raw)
    if (!delegationActiveAt(d, atMs)) continue
    if (d.task_types.length && !d.task_types.includes(task.type)) continue
    if (d.scope === 'applications' && num(task.application_id) && !d.application_ids.includes(num(task.application_id))) continue
    return { via: 'delegate', role: step.role, delegation: d }
  }
  return null
}
// 该节点角色当前的全部有效代理人（用于同事务投递个人待办/撤销通知）
function activeDelegatesFor(role, { taskType = '', applicationId = 0 } = {}) {
  // 策略发布等类型不参与按角色委托
  if (taskType && !DELEGATABLE_TYPES.includes(taskType)) return []
  return db.prepare("SELECT * FROM approval_delegations WHERE role=? AND status='active' ORDER BY id")
    .all(role)
    .map(parseDelegationRow)
    .filter(d => {
      if (!delegationActiveAt(d)) return false
      if (taskType && d.task_types.length && !d.task_types.includes(taskType)) return false
      if (applicationId && d.scope === 'applications' && num(applicationId) && !d.application_ids.includes(num(applicationId))) return false
      return true
    })
}

function addStep(taskId, { stepNo = -1, role = '', action, actor, note = '', via = '', delegationId = 0 }) {
  db.prepare(`INSERT INTO approval_steps(task_id,step_no,role,action,actor_id,actor_name,note,acted_at,via,delegation_id)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(taskId, stepNo, role, action, actor?.id || '', actor?.name || actor || '', note, ts(),
      via || '', num(delegationId) || 0)
}

// 审计通知：默认按接收角色投递；recipientId 非空时为个人通知（代理人/升级对象），仅其本人可见
function notify({ recipientRole, type, title, body, taskId = 0, appId = 0, recipientId = '', delegationId = 0 }) {
  db.prepare(`INSERT INTO notifications(recipient_role,recipient_id,delegation_id,type,title,body,task_id,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,?,?,?,0,?)`)
    .run(recipientRole, recipientId, num(delegationId), type, title, body, taskId, appId, ts())
}

// 节点待办通知：角色桶 + 每个有效代理人的个人待办（代理人若本身就是该角色，不重复投递）
function notifyStepAudience(task, step, { type, title, body, extraDelegations = [] }) {
  notify({ recipientRole: step.role, type, title, body, taskId: task.id, appId: task.application_id })
  const ds = (extraDelegations.length ? extraDelegations : activeDelegatesFor(step.role, { taskType: task.type, applicationId: task.application_id }))
  ds.forEach(d => {
    const delegatee = db.prepare('SELECT role FROM users WHERE id=?').get(d.delegatee_id)
    if (delegatee?.role === step.role) return
    notify({
      recipientRole: step.role, recipientId: d.delegatee_id, delegationId: d.id, type,
      title: `【代理审批】${title}`, body: `${d.delegator_name} 已将该${ROLE_LABEL[step.role]}节点委托给您：${body}`,
      taskId: task.id, appId: task.application_id
    })
  })
}

// 待办归并：节点流转/撤销/退回/升级时，把该任务上一节点受众（角色桶+代理人个人）的未读待办通知标记已读，
// 保证铃铛/红点在并发、撤销、代理撤销后只反映当前真正待办。submitter 结果通知（task_returned 等）不受影响。
const ACTIONABLE_NOTIFY_TYPES = ['task_submitted', 'task_resubmitted', 'task_escalated']
function markActionableRead(taskId, audienceStep = null) {
  const id = num(taskId)
  if (!id) return 0
  const types = ACTIONABLE_NOTIFY_TYPES.map(() => '?').join(',')
  let rows
  if (audienceStep) {
    rows = db.prepare(`SELECT id FROM notifications
                       WHERE task_id=? AND is_read=0 AND type IN (${types})
                         AND (recipient_id='' OR recipient_id IS NULL OR recipient_id=? OR recipient_role=?)`)
      .all(id, ...ACTIONABLE_NOTIFY_TYPES, audienceStep.role, audienceStep.role)
  } else {
    rows = db.prepare(`SELECT id FROM notifications WHERE task_id=? AND is_read=0 AND type IN (${types})`)
      .all(id, ...ACTIONABLE_NOTIFY_TYPES)
  }
  if (rows.length) {
    const marks = rows.map(() => '?').join(',')
    db.prepare(`UPDATE notifications SET is_read=1 WHERE id IN (${marks})`).run(...rows.map(r => r.id))
  }
  return rows.length
}
// 按委托撤销归并：该代理人在指定（或全部）在途任务上的个人未读待办一次性已读
function markDelegateTodosRead(delegationId, taskId = 0) {
  const sql = `SELECT id FROM notifications WHERE recipient_id!='' AND delegation_id=? AND is_read=0 AND type IN (${ACTIONABLE_NOTIFY_TYPES.map(() => '?').join(',')})${taskId ? ' AND task_id=?' : ''}`
  const args = [num(delegationId), ...ACTIONABLE_NOTIFY_TYPES]
  if (taskId) args.push(num(taskId))
  const rows = db.prepare(sql).all(...args)
  if (rows.length) {
    const marks = rows.map(() => '?').join(',')
    db.prepare(`UPDATE notifications SET is_read=1 WHERE id IN (${marks})`).run(...rows.map(r => r.id))
  }
  return rows.length
}

// 乐观锁：阶段协同类操作必须携带读取时的 version；并发/重复点击导致版本错位时拒绝
function checkVersion(app, expected) {
  if (expected !== undefined && expected !== null && expected !== '' && num(expected) !== num(app.version)) {
    conflict('流程状态已被其他操作更新，请刷新后重试', 'version_conflict')
  }
}

function latestInterviewOf(applicationId) {
  return db.prepare('SELECT * FROM interviews WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null
}

// 面试结论约束：进入 Offer 前，最近一轮必须已有「通过」结论（待定/不通过均拦截）
function assertCanEnterOffer(app) {
  const iv = latestInterviewOf(app.id)
  if (!iv) badRequest('请先安排并完成至少一轮面试', 'interview_required')
  const c = iv.conclusion || iv.result || 'pending'
  if (c === 'pending') badRequest(`最近一轮「${iv.round}」尚未给出面试结论，不能进入 Offer`, 'interview_pending')
  if (c === 'fail') badRequest(`最近一轮「${iv.round}」结论为不通过，不能进入 Offer；如需推进请先改判结论`, 'interview_failed')
  // 预约缺席责任闸门：候选人方（候选人/双方）缺席场次未重约闭环前不进入 Offer；面试官责任不拦截候选人
  assertNoOpenCandidateNoshow(app.id)
}

function offerOfApp(applicationId) {
  return db.prepare('SELECT * FROM offers WHERE application_id=? ORDER BY id DESC LIMIT 1').get(applicationId) || null
}

function addOfferLog({ offerId, applicationId, changeType, of, toStatus, toSalary, operator = 'HR-Sandy', note = '' }) {
  db.prepare(`INSERT INTO offer_change_logs(offer_id,application_id,change_type,from_status,to_status,from_salary,to_salary,changed_at,operator,note)
              VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(offerId, applicationId, changeType,
      of?.status || '', toStatus ?? of?.status ?? '',
      num(of?.salary, 0), num(toSalary ?? of?.salary, 0),
      ts(), operator, note)
}

// ---------------- 人岗匹配评分算法 ----------------
// 系统默认五维权重合计闭合为 1.0；每个职位可发布自己的策略（match_strategies）
const WEIGHT_KEYS = ['skill', 'year', 'salary', 'edu', 'city']

// 把前端传入的权重归一化为合计 1.0；允许将某维权重设为 0（如不看学历）
function normalizeWeights(input) {
  const raw = {}
  WEIGHT_KEYS.forEach(k => { raw[k] = Math.max(0, num(input?.[k], DEFAULT_WEIGHTS[k])) })
  const total = WEIGHT_KEYS.reduce((s, k) => s + raw[k], 0)
  if (total <= 0) return { ...DEFAULT_WEIGHTS }
  // 先保留两位小数，再把舍入残差补到权重最大的维度，保证合计严格为 1
  const w = {}
  WEIGHT_KEYS.forEach(k => { w[k] = Math.round(raw[k] / total * 100) / 100 })
  let rest = Math.round((1 - WEIGHT_KEYS.reduce((s, k) => s + w[k], 0)) * 100) / 100
  if (rest !== 0) {
    const maxK = WEIGHT_KEYS.reduce((a, b) => w[b] > w[a] ? b : a, WEIGHT_KEYS[0])
    w[maxK] = Math.round((w[maxK] + rest) * 100) / 100
  }
  return w
}

// 读取职位当前全量基线策略；待审/灰度版本不会在这里替换基线，保证未命中灰度的流量口径稳定
function getStrategy(posId, at = new Date().toISOString()) {
  const row = db.prepare('SELECT * FROM match_strategies WHERE position_id=?').get(num(posId))
  if (!row) return defaultStrategy(posId, 0, { publishedAt: '', publishedBy: '', isDefault: true })
  const activeId = num(row.active_version_id)
  const active = activeId ? db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(activeId) : null
  // 全量版本到达失效窗口后，逻辑上回到其发布前基线；定时 sweep 负责落库和批量回滚
  if (active && active.effective_end && at > active.effective_end && num(active.baseline_version_id) !== activeId) {
    const baselineId = num(active.baseline_version_id)
    const base = baselineId ? db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(baselineId) : null
    if (base) return versionToStrategy(base, posId, { isDefault: false, status: 'expired' })
    return defaultStrategy(posId, 0, { publishedAt: row.published_at, publishedBy: row.published_by })
  }
  if (active) return versionToStrategy(active, posId, { isDefault: false })
  return defaultStrategy(posId, 0, {
    publishedAt: row.published_at, publishedBy: row.published_by, isDefault: !activeId
  })
}

function defaultStrategy(posId, versionId = 0, extra = {}) {
  return {
    positionId: num(posId),
    weights: { ...DEFAULT_WEIGHTS },
    keywordCap: DEFAULT_KEYWORD_CAP,
    versionId,
    publishedAt: '',
    publishedBy: '',
    isDefault: versionId === 0,
    status: 'default',
    rolloutMode: 'full',
    isCanary: false,
    strategyMode: 'default',
    ...extra
  }
}

function parseStrategyVersionRow(v, posId = v?.position_id) {
  if (!v) return null
  return {
    ...v,
    position_id: num(posId),
    keyword_cap: Math.max(0, num(v.keyword_cap, DEFAULT_KEYWORD_CAP)),
    canary_percent: Math.max(0, Math.min(100, num(v.canary_percent))),
    baseline_version_id: num(v.baseline_version_id),
    approval_task_id: num(v.approval_task_id),
    promoted_version_id: num(v.promoted_version_id),
    weights: normalizeWeights(parseJSON(v.weights, { ...DEFAULT_WEIGHTS })),
    canary_candidate_ids: parseJSON(v.canary_candidate_ids, []).map(x => num(x)).filter(Boolean)
  }
}

function getStrategyVersion(versionId) {
  const id = num(versionId)
  if (!id) return null
  return parseStrategyVersionRow(db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(id))
}

function versionToStrategy(v, posId = v.position_id, extra = {}) {
  const row = parseStrategyVersionRow(v, posId)
  return {
    positionId: num(posId),
    weights: row.weights,
    keywordCap: row.keyword_cap,
    versionId: row.id,
    publishedAt: row.approved_at || row.published_at,
    publishedBy: row.published_by,
    isDefault: false,
    status: row.status,
    rolloutMode: row.rollout_mode,
    effectiveStart: row.effective_start,
    effectiveEnd: row.effective_end,
    canaryPercent: row.canary_percent,
    canaryCandidateIds: row.canary_candidate_ids,
    isCanary: false,
    strategyMode: row.rollout_mode === 'canary' ? 'canary' : 'full',
    ...extra
  }
}

function getCanaryVersion(posId, at = new Date().toISOString()) {
  const row = db.prepare("SELECT * FROM strategy_versions WHERE position_id=? AND status='canary' ORDER BY id DESC LIMIT 1")
    .get(num(posId))
  if (!row) return null
  const v = parseStrategyVersionRow(row, posId)
  if (v.effective_end && at > v.effective_end) return null
  return v
}

// 稳定灰度选样：显式候选人优先；否则用候选人 ID 哈希落桶，避免每次请求随机漂移
function isCanaryCandidate(v, candidateId) {
  const cid = num(candidateId)
  if (!cid) return false
  if (v.canary_candidate_ids.length) return v.canary_candidate_ids.includes(cid)
  if (!v.canary_percent) return false
  const bucket = (cid * 9301 + 49297) % 100
  return bucket < v.canary_percent
}

// 单个职位×候选人的当前生效策略：灰度窗口内命中灰度则使用灰度版本，否则走全量基线/默认策略
function resolveStrategy(posId, candidateId, at = new Date().toISOString()) {
  const canary = getCanaryVersion(posId, at)
  if (canary && isCanaryCandidate(canary, candidateId)) {
    return versionToStrategy(canary, posId, { isCanary: true, strategyMode: 'canary' })
  }
  return getStrategy(posId, at)
}

function windowInput(v) {
  if (v === undefined || v === null || v === '') return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}
function fmtWindow(v) {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN')
}

function strategyVersionSummary(v) {
  const row = parseStrategyVersionRow(v)
  return {
    ...row,
    weights: row.weights,
    effective_start_text: fmtWindow(row.effective_start),
    effective_end_text: fmtWindow(row.effective_end),
    canary_candidate_ids: row.canary_candidate_ids
  }
}

function computeMatch(cand, pos, strategy) {
  const W = strategy?.weights || DEFAULT_WEIGHTS
  const keywordCap = strategy?.keywordCap ?? DEFAULT_KEYWORD_CAP
  const cSkills = parseSkills(cand.skills)
  const pSkills = parseSkills(pos.skills)
  const dims = []

  // 技能匹配：候选者命中职位要求技能的熟练度按职位权重加权
  let skillScore = 0, matched = 0, skillWeightSum = 0
  pSkills.forEach(req => {
    const hit = cSkills.find(c => c.k === req.k)
    if (hit) { skillScore += Math.min(100, (num(hit.idx, 3) / 5) * 100) * req.w; matched++ }
    skillWeightSum += req.w
  })
  const skillCover = pSkills.length ? matched / pSkills.length : 1
  skillScore = pSkills.length ? (skillWeightSum ? skillScore / skillWeightSum : 0) : 70
  dims.push({ k: '技能', score: Math.round(skillScore), w: W.skill })

  // 年限匹配
  const ideal = num(pos.years, 0)
  const yearScore = num(cand.years, 0) >= ideal ? 90 : Math.max(30, 100 - (ideal - num(cand.years, 0)) * 15)
  dims.push({ k: '经验年限', score: Math.round(yearScore), w: W.year })

  // 薪资带宽匹配（先判低于带宽，再判高于带宽，避免分支被吞）
  const sal = num(cand.exp_salary, 0)
  let salScore, salNote, salOver = false, salOverMuch = false
  if (sal <= 0) { salScore = 70; salNote = '期望薪资未填写' }
  else if (sal < pos.salary_min) { salScore = 75; salNote = '期望薪资低于带宽' }
  else if (sal <= pos.salary_max) { salScore = 90; salNote = '期望薪资在带宽内' }
  else if (sal <= pos.salary_max * 1.15) { salScore = 70; salNote = '期望薪资略高于带宽'; salOver = true }
  else { salScore = 45; salNote = '期望薪资超出带宽'; salOver = true; salOverMuch = true }
  dims.push({ k: '薪资匹配', score: salScore, w: W.salary })

  // 学历匹配
  const eduRank = { '博士': 100, '硕士': 85, '本科': 70, '大专': 55 }
  const eduScore = eduRank[cand.edu] ?? 65
  dims.push({ k: '学历', score: eduScore, w: W.edu })

  // 城市匹配
  const cityHit = pos.city === '全国' || (!!cand.city && cand.city === pos.city)
  const cityScore = cityHit ? 90 : 65
  dims.push({ k: '城市地点', score: cityScore, w: W.city })

  // 简历关键词加分（在职位名/要求技能中命中，封顶，不计入维度权重；cap=0 关闭）
  const keywords = new Set([...pSkills.map(s => s.k), ...String(pos.name || '').split(/[\s/、,，]+/).filter(Boolean)])
  const tokens = String(cand.raw || '').split(/[,，。；;、/\s]+/).filter(Boolean)
  const hitKws = new Set([...keywords].filter(kw => tokens.some(t => t.includes(kw))))
  const keywordBonus = Math.min(keywordCap, hitKws.size * 1.5)

  // 五维加权（权重按职位策略，合计 1.0）+ 封顶关键词附加分
  const base = skillScore * W.skill
    + yearScore * W.year
    + salScore * W.salary
    + eduScore * W.edu
    + cityScore * W.city
  const score = Math.min(100, Math.round(base + keywordBonus))

  // 短板：覆盖技能/年限/薪资/学历/城市五个维度
  const weakness = []
  if (skillCover < 0.5) weakness.push('关键技能覆盖不足')
  if (yearScore < 65) weakness.push('经验年限偏低')
  if (salOverMuch) weakness.push('期望薪资超出带宽')
  else if (salOver) weakness.push('期望薪资略高于带宽')
  if (eduScore < 60) weakness.push('学历相对偏低')
  if (!cityHit) weakness.push('工作城市不匹配')

  const rating = score >= 80 ? '高匹配' : score >= 65 ? '匹配度良好' : score >= 55 ? '基本匹配' : '匹配度偏低'
  const cityNote = cityHit
    ? (pos.city === '全国' ? '城市全国可选' : `城市${cand.city}与职位一致`)
    : `城市${cand.city || '未知'}≠${pos.city}`
  const reason = [
    `技能覆盖${Math.round(skillCover * 100)}%`,
    `经验${cand.years}/${ideal}年`,
    salNote,
    `${cand.edu || '学历未知'}`,
    cityNote
  ].join('，') + `；综合${rating}${keywordBonus ? `（简历关键词+${keywordBonus.toFixed(1)}分）` : ''}`

  return { score, dims, reason, weakness: weakness.join('、') || '无显著短板' }
}

// 计算评分但不落库：推荐列表浏览不隐式制造“最新结果”，避免与流程推进时看到的证据不一致
function computePair(candId, posId, strategy = resolveStrategy(posId, candId)) {
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(candId)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(posId)
  if (!cand || !pos) return null
  const m = computeMatch(cand, pos, strategy)
  return {
    ...m,
    candidate_id: candId,
    position_id: posId,
    weights: strategy.weights,
    keyword_cap: strategy.keywordCap,
    strategy_id: strategy.versionId,
    strategy_is_default: strategy.isDefault,
    strategy_status: strategy.status || '',
    strategy_mode: strategy.strategyMode || (strategy.isDefault ? 'default' : 'full'),
    is_canary: !!strategy.isCanary,
    effective_start: strategy.effectiveStart || '',
    effective_end: strategy.effectiveEnd || '',
    computed_at: now()
  }
}

function createRecalcJob({
  triggerType, scope, positionId = 0, strategyId = 0, triggeredBy = 'HR',
  rolloutMode = 'full', canaryVersionId = 0
}) {
  const stamp = ts()
  const r = db.prepare(`INSERT INTO recalc_jobs(trigger_type,scope,position_id,strategy_id,rollout_mode,canary_version_id,status,pair_count,canary_count,baseline_count,started_at,finished_at,triggered_by)
                        VALUES(?,?,?,?,?,?, 'running', 0,0,0,?,?,?)`)
    .run(triggerType, scope, num(positionId), num(strategyId), rolloutMode, num(canaryVersionId), stamp, stamp, triggeredBy)
  return Number(r.lastInsertRowid)
}

function completeRecalcJob(jobId, pairCount, canaryCount = 0, baselineCount = 0) {
  db.prepare('UPDATE recalc_jobs SET status=?, pair_count=?, canary_count=?, baseline_count=?, finished_at=? WHERE id=?')
    .run('completed', pairCount, canaryCount, baselineCount, ts(), jobId)
}

// 按职位当前生效策略重算并落库为「最新结果」（不影响 applications/events 中的历史快照）
// strategy 可显式传入全量/灰度/回滚版本；默认按候选人是否命中灰度自动解析。
function upsertMatch(candId, posId, jobId = 0, strategy = null) {
  const m = computePair(candId, posId, strategy || undefined)
  if (!m) return null
  const stamp = m.computed_at
  const jid = num(jobId)
  const isCanary = m.is_canary ? 1 : 0
  const mode = m.strategy_mode || (m.strategy_id ? 'full' : 'default')
  const existing = db.prepare('SELECT id FROM matches WHERE candidate_id=? AND position_id=?').get(candId, posId)
  if (existing) {
    db.prepare(`UPDATE matches SET score=?,dims=?,reason=?,weakness=?,computed_at=?,strategy_id=?,weights=?,keyword_cap=?,is_canary=?,strategy_mode=? WHERE id=?`)
      .run(m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp, m.strategy_id,
        JSON.stringify(m.weights), m.keyword_cap, isCanary, mode, existing.id)
  } else {
    db.prepare(`INSERT INTO matches(candidate_id,position_id,score,dims,reason,weakness,computed_at,strategy_id,weights,keyword_cap,is_canary,strategy_mode)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(candId, posId, m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp, m.strategy_id,
        JSON.stringify(m.weights), m.keyword_cap, isCanary, mode)
  }
  if (jid) {
    db.prepare(`INSERT INTO recalc_items(job_id,candidate_id,position_id,strategy_id,weights,keyword_cap,is_canary,strategy_mode,score,dims,reason,weakness,computed_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(jid, candId, posId, m.strategy_id, JSON.stringify(m.weights), m.keyword_cap, isCanary, mode,
        m.score, JSON.stringify(m.dims), m.reason, m.weakness, stamp)
  }
  return { ...m, recalc_job_id: jid }
}

// 投递/进入阶段时的评分依据快照：锁定分数、维度、理由、短板及所用策略版本，后续重算不再改变
function buildSnapshot(candId, posId, m, extra = {}, strategy = m) {
  const resolved = strategy && Object.prototype.hasOwnProperty.call(strategy, 'weights')
    ? strategy
    : resolveStrategy(posId, candId)
  // 兼容存储态结果（resultFromStored 用 strategy_id 而非 versionId）：快照策略版本号两种字段名都取得到
  const strategyVersionId = Object.prototype.hasOwnProperty.call(resolved, 'versionId')
    ? resolved.versionId
    : (num(resolved.strategy_id) || 0)
  return {
    score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness,
    weights: resolved.weights, keyword_cap: resolved.keywordCap,
    strategy_id: strategyVersionId, strategy_is_default: resolved.isDefault ?? (strategyVersionId === 0),
    strategy_status: resolved.status || '',
    strategy_mode: resolved.strategyMode || (resolved.isDefault ? 'default' : 'full'),
    is_canary: !!resolved.isCanary,
    effective_start: resolved.effectiveStart || '',
    effective_end: resolved.effectiveEnd || '',
    published_at: resolved.publishedAt, published_by: resolved.publishedBy,
    candidate_id: candId, position_id: posId,
    matched_at: now(),
    ...extra
  }
}

// ---------------- 状态汇总 ----------------
app.get('/api/state', (req, res) => {
  const positions = db.prepare('SELECT * FROM positions ORDER BY id').all().map(p => {
    const st = db.prepare(`SELECT ms.*,
        (SELECT COUNT(*) FROM strategy_versions sv WHERE sv.position_id=ms.position_id AND sv.status='pending') pending_count,
        (SELECT COUNT(*) FROM strategy_versions sv WHERE sv.position_id=ms.position_id AND sv.status='canary') canary_count
      FROM match_strategies ms WHERE ms.position_id=?`).get(p.id)
    const activeVersionId = st ? num(st.active_version_id) : 0
    return {
      ...p,
      skills: parseSkills(p.skills),
      strategy: st ? {
        published_at: st.published_at,
        published_by: st.published_by,
        active_version_id: activeVersionId,
        effective_start: st.effective_start,
        effective_end: st.effective_end,
        pending_count: num(st.pending_count),
        canary_count: num(st.canary_count)
      } : { active_version_id: 0, pending_count: 0, canary_count: 0 }
    }
  })
  const candidates = db.prepare('SELECT * FROM candidates ORDER BY id').all().map(c => ({ ...c, skills: parseSkills(c.skills) }))
  const apps = db.prepare('SELECT * FROM applications ORDER BY id DESC').all()
  const interviews = db.prepare('SELECT * FROM interviews ORDER BY id DESC').all()
  const offers = db.prepare('SELECT * FROM offers ORDER BY id DESC').all()
  const offerLogs = db.prepare('SELECT * FROM offer_change_logs ORDER BY id ASC').all().map(l => ({
    ...l,
    from_salary: num(l.from_salary),
    to_salary: num(l.to_salary),
    change_label: {
      create: '发起 Offer', update_salary: '调整薪资', update_due: '调整期限',
      accept: '候选人接受', reject: '候选人拒绝', join: '确认入职',
      withdraw: '撤回 Offer', reopen: '重新发起'
    }[l.change_type] || l.change_type
  }))
  const channels = db.prepare('SELECT * FROM channels ORDER BY id').all()
  const strategyVersions = db.prepare('SELECT * FROM strategy_versions ORDER BY id DESC').all().map(strategyVersionSummary)
  const recalcJobs = db.prepare('SELECT * FROM recalc_jobs ORDER BY id DESC').all().map(j => ({
    ...j,
    position_id: num(j.position_id),
    strategy_id: num(j.strategy_id),
    canary_version_id: num(j.canary_version_id),
    pair_count: num(j.pair_count),
    canary_count: num(j.canary_count),
    baseline_count: num(j.baseline_count)
  }))
  const recalcItems = db.prepare(`SELECT id,job_id,candidate_id,position_id,strategy_id,weights,keyword_cap,is_canary,strategy_mode,score,computed_at
      FROM recalc_items ORDER BY id DESC LIMIT 500`)
    .all().map(i => ({
      ...i,
      strategy_id: num(i.strategy_id),
      keyword_cap: num(i.keyword_cap),
      score: num(i.score),
      is_canary: !!i.is_canary,
      weights: parseJSON(i.weights, {})
    }))
  const appEvents = db.prepare('SELECT * FROM application_events ORDER BY id ASC').all().map(e => ({
    ...e,
    from_stage: e.from_stage || '',
    match_score: num(e.match_score),
    strategy_id: num(e.strategy_id),
    recalc_job_id: num(e.recalc_job_id),
    backfilled: !!e.backfilled,
    stage_label: { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }[e.stage] || e.stage,
    scoreSnapshot: parseJSON(e.score_snapshot, null)
  }))
  const jobOf = new Map(recalcJobs.map(j => [j.id, j]))
  const matches = db.prepare('SELECT * FROM matches ORDER BY id DESC').all().map(m => ({
    ...m,
    score: num(m.score),
    dims: parseDims(m.dims, '[]'),
    strategy_id: num(m.strategy_id),
    keyword_cap: num(m.keyword_cap, DEFAULT_KEYWORD_CAP),
    is_canary: !!m.is_canary,
    strategy_mode: m.strategy_mode || (num(m.strategy_id) ? 'full' : 'default'),
    weights: parseJSON(m.weights, {}) || {}
  }))
  // 审批中心数据：任务 + 提交时固化的审批链 + 全程步骤留痕；通知按角色投递
  const users = db.prepare('SELECT * FROM users ORDER BY rowid').all()
  const approvalSteps = db.prepare('SELECT * FROM approval_steps ORDER BY id ASC').all()
  const approvals = db.prepare('SELECT * FROM approval_tasks ORDER BY id DESC').all().map(t => {
    const a = apps.find(x => x.id === t.application_id)
    const payload0 = parseJSON(t.payload, {})
    const posId = a ? a.position_id : num(payload0.position_id)
    const pos = positions.find(p => p.id === posId)
    const cand = a ? candidates.find(c => c.id === a.candidate_id) : null
    const chain = parseJSON(t.chain, [])
    const steps = approvalSteps.filter(s => s.task_id === t.id)
    const cur = chain[t.current_step] || null
    return {
      ...t,
      payload: payload0,
      chain,
      steps,
      escalated: chain.some(n => !!n.escalated_at),
      current_role: cur?.role || '',
      due_at: cur?.due_at || '',
      entered_at: cur?.entered_at || '',
      candidate: cand ? cand.name : '',
      position: pos ? pos.name : '',
      dept: pos ? pos.dept : '',
      app_stage: a ? a.stage : '',
      type_label: TASK_TYPES[t.type]?.label || t.type
    }
  })
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 300').all()
    .map(n => ({ ...n, is_read: !!n.is_read }))
  // 审批委托与超时升级规则：审批中心按当前身份渲染代理待办、委托管理与 SLA 配置
  const delegations = db.prepare('SELECT * FROM approval_delegations ORDER BY id DESC').all().map(d => ({
    ...d,
    task_types: parseJSON(d.task_types, []),
    application_ids: parseJSON(d.application_ids, []).map(x => num(x))
  }))
  const escalationRules = db.prepare('SELECT * FROM approval_escalation_rules ORDER BY task_type, role').all()
    .map(r => ({ ...r, enabled: !!r.enabled, timeout_hours: Number(r.timeout_hours) }))
  const latestItemOf = (cid, pid) => db.prepare(`SELECT ri.* FROM recalc_items ri
    WHERE ri.candidate_id=? AND ri.position_id=? ORDER BY ri.id DESC LIMIT 1`).get(cid, pid) || null
  const matchOf = (cid, pid) => matches.find(m => m.candidate_id === cid && m.position_id === pid) || null
  const pipelines = apps.map(a => {
    const pos = positions.find(p => p.id === a.position_id)
    const cand = candidates.find(c => c.id === a.candidate_id)
    const its = interviews.filter(i => i.application_id === a.id)
    const of = offers.find(o => o.application_id === a.id) || null
    const mt = matchOf(a.candidate_id, a.position_id)
    const latestItem = latestItemOf(a.candidate_id, a.position_id)
    const latestJob = latestItem ? (jobOf.get(latestItem.job_id) || null) : null
    // 投递时锁定的历史评分依据；兼容旧数据：无快照时置空由前端回退最新分
    const snap = parseJSON(a.match_snapshot, null)
    const stageSnap = parseJSON(a.stage_snapshot, null)
    const latest = mt ? {
      score: mt.score, dims: mt.dims, reason: mt.reason, weakness: mt.weakness,
      computed_at: mt.computed_at, strategy_id: mt.strategy_id,
      strategy_mode: mt.strategy_mode, is_canary: mt.is_canary,
      recalc_job_id: latestItem?.job_id || 0,
      recalc_trigger: latestJob?.trigger_type || '',
      recalc_scope: latestJob?.scope || ''
    } : null
    return {
      ...a,
      version: num(a.version),
      position: pos ? pos.name : '', dept: pos ? pos.dept : '', city: pos ? pos.city : '',
      candidate: cand ? cand.name : '', candSkills: cand ? cand.skills : [],
      matchSnapshot: snap, matched_at: a.matched_at || '',
      stageSnapshot: stageSnap, entered_at: a.entered_at || '',
      match: latest,
      events: appEvents.filter(e => e.application_id === a.id),
      interviews: its, offer: of,
      offerLogs: offerLogs.filter(l => l.application_id === a.id)
    }
  })
  res.json({
    positions, candidates, applications: pipelines, interviews, offers, offerLogs, channels, matches,
    strategyVersions, recalcJobs, recalcItems, users, approvals, notifications,
    delegations, escalationRules,
    defaultStrategy: { weights: { ...DEFAULT_WEIGHTS }, keywordCap: DEFAULT_KEYWORD_CAP },
    ...getCrisisState(),
    ...getScheduleState()
  })
})

app.get('/api/summary', (req, res) => {
  const pos = db.prepare('SELECT status, COUNT(*) c FROM positions GROUP BY status').all()
  const apps = db.prepare('SELECT stage, COUNT(*) c FROM applications GROUP BY stage').all()
  const cand = db.prepare('SELECT COUNT(*) c FROM candidates').get().c
  return res.json({ positions: pos, applications: apps, candidates: cand })
})

// ---------------- 职位 ----------------
app.post('/api/positions', (req, res) => {
  const b = req.body || {}
  const r = db.prepare('INSERT INTO positions(name,dept,city,level,salary_min,salary_max,skills,years,slots,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(b.name, b.dept || '技术部', b.city || '上海', b.level || 'P5', num(b.salary_min, 15000), num(b.salary_max, 30000), JSON.stringify(b.skills || []), num(b.years, 2), num(b.slots, 1), 'open', ts())
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.post('/api/positions/:id', (req, res) => {
  const id = num(req.params.id)
  const b = req.body || {}
  if (b.status) db.prepare('UPDATE positions SET status=? WHERE id=?').run(b.status, id)
  if (b.skills !== undefined) db.prepare('UPDATE positions SET skills=? WHERE id=?').run(JSON.stringify(b.skills), id)
  res.json({ ok: true })
})

// ---------------- 按职位配置/发布匹配策略 ----------------
// 读取某职位生效中的全量基线与版本治理记录（待审/灰度不计入基线）
app.get('/api/positions/:id/strategy', (req, res) => {
  const id = num(req.params.id)
  const pos = db.prepare('SELECT id,name FROM positions WHERE id=?').get(id)
  if (!pos) return res.status(404).json({ ok: false })
  const versions = db.prepare('SELECT * FROM strategy_versions WHERE position_id=? ORDER BY id DESC LIMIT 20')
    .all().map(strategyVersionSummary)
  res.json({
    ok: true,
    position: pos,
    strategy: getStrategy(id),
    canary: (() => { const v = getCanaryVersion(id); return v ? versionToStrategy(v, id, { isCanary: false }) : null })(),
    versions,
    defaults: { weights: { ...DEFAULT_WEIGHTS }, keywordCap: DEFAULT_KEYWORD_CAP }
  })
})

// ---------------- 策略版本治理：审批 / 生效窗口 / 灰度 / 回滚 / 批量重算 ----------------
function parseStrategyPayload(b = {}) {
  const weights = b.reset ? { ...DEFAULT_WEIGHTS } : normalizeWeights(b.weights || {})
  const keywordCap = Math.max(0, Math.min(20, num(b.keyword_cap, DEFAULT_KEYWORD_CAP)))
  const rolloutMode = b.rollout_mode === 'canary' ? 'canary' : 'full'
  const canaryPercent = rolloutMode === 'canary'
    ? Math.max(0, Math.min(100, Math.round(num(b.canary_percent, 0))))
    : 0
  const canaryIds = rolloutMode === 'canary' && Array.isArray(b.canary_candidate_ids)
    ? [...new Set(b.canary_candidate_ids.map(num).filter(Boolean))]
    : []
  if (rolloutMode === 'canary' && !canaryIds.length && canaryPercent <= 0) {
    badRequest('灰度发布必须选择灰度候选人或填写大于 0 的灰度比例', 'canary_scope_required')
  }
  if (canaryIds.length) {
    const exists = db.prepare('SELECT COUNT(*) c FROM candidates WHERE id IN (' + canaryIds.map(() => '?').join(',') + ')').get(...canaryIds).c
    if (exists !== canaryIds.length) badRequest('灰度候选人不存在', 'canary_candidate_invalid')
  }
  const start = windowInput(b.effective_start)
  const end = windowInput(b.effective_end)
  if (start && end && end <= start) badRequest('生效结束时间必须晚于开始时间', 'window_invalid')
  if (rolloutMode === 'canary' && !end && !b.allow_indefinite) badRequest('灰度版本必须设置观察窗口结束时间', 'canary_window_required')
  return {
    weights, keywordCap, rolloutMode, canaryPercent, canaryIds,
    effectiveStart: start, effectiveEnd: end,
    changeNote: String(b.change_note || '').slice(0, 500)
  }
}

function assertNoStrategyGovernanceLock(posId) {
  const blocked = db.prepare("SELECT id,status FROM strategy_versions WHERE position_id=? AND status IN ('pending','returned','scheduled') ORDER BY id DESC LIMIT 1").get(posId)
  if (blocked) conflict(`该职位已有${blocked.status === 'returned' ? '被退回' : blocked.status === 'scheduled' ? '待生效' : '待审批'}策略 v${blocked.id}，请先完成、修改重提或撤销`, 'strategy_pending_exists')
  const canary = db.prepare("SELECT id FROM strategy_versions WHERE position_id=? AND status='canary'").get(posId)
  if (canary) conflict(`该职位存在灰度策略 v${canary.id}，请先全量、回滚或等待窗口结束`, 'strategy_canary_exists')
}

function upsertActiveStrategy(posId, v, stamp) {
  db.prepare(`INSERT INTO match_strategies(position_id,weights,keyword_cap,active_version_id,effective_start,effective_end,published_at,published_by)
              VALUES(?,?,?,?,?,?,?,?)
              ON CONFLICT(position_id) DO UPDATE SET
                weights=excluded.weights,keyword_cap=excluded.keyword_cap,active_version_id=excluded.active_version_id,
                effective_start=excluded.effective_start,effective_end=excluded.effective_end,
                published_at=excluded.published_at,published_by=excluded.published_by`)
    .run(posId, JSON.stringify(v.weights), v.keyword_cap, v.id,
      v.effective_start || stamp, v.effective_end, stamp, v.published_by)
}

function recomputePosition(posId, jobId = 0) {
  const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(posId)
  if (!pos) return { pairs: 0, canary: 0, baseline: 0 }
  const cands = db.prepare('SELECT id FROM candidates ORDER BY id').all()
  let canary = 0
  cands.forEach(c => {
    const strategy = resolveStrategy(posId, c.id)
    if (strategy.isCanary) canary++
    upsertMatch(c.id, posId, jobId, strategy)
  })
  return { pairs: cands.length, canary, baseline: cands.length - canary }
}

// 固定策略重算：全量/回滚/提升时所有候选人统一使用同一版本；窗口观察或灰度发布用 recomputePosition
function recomputePositionWithVersion(posId, jobId, versionId, mode = 'full') {
  const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(posId)
  if (!pos) return { pairs: 0, canary: 0, baseline: 0 }
  const strategy = versionId ? versionToStrategy(getStrategyVersion(versionId), posId, { strategyMode: mode })
    : defaultStrategy(posId)
  const cands = db.prepare('SELECT id FROM candidates ORDER BY id').all()
  cands.forEach(c => upsertMatch(c.id, posId, jobId, strategy))
  return { pairs: cands.length, canary: 0, baseline: cands.length }
}

function activateCanaryVersion(version, { triggeredBy } = {}) {
  const v = parseStrategyVersionRow(version)
  const stamp = ts()
  const jobId = createRecalcJob({
    triggerType: 'strategy_canary', scope: 'position', positionId: v.position_id,
    strategyId: v.id, triggeredBy: triggeredBy || v.published_by,
    rolloutMode: 'canary', canaryVersionId: v.id
  })
  const counts = recomputePosition(v.position_id, jobId)
  completeRecalcJob(jobId, counts.pairs, counts.canary, counts.baseline)
  db.prepare(`UPDATE strategy_versions
              SET status='canary', approved_at=COALESCE(NULLIF(approved_at,''),?)
              WHERE id=?`).run(stamp, v.id)
  v.status = 'canary'
  return { jobId, ...counts }
}

function activateFullVersion(version, { triggeredBy, triggerType = 'strategy_publish' } = {}) {
  const v = parseStrategyVersionRow(version)
  const stamp = ts()
  const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(v.position_id)
  if (!pos) badRequest('职位不存在', 'position_missing')
  // 全量生效会终止同职位灰度/待生效版本：旧版本标记为 superseded，不删除证据
  db.prepare("UPDATE strategy_versions SET status='superseded' WHERE position_id=? AND status IN ('canary','scheduled','full') AND id<>?")
    .run(v.position_id, v.id)
  upsertActiveStrategy(v.position_id, v, stamp)
  const jobId = createRecalcJob({
    triggerType, scope: 'position', positionId: v.position_id, strategyId: v.id,
    triggeredBy: triggeredBy || v.published_by
  })
  const counts = recomputePositionWithVersion(v.position_id, jobId, v.id, 'full')
  completeRecalcJob(jobId, counts.pairs, 0, counts.pairs)
  db.prepare(`UPDATE strategy_versions
              SET status='full', rollout_mode='full', canary_percent=0, canary_candidate_ids='[]',
                  approved_at=COALESCE(NULLIF(approved_at,''),?)
              WHERE id=?`).run(stamp, v.id)
  return { jobId, ...counts }
}

// 提交策略发布审批：仅创建 pending 版本；审批通过且到达生效窗口后才改变 matches 与基线
app.post('/api/positions/:id/strategy', (req, res, next) => {
  const user = currentUser(req)
  const id = num(req.params.id)
  const b = req.body || {}
  try {
    if (user.role !== 'recruiter') forbidden('匹配策略发布需由招聘负责人发起', 'role_not_allowed')
    if (!db.prepare('SELECT id FROM positions WHERE id=?').get(id)) return res.status(404).json({ ok: false })
    const payload = parseStrategyPayload(b)
    const result = tx(() => {
      assertNoStrategyGovernanceLock(id)
      const baseline = getStrategy(id)
      const stamp = ts()
      const vr = db.prepare(`INSERT INTO strategy_versions(
          position_id,weights,keyword_cap,status,rollout_mode,canary_percent,canary_candidate_ids,
          effective_start,effective_end,baseline_version_id,change_note,published_at,published_by)
        VALUES(?,?,?, 'pending', ?,?,?,?,?,?,?,?,?)`)
        .run(id, JSON.stringify(payload.weights), payload.keywordCap, payload.rolloutMode,
          payload.canaryPercent, JSON.stringify(payload.canaryIds), payload.effectiveStart,
          payload.effectiveEnd, baseline.versionId, payload.changeNote, stamp, user.name)
      const versionId = Number(vr.lastInsertRowid)
      const approvalPayload = {
        position_id: id,
        strategy_version_id: versionId,
        rollout_mode: payload.rolloutMode,
        canary_percent: payload.canaryPercent,
        canary_candidate_ids: payload.canaryIds,
        effective_start: payload.effectiveStart,
        effective_end: payload.effectiveEnd,
        change_note: payload.changeNote,
        weights: payload.weights,
        keyword_cap: payload.keywordCap
      }
      const chain = buildChain('strategy_publish', approvalPayload, null)
      if (chain[0]) stampNodeDue(chain[0])
      const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(id)
      const tr = db.prepare(`INSERT INTO approval_tasks(type,application_id,interview_id,offer_id,payload,chain,current_step,status,submitted_by,submitted_by_name,submitted_role,submitted_at,version)
                             VALUES('strategy_publish',0,0,0,?,?,0,'pending',?,?,?,?,1)`)
        .run(JSON.stringify(approvalPayload), JSON.stringify(chain), user.id, user.name, user.role, stamp)
      const taskId = Number(tr.lastInsertRowid)
      db.prepare('UPDATE strategy_versions SET approval_task_id=? WHERE id=?').run(taskId, versionId)
      addStep(taskId, {
        stepNo: -1, role: user.role, action: 'submit', actor: user,
        note: `提交策略 v${versionId}（${payload.rolloutMode === 'canary' ? `灰度 ${payload.canaryIds.length || payload.canaryPercent + '%'}` : '全量'}）：${payload.changeNote || '无发布说明'}`
      })
      notify({
        recipientRole: chain[0].role, type: 'task_submitted',
        title: '新的匹配策略发布审批待处理',
        body: `${user.name} 提交「${pos.name}」策略 v${versionId}，请核对生效窗口与灰度范围`,
        taskId, appId: 0
      })
      return { versionId, taskId, chain }
    })
    res.json({ ok: true, version_id: result.versionId, task_id: result.taskId, chain: result.chain })
  } catch (e) { next(e) }
})

// 灰度转正：复用灰度版本证据，将其提升为全量基线并重算整个职位
app.post('/api/strategy-versions/:vid/promote', (req, res, next) => {
  const user = currentUser(req)
  const vid = num(req.params.vid)
  try {
    const out = tx(() => {
      const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(vid)
      if (!v) return { notFound: true }
      if (user.role !== 'recruiter') forbidden('仅招聘负责人可将灰度策略转正', 'role_not_allowed')
      if (v.status !== 'canary') badRequest('仅灰度中的版本可以转正', 'strategy_not_canary')
      const blocked = db.prepare("SELECT id,status FROM strategy_versions WHERE position_id=? AND status IN ('pending','returned','scheduled') AND id<>? ORDER BY id DESC LIMIT 1")
        .get(v.position_id, v.id)
      if (blocked) conflict('存在待审批、退回或待生效版本，请先处理后再转正', 'strategy_pending_exists')
      const r = activateFullVersion(v, { triggeredBy: user.name, triggerType: 'strategy_promote' })
      db.prepare("UPDATE strategy_versions SET promoted_version_id=id WHERE id=?").run(v.id)
      notify({
        recipientRole: user.role, type: 'task_executed',
        title: '灰度策略已全量生效',
        body: `v${v.id} 已转正，批次 #${r.jobId} 完成 ${r.pairs} 组匹配重算`,
        taskId: num(v.approval_task_id)
      })
      return { ok: true, ...r, version_id: v.id }
    })
    if (out.notFound) return res.status(404).json({ ok: false })
    res.json(out)
  } catch (e) { next(e) }
})

// 灰度/全量回滚：恢复发布前基线并生成 strategy_rollback 批次；历史阶段/投递快照保持不变
app.post('/api/strategy-versions/:vid/rollback', (req, res, next) => {
  const user = currentUser(req)
  const vid = num(req.params.vid)
  const reason = String(req.body?.reason || '').trim()
  try {
    const out = tx(() => {
      const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(vid)
      if (!v) return { notFound: true }
      if (user.role !== 'recruiter') forbidden('仅招聘负责人可回滚策略', 'role_not_allowed')
      if (!reason) badRequest('策略回滚必须填写原因', 'rollback_reason_required')
      if (!['canary', 'full', 'scheduled', 'expired'].includes(v.status)) {
        badRequest('仅灰度中、全量中、待生效或已过期版本可以执行回滚', 'strategy_status_invalid')
      }
      const posId = num(v.position_id)
      const baselineId = num(v.baseline_version_id)
      const baseline = baselineId ? db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(baselineId) : null
      const stamp = ts()
      const jobId = createRecalcJob({
        triggerType: 'strategy_rollback', scope: 'position', positionId: posId,
        strategyId: baselineId, triggeredBy: user.name
      })
      const counts = recomputePositionWithVersion(posId, jobId, baselineId, 'full')
      completeRecalcJob(jobId, counts.pairs, 0, counts.pairs)
      if (baseline) {
        db.prepare("UPDATE strategy_versions SET status='full' WHERE id=?").run(baselineId)
        upsertActiveStrategy(posId, parseStrategyVersionRow(baseline), stamp)
      } else {
    db.prepare(`INSERT INTO match_strategies(position_id,weights,keyword_cap,active_version_id,effective_start,effective_end,published_at,published_by)
                VALUES(?,?,0,'','',?,?,?)
                ON CONFLICT(position_id) DO UPDATE SET weights=excluded.weights,keyword_cap=excluded.keyword_cap,
                  active_version_id=0,effective_start='',effective_end='',published_at=excluded.published_at,published_by=excluded.published_by`)
      .run(posId, JSON.stringify(DEFAULT_WEIGHTS), DEFAULT_KEYWORD_CAP, stamp, user.name)
      }
      db.prepare(`UPDATE strategy_versions
                  SET status='rolled_back', rolled_back_by=?, rolled_back_at=?, rollback_reason=?
                  WHERE id=?`).run(user.name, stamp, reason, vid)
      db.prepare("UPDATE strategy_versions SET status='superseded' WHERE position_id=? AND status='canary' AND id<>?", posId, vid)
      notify({
        recipientRole: user.role, type: 'task_failed',
        title: '匹配策略已回滚',
        body: `v${vid} 已回滚至 ${baselineId ? 'v' + baselineId : 'v0 默认策略'}，批次 #${jobId} 已重算 ${counts.pairs} 组匹配`,
        taskId: num(v.approval_task_id)
      })
      return { ok: true, version_id: vid, baseline_version_id: baselineId, job_id: jobId, ...counts }
    })
    if (out.notFound) return res.status(404).json({ ok: false })
    res.json(out)
  } catch (e) { next(e) }
})

// 生效窗口推进：定时/手动幂等扫描。scheduled 到点执行；canary 到点自动回滚到发布前基线
function sweepStrategyWindows(at = new Date().toISOString()) {
  const due = db.prepare(`SELECT * FROM strategy_versions
                          WHERE (status='scheduled')
                             OR (status='canary' AND effective_end!='' AND effective_end<=?)
                             OR (status='full' AND effective_end!='' AND effective_end<=?)
                          ORDER BY id`).all(at, at)
  const out = []
  due.forEach(raw => {
    tx(() => {
      const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(raw.id)
      if (!v || !['scheduled', 'canary', 'full'].includes(v.status)) return
      if (v.status === 'scheduled' && v.effective_start && at < v.effective_start) return
      if (v.status === 'canary' || v.status === 'full') {
        if (v.approval_task_id) {
          const label = v.status === 'canary' ? '灰度观察窗口到期' : '全量生效窗口到期'
          db.prepare(`INSERT INTO approval_steps(task_id,step_no,role,action,actor_id,actor_name,note,acted_at)
                      VALUES(?,-1,'recruiter','failed','system','系统窗口守护',?,?)`)
            .run(num(v.approval_task_id), `${label}，自动回滚 v${v.id}`, ts())
        }
        const action = v.status === 'canary' ? 'canary_expired' : 'full_expired'
        const reason = v.status === 'canary' ? '灰度观察窗口到期，自动回滚' : '全量生效窗口到期，自动回滚到发布前基线'
        const r = {
          ...{ version_id: v.id, action },
          ...rollbackVersionInternal(v, '系统窗口守护', reason)
        }
        out.push(r)
      } else {
        const r = v.rollout_mode === 'canary'
          ? activateCanaryVersion(v, { triggeredBy: 'system-window' })
          : activateFullVersion(v, { triggeredBy: 'system-window', triggerType: 'strategy_publish' })
        out.push({ version_id: v.id, action: v.rollout_mode === 'canary' ? 'canary_activated' : 'activated', ...r })
      }
    })
  })
  return out
}

// 供窗口守护在同一事务内复用回滚逻辑（不做 HTTP 权限/原因校验）
function rollbackVersionInternal(rawV, operator, reason) {
  const v = parseStrategyVersionRow(rawV)
  const posId = v.position_id
  const baselineId = v.baseline_version_id
  const baseline = baselineId ? db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(baselineId) : null
  const stamp = ts()
  const jobId = createRecalcJob({
    triggerType: 'strategy_rollback', scope: 'position', positionId: posId,
    strategyId: baselineId, triggeredBy: operator
  })
  const counts = recomputePositionWithVersion(posId, jobId, baselineId, 'full')
  completeRecalcJob(jobId, counts.pairs, 0, counts.pairs)
  if (baseline) {
    db.prepare("UPDATE strategy_versions SET status='full' WHERE id=?").run(baselineId)
    upsertActiveStrategy(posId, parseStrategyVersionRow(baseline), stamp)
  } else {
    db.prepare(`INSERT INTO match_strategies(position_id,weights,keyword_cap,active_version_id,effective_start,effective_end,published_at,published_by)
                VALUES(?,?,0,'','',?,?,?)
                ON CONFLICT(position_id) DO UPDATE SET weights=excluded.weights,keyword_cap=excluded.keyword_cap,
                  active_version_id=0,effective_start='',effective_end='',published_at=excluded.published_at,published_by=excluded.published_by`)
      .run(posId, JSON.stringify(DEFAULT_WEIGHTS), DEFAULT_KEYWORD_CAP, stamp, operator)
  }
  db.prepare(`UPDATE strategy_versions SET status='rolled_back', rolled_back_by=?, rolled_back_at=?, rollback_reason=? WHERE id=?`)
    .run(operator, stamp, reason, v.id)
  return { baseline_version_id: baselineId, job_id: jobId, ...counts }
}
app.get('/api/strategies/sweep', (req, res) => {
  const changed = sweepStrategyWindows()
  res.json({ ok: true, changed, count: changed.length })
})

// ---------------- 批量重算推荐结果 ----------------
app.post('/api/match/recompute', (req, res) => {
  const b = req.body || {}
  const result = tx(() => {
    let pairCount = 0, posCount = 0, scope = 'global', targetPos = 0, strategyId = 0
    if (b.position_id) {
      const pos = db.prepare('SELECT id FROM positions WHERE id=?').get(num(b.position_id))
      if (!pos) return { notFound: true }
      targetPos = pos.id
      scope = 'position'
      strategyId = getStrategy(pos.id).versionId
      const jobId = createRecalcJob({ triggerType: 'manual', scope, positionId: targetPos, strategyId, triggeredBy: b.triggered_by || 'HR' })
      const counts = recomputePosition(targetPos, jobId)
      pairCount = counts.pairs
      posCount = 1
      completeRecalcJob(jobId, pairCount, counts.canary, counts.baseline)
      return { ok: true, jobId, positions: posCount, pairs: pairCount, canary: counts.canary, baseline: counts.baseline }
    }

    const jobId = createRecalcJob({ triggerType: 'manual', scope, triggeredBy: b.triggered_by || 'HR' })
    // 全局：所有在招职位 × 全部候选人；同时补上已关闭职位上已存在的匹配对
    const posIds = db.prepare("SELECT id FROM positions WHERE status='open'").all().map(p => p.id)
    db.prepare("SELECT DISTINCT m.position_id FROM matches m JOIN positions p ON p.id=m.position_id WHERE p.status!='open'")
      .all().forEach(r => posIds.push(r.position_id))
    let canaryCount = 0, baselineCount = 0
    posIds.forEach(pid => {
      // 批次是全局操作，明细保留每个职位实际使用的策略版本；命中灰度的候选人随当前灰度策略重算
      const counts = recomputePosition(pid, jobId)
      pairCount += counts.pairs
      canaryCount += counts.canary
      baselineCount += counts.baseline
      posCount++
    })
    completeRecalcJob(jobId, pairCount, canaryCount, baselineCount)
    return { ok: true, jobId, positions: posCount, pairs: pairCount, canary: canaryCount, baseline: baselineCount }
  })
  if (result.notFound) return res.status(404).json({ ok: false })
  res.json({
    ok: true,
    positions: result.positions, pairs: result.pairs, canary: result.canary, baseline: result.baseline,
    job_id: result.jobId, recomputed_at: ts()
  })
})

// ---------------- 候选人 ----------------
app.post('/api/candidates', (req, res) => {
  const b = req.body || {}
  const r = db.prepare('INSERT INTO candidates(name,phone,skills,years,edu,school,city,exp_salary,channel,raw) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(b.name, b.phone || '', JSON.stringify(b.skills || []), num(b.years, 0), b.edu || '本科', b.school || '', b.city || '', num(b.exp_salary, 0), b.channel || '内推', b.raw || `候选人${b.name}的简历`)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})

app.delete('/api/candidates/:id', (req, res) => {
  db.prepare('DELETE FROM candidates WHERE id=?').run(num(req.params.id))
  res.json({ ok: true })
})

// ---------------- 匹配 ----------------
app.get('/api/match/pos/:pid', (req, res) => {
  const posId = num(req.params.pid)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(posId)
  if (!pos) return res.status(404).json({ ok: false })
  const cands = db.prepare('SELECT * FROM candidates').all()
  const rows = cands.map(c => {
    // 浏览推荐时实时计算；只有显式“批量重算/发布策略”才更新最新结果与审计批次
    const m = computePair(c.id, posId)
    return { candidate_id: c.id, name: c.name, skills: parseSkills(c.skills), years: c.years, edu: c.edu, city: c.city, exp_salary: c.exp_salary, score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness, computed_at: m.computed_at, strategy_id: m.strategy_id, is_canary: m.is_canary, strategy_mode: m.strategy_mode }
  })
  rows.sort((a, b) => b.score - a.score)
  const strategy = getStrategy(posId)
  const canaryVersion = getCanaryVersion(posId)
  res.json({
    position: { ...pos, skills: parseSkills(pos.skills) },
    candidates: rows,
    strategy,
    canary: canaryVersion ? versionToStrategy(canaryVersion, posId, { isCanary: false }) : null,
    canary_count: rows.filter(r => r.is_canary).length
  })
})

app.get('/api/match/cand/:cid', (req, res) => {
  const candId = num(req.params.cid)
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(candId)
  if (!cand) return res.status(404).json({ ok: false })
  const poss = db.prepare("SELECT * FROM positions WHERE status='open'").all()
  const rows = poss.map(p => {
    // 与按职位推荐共用同一实时计算逻辑；显式重算的结果才写入最新结果/批次明细
    const m = computePair(candId, p.id)
    return { position_id: p.id, name: p.name, dept: p.dept, city: p.city, level: p.level, salary_min: p.salary_min, salary_max: p.salary_max, score: m.score, dims: m.dims, reason: m.reason, weakness: m.weakness, computed_at: m.computed_at, strategy_id: m.strategy_id, strategy_is_default: m.strategy_is_default, is_canary: m.is_canary, strategy_mode: m.strategy_mode }
  })
  rows.sort((a, b) => b.score - a.score)
  res.json({ candidate: { name: cand.name, skills: parseSkills(cand.skills), years: cand.years }, positions: rows })
})

// ---------------- 应聘流程 ----------------
function getStoredMatch(candId, posId) {
  return db.prepare('SELECT * FROM matches WHERE candidate_id=? AND position_id=?').get(candId, posId) || null
}

function resultFromStored(row) {
  if (!row) return null
  return {
    score: num(row.score),
    dims: parseDims(row.dims, '[]'),
    reason: row.reason,
    weakness: row.weakness,
    computed_at: row.computed_at,
    strategy_id: num(row.strategy_id),
    weights: parseJSON(row.weights, {}),
    keyword_cap: num(row.keyword_cap, DEFAULT_KEYWORD_CAP),
    is_canary: !!row.is_canary,
    strategy_mode: row.strategy_mode || (num(row.strategy_id) ? 'full' : 'default')
  }
}

function latestJobForPair(candId, posId) {
  return db.prepare(`SELECT ri.job_id, ri.strategy_id, ri.computed_at
                     FROM recalc_items ri
                     WHERE ri.candidate_id=? AND ri.position_id=?
                     ORDER BY ri.id DESC LIMIT 1`).get(candId, posId) || null
}

// 写入/刷新「进入某阶段」的正式事件（backfilled=0）：
// 同一 application×stage 永远只有一条正式事件（部分唯一索引兜底），候选人再次进入该阶段时
// 直接刷新该行，保证阶段快照、时间线与当前阶段口径一致；补录事件不受影响
function insertStageEvent({ applicationId, stage, fromStage, eventType = 'advance', operator = 'HR-Sandy', candId, posId, latest, backfilled = false }) {
  const source = latest || resultFromStored(getStoredMatch(candId, posId))
  const item = latestJobForPair(candId, posId)
  const linkedItem = source && item && item.computed_at === source.computed_at ? item : null
  const recalcJobId = latest && Object.prototype.hasOwnProperty.call(latest, 'recalc_job_id')
    ? num(latest.recalc_job_id)
    : num(linkedItem?.job_id || 0)
  const stamp = ts()
  const snap = buildSnapshot(candId, posId, source || {
    score: 0, dims: [], reason: '暂无已发布评分', weakness: '暂无评分依据'
  }, {
    stage,
    stage_label: STAGE_LABEL[stage] || stage,
    event_type: eventType,
    event_at: stamp,
    recalc_job_id: recalcJobId,
    backfilled
  }, source || undefined)
  if (backfilled) {
    db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,recalc_job_id,backfilled)
                VALUES(?,?,?,?,?,?,?,?,?,?,1)
                ON CONFLICT(application_id,stage) WHERE backfilled=0 DO NOTHING`)
      .run(applicationId, stage, fromStage || '', eventType, stamp, operator,
        JSON.stringify(snap), snap.score, snap.strategy_id, snap.recalc_job_id)
  } else {
    db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,recalc_job_id,backfilled)
                VALUES(?,?,?,?,?,?,?,?,?,?,0)
                ON CONFLICT(application_id,stage) WHERE backfilled=0 DO UPDATE SET
                  from_stage=excluded.from_stage,event_type=excluded.event_type,event_at=excluded.event_at,
                  operator=excluded.operator,score_snapshot=excluded.score_snapshot,match_score=excluded.match_score,
                  strategy_id=excluded.strategy_id,recalc_job_id=excluded.recalc_job_id`)
      .run(applicationId, stage, fromStage || '', eventType, stamp, operator,
        JSON.stringify(snap), snap.score, snap.strategy_id, snap.recalc_job_id)
  }
  return snap
}

// 阶段协同的唯一入口：更新应用阶段 + 乐观锁版本 + 阶段快照 + 阶段事件，保证四处口径一次事务内一致
function moveStage(app, stage, { eventType, fromStage, operator }) {
  const stamp = ts()
  db.prepare('UPDATE applications SET stage=?, updated=?, entered_at=?, stage_snapshot=?, version=version+1 WHERE id=?')
    .run(stage, stamp, stamp, '', app.id)
  const snap = insertStageEvent({
    applicationId: app.id, stage, fromStage: fromStage ?? app.stage, eventType,
    operator: operator || app.recruiter || 'HR-Sandy', candId: app.candidate_id, posId: app.position_id
  })
  // 事件刚写入，stage_snapshot 与其同源：直接固化为该阶段事件的评分快照
  db.prepare('UPDATE applications SET stage_snapshot=? WHERE id=?').run(JSON.stringify(snap), app.id)
  app.stage = stage
  app.version = num(app.version) + 1
  return { stage, snapshot: snap }
}

// 异常回退到上一阶段的协同：终态先解除（Offer 重置为已撤回），再写 rollback 事件与新的阶段快照
function rollbackStage(app, { operator, expectedVersion, reason = '' }) {
  checkVersion(app, expectedVersion)
  if (app.stage === 'rejected') {
    const target = PREV_STAGE[app.reject_from || ''] || ''
    if (!target) badRequest('该淘汰记录缺少回退来源，请先在追溯中确认来源阶段', 'rollback_no_source')
    return reopenRejected(app, { target, operator, reason })
  }
  const target = PREV_STAGE[app.stage]
  if (!target) badRequest('投递阶段无法继续回退', 'rollback_first_stage')
  // 从 Offer 阶段回退：进行中/已接受的 Offer 必须撤回，避免 Offer 页与流程页口径不一致
  if (app.stage === 'offer') withdrawActiveOffer(app, { operator, reason })
  if (app.stage === 'hired') withdrawAcceptedOffer(app, { operator, reason })
  return moveStage(app, target, { eventType: 'rollback', operator, fromStage: app.stage })
}

function reopenRejected(app, { target, operator, reason = '' }) {
  const of = offerOfApp(app.id)
  if (of && (of.status === 'accepted' || of.status === 'joined')) {
    badRequest('候选人已接受 Offer/已入职，不能从淘汰复活', 'terminal_locked')
  }
  if (of && of.status === 'pending') withdrawActiveOffer(app, { operator, reason, force: true })
  return moveStage(app, target, { eventType: 'rollback', operator, fromStage: 'rejected' })
}

function withdrawActiveOffer(app, { operator, reason = '', force = false }) {
  const of = offerOfApp(app.id)
  if (!of || (of.status !== 'pending' && !force)) return null
  const stamp = ts()
  db.prepare('UPDATE offers SET status=?, note=?, decided_at=?, decided_by=? WHERE id=?')
    .run('withdrawn', reason || of.note, stamp, operator || 'HR-Sandy', of.id)
  addOfferLog({
    offerId: of.id, applicationId: app.id, changeType: 'withdraw', of,
    toStatus: 'withdrawn', operator: operator || 'HR-Sandy', note: reason
  })
  of.status = 'withdrawn'
  return of
}

function withdrawAcceptedOffer(app, { operator, reason }) {
  const of = offerOfApp(app.id)
  if (!of || (of.status !== 'accepted' && of.status !== 'joined')) return null
  const stamp = ts()
  db.prepare('UPDATE offers SET status=?, note=?, decided_at=?, decided_by=?, joined_at=? WHERE id=?')
    .run('withdrawn', reason || of.note, stamp, operator || 'HR-Sandy', app.stage === 'hired' ? '' : of.joined_at, of.id)
  addOfferLog({
    offerId: of.id, applicationId: app.id, changeType: 'withdraw', of,
    toStatus: 'withdrawn', operator: operator || 'HR-Sandy', note: reason
  })
  of.status = 'withdrawn'
  return of
}

app.post('/api/applications', (req, res) => {
  const b = req.body || {}
  const pid = num(b.position_id), cid = num(b.candidate_id)
  const dup = db.prepare('SELECT id FROM applications WHERE position_id=? AND candidate_id=?').get(pid, cid)
  if (dup) return res.status(409).json({ ok: false, code: 'duplicate_application', msg: '该候选人已投递此职位，请勿重复投递' })
  const cand = db.prepare('SELECT * FROM candidates WHERE id=?').get(cid)
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(pid)
  if (!cand || !pos) return res.status(404).json({ ok: false, msg: '职位或候选人不存在' })
  const out = tx(() => {
    // 投递时同步固化当前评分证据；不创建重算批次，避免把单个投递伪装成批量策略重算
    const m = upsertMatch(cid, pid, 0)
    const stamp = now()
    const snap = buildSnapshot(cid, pid, { ...m, computed_at: stamp }, {
      stage: 'submitted',
      stage_label: '投递',
      event_type: 'advance',
      matched_at: stamp,
      recalc_job_id: 0
    })
    const r = db.prepare('INSERT INTO applications(position_id,candidate_id,stage,updated,recruiter,match_snapshot,matched_at,stage_snapshot,entered_at,version) VALUES(?,?,?,?,?,?,?,?,?,1)')
      .run(pid, cid, 'submitted', ts(), b.recruiter || 'HR-Sandy', JSON.stringify(snap), snap.matched_at, JSON.stringify(snap), ts())
    const appId = Number(r.lastInsertRowid)
    insertStageEvent({
      applicationId: appId, stage: 'submitted', fromStage: '', eventType: 'advance',
      operator: b.recruiter || 'HR-Sandy', candId: cid, posId: pid, latest: m
    })
    return { id: appId }
  })
  res.json({ ok: true, id: out.id })
})

// 阶段推进核心：只能沿投递→筛选→面试→Offer→录用顺序前进，且受面试结论/Offer 状态约束。
// 供「直接推进端点」与「审批通过后的执行回写」共用；targetStage 用于审批场景校验申请时锁定的目标阶段未漂移
function advanceApplication(a, { operator, expectedVersion, targetStage } = {}) {
  checkVersion(a, expectedVersion)
  if (a.stage === 'rejected') conflict('候选人已淘汰，请先「异常回退」复活后再推进', 'rejected_locked')
  const next = NEXT_STAGE[a.stage]
  if (!next) conflict('已到最后阶段，无需重复推进', 'last_stage')
  if (targetStage && next !== targetStage) {
    conflict(`流程阶段已变化（当前「${STAGE_LABEL[a.stage]}」），无法按申请推进到「${STAGE_LABEL[targetStage] || targetStage}」`, 'stage_mismatch')
  }
  if (next === 'offer') assertCanEnterOffer(a)
  // Offer → 录用只能由「接受 Offer」驱动，防止跳过候选人接受确认
  if (next === 'hired') {
    const of = offerOfApp(a.id)
    if (!of || of.status !== 'accepted') badRequest('请先在 Offer 管理中等待候选人接受 Offer', 'offer_not_accepted')
  }
  const r = moveStage(a, next, { eventType: 'advance', operator })
  return { stage: next, version: a.version, snapshot: r.snapshot }
}

app.post('/api/applications/:id/advance', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      const r = advanceApplication(a, { operator: b.operator, expectedVersion: b.version })
      return { ok: true, ...r }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

app.post('/api/applications/:id/reject', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  const actor = currentUser(req)
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      checkVersion(a, b.version)
      if (a.stage === 'rejected') conflict('该候选人已淘汰，请勿重复操作', 'already_rejected')
      if (a.stage === 'hired') conflict('候选人已录用，不能淘汰；如需修正请走异常回退', 'hired_locked')
      // 待回应 Offer 随淘汰一并撤回，Offer 记录与流程阶段保持同一口径
      withdrawActiveOffer(a, { operator: b.operator, reason: b.reason || '候选人流程淘汰', force: true })
      const fromStage = a.stage
      const r = moveStage(a, 'rejected', {
        eventType: fromStage === 'offer' ? 'offer_rejected' : 'reject',
        operator: b.operator, fromStage
      })
      db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, id)
      auditPassive({
        category: 'action', action: 'state.reject', actor, applicationId: id,
        refType: 'application', refId: id,
        summary: `危机相关流程淘汰：${STAGE_LABEL[fromStage] || fromStage} → 淘汰`,
        detail: { from: fromStage, to: 'rejected', reason: b.reason || '' }
      })
      return { ok: true, stage: 'rejected', from: fromStage, version: a.version, snapshot: r.snapshot }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 异常回退：仅允许回到上一阶段（淘汰复活除外），写 rollback 事件并刷新阶段快照，全程留痕
app.post('/api/applications/:id/rollback', (req, res, next) => {
  const id = num(req.params.id)
  const b = req.body || {}
  const actor = currentUser(req)
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id)
      if (!a) return { notFound: true }
      const fromStage = a.stage
      const offerBefore = offerOfApp(a.id)
      const r = rollbackStage(a, { operator: b.operator, expectedVersion: b.version, reason: b.reason || '' })
      if (a.stage === 'rejected') db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(id)
      const offerAfter = offerOfApp(a.id)
      // 若该应聘关联了进行中的危机事件，状态回退同事务追加到不可篡改审计链
      auditPassive({
        category: 'rollback', action: 'state.rollback', actor, applicationId: id,
        refType: 'application', refId: id,
        summary: `流程异常回退：${STAGE_LABEL[fromStage] || fromStage} → ${STAGE_LABEL[a.stage] || a.stage}`,
        detail: {
          from: fromStage, to: a.stage, reason: b.reason || '',
          offer_withdrawn: !!offerBefore && offerBefore.status !== 'withdrawn' && offerAfter?.status === 'withdrawn'
        }
      })
      return { ok: true, stage: a.stage, version: a.version, snapshot: r.snapshot }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 面试 ----------------
app.post('/api/applications/:id/interview', (req, res, next) => {
  const b = req.body || {}
  try {
    const out = tx(() => {
      const appId = num(req.params.id)
      const a = db.prepare('SELECT id,stage FROM applications WHERE id=?').get(appId)
      if (!a) return { notFound: true }
      if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能再安排面试', 'terminal_locked')
      const r = db.prepare('INSERT INTO interviews(application_id,interviewer,time,round,eval,result,conclusion) VALUES(?,?,?,?,?,?,\'pending\')')
        .run(appId, b.interviewer || '面试官', b.time || ts(), b.round || '初试', b.eval || '', b.result === 'pass' || b.result === 'fail' ? b.result : 'pending')
      return { ok: true, id: Number(r.lastInsertRowid) }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 面试结论协同核心：双写 conclusion/result 并记录决定人；最近一轮「不通过」自动淘汰，
// 淘汰态改判「通过/待定」复活回面试阶段；录用后锁定，同结论幂等。
// 供「面试更新端点」与「面试结论审批通过后的执行回写」共用
function applyInterviewConclusion(iv, a, conclusion, { operator } = {}) {
  const current = iv.conclusion || iv.result || 'pending'
  if (a.stage === 'hired' && conclusion !== current) {
    conflict('候选人已录用，面试结论已锁定', 'terminal_locked')
  }
  if (conclusion === current) return { idempotent: true, version: num(a.version) }
  const stamp = ts()
  db.prepare('UPDATE interviews SET conclusion=?, result=?, decided_at=?, decided_by=? WHERE id=?')
    .run(conclusion, conclusion, stamp, operator || a.recruiter || 'HR-Sandy', iv.id)
  // 最近一轮给出「不通过」结论：应聘自动淘汰并固化阶段事件（仅对最近一轮生效，历史轮次改判不联动）
  const last = latestInterviewOf(a.id)
  if (conclusion === 'fail' && last && last.id === iv.id && a.stage !== 'rejected') {
    const fromStage = a.stage
    moveStage(a, 'rejected', { eventType: 'reject', operator, fromStage })
    db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, a.id)
  }
  // 淘汰状态下「改判通过/待定」可复活：回到面试阶段（单步回退，避免跨阶段跳变）
  if (conclusion !== 'fail' && a.stage === 'rejected') {
    const target = a.reject_from && STAGES.includes(a.reject_from) && STAGES.indexOf(a.reject_from) <= STAGES.indexOf('interview')
      ? a.reject_from : 'interview'
    moveStage(a, target, { eventType: 'rollback', operator, fromStage: 'rejected' })
    db.prepare("UPDATE applications SET reject_from='' WHERE id=?").run(a.id)
  }
  return { idempotent: false, version: a.version }
}

// 更新面试评价/结论。结论(pass/fail/pending)与 result 双写兼容；同一结论重复提交直接幂等返回
app.post('/api/interviews/:id', (req, res, next) => {
  const b = req.body || {}
  const ivId = num(req.params.id)
  try {
    const out = tx(() => {
      const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(ivId)
      if (!iv) return { notFound: true }
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(iv.application_id)
      if (!a) return { appNotFound: true }
      const sets = [], vals = []
      if (b.eval !== undefined) { sets.push('eval=?'); vals.push(String(b.eval)) }
      if (b.interviewer !== undefined) { sets.push('interviewer=?'); vals.push(String(b.interviewer)) }
      if (b.time !== undefined) { sets.push('time=?'); vals.push(String(b.time)) }
      if (sets.length) {
        vals.push(ivId)
        db.prepare(`UPDATE interviews SET ${sets.join(',')} WHERE id=?`).run(...vals)
      }

      const conclusion = ['pass', 'fail', 'pending'].includes(b.conclusion)
        ? b.conclusion
        : (['pass', 'fail', 'pending'].includes(b.result) ? b.result : null)
      if (conclusion) {
        const r = applyInterviewConclusion(iv, a, conclusion, { operator: b.operator })
        return { ok: true, ...r, conclusion }
      }
      return { ok: true, idempotent: false, conclusion: iv.conclusion || iv.result, version: num(a.version) }
    })
    if (out.notFound || out.appNotFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- Offer ----------------
const SALARY_MIN = 1000, SALARY_MAX = 1000000

// 发起 Offer 核心：必须处于 Offer 阶段（非终态，面试阶段发起会协同推进）；同一应聘同时只能有一个
// 进行中的 Offer；被撤回/拒绝的旧记录原地重新发起并留痕。供「发起端点」与「Offer 审批通过后的执行回写」共用
function issueOffer(a, { salary, due, note, operator, expectedVersion } = {}) {
  checkVersion(a, expectedVersion)
  if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能发起 Offer', 'terminal_locked')
  // 发起 Offer 前同样受面试结论约束
  if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) assertCanEnterOffer(a)
  const exist = offerOfApp(a.id)
  if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer，请勿重复发起', 'offer_duplicate')
  if (exist && (exist.status === 'accepted' || exist.status === 'joined')) {
    conflict('该候选人的 Offer 已被接受，不能重新发起', 'offer_accepted_locked')
  }
  salary = num(salary, 20000)
  if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
  const stamp = ts()
  operator = operator || a.recruiter || 'HR-Sandy'
  // 候选人还停留在面试阶段：发起即协同推进到 Offer（同事务写阶段事件+快照）
  if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) {
    moveStage(a, 'offer', { eventType: 'advance', operator, fromStage: a.stage })
  }
  let offerId
  if (exist) {
    // 复用被撤回/拒绝的旧记录：重新发起，保留薪资历史可追溯
    db.prepare('UPDATE offers SET salary=?, status=?, due=?, note=?, decided_at=?, decided_by=?, joined_at=? WHERE id=?')
      .run(salary, 'pending', due || stamp, note || '', '', '', '', exist.id)
    offerId = exist.id
    addOfferLog({ offerId, applicationId: a.id, changeType: 'reopen', of: exist, toStatus: 'pending', toSalary: salary, operator, note: note || '' })
  } else {
    const r = db.prepare('INSERT INTO offers(application_id,salary,status,due,note) VALUES(?,?,?,?,?)')
      .run(a.id, salary, 'pending', due || stamp, note || '')
    offerId = Number(r.lastInsertRowid)
    addOfferLog({
      offerId, applicationId: a.id, changeType: 'create',
      of: { status: '', salary: 0 }, toStatus: 'pending', toSalary: salary, operator, note: note || ''
    })
  }
  return { id: offerId, stage: a.stage, version: a.version }
}

app.post('/api/applications/:id/offer', (req, res, next) => {
  const b = req.body || {}
  const appId = num(req.params.id)
  try {
    const out = tx(() => {
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(appId)
      if (!a) return { notFound: true }
      const r = issueOffer(a, { salary: b.salary, due: b.due, note: b.note, operator: b.operator, expectedVersion: b.version })
      return { ok: true, ...r }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// Offer 变更统一入口：
//  - 字段更新 salary/due/note 仅允许 pending（避免接受后暗改薪酬）
//  - status 仅允许 pending→accepted/rejected/withdrawn、accepted→joined（终态/跳跃变更拒绝）
//  - 每次变更追加 offer_change_logs；接受/拒绝/入职与应用阶段、阶段事件同事务提交
app.post('/api/offers/:id', (req, res, next) => {
  const b = req.body || {}
  const offerId = num(req.params.id)
  try {
    const out = tx(() => {
      const of = db.prepare('SELECT * FROM offers WHERE id=?').get(offerId)
      if (!of) return { notFound: true }
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(of.application_id)
      if (!a) return { appNotFound: true }
      checkVersion(a, b.version)
      const operator = b.operator || a.recruiter || 'HR-Sandy'
      const stamp = ts()

      // ---- 字段变更（仅待回应可改，且写留痕）----
      if (b.salary !== undefined) {
        if (of.status !== 'pending') conflict('仅待回应的 Offer 可以调整薪资', 'offer_locked')
        const salary = num(b.salary, of.salary)
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        if (salary !== num(of.salary)) {
          db.prepare('UPDATE offers SET salary=? WHERE id=?').run(salary, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'update_salary', of, toStatus: of.status, toSalary: salary, operator, note: b.note || '' })
          of.salary = salary
        }
      }
      if (b.due !== undefined && String(b.due) !== String(of.due)) {
        if (of.status !== 'pending') conflict('仅待回应的 Offer 可以调整期限', 'offer_locked')
        db.prepare('UPDATE offers SET due=? WHERE id=?').run(String(b.due), offerId)
        addOfferLog({ offerId, applicationId: a.id, changeType: 'update_due', of, toStatus: of.status, toSalary: of.salary, operator })
      }
      if (b.note !== undefined && String(b.note) !== String(of.note)) {
        db.prepare('UPDATE offers SET note=? WHERE id=?').run(String(b.note), offerId)
      }

      // ---- 状态流转 ----
      let moved = null
      if (b.status && b.status !== of.status) {
        const s = b.status
        const allowed = {
          pending: ['accepted', 'rejected', 'withdrawn'],
          accepted: ['joined', 'withdrawn'],
          rejected: [], withdrawn: [], joined: []
        }[of.status] || []
        if (of.status === s) return { ok: true, idempotent: true, stage: a.stage, version: num(a.version) }
        if (!allowed.includes(s)) conflict(`Offer 不能从「${of.status}」变更为「${s}」，请按待回应→接受/拒绝→入职流转`, 'offer_transition')

        if (s === 'accepted') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=? WHERE id=?').run('accepted', stamp, operator, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'accept', of, toStatus: 'accepted', operator, note: b.note || '' })
          if (a.stage !== 'hired' && a.stage !== 'rejected') {
            // 接受 Offer 即进入「录用」阶段，固化当时评分证据
            moved = moveStage(a, 'hired', { eventType: 'offer_accepted', operator, fromStage: a.stage })
          }
        } else if (s === 'joined') {
          db.prepare('UPDATE offers SET status=?, joined_at=COALESCE(NULLIF(joined_at,\'\'),?), decided_at=? WHERE id=?')
            .run('joined', stamp, stamp, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'join', of: { ...of, status: 'accepted' }, toStatus: 'joined', operator, note: b.note || '' })
          if (a.stage !== 'hired') moved = moveStage(a, 'hired', { eventType: 'offer_accepted', operator, fromStage: a.stage })
        } else if (s === 'rejected') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=? WHERE id=?').run('rejected', stamp, operator, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'reject', of, toStatus: 'rejected', operator, note: b.note || '' })
          if (a.stage !== 'rejected') {
            const fromStage = a.stage
            moved = moveStage(a, 'rejected', { eventType: 'offer_rejected', operator, fromStage })
            db.prepare('UPDATE applications SET reject_from=? WHERE id=?').run(fromStage, a.id)
          }
        } else if (s === 'withdrawn') {
          db.prepare('UPDATE offers SET status=?, decided_at=?, decided_by=?, note=? WHERE id=?')
            .run('withdrawn', stamp, operator, b.note || of.note, offerId)
          addOfferLog({ offerId, applicationId: a.id, changeType: 'withdraw', of, toStatus: 'withdrawn', operator, note: b.note || '' })
          // 已接受/已入职后撤回：录用阶段同步回退到 Offer（单步回退，事件留痕）
          if (a.stage === 'hired') moved = moveStage(a, 'offer', { eventType: 'rollback', operator, fromStage: 'hired' })
        }
      }
      return { ok: true, status: b.status || of.status, stage: a.stage, version: num(a.version), moved: !!moved }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    if (out.appNotFound) return res.status(409).json({ ok: false, code: 'app_missing', msg: 'Offer 对应的应聘记录不存在' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 审批中心 ----------------
// 审批通过后的执行回写：按任务类型调用与直接操作完全相同的业务函数，
// 保证「审批生效」与「直接操作」走同一条状态机路径，阶段/面试/Offer 三处口径一致
function executeApprovalTask(task, actor) {
  const payload = parseJSON(task.payload, {})
  if (task.type === 'strategy_publish') {
    const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(num(payload.strategy_version_id))
    if (!v) badRequest('关联策略版本不存在', 'strategy_version_missing')
    if (v.status !== 'pending') conflict(`策略版本当前状态为「${v.status}」，不能重复执行`, 'strategy_not_pending')
    const at = new Date().toISOString()
    const scheduled = v.effective_start && at < v.effective_start
    if (scheduled) {
      db.prepare("UPDATE strategy_versions SET status='scheduled', approved_at=? WHERE id=?").run(ts(), v.id)
      return { desc: `策略 v${v.id} 已审批通过，将于 ${fmtWindow(v.effective_start)} 生效`, version: 1, deferred: true }
    }
    if (v.rollout_mode === 'canary') {
      const r = activateCanaryVersion(v, { triggeredBy: actor.name })
      return {
        desc: `策略 v${v.id} 已灰度生效：${r.canary}/${r.pairs} 名候选人命中，观察窗口至 ${fmtWindow(v.effective_end) || '长期'}`,
        version: 1, jobId: r.jobId
      }
    }
    const r = activateFullVersion(v, { triggeredBy: actor.name, triggerType: 'strategy_publish' })
    return { desc: `策略 v${v.id} 已全量生效，批次 #${r.jobId} 重算 ${r.pairs} 组匹配`, version: 1, jobId: r.jobId }
  }

  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(task.application_id)
  if (!a) badRequest('关联应聘记录不存在', 'app_missing')
  if (task.type === 'stage_advance') {
    const r = advanceApplication(a, { operator: actor.name, targetStage: payload.target_stage })
    return { desc: `已推进至「${STAGE_LABEL[r.stage]}」阶段`, version: r.version }
  }
  if (task.type === 'interview_conclusion') {
    const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(num(payload.interview_id))
    if (!iv || iv.application_id !== a.id) badRequest('关联面试记录不存在', 'interview_missing')
    applyInterviewConclusion(iv, a, payload.conclusion, { operator: actor.name })
    return { desc: `「${iv.round}」面试结论已生效：${payload.conclusion === 'pass' ? '通过' : '不通过'}`, version: a.version }
  }
  if (task.type === 'offer_issue') {
    issueOffer(a, { salary: payload.salary, due: payload.due, note: payload.note, operator: actor.name })
    return { desc: `Offer 已发放（月薪 ¥${num(payload.salary).toLocaleString()}，待候选人回应）`, version: a.version }
  }
  badRequest('未知审批类型', 'unknown_task_type')
}

// 提交审批申请：校验发起角色权限 + 业务前置，固化审批链后通知第一级审批人
app.post('/api/approvals', (req, res, next) => {
  const user = currentUser(req)
  const b = req.body || {}
  const type = String(b.type || '')
  const meta = TASK_TYPES[type]
  try {
    const out = tx(() => {
      if (!meta) badRequest('未知审批类型', 'unknown_task_type')
      if (type === 'strategy_publish') badRequest('策略发布请使用 /api/positions/:id/strategy 专用入口', 'use_strategy_endpoint')
      if (user.role !== meta.submitRole) {
        forbidden(`「${meta.label}」申请需由${ROLE_LABEL[meta.submitRole]}发起，当前身份为「${ROLE_LABEL[user.role]}」`, 'role_not_allowed')
      }
      const a = db.prepare('SELECT * FROM applications WHERE id=?').get(num(b.application_id))
      if (!a) return { notFound: true }
      // 同一应聘同一类型只允许一个进行中的审批，防止重复申请
      const dup = db.prepare("SELECT id FROM approval_tasks WHERE application_id=? AND type=? AND status='pending'").get(a.id, type)
      if (dup) conflict(`该候选人已有进行中的「${meta.label}」审批（#${dup.id}），请勿重复提交`, 'task_duplicate')

      // 按类型构造并校验申请内容（提交时预校验业务约束，终审执行时再严格复核）
      const payload = {}
      let interviewId = 0
      let summary = ''
      if (type === 'stage_advance') {
        const target = String(b.payload?.target_stage || '')
        if (a.stage === 'rejected') conflict('候选人已淘汰，请先复活后再提请推进', 'rejected_locked')
        if (NEXT_STAGE[a.stage] !== target) badRequest(`目标阶段应为「${STAGE_LABEL[NEXT_STAGE[a.stage]] || '无'}」`, 'target_mismatch')
        // 提交时同样校验进入 Offer 的面试结论/缺席责任闸门，避免必失败的任务进入审批链
        if (target === 'offer') assertCanEnterOffer(a)
        payload.target_stage = target
        payload.from_stage = a.stage
        summary = `推进「${STAGE_LABEL[a.stage]} → ${STAGE_LABEL[target]}」`
      } else if (type === 'interview_conclusion') {
        const iv = db.prepare('SELECT * FROM interviews WHERE id=?').get(num(b.payload?.interview_id))
        if (!iv || iv.application_id !== a.id) badRequest('面试记录不存在或不属于该应聘', 'interview_missing')
        const conclusion = String(b.payload?.conclusion || '')
        if (!['pass', 'fail'].includes(conclusion)) badRequest('仅「通过/不通过」结论需要审批；「待定」可直接保存', 'conclusion_invalid')
        const current = iv.conclusion || iv.result || 'pending'
        if (current === conclusion) conflict('该结论已生效，无需重复审批', 'conclusion_same')
        payload.interview_id = iv.id
        payload.conclusion = conclusion
        payload.round = iv.round
        interviewId = iv.id
        summary = `「${iv.round}」结论：${conclusion === 'pass' ? '✅ 通过' : '❌ 不通过'}`
      } else if (type === 'offer_issue') {
        if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态，不能发起 Offer 审批', 'terminal_locked')
        const exist = offerOfApp(a.id)
        if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer', 'offer_duplicate')
        if (exist && (exist.status === 'accepted' || exist.status === 'joined')) conflict('该候选人的 Offer 已被接受', 'offer_accepted_locked')
        const salary = num(b.payload?.salary, 0)
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        // 提交时预校验面试结论门槛，终审执行时还会复核
        if (STAGES.indexOf(a.stage) < STAGES.indexOf('offer')) assertCanEnterOffer(a)
        payload.salary = salary
        payload.due = String(b.payload?.due || '')
        payload.note = String(b.payload?.note || '')
        summary = `月薪 ¥${salary.toLocaleString()}`
      }

      const chain = buildChain(type, payload, a)
      // 首节点进入待审，固化其 SLA 截止时间快照
      if (chain[0]) stampNodeDue(chain[0])
      const cand = db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
      const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(a.position_id)
      const r = db.prepare(`INSERT INTO approval_tasks(type,application_id,interview_id,payload,chain,current_step,status,submitted_by,submitted_by_name,submitted_role,submitted_at,version)
                            VALUES(?,?,?,?,?,0,'pending',?,?,?,?,1)`)
        .run(type, a.id, interviewId, JSON.stringify(payload), JSON.stringify(chain), user.id, user.name, user.role, ts())
      const taskId = Number(r.lastInsertRowid)
      addStep(taskId, { stepNo: -1, role: user.role, action: 'submit', actor: user, note: summary })
      notifyStepAudience({ id: taskId, application_id: a.id, type }, chain[0], {
        type: 'task_submitted',
        title: `新的${meta.label}审批待处理`,
        body: `${user.name} 提交「${cand?.name || ''} · ${pos?.name || ''}」：${summary}`
      })
      return { ok: true, id: taskId, chain }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 审批决定：approve 逐级通过（终审在同一事务内执行回写）/ return 退回申请人（可修改后重提）
app.post('/api/approvals/:id/decide', (req, res, next) => {
  const user = currentUser(req)
  const b = req.body || {}
  const taskId = num(req.params.id)
  try {
    const out = tx(() => {
      const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(taskId)
      if (!t) return { notFound: true }
      checkVersion(t, b.version)
      if (t.status !== 'pending') conflict('该任务已被处理，请刷新查看最新状态', 'task_closed')
      const chain = parseJSON(t.chain, [])
      const step = chain[t.current_step]
      if (!step) conflict('审批链数据异常', 'chain_broken')
      // 权限实时解析：本人直接审批 或 持有该节点角色的有效委托；委托撤销/到期后即使页面过期也被拒绝
      const authority = resolveStepAuthority(t, step, user)
      if (!authority) {
        forbidden(`当前节点需「${ROLE_LABEL[step.role]}」或其有效委托人审批，您当前身份「${ROLE_LABEL[user.role] || user.role}」无审批权`, 'role_not_allowed')
      }
      const viaLabel = authority.via === 'delegate'
        ? `（代理${ROLE_LABEL[step.role]} · 委托人 ${authority.delegation.delegator_name}）`
        : ''
      const meta = TASK_TYPES[t.type]
      const note = String(b.note || '')
      const payloadNow = parseJSON(t.payload, {})
      const a = t.type === 'strategy_publish' ? null : db.prepare('SELECT * FROM applications WHERE id=?').get(t.application_id)
      const cand = a && db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
      const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(a ? a.position_id : num(payloadNow.position_id))
      const who = a ? `${cand?.name || ''} · ${pos?.name || ''}` : (pos ? `${pos.name} 策略` : `策略 #${t.id}`)

      if (b.action === 'return') {
        if (!note.trim()) badRequest('退回必须填写退回意见', 'note_required')
        db.prepare("UPDATE approval_tasks SET status='returned', decided_at=?, decide_note=?, version=version+1 WHERE id=?")
          .run(ts(), note, taskId)
        if (t.type === 'strategy_publish') {
          db.prepare("UPDATE strategy_versions SET status='returned' WHERE id=? AND status='pending'")
            .run(num(payloadNow.strategy_version_id))
        }
        markActionableRead(taskId, step)
        addStep(taskId, {
          stepNo: t.current_step, role: user.role, action: 'return', actor: user,
          note: `${note}${viaLabel ? ' ' + viaLabel : ''}`,
          via: authority.via, delegationId: authority.delegation?.id || 0
        })
        notify({
          recipientRole: t.submitted_role, type: 'task_returned',
          title: `${meta.label}审批被退回`,
          body: `${user.name}${viaLabel} 退回「${who}」：${note}`,
          taskId, appId: t.application_id
        })
        return { ok: true, status: 'returned' }
      }
      if (b.action !== 'approve') badRequest('未知审批动作', 'unknown_action')

      addStep(taskId, {
        stepNo: t.current_step, role: user.role, action: 'approve', actor: user,
        note: note ? `${note}${viaLabel ? ' ' + viaLabel : ''}` : viaLabel.trim(),
        via: authority.via, delegationId: authority.delegation?.id || 0
      })
      if (t.current_step + 1 < chain.length) {
        // 中间级通过：流转下一节点并通知下一审批人（含其有效代理人）；旧节点待办同事务归并已读
        markActionableRead(taskId, step)
        const nextStep = chain[t.current_step + 1]
        stampNodeDue(nextStep)
        db.prepare('UPDATE approval_tasks SET current_step=current_step+1, chain=?, version=version+1 WHERE id=?')
          .run(JSON.stringify(chain), taskId)
        notifyStepAudience(t, nextStep, {
          type: 'task_submitted',
          title: `${meta.label}审批流转至您`,
          body: `「${who}」已由 ${user.name}${viaLabel} 初审通过，待您终审`
        })
        return { ok: true, status: 'pending', next: nextStep.role }
      }

      // 终审通过：SAVEPOINT 内执行回写；业务状态漂移导致失败时仅回滚执行段，任务标记 failed 并通知申请人
      // 终审节点的待办通知先在同事务归并，保证无论执行成功/失败铃铛都不残留
      markActionableRead(taskId, step)
      db.exec('SAVEPOINT task_exec')
      let execDesc = '', execErr = null
      try {
        const r = executeApprovalTask(t, user)
        execDesc = r.desc
        db.exec('RELEASE task_exec')
      } catch (e) {
        db.exec('ROLLBACK TO task_exec')
        db.exec('RELEASE task_exec')
        if (!(e instanceof ApiError)) throw e
        execErr = e
      }
      const stamp = ts()
      if (execErr) {
        db.prepare("UPDATE approval_tasks SET status='failed', decided_at=?, decide_note=?, result_note=?, version=version+1 WHERE id=?")
          .run(stamp, note, execErr.message, taskId)
        if (t.type === 'strategy_publish') {
          db.prepare("UPDATE strategy_versions SET status='failed' WHERE id=? AND status='pending'")
            .run(num(payloadNow.strategy_version_id))
        }
        addStep(taskId, {
          stepNo: t.current_step, role: user.role, action: 'failed', actor: user,
          note: `审批通过但执行失败：${execErr.message}${viaLabel ? ' ' + viaLabel : ''}`,
          via: authority.via, delegationId: authority.delegation?.id || 0
        })
        // 危机事件关联的应聘：审批回写失败也是关键处置事件，上链留痕
        auditPassive({
          category: 'decision', action: 'approval.failed', actor: user, applicationId: t.application_id,
          refType: 'approval', refId: taskId,
          summary: `${meta.label}审批通过但执行回写失败：${execErr.message}`,
          detail: { task_id: taskId, type: t.type, error_code: execErr.code, error: execErr.message }
        })
        notify({
          recipientRole: t.submitted_role, type: 'task_failed',
          title: `${meta.label}审批执行失败`,
          body: `「${who}」审批已通过，但回写失败：${execErr.message}`,
          taskId, appId: t.application_id
        })
        return { ok: true, status: 'failed', msg: execErr.message }
      }
      db.prepare("UPDATE approval_tasks SET status='approved', decided_at=?, decide_note=?, result_note=?, version=version+1 WHERE id=?")
        .run(stamp, note, execDesc, taskId)
      addStep(taskId, {
        stepNo: t.current_step, role: user.role, action: 'execute', actor: user,
        note: `${execDesc}${viaLabel ? ' ' + viaLabel : ''}`,
        via: authority.via, delegationId: authority.delegation?.id || 0
      })
      auditPassive({
        category: 'decision', action: 'approval.execute', actor: user, applicationId: t.application_id,
        refType: 'approval', refId: taskId,
        summary: `${meta.label}终审通过并执行回写：${execDesc}`,
        detail: { task_id: taskId, type: t.type, payload: parseJSON(t.payload, {}), result: execDesc }
      })
      notify({
        recipientRole: t.submitted_role, type: 'task_executed',
        title: `${meta.label}审批通过已生效`,
        body: `「${who}」${execDesc}（终审：${user.name}）`,
        taskId, appId: t.application_id
      })
      return { ok: true, status: 'approved', desc: execDesc }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 退回后修改重提：整体替换申请内容并按新内容重建审批链（如薪资变化影响加签），从第一级重新审批
app.post('/api/approvals/:id/resubmit', (req, res, next) => {
  const user = currentUser(req)
  const b = req.body || {}
  const taskId = num(req.params.id)
  try {
    const out = tx(() => {
      const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(taskId)
      if (!t) return { notFound: true }
      if (t.status !== 'returned') conflict('仅被退回的任务可以修改后重新提交', 'task_not_returned')
      if (t.submitted_by !== user.id) forbidden('仅原申请人可以重新提交该任务', 'not_submitter')
      const a = t.type === 'strategy_publish' ? null : db.prepare('SELECT * FROM applications WHERE id=?').get(t.application_id)
      if (!a && t.type !== 'strategy_publish') return { notFound: true }
      const meta = TASK_TYPES[t.type]
      const payload = { ...parseJSON(t.payload, {}) }
      let summary = ''
      if (t.type === 'strategy_publish') {
        const next = parseStrategyPayload({
          weights: b.payload?.weights ?? payload.weights,
          keyword_cap: b.payload?.keyword_cap ?? payload.keyword_cap,
          rollout_mode: b.payload?.rollout_mode ?? payload.rollout_mode,
          canary_percent: b.payload?.canary_percent ?? payload.canary_percent,
          canary_candidate_ids: b.payload?.canary_candidate_ids ?? payload.canary_candidate_ids,
          effective_start: b.payload?.effective_start ?? payload.effective_start,
          effective_end: b.payload?.effective_end ?? payload.effective_end,
          change_note: b.payload?.change_note ?? payload.change_note,
          reset: b.payload?.reset,
          allow_indefinite: true
        })
        Object.assign(payload, next)
        const v = db.prepare('SELECT * FROM strategy_versions WHERE id=?').get(num(payload.strategy_version_id))
        if (!v || v.position_id !== num(payload.position_id)) return { notFound: true }
        const otherPending = db.prepare("SELECT id,status FROM strategy_versions WHERE position_id=? AND status IN ('pending','returned','scheduled') AND id<>? ORDER BY id DESC LIMIT 1")
          .get(v.position_id, v.id)
        if (otherPending) conflict(`该职位已有${otherPending.status === 'returned' ? '退回' : otherPending.status === 'scheduled' ? '待生效' : '待审批'}策略 v${otherPending.id}，请先处理后再重提`, 'strategy_pending_exists')
        const activeCanary = db.prepare("SELECT id FROM strategy_versions WHERE position_id=? AND status='canary' AND id<>?")
          .get(v.position_id, v.id)
        if (activeCanary) conflict(`该职位存在灰度策略 v${activeCanary.id}，请先全量或回滚`, 'strategy_canary_exists')
        db.prepare(`UPDATE strategy_versions
                    SET weights=?,keyword_cap=?,rollout_mode=?,canary_percent=?,canary_candidate_ids=?,
                        effective_start=?,effective_end=?,change_note=?,status='pending'
                    WHERE id=?`)
          .run(JSON.stringify(next.weights), next.keywordCap, next.rolloutMode, next.canaryPercent,
            JSON.stringify(next.canaryIds), next.effectiveStart, next.effectiveEnd, next.changeNote, v.id)
        summary = `策略改为${next.rolloutMode === 'canary' ? `灰度 ${next.canaryIds.length || next.canaryPercent + '%'}` : '全量'}发布`
      } else if (t.type === 'offer_issue') {
        const salary = num(b.payload?.salary, num(payload.salary))
        if (salary < SALARY_MIN || salary > SALARY_MAX) badRequest(`Offer 月薪需在 ${SALARY_MIN}~${SALARY_MAX} 之间`, 'salary_range')
        payload.salary = salary
        if (b.payload?.due !== undefined) payload.due = String(b.payload.due)
        if (b.payload?.note !== undefined) payload.note = String(b.payload.note)
        if (a.stage === 'rejected' || a.stage === 'hired') conflict('该候选人流程已终态', 'terminal_locked')
        const exist = offerOfApp(a.id)
        if (exist && exist.status === 'pending') conflict('该候选人已有待回应的 Offer', 'offer_duplicate')
        summary = `月薪调整为 ¥${salary.toLocaleString()}`
      } else if (t.type === 'interview_conclusion') {
        const conclusion = String(b.payload?.conclusion || payload.conclusion)
        if (!['pass', 'fail'].includes(conclusion)) badRequest('结论仅支持通过/不通过', 'conclusion_invalid')
        payload.conclusion = conclusion
        summary = `结论改为：${conclusion === 'pass' ? '✅ 通过' : '❌ 不通过'}`
      } else if (t.type === 'stage_advance') {
        // 目标阶段不可改（由当前流程决定）；若流程已漂移，该申请失效，应撤销后重新发起
        if (NEXT_STAGE[a.stage] !== payload.target_stage) {
          badRequest(`流程阶段已变化（当前「${STAGE_LABEL[a.stage]}」），该申请已失效，请撤销后重新发起`, 'stage_mismatch')
        }
        summary = '重新提交推进申请'
      }
      const chain = buildChain(t.type, payload, a)
      if (chain[0]) stampNodeDue(chain[0])
      // 重提重建审批链：旧链上各节点的未读待办全部归并，避免红点残留到已失效节点
      markActionableRead(taskId)
      db.prepare("UPDATE approval_tasks SET payload=?, chain=?, current_step=0, status='pending', submitted_at=?, decided_at='', decide_note='', result_note='', version=version+1 WHERE id=?")
        .run(JSON.stringify(payload), JSON.stringify(chain), ts(), taskId)
      addStep(taskId, { stepNo: -1, role: user.role, action: 'resubmit', actor: user, note: summary })
      const cand = a && db.prepare('SELECT name FROM candidates WHERE id=?').get(a.candidate_id)
      const pos = db.prepare('SELECT name FROM positions WHERE id=?').get(a ? a.position_id : num(payload.position_id))
      const targetName = a ? `${cand?.name || ''} · ${pos?.name || ''}` : `${pos?.name || ''} 策略 v${payload.strategy_version_id}`
      notifyStepAudience(t, chain[0], {
        type: 'task_resubmitted',
        title: `${meta.label}申请已修改重提`,
        body: `${user.name} 重新提交「${targetName}」：${summary}`
      })
      return { ok: true, status: 'pending', chain }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// 撤销申请：进行中/已退回的任务可由申请人撤销，撤销后释放「同类型唯一进行中」名额
app.post('/api/approvals/:id/cancel', (req, res, next) => {
  const user = currentUser(req)
  const taskId = num(req.params.id)
  try {
    const out = tx(() => {
      const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(taskId)
      if (!t) return { notFound: true }
      if (t.status !== 'pending' && t.status !== 'returned') conflict('该任务已结案，无法撤销', 'task_closed')
      if (t.submitted_by !== user.id) forbidden('仅原申请人可以撤销该任务', 'not_submitter')
      db.prepare("UPDATE approval_tasks SET status='cancelled', decided_at=?, version=version+1 WHERE id=?").run(ts(), taskId)
      if (t.type === 'strategy_publish') {
        const payload = parseJSON(t.payload, {})
        db.prepare("UPDATE strategy_versions SET status='cancelled' WHERE id=? AND status IN ('pending','returned')")
          .run(num(payload.strategy_version_id))
      }
      addStep(taskId, { stepNo: -1, role: user.role, action: 'cancel', actor: user, note: String(req.body?.note || '') })
      if (t.status === 'pending') {
        const chain = parseJSON(t.chain, [])
        const step = chain[t.current_step] || null
        const meta = TASK_TYPES[t.type]
        const payload = parseJSON(t.payload, {})
        // 当前节点受众（角色桶+代理人）的未读待办同事务归并，撤销后铃铛/红点立即清空
        markActionableRead(taskId, step)
        if (step) {
          notifyStepAudience(t, step, {
            type: 'task_cancelled',
            title: `${meta?.label || '审批'}申请已撤销`,
            body: `${user.name} 撤销了「${meta?.label || ''}」申请 #${taskId}${payload.strategy_version_id ? `（v${payload.strategy_version_id}）` : ''}`
          })
        }
      }
      return { ok: true, status: 'cancelled' }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 按角色审批委托 ----------------
// 把当前身份的某节点角色审批权委托给代理人（可限定审批类型/应聘范围/到期时间）。
// 授权同事务：① 给匹配的在途任务追加 delegate 留痕；② 给代理人投递个人待办；③ 事后可撤销/自动到期。
app.post('/api/delegations', (req, res, next) => {
  const user = currentUser(req)
  const b = req.body || {}
  try {
    const out = tx(() => {
      const role = String(b.role || '')
      if (!ROLE_LABEL[role]) badRequest('委托的审批角色不存在', 'delegation_role_invalid')
      if (user.role !== role) forbidden(`只能委托本人角色「${ROLE_LABEL[user.role]}」的审批权，不能代他人委托`, 'delegation_not_owner')
      const delegateeId = String(b.delegatee_id || '')
      const delegatee = db.prepare('SELECT * FROM users WHERE id=?').get(delegateeId)
      if (!delegatee) badRequest('代理人不存在', 'delegatee_missing')
      if (delegateeId === user.id) badRequest('不能委托给自己', 'delegation_self')
      const types = Array.isArray(b.task_types)
        ? [...new Set(b.task_types.filter(t => DELEGATABLE_TYPES.includes(t)))]
        : []
      if (!types.length) badRequest('请至少选择一种可委托的审批类型（推进/面试结论/Offer 发放）', 'delegation_types_required')
      const scope = b.scope === 'applications' ? 'applications' : 'all'
      const appIds = scope === 'applications' && Array.isArray(b.application_ids)
        ? [...new Set(b.application_ids.map(num).filter(Boolean))]
        : []
      if (scope === 'applications' && !appIds.length) badRequest('指定应聘范围时必须选择应聘记录', 'delegation_scope_empty')
      const note = String(b.note || '').trim()
      if (!note) badRequest('委托必须填写事由（审计留痕）', 'delegation_note_required')
      const expiresAt = windowInput(b.expires_at)
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) badRequest('到期时间必须晚于当前时间', 'delegation_expires_past')
      // 同一委托人→代理人→角色 已存在有效委托时拒绝重复创建（撤销后可重建）
      const dup = db.prepare("SELECT id FROM approval_delegations WHERE delegator_id=? AND delegatee_id=? AND role=? AND status='active'").get(user.id, delegateeId, role)
      if (dup) conflict('该代理人已持有此角色的有效委托，请勿重复创建', 'delegation_duplicate')
      const stamp = ts()
      const r = db.prepare(`INSERT INTO approval_delegations
          (delegator_id,delegator_name,delegatee_id,delegatee_name,role,task_types,scope,application_ids,note,status,expires_at,created_at)
          VALUES(?,?,?,?,?,?,?,?,?, 'active',?,?)`)
        .run(user.id, user.name, delegateeId, delegatee.name, role, JSON.stringify(types), scope, JSON.stringify(appIds), note, expiresAt, stamp)
      const delegationId = Number(r.lastInsertRowid)

      // 在匹配的进行中任务上补留痕，并给代理人投递个人待办（角色桶原通知保留，无需重复发）
      let taskCount = 0
      const pending = db.prepare("SELECT * FROM approval_tasks WHERE status='pending' ORDER BY id").all()
      pending.forEach(t => {
        if (!types.includes(t.type)) return
        if (scope === 'applications' && !appIds.includes(num(t.application_id))) return
        const chain = parseJSON(t.chain, [])
        const step = chain[t.current_step]
        if (!step || step.role !== role) return
        taskCount++
        addStep(t.id, {
          stepNo: num(t.current_step), role, action: 'delegate', actor: user,
          note: `委托给 ${delegatee.name} 代为审批：${note}${expiresAt ? `（有效期至 ${fmtWindow(expiresAt)}）` : ''}`
        })
        const delegateeRole = db.prepare('SELECT role FROM users WHERE id=?').get(delegateeId)
        if (delegateeRole?.role !== role) {
          notify({
            recipientRole: role, recipientId: delegateeId, delegationId, type: 'task_submitted',
            title: '【代理审批】您收到新的代理审批任务',
            body: `${user.name} 将「${TASK_TYPES[t.type]?.label || t.type}」#${t.id} 的${ROLE_LABEL[role]}节点委托给您：${note}`,
            taskId: t.id, appId: num(t.application_id)
          })
        }
      })
      return { ok: true, id: delegationId, task_count: taskCount }
    })
    res.json(out)
  } catch (e) { next(e) }
})

// 撤销委托：进行中任务的代理权限立即失效；代理人个人未读待办同事务归并已读，并补 delegate_revoke 留痕
app.post('/api/delegations/:id/revoke', (req, res, next) => {
  const user = currentUser(req)
  const delegationId = num(req.params.id)
  const note = String(req.body?.note || '').trim()
  try {
    const out = tx(() => {
      const d = db.prepare('SELECT * FROM approval_delegations WHERE id=?').get(delegationId)
      if (!d) return { notFound: true }
      if (d.status !== 'active') conflict('该委托已失效，无需重复撤销', 'delegation_closed')
      if (d.delegator_id !== user.id) forbidden('仅委托人本人可以撤销该委托', 'delegation_not_owner')
      const stamp = ts()
      db.prepare("UPDATE approval_delegations SET status='revoked', revoked_at=?, revoke_note=? WHERE id=?")
        .run(stamp, note, delegationId)
      const types = parseJSON(d.task_types, [])
      const appIds = parseJSON(d.application_ids, []).map(x => num(x))
      // 仍停留在被代理节点的进行中任务：追加撤销留痕
      const pending = db.prepare("SELECT * FROM approval_tasks WHERE status='pending' ORDER BY id").all()
      let taskCount = 0
      pending.forEach(t => {
        if (!types.includes(t.type)) return
        if (d.scope === 'applications' && !appIds.includes(num(t.application_id))) return
        const chain = parseJSON(t.chain, [])
        const step = chain[t.current_step]
        if (!step || step.role !== d.role) return
        taskCount++
        addStep(t.id, {
          stepNo: num(t.current_step), role: d.role, action: 'delegate_revoke', actor: user,
          note: `撤销对 ${d.delegatee_name} 的审批委托${note ? `：${note}` : ''}`
        })
      })
      const readCount = markDelegateTodosRead(delegationId)
      return { ok: true, task_count: taskCount, notifications_read: readCount }
    })
    if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 超时升级规则配置（仅招聘负责人） ----------------
app.post('/api/escalation-rules', (req, res, next) => {
  const user = currentUser(req)
  const rows = Array.isArray(req.body?.rules) ? req.body.rules : null
  try {
    const out = tx(() => {
      if (user.role !== 'recruiter') forbidden('仅招聘负责人可配置审批超时升级规则', 'role_not_allowed')
      if (!rows) badRequest('规则列表不能为空', 'rules_required')
      const stamp = ts()
      const saved = []
      rows.forEach(row => {
        const type = String(row.task_type || '')
        const role = String(row.role || '')
        if (!DELEGATABLE_TYPES.includes(type) || !ROLE_LABEL[role]) return
        const hours = Math.round(num(row.timeout_hours, 0) * 10) / 10
        const target = String(row.escalate_to || '')
        const enabled = row.enabled === false ? 0 : 1
        if (enabled) {
          if (!(hours > 0)) badRequest('超时时限必须大于 0 小时', 'escalation_timeout_invalid')
          if (!ROLE_LABEL[target]) badRequest('升级目标角色不存在', 'escalation_target_invalid')
          if (target === role) badRequest('升级目标不能与当前节点角色相同（防升级环）', 'escalation_loop')
        }
        db.prepare(`INSERT INTO approval_escalation_rules(task_type,role,timeout_hours,escalate_to,enabled,updated_by,updated_at)
                    VALUES(?,?,?,?,?,?,?)
                    ON CONFLICT(task_type,role) DO UPDATE SET
                      timeout_hours=excluded.timeout_hours,escalate_to=excluded.escalate_to,
                      enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .run(type, role, hours, target, enabled, user.name, stamp)
        saved.push({ task_type: type, role, timeout_hours: hours, escalate_to: target, enabled: !!enabled })
      })
      if (!saved.length) badRequest('没有可保存的有效规则', 'rules_empty')
      return { ok: true, saved }
    })
    res.json(out)
  } catch (e) { next(e) }
})

// ---------------- 超时升级扫描（幂等） ----------------
// 委托到期先失效；再对超过当前节点 SLA deadline 的 pending 任务在链尾追加升级节点（原节点保留）。
// 每个任务独立 BEGIN IMMEDIATE 事务 + 状态/截止时间二次检查，并发/重复 sweep 不会重复升级；
// 审批链快照原样保留，升级动作、状态指针、通知在同一事务内提交。
function expireDelegations(atMs = Date.now()) {
  const rows = db.prepare("SELECT * FROM approval_delegations WHERE status='active' AND expires_at!=''").all()
  let n = 0
  rows.forEach(d => {
    const exp = new Date(d.expires_at).getTime()
    if (Number.isFinite(exp) && exp <= atMs) {
      db.prepare("UPDATE approval_delegations SET status='expired' WHERE id=? AND status='active'").run(d.id)
      markDelegateTodosRead(d.id)
      n++
    }
  })
  return n
}

function escalateDueTasks(at = new Date().toISOString(), atLocale = ts()) {
  const due = db.prepare("SELECT id FROM approval_tasks WHERE status='pending' ORDER BY id").all()
  const out = []
  due.forEach(({ id }) => {
    tx(() => {
      // 委托到期在每个升级事务内顺带处理，保证并发扫描下到期代理立即失权
      expireDelegations(Date.now())
      const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(id)
      if (!t || t.status !== 'pending') return
      const chain = parseJSON(t.chain, [])
      const idx = num(t.current_step)
      const step = chain[idx]
      if (!step || !step.sla || step.escalated_at) return
      // 兼容旧任务：节点从未进入计时则补打 deadline，不立即升级
      if (!step.due_at) { stampNodeDue(step); db.prepare('UPDATE approval_tasks SET chain=? WHERE id=?').run(JSON.stringify(chain), t.id); return }
      if (step.due_at > atLocale) return
      const targetRole = String(step.sla.escalate_to || '')
      if (!ROLE_LABEL[targetRole]) return
      // 防升级环：目标角色已存在于链上（审批中或曾升级）则不再追加，避免无限升级
      if (chain.some(n => n.role === targetRole)) return
      const meta = TASK_TYPES[t.type]
      const overdueH = step.sla.timeout_hours
      // 旧节点标记已升级（阻断对该节点重复升级，原节点与 SLA 快照完整保留）；新节点从链尾继续计时
      step.escalated_at = atLocale
      step.escalated_to = targetRole
      const newNode = stampNodeDue({
        role: targetRole,
        reason: `超时升级：${ROLE_LABEL[step.role]}超过 ${overdueH}h 未处理`,
        escalated_from: step.role,
        escalated_node_at: atLocale,
        due_at_origin: step.due_at
      })
      // 新节点继续适用目标角色自己的 SLA 规则（取当前生效规则快照；无规则则不再继续升级）
      const nextSla = ruleSlaSnapshot(t.type, targetRole)
      if (nextSla) newNode.sla = nextSla
      // 旧节点待办（角色桶+代理人）在升级瞬间归并，防止红点残留
      markActionableRead(t.id, step)
      chain.push(newNode)
      db.prepare('UPDATE approval_tasks SET chain=?, current_step=?, version=version+1 WHERE id=?')
        .run(JSON.stringify(chain), chain.length - 1, t.id)
      addStep(t.id, {
        stepNo: chain.length - 1, role: targetRole, action: 'escalate', actor: { id: 'system', name: '系统超时守护' },
        note: `${ROLE_LABEL[step.role]}节点超过 SLA ${overdueH}h（截止 ${step.due_at}）未审批，自动升级至${ROLE_LABEL[targetRole]}`
      })
      notifyStepAudience(t, newNode, {
        type: 'task_escalated',
        title: `⏰ ${meta?.label || '审批'}超时升级待处理`,
        body: `任务 #${t.id} 的${ROLE_LABEL[step.role]}节点已超时，升级到您处理（原截止 ${step.due_at}）`
      })
      out.push({ task_id: t.id, type: t.type, from: step.role, to: targetRole, due: step.due_at })
    })
  })
  return out
}

app.get('/api/approvals/sweep', (req, res) => {
  const expired = tx(() => expireDelegations(Date.now()))
  const escalated = escalateDueTasks()
  res.json({ ok: true, delegations_expired: expired, escalated, count: escalated.length })
})

// 通知已读：默认把当前身份角色桶 + 本人个人收件箱（代理/升级待办）的未读全部标记；也可传 ids 精准标记
app.post('/api/notifications/read', (req, res) => {
  const user = currentUser(req)
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(num).filter(Boolean) : []
  if (ids.length) {
    const marks = ids.map(() => '?').join(',')
    db.prepare(`UPDATE notifications SET is_read=1 WHERE (recipient_role=? OR recipient_id=?) AND id IN (${marks})`)
      .run(user.role, user.id, ...ids)
  } else {
    db.prepare('UPDATE notifications SET is_read=1 WHERE is_read=0 AND (recipient_role=? OR recipient_id=?)')
      .run(user.role, user.id)
  }
  res.json({ ok: true })
})

// ---------------- 渠道 ----------------
app.post('/api/channels', (req, res) => {
  const b = req.body || {}
  db.prepare('INSERT INTO channels(name,cost) VALUES(?,?)').run(b.name, num(b.cost, 5000))
  res.json({ ok: true })
})

// 启动迁移：旧库中已有的 matches/applications 归入一个 startup 批次，并补齐投递快照与阶段事件
function migrateHistory() {
  const hadStartupJob = db.prepare("SELECT COUNT(*) c FROM recalc_jobs WHERE trigger_type='startup'").get().c > 0
  const pairRows = db.prepare(`
    SELECT candidate_id, position_id FROM matches
    UNION SELECT candidate_id, position_id FROM applications
  `).all()
  const appsNeedBackfill = db.prepare(`
    SELECT a.* FROM applications a
    WHERE (a.match_snapshot IS NULL OR a.match_snapshot='')
       OR NOT EXISTS (SELECT 1 FROM application_events e WHERE e.application_id=a.id)
  `).all()

  if (!pairRows.length || (hadStartupJob && !appsNeedBackfill.length)) return

  tx(() => {
    let jobId = 0
    const latestStartupJob = hadStartupJob
      ? num(db.prepare("SELECT MAX(id) id FROM recalc_jobs WHERE trigger_type='startup'").get().id || 0)
      : 0
    if (pairRows.length && !hadStartupJob) {
      jobId = createRecalcJob({ triggerType: 'startup', scope: 'startup', triggeredBy: 'system-migration' })
      pairRows.forEach(r => upsertMatch(r.candidate_id, r.position_id, jobId))
      completeRecalcJob(jobId, pairRows.length, 0, pairRows.length)
    } else {
      jobId = latestStartupJob
    }

    appsNeedBackfill.forEach(a => {
      let snap = parseJSON(a.match_snapshot, null)
      const latest = resultFromStored(getStoredMatch(a.candidate_id, a.position_id))
      const item = latestJobForPair(a.candidate_id, a.position_id)
      if (!snap) {
        snap = buildSnapshot(a.candidate_id, a.position_id, latest || {
          score: 0, dims: [], reason: '暂无已发布评分', weakness: '暂无评分依据'
        }, {
          stage: 'submitted', stage_label: '投递', event_type: 'advance',
          recalc_job_id: item?.job_id || jobId, backfilled: true
        })
        db.prepare('UPDATE applications SET match_snapshot=?, matched_at=? WHERE id=?')
          .run(JSON.stringify(snap), snap.matched_at, a.id)
      }

      const eventExists = stage => db.prepare('SELECT id FROM application_events WHERE application_id=? AND stage=?').get(a.id, stage)
      const insertRawEvent = (stage, eventType, fromStage, payload) => {
        const enriched = {
          ...payload,
          stage,
          stage_label: { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }[stage] || stage,
          event_type: eventType,
          event_at: payload.event_at || payload.matched_at || ts(),
          backfilled: true
        }
        db.prepare(`INSERT INTO application_events(application_id,stage,from_stage,event_type,event_at,operator,score_snapshot,match_score,strategy_id,recalc_job_id,backfilled)
                    VALUES(?,?,?,?,?,?,?,?,?,?,1)`)
          .run(a.id, stage, fromStage, eventType, enriched.event_at, a.recruiter || 'system-migration',
            JSON.stringify(enriched), num(enriched.score), num(enriched.strategy_id),
            num(enriched.recalc_job_id || item?.job_id || jobId))
      }

      if (!eventExists('submitted')) insertRawEvent('submitted', 'advance', '', snap)
      if (a.stage !== 'submitted' && !eventExists(a.stage)) {
        const order = ['submitted', 'screening', 'interview', 'offer', 'hired']
        const currentIndex = order.indexOf(a.stage)
        const fromStage = currentIndex > 0 ? order[currentIndex - 1] : 'submitted'
        const eventType = a.stage === 'rejected' ? 'reject' : 'advance'
        const stageSnap = buildSnapshot(a.candidate_id, a.position_id, latest || snap, {
          recalc_job_id: item?.job_id || jobId
        })
        insertRawEvent(a.stage, eventType, a.stage === 'rejected' ? fromStage : fromStage, stageSnap)
      }
    })

    // 补录事件落库后回填当前阶段快照/进入时间（可能来自补录事件；正式事件由 db.js 兼容段优先处理）
    db.prepare(`UPDATE applications SET stage_snapshot=(
                  SELECT e.score_snapshot FROM application_events e
                  WHERE e.application_id=applications.id AND e.stage=applications.stage
                  ORDER BY e.id DESC LIMIT 1),
                entered_at=(
                  SELECT e.event_at FROM application_events e
                  WHERE e.application_id=applications.id AND e.stage=applications.stage
                  ORDER BY e.id DESC LIMIT 1)
                WHERE stage_snapshot=''`).run()

    if (jobId) console.log(`[HR] startup recalc job #${jobId} refreshed ${pairRows.length} pairs`)
    if (appsNeedBackfill.length) console.log(`[HR] backfilled trace events for ${appsNeedBackfill.length} applications`)
  })
}
migrateHistory()
// 预约风险台账旧库回填（缺席/改期/重约 → 统一责任判定，供阶段闸门与风险报表）
migrateScheduleRisk()
try {
  const due = sweepStrategyWindows()
  if (due.length) console.log(`[HR] strategy window swept ${due.length} version(s)`)
} catch (e) {
  console.error('[HR] strategy window sweep failed:', e)
}
try {
  const expired = tx(() => expireDelegations(Date.now()))
  const escalated = escalateDueTasks()
  if (expired || escalated.length) {
    console.log(`[HR] approval sweep: ${expired} delegation(s) expired, ${escalated.length} task(s) escalated`)
  }
} catch (e) {
  console.error('[HR] approval escalation sweep failed:', e)
}

// 挂载跨角色危机处置审计模块（路由 + 哈希链 + 责任回写），并注入主流程回退执行器
bindCrisisCore({ rollbackForIncident })
app.use('/api/crisis', crisisRouter)
// 候选人↔面试官双向预约沟通（可用时段/双向确认改期/提醒/缺席处理）
// 注入主流程状态机：危机重约确认后的阶段恢复复用 moveStage，保证与普通回退/推进完全同一条路径
bindScheduleCore({
  moveStageForSchedule: (a, stage, { operator, eventType, fromStage }) =>
    moveStage(a, stage, { eventType, fromStage, operator }),
  findActiveIncident: findActiveIncidentForApp
})
app.use('/api/schedule', scheduleRouter)

// 统一业务错误出口：ApiError 携带状态码与错误码，其余错误按 500 返回
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ ok: false, code: err.code, msg: err.message })
  // 危机模块（独立 express.Router）抛出的带状态业务错误
  if (err?.status && err?.code) return res.status(err.status).json({ ok: false, code: err.code, msg: err.message })
  console.error('[HR] unhandled error:', err)
  res.status(500).json({ ok: false, code: 'internal', msg: '服务内部错误' })
})

app.listen(PORT, () => console.log(`[HR] API running at http://localhost:${PORT}`))