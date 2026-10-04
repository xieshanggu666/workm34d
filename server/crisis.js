// 跨角色危机处置审计模块
// - 危机事件立案后，关键操作 / 授权变更 / 状态回退统一追加到「每事件一条」的 SHA-256 哈希链
// - crisis_audit_entries 在数据库层由触发器禁止 UPDATE/DELETE，应用层提供逐链重算校验
// - 处置通知、工单责任人、复盘责任矩阵均从同一条审计链回写，保证责任口径一致
import express from 'express'
import crypto from 'node:crypto'
import db, { ts } from './db.js'
import { suspendAppointmentsForIncident } from './schedule.js'

export const router = express.Router()

// ---------------- 通用工具 ----------------
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const httpError = (status, code, msg) => Object.assign(new Error(msg), { status, code })
const badRequest = (m, c = 'invalid') => { throw httpError(400, c, m) }
const conflict = (m, c = 'conflict') => { throw httpError(409, c, m) }
const forbidden = (m, c = 'forbidden') => { throw httpError(403, c, m) }

// 包装同步路由：业务错误带 HTTP 状态码交主进程统一出口处理
const wrap = fn => (req, res, next) => { try { return fn(req, res, next) } catch (e) { next(e) } }

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

export const ROLE_LABEL = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }
export const CRISIS_ROLES = ['recruiter', 'interviewer', 'hiring_manager']
export const SEVERITY_LABEL = { critical: 'P0 特急', major: 'P1 重大', minor: 'P2 一般' }
export const INCIDENT_STATUS_LABEL = {
  declared: '已立案', responding: '处置中', contained: '已遏制', reviewing: '复盘中', closed: '已结案' }
export const CATEGORY_LABEL = {
  declare: '立案', action: '关键操作', authorization: '授权变更', rollback: '状态回退',
  decision: '审批决策', ticket: '处置工单', report: '复盘定稿', close: '结案归档'
}
export const ACTION_LABEL = {
  'incident.declare': '事件立案', 'incident.state': '事件状态流转', 'incident.commander': '指挥官变更',
  'incident.close': '结案归档', 'authz.grant': '临时授权', 'authz.revoke': '收回授权',
  'state.rollback': '流程状态回退', 'state.reject': '流程淘汰',
  'schedule.suspend': '预约同步挂起', 'schedule.rebook': '预约重约恢复', 'schedule.confirmed': '预约确认恢复',
  'schedule.noshow': '预约缺席裁定', 'schedule.stage_recover': '阶段随重约恢复',
  'approval.auto_cancel': '待审任务同步撤销', 'notification.sync_read': '未读通知同步归并',
  'approval.execute': '审批执行回写', 'approval.failed': '审批执行失败',
  'ticket.create': '创建工单', 'ticket.assign': '工单改派', 'ticket.transition': '工单流转',
  'report.finalize': '复盘定稿'
}

function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}
const actorOf = u => ({ id: u?.id || '', name: u?.name || '', role: u?.role || '' })
const userById = id => db.prepare('SELECT * FROM users WHERE id=?').get(String(id || '')) || null

// 主流程注入的危机回退能力（在本模块事务内执行，复用同一条流程状态机）
let core = null
export function bindCrisisCore(c) { core = c }

// ---------------- 哈希链 ----------------
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
// 事件根哈希：立案时把可读事件号绑定进链，后续条目无法在不破坏首链的情况下被搬运到别的事件
export const genesisHash = code => sha256(`genesis:${code}`)

// 参与哈希的字段固定顺序；detail 以入库时的原文参与运算，重算时直接读库列，保证口径一致
function hashPayload(e, prev) {
  const payload = [
    e.incident_id, e.seq, e.category, e.action, e.actor_id, e.actor_role,
    e.target_role, e.ref_type, e.ref_id, e.summary, e.detail, e.acted_at
  ].join('\n')
  return sha256(`${prev}\n${payload}`)
}

function lastEntry(incidentId) {
  return db.prepare('SELECT * FROM crisis_audit_entries WHERE incident_id=? ORDER BY seq DESC LIMIT 1').get(incidentId) || null
}

// 追加一条审计条目（必须在调用方事务内执行）：序号连续、prev_hash 串链、写入后内容不可改
export function appendEntry(incidentId, fields) {
  const inc = db.prepare('SELECT * FROM crisis_incidents WHERE id=?').get(incidentId)
  if (!inc) badRequest('危机事件不存在', 'incident_missing')
  const last = lastEntry(incidentId)
  const seq = last ? num(last.seq) + 1 : 0
  const prevHash = last ? last.entry_hash : genesisHash(inc.code)
  const actedAt = fields.actedAt || ts()
  const detail = JSON.stringify(fields.detail || {})
  const row = {
    incident_id: inc.id, seq,
    category: String(fields.category || 'action'),
    action: String(fields.action || fields.category || 'action'),
    actor_id: fields.actor?.id || '',
    actor_name: fields.actor?.name || '',
    actor_role: fields.actor?.role || '',
    target_role: fields.targetRole || '',
    ref_type: fields.refType || '',
    ref_id: String(fields.refId ?? ''),
    summary: String(fields.summary || ''),
    detail,
    acted_at: actedAt,
    prev_hash: prevHash
  }
  row.entry_hash = hashPayload(row, prevHash)
  const r = db.prepare(`INSERT INTO crisis_audit_entries
    (incident_id,seq,category,action,actor_id,actor_name,actor_role,target_role,ref_type,ref_id,summary,detail,acted_at,prev_hash,entry_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.incident_id, row.seq, row.category, row.action, row.actor_id, row.actor_name, row.actor_role,
    row.target_role, row.ref_type, row.ref_id, row.summary, row.detail, row.acted_at, row.prev_hash, row.entry_hash)
  return { ...row, id: Number(r.lastInsertRowid) }
}

// 从库里逐条重算整条链：校验根条目、序号连续性与每个 entry_hash
export function verifyChain(incidentId) {
  const inc = db.prepare('SELECT * FROM crisis_incidents WHERE id=?').get(num(incidentId))
  if (!inc) return null
  const entries = db.prepare('SELECT * FROM crisis_audit_entries WHERE incident_id=? ORDER BY seq ASC').all(num(incidentId))
  const broken = []
  let prev = genesisHash(inc.code)
  entries.forEach((e, i) => {
    if (i === 0 && (num(e.seq) !== 0 || e.category !== 'declare')) {
      broken.push({ seq: num(e.seq), reason: '根条目缺失或不是立案条目（链可能被截断）' })
    }
    if (i > 0 && num(e.seq) !== num(entries[i - 1].seq) + 1) {
      broken.push({ seq: num(e.seq), reason: '序号不连续（条目可能被删除/插入）' })
    }
    if (e.prev_hash !== prev) broken.push({ seq: num(e.seq), reason: 'prev_hash 与上一条不一致（链在此处断裂）' })
    const expected = hashPayload(e, prev)
    if (e.entry_hash !== expected) broken.push({ seq: num(e.seq), reason: '内容哈希不匹配（条目内容被篡改）', expected })
    prev = e.entry_hash
  })
  if (!entries.length) broken.push({ seq: -1, reason: '审计链为空' })
  return { ok: !broken.length, count: entries.length, head_hash: entries.at(-1)?.entry_hash || '', broken }
}

// 被动审计钩子：供主流程（回退/淘汰/审批执行）在同一事务内调用；
// 应聘未关联进行中的危机事件时不产生条目；上链失败随主业务事务一起回滚（fail-closed）
export function findActiveIncidentForApp(applicationId) {
  const appId = num(applicationId)
  if (!appId) return null
  return db.prepare("SELECT * FROM crisis_incidents WHERE application_id=? AND status!='closed' ORDER BY id DESC LIMIT 1").get(appId) || null
}
export function auditPassive({ category, action, actor, applicationId, refType = '', refId = '', summary, detail = {}, targetRole = '' }) {
  const inc = findActiveIncidentForApp(applicationId)
  if (!inc) return null
  return appendEntry(inc.id, { category, action, actor: actorOf(actor), refType, refId, summary, detail, targetRole })
}

// ---------------- 通知（责任回写） ----------------
function notifyOne({ recipientRole, type, title, body, appId = 0, incidentId = 0, ticketId = 0, taskId = 0, owner = null }) {
  db.prepare(`INSERT INTO notifications
    (recipient_role,type,title,body,task_id,application_id,is_read,created_at,incident_id,ticket_id,owner_name,owner_user_id)
    VALUES(?,?,?,? ,?,?,0,?,?,?,?,?)`)
    .run(recipientRole, type, title, body, num(taskId), num(appId), ts(), num(incidentId), num(ticketId), owner?.name || '', owner?.id || '')
}
// 危机处置按角色全员触达（跨角色协同）；每条通知固化当前责任人，便于铃铛/工单/复盘回查
function notifyAllRoles(type, { title, body, appId = 0, incidentId = 0, ticketId = 0, taskId = 0, owner = null }) {
  CRISIS_ROLES.forEach(role => notifyOne({ recipientRole: role, type, title, body, appId, incidentId, ticketId, taskId, owner }))
}
// 供预约模块在自己的事务内调用：重约确认触发阶段恢复等被动协同结果，按事件三角色触达并归属指挥官
export function notifyIncidentRoles(type, { title, body, appId = 0, incidentId = 0 }) {
  const inc = db.prepare('SELECT * FROM crisis_incidents WHERE id=?').get(num(incidentId))
  notifyAllRoles(type, {
    title, body, appId, incidentId,
    owner: inc ? { id: inc.commander_id, name: inc.commander_name } : null
  })
}
// 把最新责任人回写到该事件/工单尚未读的通知上（责任变更不丢失历史，只刷新待办归属）
function rewriteUnreadOwner({ incidentId, ticketId, owner }) {
  if (incidentId) {
    db.prepare('UPDATE notifications SET owner_name=?, owner_user_id=? WHERE incident_id=? AND is_read=0')
      .run(owner?.name || '', owner?.id || '', num(incidentId))
  }
  if (ticketId) {
    db.prepare('UPDATE notifications SET owner_name=?, owner_user_id=? WHERE ticket_id=? AND is_read=0')
      .run(owner?.name || '', owner?.id || '', num(ticketId))
  }
}

// ---------------- 权限 ----------------
function getIncident(id) {
  const inc = db.prepare('SELECT * FROM crisis_incidents WHERE id=?').get(num(id))
  if (!inc) badRequest('危机事件不存在', 'incident_missing')
  return inc
}
const activeGrantOf = (incidentId, userId) =>
  db.prepare("SELECT * FROM crisis_grants WHERE incident_id=? AND grantee_id=? AND status='active'").get(num(incidentId), userId) || null
const isCommander = (inc, u) => !!inc.commander_id && inc.commander_id === u.id
// 事件成员：指挥官、立案人、持有本事件有效临时授权者
const isMember = (inc, u) => isCommander(inc, u) || inc.declared_by === u.id || !!activeGrantOf(inc.id, u.id)
function requireCommander(inc, u) {
  if (!isCommander(inc, u)) forbidden(`该操作需事件指挥官「${inc.commander_name || ROLE_LABEL[inc.commander_role]}」执行`, 'not_commander')
}
function requireMember(inc, u) {
  if (!isMember(inc, u)) forbidden('您不是该危机事件的处置成员，需由指挥官临时授权后操作', 'not_incident_member')
}

const STATUS_FLOW = {
  declared: ['responding'],
  responding: ['contained', 'reviewing'],
  contained: ['reviewing', 'responding'],
  reviewing: ['contained', 'responding'],
  closed: []
}

// ---------------- 事件立案 ----------------
router.post('/incidents', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const title = String(b.title || '').trim()
  if (!title) badRequest('请填写危机事件标题', 'title_required')
  const severity = ['critical', 'major', 'minor'].includes(b.severity) ? b.severity : 'major'
  let appId = num(b.application_id)
  if (appId && !db.prepare('SELECT id FROM applications WHERE id=?').get(appId)) appId = 0

  // 指挥官默认招聘负责人；允许指定为任意在职用户（跨角色指挥）
  let commander = b.commander_id ? userById(b.commander_id) : null
  if (b.commander_id && !commander) badRequest('指定的指挥官不存在', 'commander_missing')
  if (!commander) commander = db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()

  const out = tx(() => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const existed = db.prepare("SELECT COUNT(*) c FROM crisis_incidents WHERE code LIKE ?").get(`CR-${day}-%`).c
    const code = `CR-${day}-${String(num(existed) + 1).padStart(3, '0')}`
    const stamp = ts()
    const r = db.prepare(`INSERT INTO crisis_incidents
      (code,title,severity,status,application_id,description,declared_by,declared_by_name,declared_role,declared_at,commander_id,commander_name,commander_role,version)
      VALUES(?,?,?,'declared',?,?,?,?,?,?,?,?,?,1)`)
      .run(code, title, severity, appId, String(b.description || ''), user.id, user.name, user.role, stamp,
        commander.id, commander.name, commander.role)
    const incidentId = Number(r.lastInsertRowid)
    const inc = getIncident(incidentId)
    appendEntry(incidentId, {
      category: 'declare', action: 'incident.declare', actor: actorOf(user),
      refType: appId ? 'application' : '', refId: appId || '',
      summary: `立案「${title}」（${SEVERITY_LABEL[severity]}），指挥官：${commander.name}`,
      detail: {
        code, title, severity, application_id: appId, description: String(b.description || ''),
        declared_by: { id: user.id, name: user.name, role: user.role },
        commander: { id: commander.id, name: commander.name, role: commander.role }
      }
    })
    notifyAllRoles('crisis_declared', {
      title: `🚨 危机事件立案 ${code}`,
      body: `${user.name} 立案「${title}」，指挥官 ${commander.name}，请按角色协同处置`,
      appId, incidentId, owner: actorOf(commander)
    })
    return { id: incidentId, code }
  })
  res.json({ ok: true, ...out })
}))

// 事件状态流转：立案→处置中→已遏制→复盘中（结案走专用接口，必须先定稿复盘）
router.post('/incidents/:id/state', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const target = String(req.body?.status || '')
  const note = String(req.body?.note || '')
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireCommander(inc, user)
    if (inc.status === 'closed') conflict('事件已结案，不能再变更状态', 'incident_closed')
    if (!STATUS_FLOW[inc.status]?.includes(target)) conflict(`不能从「${INCIDENT_STATUS_LABEL[inc.status]}」流转到「${INCIDENT_STATUS_LABEL[target] || target}」`, 'bad_transition')
    db.prepare('UPDATE crisis_incidents SET status=?, contained_at=CASE WHEN ?=\'contained\' THEN ? ELSE contained_at END, version=version+1 WHERE id=?')
      .run(target, target, ts(), inc.id)
    appendEntry(inc.id, {
      category: 'action', action: 'incident.state', actor: actorOf(user),
      summary: `事件状态「${INCIDENT_STATUS_LABEL[inc.status]} → ${INCIDENT_STATUS_LABEL[target]}」`,
      detail: { from: inc.status, to: target, note }
    })
    notifyAllRoles('crisis_state', {
      title: `🚨 ${inc.code} 状态更新：${INCIDENT_STATUS_LABEL[target]}`,
      body: `${user.name} 将事件流转为「${INCIDENT_STATUS_LABEL[target]}」${note ? `：${note}` : ''}`,
      appId: inc.application_id, incidentId: inc.id, owner: { id: inc.commander_id, name: inc.commander_name }
    })
    return { ok: true, status: target }
  })
  res.json(out)
}))

// 指挥官变更（责任移交）：更新事件责任人，未读通知的责任归属一并回写
router.post('/incidents/:id/commander', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const next = userById(req.body?.commander_id)
  if (!next) badRequest('新指挥官不存在', 'commander_missing')
  const note = String(req.body?.note || '')
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireCommander(inc, user)
    if (inc.status === 'closed') conflict('事件已结案，无法移交指挥权', 'incident_closed')
    if (next.id === inc.commander_id) conflict('该成员已是当前指挥官', 'same_commander')
    db.prepare('UPDATE crisis_incidents SET commander_id=?, commander_name=?, commander_role=?, version=version+1 WHERE id=?')
      .run(next.id, next.name, next.role, inc.id)
    appendEntry(inc.id, {
      category: 'action', action: 'incident.commander', actor: actorOf(user), targetRole: next.role,
      summary: `指挥官变更：${inc.commander_name} → ${next.name}`,
      detail: { from: { id: inc.commander_id, name: inc.commander_name, role: inc.commander_role }, to: actorOf(next), note }
    })
    rewriteUnreadOwner({ incidentId: inc.id, owner: actorOf(next) })
    notifyAllRoles('crisis_commander', {
      title: `🔀 ${inc.code} 指挥官变更`,
      body: `${user.name} 将事件指挥权移交给 ${next.name}（${ROLE_LABEL[next.role] || next.role}），处置责任同步转移`,
      appId: inc.application_id, incidentId: inc.id, owner: actorOf(next)
    })
    return { ok: true, commander: actorOf(next) }
  })
  res.json(out)
}))

// ---------------- 临时跨角色授权 ----------------
router.post('/incidents/:id/grants', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const b = req.body || {}
  const grantee = userById(b.grantee_id)
  if (!grantee) badRequest('被授权人不存在', 'grantee_missing')
  if (!CRISIS_ROLES.includes(String(b.role))) badRequest('授权角色非法', 'role_invalid')
  const reason = String(b.reason || '').trim()
  if (!reason) badRequest('请填写授权事由（危机授权必须留痕原因）', 'reason_required')
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireCommander(inc, user)
    if (inc.status === 'closed') conflict('事件已结案，不能再授权', 'incident_closed')
    const dup = activeGrantOf(inc.id, grantee.id)
    if (dup) conflict(`已持有 ${inc.code} 的有效临时授权，请先收回再重授`, 'grant_duplicate')
    const stamp = ts()
    const r = db.prepare(`INSERT INTO crisis_grants
      (incident_id,grantee_id,grantee_name,role,reason,scope,status,granted_by,granted_by_name,granted_at)
      VALUES(?,?,?,?,?,'incident','active',?,?,?)`)
      .run(inc.id, grantee.id, grantee.name, b.role, reason, user.id, user.name, stamp)
    const grantId = Number(r.lastInsertRowid)
    const entry = appendEntry(inc.id, {
      category: 'authorization', action: 'authz.grant', actor: actorOf(user), targetRole: b.role,
      refType: 'grant', refId: grantId,
      summary: `临时授权：${grantee.name} 获得「${ROLE_LABEL[b.role]}」处置权限`,
      detail: { grantee: actorOf(grantee), granted_role: b.role, reason, scope: 'incident', granted_at: stamp }
    })
    db.prepare('UPDATE crisis_grants SET entry_id=? WHERE id=?').run(entry.id, grantId)
    notifyOne({
      recipientRole: grantee.role, type: 'crisis_grant',
      title: `🔑 您已获得 ${inc.code} 临时授权`,
      body: `${user.name} 授权您在本次危机中临时承担「${ROLE_LABEL[b.role]}」职责，事由：${reason}`,
      appId: inc.application_id, incidentId: inc.id, owner: actorOf(grantee)
    })
    notifyAllRoles('crisis_grant_log', {
      title: `🔑 ${inc.code} 新增临时授权`,
      body: `${grantee.name} 临时获得「${ROLE_LABEL[b.role]}」处置权限（授权人：${user.name}）`,
      appId: inc.application_id, incidentId: inc.id, owner: { id: inc.commander_id, name: inc.commander_name }
    })
    return { ok: true, id: grantId }
  })
  res.json(out)
}))

router.post('/grants/:gid/revoke', wrap((req, res) => {
  const user = currentUser(req)
  const grantId = num(req.params.gid)
  const note = String(req.body?.note || '')
  const out = tx(() => {
    const g = db.prepare('SELECT * FROM crisis_grants WHERE id=?').get(grantId)
    if (!g) badRequest('授权记录不存在', 'grant_missing')
    const inc = getIncident(g.incident_id)
    requireCommander(inc, user)
    if (g.status !== 'active') conflict('该授权已收回', 'grant_inactive')
    const stamp = ts()
    db.prepare("UPDATE crisis_grants SET status='revoked', revoked_by=?, revoked_by_name=?, revoked_at=?, revoke_entry_id=? WHERE id=?")
      .run(user.id, user.name, stamp, 0, grantId)
    const entry = appendEntry(inc.id, {
      category: 'authorization', action: 'authz.revoke', actor: actorOf(user), targetRole: g.role,
      refType: 'grant', refId: grantId,
      summary: `收回授权：${g.grantee_name} 的「${ROLE_LABEL[g.role]}」处置权限失效`,
      detail: { grant_id: grantId, grantee: { id: g.grantee_id, name: g.grantee_name }, revoked_role: g.role, note, revoked_at: stamp }
    })
    db.prepare('UPDATE crisis_grants SET revoke_entry_id=? WHERE id=?').run(entry.id, grantId)
    const grantee = userById(g.grantee_id)
    if (grantee) notifyOne({
      recipientRole: grantee.role, type: 'crisis_grant_revoked',
      title: `🔒 ${inc.code} 临时授权已收回`,
      body: `${user.name} 收回了您的「${ROLE_LABEL[g.role]}」临时处置权限${note ? `：${note}` : ''}`,
      appId: inc.application_id, incidentId: inc.id, owner: actorOf(grantee)
    })
    return { ok: true }
  })
  res.json(out)
}))

// ---------------- 危机状态回退（跨角色紧急处置，复用主流程状态机） ----------------
// 三类审批任务的可读名（同步撤销待审任务时留痕/通知用）
const TASK_TYPE_LABEL = { stage_advance: '候选人推进', interview_conclusion: '面试结论', offer_issue: 'Offer 发放' }

// 同步撤销该应聘全部「待审批」任务（退回态保留，由申请人自行决定重提/撤销）：
// 任务状态、步骤留痕与业务回退在同一事务内完成；返回被撤销任务清单供上链
function cancelPendingTasksForIncident(appId, { actor, reason }) {
  const tasks = db.prepare("SELECT * FROM approval_tasks WHERE application_id=? AND status='pending' ORDER BY id").all(appId)
  const stamp = ts()
  const cancelled = []
  tasks.forEach(t => {
    db.prepare("UPDATE approval_tasks SET status='cancelled', decided_at=?, decide_note=?, version=version+1 WHERE id=?")
      .run(stamp, `危机处置同步撤销：${reason}`, t.id)
    db.prepare(`INSERT INTO approval_steps(task_id,step_no,role,action,actor_id,actor_name,note,acted_at)
                VALUES(?,?,?,?,?,?,?,?)`)
      .run(t.id, num(t.current_step), actor?.role || '', 'cancel', actor?.id || '', actor?.name || '',
        `危机回退自动撤销待审任务：${reason}`, stamp)
    cancelled.push({
      id: t.id, type: t.type, type_label: TASK_TYPE_LABEL[t.type] || t.type,
      current_step: num(t.current_step)
    })
  })
  return cancelled
}

// 归并该应聘的在途未读通知：预约协商（sched_*）与审批待办（task_*）已随回退失效，
// 直接标记已读避免铃铛/红点残留；危机处置类通知保留未读（仍是处置待办）。返回按类型计数
function syncUnreadNotificationsForIncident(appId) {
  const rows = db.prepare(`SELECT id,type,recipient_role FROM notifications
                           WHERE application_id=? AND is_read=0
                             AND (type LIKE 'sched_%' OR type LIKE 'task_%')`).all(num(appId))
  if (rows.length) {
    const marks = rows.map(() => '?').join(',')
    db.prepare(`UPDATE notifications SET is_read=1 WHERE id IN (${marks})`).run(...rows.map(r => r.id))
  }
  const byType = {}
  rows.forEach(r => { byType[r.type] = (byType[r.type] || 0) + 1 })
  return { count: rows.length, ids: rows.map(r => num(r.id)), by_type: byType }
}

router.post('/incidents/:id/rollback', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const reason = String(req.body?.reason || '').trim()
  if (!reason) badRequest('危机回退必须填写处置原因（审计强制）', 'reason_required')
  if (!core?.rollbackForIncident) badRequest('流程回退能力未就绪', 'core_unbound')
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireMember(inc, user)
    if (inc.status === 'closed') conflict('事件已结案，不能再执行回退', 'incident_closed')
    const appId = num(req.body?.application_id) || num(inc.application_id)
    if (!appId) badRequest('该事件未关联应聘记录，请在立案时关联或显式指定 application_id', 'app_missing')
    const revived = (() => {
      const before = db.prepare('SELECT stage FROM applications WHERE id=?').get(appId)
      return before?.stage === 'rejected'
    })()
    // 1) 与主流程共用 rollbackStage：撤回联动 Offer、写 rollback 阶段事件均保持一致；危机处置豁免乐观锁
    const r = core.rollbackForIncident(appId, user.name, reason)
    appendEntry(inc.id, {
      category: 'rollback', action: 'state.rollback', actor: actorOf(user),
      refType: 'application', refId: appId,
      summary: `危机处置状态回退：${r.fromLabel} → ${r.toLabel}${revived ? '（淘汰复活）' : ''}`,
      detail: {
        application_id: appId, from: r.from, to: r.to, reason,
        via: 'crisis_command', revived, offer_withdrawn: !!r.offerWithdrawn
      }
    })

    // 2) 同步处理进行中的面试预约：回退到面试以前阶段挂起协商；回退到面试/淘汰复活（回面试）时保留协商
    const suspendAppointments = !revived && ['submitted', 'screening'].includes(r.to)
    let suspended = []
    if (suspendAppointments) {
      suspended = suspendAppointmentsForIncident(appId, { incidentId: inc.id, actor: actorOf(user), reason })
      appendEntry(inc.id, {
        category: 'rollback', action: 'schedule.suspend', actor: actorOf(user),
        refType: 'appointment',
        refId: suspended.length ? suspended.map(a => a.id).join(',') : '',
        summary: suspended.length
          ? `同步挂起 ${suspended.length} 个进行中的面试预约（时段已释放，可在原单重约恢复）`
          : '进行中的面试预约无需挂起',
        detail: { application_id: appId, reason, appointments: suspended }
      })
      if (suspended.length) {
        notifyAllRoles('crisis_appt_suspended', {
          title: `⏸️ ${inc.code} 面试预约已随危机回退挂起`,
          body: `${user.name} 因「${reason}」回退流程，${suspended.length} 个进行中预约已挂起并释放时段，待流程恢复后在原单重新约期`,
          appId, incidentId: inc.id, owner: { id: inc.commander_id, name: inc.commander_name }
        })
      }
    }

    // 3) 同步撤销待审批任务：回退后申请内容对应的业务前置已失效，终审执行必然漂移，统一撤销留痕
    const cancelledTasks = cancelPendingTasksForIncident(appId, { actor: actorOf(user), reason })
    appendEntry(inc.id, {
      category: 'decision', action: 'approval.auto_cancel', actor: actorOf(user),
      refType: 'approval',
      refId: cancelledTasks.length ? cancelledTasks.map(t => t.id).join(',') : '',
      summary: cancelledTasks.length
        ? `同步撤销 ${cancelledTasks.length} 个待审批任务（${cancelledTasks.map(t => t.type_label).join('、')}）`
        : '无进行中的待审批任务',
      detail: { application_id: appId, reason, tasks: cancelledTasks }
    })
    cancelledTasks.forEach(t => {
      // 通知申请人角色：推进/Offer 由招聘负责人发起，面试结论由面试官发起
      const submitterRole = t.type === 'interview_conclusion' ? 'interviewer' : 'recruiter'
      notifyOne({
        recipientRole: submitterRole,
        type: 'crisis_task_cancelled',
        title: `⏸️ ${inc.code} 审批任务已随危机回退撤销`,
        body: `「${t.type_label}」申请 #${t.id} 因流程危机回退（${reason}）被同步撤销，流程恢复后可重新发起`,
        appId, incidentId: inc.id, taskId: t.id,
        owner: { id: inc.commander_id, name: inc.commander_name }
      })
    })

    // 4) 未读通知归并：失效的预约/审批未读提醒统一已读，铃铛/红点不再残留旧待办
    const readSync = syncUnreadNotificationsForIncident(appId)
    appendEntry(inc.id, {
      category: 'action', action: 'notification.sync_read', actor: actorOf(user),
      refType: 'notification',
      refId: readSync.ids.slice(0, 50).join(','),
      summary: readSync.count
        ? `同步归并 ${readSync.count} 条失效的预约/审批未读通知为已读`
        : '无失效的未读通知需要归并',
      detail: { application_id: appId, count: readSync.count, notification_ids: readSync.ids, by_type: readSync.by_type }
    })

    notifyAllRoles('crisis_rollback', {
      title: `⏪ ${inc.code} 执行状态回退（已同步后续协同）`,
      body: `${user.name} 因「${reason}」将应聘流程从「${r.fromLabel}」回退到「${r.toLabel}」`
        + `：挂起预约 ${suspended.length} 个、撤销待审 ${cancelledTasks.length} 个、归并未读 ${readSync.count} 条`,
      appId, incidentId: inc.id, owner: { id: inc.commander_id, name: inc.commander_name }
    })
    return {
      ok: true, ...r, revived,
      appointments_suspended: suspended,
      tasks_cancelled: cancelledTasks,
      notifications_read: readSync.count
    }
  })
  res.json(out)
}))

// ---------------- 关键操作（通用上链） ----------------
router.post('/incidents/:id/actions', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const b = req.body || {}
  const summary = String(b.summary || '').trim()
  if (!summary) badRequest('请填写关键操作内容', 'summary_required')
  const category = ['action', 'decision'].includes(b.category) ? b.category : 'action'
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireMember(inc, user)
    if (inc.status === 'closed') conflict('事件已结案，不能再追加操作', 'incident_closed')
    const entry = appendEntry(inc.id, {
      category, action: String(b.action || (category === 'decision' ? 'manual.decision' : 'manual.action')),
      actor: actorOf(user), targetRole: String(b.target_role || ''),
      refType: String(b.ref_type || ''), refId: String(b.ref_id || ''),
      summary, detail: b.detail && typeof b.detail === 'object' ? b.detail : { note: String(b.detail || '') }
    })
    return { ok: true, entry_id: entry.id, seq: entry.seq }
  })
  res.json(out)
}))

// ---------------- 处置工单（责任到人 + 责任回写通知） ----------------
router.post('/incidents/:id/tickets', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const b = req.body || {}
  const title = String(b.title || '').trim()
  if (!title) badRequest('请填写工单标题', 'title_required')
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireMember(inc, user)
    if (inc.status === 'closed') conflict('事件已结案，不能再开工单', 'incident_closed')
    let owner = b.owner_id ? userById(b.owner_id) : user
    if (b.owner_id && !owner) badRequest('工单责任人不存在', 'owner_missing')
    const priority = ['P0', 'P1', 'P2', 'P3'].includes(b.priority) ? b.priority : 'P2'
    const stamp = ts()
    const r = db.prepare(`INSERT INTO crisis_tickets
      (incident_id,title,content,priority,status,owner_id,owner_name,owner_role,created_by,created_by_name,created_at,application_id)
      VALUES(?,?,?,?,'open',?,?,?,?,?,?,?)`)
      .run(inc.id, title, String(b.content || ''), priority, owner.id, owner.name, owner.role, user.id, user.name, stamp, inc.application_id)
    const ticketId = Number(r.lastInsertRowid)
    const entry = appendEntry(inc.id, {
      category: 'ticket', action: 'ticket.create', actor: actorOf(user),
      refType: 'ticket', refId: ticketId,
      summary: `创建工单「${title}」（${priority}），责任人：${owner.name}`,
      detail: { ticket_id: ticketId, title, priority, owner: actorOf(owner), content: String(b.content || '') }
    })
    db.prepare('UPDATE crisis_tickets SET entry_id=? WHERE id=?').run(entry.id, ticketId)
    notifyOne({
      recipientRole: owner.role, type: 'crisis_ticket',
      title: `🎫 ${inc.code} 新工单指派：${title}`,
      body: `${user.name} 创建工单并指派给您（${priority}），请跟进处置`,
      appId: inc.application_id, incidentId: inc.id, ticketId, owner: actorOf(owner)
    })
    return { ok: true, id: ticketId }
  })
  res.json(out)
}))

const TICKET_FLOW = { open: ['processing'], processing: ['resolved'], resolved: ['closed'], closed: [] }
router.post('/tickets/:tid', wrap((req, res) => {
  const user = currentUser(req)
  const ticketId = num(req.params.tid)
  const b = req.body || {}
  const out = tx(() => {
    const tk = db.prepare('SELECT * FROM crisis_tickets WHERE id=?').get(ticketId)
    if (!tk) badRequest('工单不存在', 'ticket_missing')
    const inc = getIncident(tk.incident_id)
    if (!isMember(inc, user) && tk.owner_id !== user.id) forbidden('仅事件成员或工单责任人可操作该工单', 'not_ticket_owner')

    // 改派：责任人更新，未读通知的责任归属同步回写
    if (b.owner_id && String(b.owner_id) !== String(tk.owner_id)) {
      const next = userById(b.owner_id)
      if (!next) badRequest('新责任人不存在', 'owner_missing')
      db.prepare('UPDATE crisis_tickets SET owner_id=?, owner_name=?, owner_role=? WHERE id=?')
        .run(next.id, next.name, next.role, ticketId)
      appendEntry(inc.id, {
        category: 'ticket', action: 'ticket.assign', actor: actorOf(user),
        refType: 'ticket', refId: ticketId,
        summary: `工单「${tk.title}」改派：${tk.owner_name} → ${next.name}`,
        detail: { ticket_id: ticketId, from: { id: tk.owner_id, name: tk.owner_name, role: tk.owner_role }, to: actorOf(next) }
      })
      rewriteUnreadOwner({ ticketId, owner: actorOf(next) })
      notifyOne({
        recipientRole: next.role, type: 'crisis_ticket_assign',
        title: `🎫 ${inc.code} 工单改派给您：${tk.title}`,
        body: `${user.name} 将工单责任人变更为您，请继续跟进`,
        appId: inc.application_id, incidentId: inc.id, ticketId, owner: actorOf(next)
      })
      tk.owner_id = next.id; tk.owner_name = next.name
    }

    if (b.status && b.status !== tk.status) {
      if (!TICKET_FLOW[tk.status]?.includes(b.status)) conflict(`工单不能从「${tk.status}」流转到「${b.status}」`, 'bad_ticket_transition')
      const resolution = String(b.resolution ?? '')
      if (b.status === 'resolved' && !resolution.trim()) badRequest('解决工单必须填写处置结果', 'resolution_required')
      const stamp = ts()
      db.prepare('UPDATE crisis_tickets SET status=?, resolution=CASE WHEN ?=\'resolved\' THEN ? ELSE resolution END, resolved_at=CASE WHEN ?=\'resolved\' THEN ? ELSE resolved_at END WHERE id=?')
        .run(b.status, b.status, resolution, b.status, stamp, ticketId)
      appendEntry(inc.id, {
        category: 'ticket', action: 'ticket.transition', actor: actorOf(user),
        refType: 'ticket', refId: ticketId,
        summary: `工单「${tk.title}」：${tk.status} → ${b.status}`,
        detail: { ticket_id: ticketId, from: tk.status, to: b.status, resolution, by: actorOf(user) }
      })
      notifyAllRoles('crisis_ticket_update', {
        title: `🎫 ${inc.code} 工单更新：${tk.title}（${b.status}）`,
        body: `${user.name} 将工单流转为「${b.status}」${resolution ? `：${resolution}` : ''}`,
        appId: inc.application_id, incidentId: inc.id, ticketId,
        owner: { id: tk.owner_id, name: tk.owner_name }
      })
    }
    return { ok: true }
  })
  res.json(out)
}))

// ---------------- 复盘报告（责任矩阵 + 定稿上链） ----------------
function buildResponsibilities(inc) {
  const entries = db.prepare('SELECT * FROM crisis_audit_entries WHERE incident_id=? ORDER BY seq ASC').all(inc.id)
  const people = new Map()
  const ensure = (id, name, role) => {
    if (!id) return null
    if (!people.has(id)) people.set(id, { user_id: id, name, role, actions: 0, categories: new Set(), last_at: '' })
    const p = people.get(id)
    if (name) p.name = name
    if (role) p.role = role
    return p
  }
  entries.forEach(e => {
    const p = ensure(e.actor_id, e.actor_name, e.actor_role)
    if (p) { p.actions++; p.categories.add(e.category); if (e.acted_at > p.last_at) p.last_at = e.acted_at }
  })
  const grants = db.prepare('SELECT * FROM crisis_grants WHERE incident_id=? ORDER BY id').all(inc.id)
  const tickets = db.prepare('SELECT * FROM crisis_tickets WHERE incident_id=? ORDER BY id').all(inc.id)
  const openTickets = tickets.filter(t => t.status !== 'closed' && t.status !== 'resolved')
  const rollbackEntries = entries.filter(e => e.category === 'rollback')
  return {
    commander: { user_id: inc.commander_id, name: inc.commander_name, role: inc.commander_role },
    declared_by: { user_id: inc.declared_by, name: inc.declared_by_name, role: inc.declared_role },
    participants: [...people.values()].map(p => ({ ...p, categories: [...p.categories] })),
    grants: grants.map(g => ({
      id: g.id, grantee_id: g.grantee_id, grantee_name: g.grantee_name, role: g.role,
      status: g.status, reason: g.reason, granted_at: g.granted_at, revoked_at: g.revoked_at
    })),
    tickets: tickets.map(t => ({
      id: t.id, title: t.title, priority: t.priority, status: t.status,
      owner_id: t.owner_id, owner_name: t.owner_name, resolved_at: t.resolved_at
    })),
    open_ticket_count: openTickets.length,
    rollback_count: rollbackEntries.length,
    entries_count: entries.length,
    generated_at: ts()
  }
}

// 保存草稿（可变，不上链）；定稿才进入不可篡改审计链
router.put('/incidents/:id/report', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const b = req.body || {}
  tx(() => {
    const inc = getIncident(incidentId)
    requireMember(inc, user)
    const improvements = Array.isArray(b.improvements) ? b.improvements.map(String).filter(Boolean) : []
    const exist = db.prepare('SELECT id,status FROM crisis_reports WHERE incident_id=?').get(incidentId)
    if (exist && exist.status === 'finalized') conflict('复盘报告已定稿，不能再修改', 'report_finalized')
    const stamp = ts()
    if (exist) {
      db.prepare('UPDATE crisis_reports SET summary=?, root_cause=?, improvements=?, owner_id=?, owner_name=?, updated_at=? WHERE incident_id=?')
        .run(String(b.summary || ''), String(b.root_cause || ''), JSON.stringify(improvements), user.id, user.name, stamp, incidentId)
    } else {
      db.prepare(`INSERT INTO crisis_reports
        (incident_id,summary,root_cause,improvements,status,owner_id,owner_name,updated_at)
        VALUES(?,?,?,?,'draft',?,?,?)`)
        .run(incidentId, String(b.summary || ''), String(b.root_cause || ''), JSON.stringify(improvements), user.id, user.name, stamp)
    }
  })
  res.json({ ok: true })
}))

router.post('/incidents/:id/report/finalize', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireCommander(inc, user)
    if (inc.status === 'closed') conflict('事件已结案', 'incident_closed')
    const report = db.prepare('SELECT * FROM crisis_reports WHERE incident_id=?').get(incidentId)
    if (!report) badRequest('请先撰写复盘报告再定稿', 'report_missing')
    if (report.status === 'finalized') conflict('复盘报告已定稿', 'report_finalized')
    // 定稿前强制校验审计链：链不完整/被篡改时禁止定稿
    const verify = verifyChain(incidentId)
    if (!verify.ok) conflict('审计链校验未通过，存在断裂或篡改，不能定稿复盘', 'chain_broken')
    const responsibilities = buildResponsibilities(inc)
    const openTicketCount = responsibilities.open_ticket_count
    if (openTicketCount > 0) conflict(`仍有 ${openTicketCount} 张未解决工单，请处理完毕或关闭后再定稿`, 'tickets_open')
    const stamp = ts()
    db.prepare(`UPDATE crisis_reports
      SET status='finalized', entries_count=?, report_hash=?, responsibilities=?, finalized_at=?, finalized_by=?, updated_at=?
      WHERE incident_id=?`)
      .run(verify.count, verify.head_hash, JSON.stringify(responsibilities), stamp, user.name, stamp, incidentId)
    db.prepare('UPDATE crisis_incidents SET report_hash=?, report_finalized_at=?, status=CASE WHEN status=\'declared\' THEN \'reviewing\' ELSE status END, version=version+1 WHERE id=?')
      .run(verify.head_hash, stamp, incidentId)
    appendEntry(incidentId, {
      category: 'report', action: 'report.finalize', actor: actorOf(user),
      refType: 'report', refId: report.id,
      summary: `复盘报告定稿（审计链 ${verify.count} 条，链顶 ${verify.head_hash.slice(0, 12)}…），责任矩阵已固化`,
      detail: { entries_count: verify.count, report_hash: verify.head_hash, responsibilities }
    })
    // 责任回写：把指挥官责任信息补写到该事件尚未读的历史通知上
    rewriteUnreadOwner({ incidentId, owner: { id: inc.commander_id, name: inc.commander_name } })
    notifyAllRoles('crisis_report', {
      title: `📝 ${inc.code} 复盘报告已定稿`,
      body: `${user.name} 定稿复盘报告，事件责任矩阵已固化到审计链，可申请结案`,
      appId: inc.application_id, incidentId, owner: { id: inc.commander_id, name: inc.commander_name }
    })
    return { ok: true, report_hash: verify.head_hash, entries_count: verify.count, responsibilities }
  })
  res.json(out)
}))

// ---------------- 结案 ----------------
router.post('/incidents/:id/close', wrap((req, res) => {
  const user = currentUser(req)
  const incidentId = num(req.params.id)
  const note = String(req.body?.note || '')
  const out = tx(() => {
    const inc = getIncident(incidentId)
    requireCommander(inc, user)
    if (inc.status === 'closed') conflict('事件已结案', 'incident_closed')
    const report = db.prepare("SELECT * FROM crisis_reports WHERE incident_id=? AND status='finalized'").get(incidentId)
    if (!report) badRequest('复盘报告未定稿，不能结案（先定稿责任矩阵）', 'report_not_finalized')
    const stamp = ts()
    // 结案自动收回全部仍然有效的临时授权，并逐条上链
    const activeGrants = db.prepare("SELECT * FROM crisis_grants WHERE incident_id=? AND status='active'").all(incidentId)
    activeGrants.forEach(g => {
      const entry = appendEntry(incidentId, {
        category: 'authorization', action: 'authz.revoke', actor: actorOf(user), targetRole: g.role,
        refType: 'grant', refId: g.id,
        summary: `结案自动收回授权：${g.grantee_name} 的「${ROLE_LABEL[g.role]}」权限失效`,
        detail: { grant_id: g.id, grantee: { id: g.grantee_id, name: g.grantee_name }, revoked_role: g.role, reason: 'incident_closed' }
      })
      db.prepare("UPDATE crisis_grants SET status='revoked', revoked_by=?, revoked_by_name=?, revoked_at=?, revoke_entry_id=? WHERE id=?")
        .run(user.id, user.name, stamp, entry.id, g.id)
    })
    db.prepare("UPDATE crisis_incidents SET status='closed', closed_at=?, version=version+1 WHERE id=?").run(stamp, incidentId)
    appendEntry(incidentId, {
      category: 'close', action: 'incident.close', actor: actorOf(user),
      refType: 'report', refId: report.id,
      summary: `事件结案归档（复盘链顶 ${inc.report_hash.slice(0, 12) || report.report_hash.slice(0, 12)}…）`,
      detail: { note, report_hash: report.report_hash, grants_revoked: activeGrants.length, closed_at: stamp }
    })
    notifyAllRoles('crisis_closed', {
      title: `🧾 ${inc.code} 已结案归档`,
      body: `${user.name} 完成结案，临时授权已全部收回，审计链与复盘报告归档不可篡改`,
      appId: inc.application_id, incidentId, owner: { id: inc.commander_id, name: inc.commander_name }
    })
    return { ok: true, closed_at: stamp, grants_revoked: activeGrants.length }
  })
  res.json(out)
}))

// ---------------- 校验 / 导出 ----------------
router.get('/incidents/:id/verify', wrap((req, res) => {
  const v = verifyChain(num(req.params.id))
  if (!v) return res.status(404).json({ ok: false, code: 'incident_missing' })
  res.json({ ok: v.ok, ...v })
}))

router.get('/incidents/:id/export', wrap((req, res) => {
  const inc = getIncident(num(req.params.id))
  const entries = db.prepare('SELECT * FROM crisis_audit_entries WHERE incident_id=? ORDER BY seq ASC').all(inc.id)
  const grants = db.prepare('SELECT * FROM crisis_grants WHERE incident_id=? ORDER BY id').all(inc.id)
  const tickets = db.prepare('SELECT * FROM crisis_tickets WHERE incident_id=? ORDER BY id').all(inc.id)
  const report = db.prepare('SELECT * FROM crisis_reports WHERE incident_id=?').get(inc.id) || null
  const verification = verifyChain(inc.id)
  res.setHeader('Content-Disposition', `attachment; filename="${inc.code}-audit.json"`)
  res.json({
    exported_at: ts(),
    incident: inc,
    verification,
    entries,
    grants,
    tickets,
    report: report ? { ...report, improvements: parseJSON(report.improvements, []), responsibilities: parseJSON(report.responsibilities, {}) } : null
  })
}))

// ---------------- 状态聚合（供 /api/state 合并返回） ----------------
export function getCrisisState() {
  const incidents = db.prepare('SELECT * FROM crisis_incidents ORDER BY id DESC').all()
  const entries = db.prepare('SELECT * FROM crisis_audit_entries ORDER BY id ASC').all().map(e => ({
    ...e, seq: num(e.seq), detail: parseJSON(e.detail, {})
  }))
  const grants = db.prepare('SELECT * FROM crisis_grants ORDER BY id DESC').all().map(g => ({ ...g, entry_id: num(g.entry_id), revoke_entry_id: num(g.revoke_entry_id) }))
  const tickets = db.prepare('SELECT * FROM crisis_tickets ORDER BY id DESC').all()
  const reports = db.prepare('SELECT * FROM crisis_reports ORDER BY id DESC').all().map(r => ({
    ...r,
    entries_count: num(r.entries_count),
    improvements: parseJSON(r.improvements, []),
    responsibilities: parseJSON(r.responsibilities, null)
  }))
  // 列表页轻量展示完整性：逐链重算（条目量级很小），异常事件给出醒目标记
  const verification = {}
  incidents.forEach(inc => { verification[inc.id] = verifyChain(inc.id) })
  return { crisisIncidents: incidents, crisisEntries: entries, crisisGrants: grants, crisisTickets: tickets, crisisReports: reports, crisisVerification: verification }
}
