// 按角色委托 + 超时升级模块（候选人推进 / 面试结论 / Offer 发放 / 策略发布四类审批共用）
//
// 一致性设计：
// 1) 审批链快照 approval_tasks.chain 只在提交/重提时按角色固化，委托与升级永不改写 chain；
//    「某一步实际由谁处理」作为独立路由 approval_step_routes 追加，并在 approval_steps 追加审计动作。
// 2) 委托是对「角色」的授权：代理人拿到的是节点原角色的处理权，撤销/到期后未消费的代理路由立即失效；
//    已经代理完成的步骤只留痕不回滚（chain 与 step 留痕共同构成证据）。
// 3) 超时升级不改写当前节点：原角色与升级人并行有权，任一人处理即把该节点全部路由置 consumed。
// 4) 所有多步动作都在调用方 BEGIN IMMEDIATE 事务内执行；步骤路由的 active 唯一性由部分唯一索引兜底，
//    sweep/授权/审批并发时第二个写入者得到 SQLITE_CONSTRAINT，按幂等跳过。
// 5) 通知支持定向到人（recipient_user_id）：代理/升级待办只进代理人/升级人的铃铛；
//    任务流转、撤销、退回、到期等会在同一事务内把已失效的未读待办归并为已读，杜绝红点残留。
import express from 'express'
import db, { ts, now } from './db.js'

export const router = express.Router()

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const parseJSON = (s, d) => { try { return JSON.parse(s || '') ?? d } catch { return d } }
const httpError = (status, code, msg) => Object.assign(new Error(msg), { status, code })
const badRequest = (m, c = 'invalid') => { throw httpError(400, c, m) }
const conflict = (m, c = 'conflict') => { throw httpError(409, c, m) }
const forbidden = (m, c = 'forbidden') => { throw httpError(403, c, m) }
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
export const TASK_TYPES = ['stage_advance', 'interview_conclusion', 'offer_issue', 'strategy_publish']
export const TASK_TYPE_LABEL = {
  stage_advance: '候选人推进', interview_conclusion: '面试结论',
  offer_issue: 'Offer 发放', strategy_publish: '匹配策略发布'
}

function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}
const userById = id => db.prepare('SELECT * FROM users WHERE id=?').get(String(id || '')) || null

// 主进程注入：审批链节点标签（供通知/留痕复用同一口径）
const ROLES = Object.keys(ROLE_LABEL)

// ---------------- 通知（定向到人时 recipient_user_id 非空） ----------------
function notify({ recipientRole = '', recipientUserId = '', type, title, body, taskId = 0, appId = 0,
  delegationId = 0, stepNo = -1 }) {
  db.prepare(`INSERT INTO notifications
    (recipient_role,recipient_user_id,delegation_id,step_no,type,title,body,task_id,application_id,is_read,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,0,?)`)
    .run(recipientRole, recipientUserId, num(delegationId), num(stepNo), type, title, body,
      num(taskId), num(appId), ts())
}

// 归并任务未读待办：
//  - audience=true  归并「处理人侧」待办（定向到某用户的路由通知 + 未定向的角色广播）
//  - audience=false 归并「申请人侧」待办（按角色广播，通常即提交人角色）
// 任务终止（通过/撤销/退回）时两侧均应归并，保证撤销/升级/代理切换后铃铛不残留旧待办
function markTaskUnreadRead(taskId, { audience = null, stepNo = null } = {}) {
  const id = num(taskId)
  // step_no 用于逐级流转：只归并「已离开节点」的处理人待办，不碰下一节点刚挂出的定向待办
  const stepCond = stepNo === null ? '' : ` AND step_no=${num(stepNo)}`
  if (audience === true) {
    db.prepare(`UPDATE notifications SET is_read=1 WHERE task_id=? AND is_read=0
                AND recipient_user_id!=''${stepCond}`).run(id)
  } else if (audience === false) {
    db.prepare(`UPDATE notifications SET is_read=1 WHERE task_id=? AND is_read=0
                AND recipient_user_id='' AND type NOT IN ('task_submitted','task_resubmitted')${stepCond}`).run(id)
  } else {
    db.prepare('UPDATE notifications SET is_read=1 WHERE task_id=? AND is_read=0').run(id)
  }
}

// ---------------- 委托查询（鉴权在动作发生的瞬间读库，撤销即时生效） ----------------
function scopeCovers(taskTypes, type) {
  const list = parseJSON(taskTypes, [])
  return !Array.isArray(list) || !list.length || list.includes(type)
}

function delegationStatus(d, at = now()) {
  if (d.status === 'revoked') return 'revoked'
  if (d.status === 'expired') return 'expired'
  if (d.starts_at && at < d.starts_at) return 'scheduled'
  if (d.ends_at && at > d.ends_at) return 'expired'
  return 'active'
}

// 找某用户当前可代理某审批类型的有效委托（角色匹配、时间窗内、类型在授权范围、未撤销）
function findActiveDelegationForUser(userId, type, at = now()) {
  const rows = db.prepare(`SELECT * FROM delegations
                           WHERE grantee_id=? AND status='active' ORDER BY id DESC`).all(String(userId || ''))
  return rows.find(d => scopeCovers(d.scope_task_types, type) && delegationStatus(d, at) === 'active') || null
}

function getDelegation(id) {
  return db.prepare('SELECT * FROM delegations WHERE id=?').get(num(id)) || null
}

// ---------------- 升级配置 ----------------
function getEscalationConfig(role) {
  let row = db.prepare('SELECT * FROM escalation_config WHERE role=?').get(role)
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO escalation_config(role,sla_hours,target_role) VALUES(?,48,?)')
      .run(role, role === 'recruiter' ? 'hiring_manager' : 'recruiter')
    row = db.prepare('SELECT * FROM escalation_config WHERE role=?').get(role)
  }
  return {
    role: row.role,
    sla_hours: num(row.sla_hours, 48),
    target_role: row.target_role || '',
    target_user_id: row.target_user_id || '',
    updated_by: row.updated_by || '',
    updated_at: row.updated_at || ''
  }
}

function computeDueAt(role, fromISO = now()) {
  const cfg = getEscalationConfig(role)
  const base = new Date(fromISO).getTime()
  if (Number.isNaN(base)) return ''
  const d = new Date(base + cfg.sla_hours * 3600_000)
  return d.toISOString()
}

// ---------------- 步骤路由（必须在调用方事务内执行） ----------------
function activeRoutesOfTask(taskId) {
  return db.prepare("SELECT * FROM approval_step_routes WHERE task_id=? AND status='active' ORDER BY id")
    .all(num(taskId))
}
function activeRouteAtStep(taskId, stepNo) {
  return db.prepare("SELECT * FROM approval_step_routes WHERE task_id=? AND step_no=? AND status='active' ORDER BY id DESC LIMIT 1")
    .get(num(taskId), num(stepNo)) || null
}

// 为某任务的当前等待节点补齐「角色委托」路由：
// 当前对该角色持有有效委托的每位代理人各生成一条 active 路由（并发授权靠部分唯一索引 + catch 幂等）
function attachDelegationRoutes(taskId, stepNo, { at = now(), notifyActors = true } = {}) {
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(num(taskId))
  if (!t || t.status !== 'pending' || num(t.current_step) !== num(stepNo)) return []
  const chain = parseJSON(t.chain, [])
  const step = chain[num(stepNo)]
  if (!step) return []
  const delegs = db.prepare(`SELECT * FROM delegations
                             WHERE granter_role=? AND status='active' ORDER BY id`).all(step.role)
  const attached = []
  const stamp = ts()
  delegs.forEach(d => {
    if (!scopeCovers(d.scope_task_types, t.type)) return
    if (delegationStatus(d, at) !== 'active') return
    try {
      db.prepare(`INSERT INTO approval_step_routes
        (task_id,step_no,kind,delegation_id,role,actor_user_id,actor_name,status,note,sla_hours,due_at,created_at)
        VALUES(?,?,'delegation',?,?,?,?,'active',?,0,'',?)`)
        .run(t.id, num(stepNo), d.id, step.role, d.grantee_id, d.grantee_name,
          `委托单 #${d.id}：${d.reason || '按角色委托'}`, stamp)
      attached.push(d)
      if (notifyActors) {
        notify({
          recipientRole: step.role, recipientUserId: d.grantee_id,
          type: 'task_delegated',
          title: `📥 您有一条代审批任务（代理${ROLE_LABEL[step.role] || step.role}）`,
          body: `您被授权代「${ROLE_LABEL[step.role] || step.role}」处理「${TASK_TYPE_LABEL[t.type] || t.type}」#${t.id}，请在审批中心待办中处理；授权随时可能被撤销`,
          taskId: t.id, appId: t.application_id, delegationId: d.id, stepNo
        })
      }
    } catch (e) {
      // 同一节点唯一 active 路由冲突：该代理人已挂账（或并发 sweep/审批抢先），幂等跳过
      if (!String(e?.message || '').includes('UNIQUE') && !String(e?.code || '').includes('CONSTRAINT')) throw e
    }
  })
  return attached
}

// 节点重排：移动到新等待节点时设置超时截止、刷新委托路由、追加代理待办通知。供提交/重提/逐级通过调用
function rearmStep(taskId, stepNo, { at = now(), notifyActors = true } = {}) {
  const t = db.prepare('SELECT * FROM approval_tasks WHERE id=?').get(num(taskId))
  if (!t) return
  const chain = parseJSON(t.chain, [])
  const step = chain[num(stepNo)]
  if (!step) {
    db.prepare('UPDATE approval_tasks SET step_due_at=? WHERE id=?').run('', t.id)
    return
  }
  const due = computeDueAt(step.role, at)
  db.prepare('UPDATE approval_tasks SET step_due_at=? WHERE id=?').run(due, t.id)
  attachDelegationRoutes(t.id, num(stepNo), { at, notifyActors })
}

// 消费某节点的全部 active 路由（代理人/升级人/原角色任一处理即关闭其他授权窗口）
function consumeActiveRoutes(taskId, stepNo, user) {
  db.prepare(`UPDATE approval_step_routes
              SET status='consumed', consumed_at=?, consumed_by=?
              WHERE task_id=? AND step_no=? AND status='active'`)
    .run(ts(), user?.id || '', num(taskId), num(stepNo))
}

// 撤销委托时把挂在各在途任务上的未消费代理路由作废，并在任务时间线追加留痕
function supersedeDelegationRoutes(delegation, { user, reason }) {
  const rows = db.prepare(`SELECT r.*, t.type AS task_type, t.status AS task_status
                           FROM approval_step_routes r
                           JOIN approval_tasks t ON t.id=r.task_id
                           WHERE r.delegation_id=? AND r.status='active'
                           ORDER BY r.id`).all(delegation.id)
  const stamp = ts()
  rows.forEach(r => {
    db.prepare(`UPDATE approval_step_routes SET status='superseded', superseded_at=?, superseded_by=? WHERE id=?`)
      .run(stamp, user?.id || '', r.id)
    if (r.task_status === 'pending') {
      db.prepare(`INSERT INTO approval_steps(task_id,step_no,role,action,actor_id,actor_name,note,acted_at)
                  VALUES(?,?,?,?,?,?,?,?)`)
        .run(r.task_id, r.step_no, r.role, 'delegate_revoke', user?.id || '', user?.name || '',
          `委托单 #${delegation.id} 已撤销，代理人 ${delegation.grantee_name} 对该节点的代理权限即时失效${reason ? `：${reason}` : ''}`, stamp)
    }
  })
  // 代理人铃铛里由该委托产生、尚未处理的定向待办全部归并，撤销后不再残留红点
  db.prepare(`UPDATE notifications SET is_read=1 WHERE delegation_id=? AND is_read=0 AND recipient_user_id=?`)
    .run(delegation.id, delegation.grantee_id)
  return rows
}

// ---------------- 审批动作鉴权 ----------------
// 返回 { mode:'role'|'delegation'|'escalation', route?, delegation? }；无权限返回 null。
// 注意：仅在调用方事务内调用，保证「鉴权 → 消费」原子，撤销与审批并发时由 BEGIN IMMEDIATE 串行化。
function resolveStepAuthority(task, user, { at = now() } = {}) {
  const chain = parseJSON(task.chain, [])
  const step = chain[num(task.current_step)]
  if (!step) return null
  // 节点原角色持有人始终有权（委托不剥夺本人权限；升级也保留原角色处理权）
  if (user.role === step.role) return { mode: 'role', role: step.role }
  const routes = activeRoutesOfTask(task.id).filter(r => num(r.step_no) === num(task.current_step))
  for (const r of routes) {
    if (r.actor_user_id !== user.id) continue
    if (r.kind === 'escalation') return { mode: 'escalation', route: r, role: step.role }
    if (r.kind === 'delegation') {
      // 再校验委托未撤销且仍在时间窗/类型范围内（路由创建后的撤销已把路由置 superseded，这里双保险）
      const d = getDelegation(r.delegation_id)
      if (d && delegationStatus(d, at) === 'active' && scopeCovers(d.scope_task_types, task.type)) {
        return { mode: 'delegation', route: r, delegation: d, role: step.role }
      }
    }
  }
  // 路由可能尚未建立（如旧任务/并发边界）：存在有效委托则当场授权并挂账
  const d = findActiveDelegationForUser(user.id, task.type, at)
  if (d && d.granter_role === step.role) {
    attachDelegationRoutes(task.id, num(task.current_step), { at, notifyActors: false })
    const r = activeRouteAtStep(task.id, task.current_step)
    if (r && r.actor_user_id === user.id) return { mode: 'delegation', route: r, delegation: d, role: step.role }
  }
  return null
}

// ---------------- 超时升级 sweep（幂等；可由启动、定时或手动按钮触发） ----------------
function activateScheduledDelegations(at = now()) {
  // 待生效委托（status='scheduled'）：到达开始窗口后置 active 并补挂在途任务；窗口已整体过期则置 expired 释放名额
  const due = db.prepare("SELECT * FROM delegations WHERE status='scheduled' AND starts_at!='' AND starts_at<=? ORDER BY id")
    .all(at)
  const activated = []
  due.forEach(d => {
    if (d.ends_at && at > d.ends_at) {
      db.prepare("UPDATE delegations SET status='expired' WHERE id=?").run(d.id)
      return
    }
    db.prepare("UPDATE delegations SET status='active' WHERE id=?").run(d.id)
    d.status = 'active'
    // 生效窗口到达：为各在途任务当前等待节点补挂代理路由并通知代理人
    const tasks = db.prepare("SELECT * FROM approval_tasks WHERE status='pending' ORDER BY id").all()
    let hit = 0
    tasks.forEach(t => {
      const chain = parseJSON(t.chain, [])
      const step = chain[num(t.current_step)]
      if (!step || step.role !== d.granter_role) return
      if (!scopeCovers(d.scope_task_types, t.type)) return
      const attached = attachDelegationRoutes(t.id, num(t.current_step), { at, notifyActors: true })
      hit += attached.length
    })
    if (hit) activated.push({ delegation_id: d.id, tasks: hit })
  })
  // 无开始时间但状态残留 scheduled 的异常数据也兜底过期
  db.prepare("UPDATE delegations SET status='expired' WHERE status='scheduled' AND (starts_at='' OR (ends_at!='' AND ends_at<=?))")
    .run(at)
  return activated
}

function escalateDueTasks(at = now()) {
  const due = db.prepare(`SELECT * FROM approval_tasks
                          WHERE status='pending' AND step_due_at!='' AND step_due_at<=? ORDER BY id`).all(at)
  const out = []
  due.forEach(t => {
    const stepNo = num(t.current_step)
    // 已存在升级路由（上次 sweep 已升级）：幂等，不重复升级/通知
    const existed = db.prepare(`SELECT id FROM approval_step_routes
                                WHERE task_id=? AND step_no=? AND kind='escalation' AND status='active'`).get(t.id, stepNo)
    if (existed) return
    const chain = parseJSON(t.chain, [])
    const step = chain[stepNo]
    if (!step) return
    const cfg = getEscalationConfig(step.role)
    const target = cfg.target_user_id
      ? userById(cfg.target_user_id)
      : (cfg.target_role ? db.prepare("SELECT * FROM users WHERE role=? ORDER BY id LIMIT 1").get(cfg.target_role) : null)
    if (!target || target.role === step.role) return // 无有效升级目标则跳过（保持原角色待办）
    const stamp = ts()
    try {
      db.prepare(`INSERT INTO approval_step_routes
        (task_id,step_no,kind,delegation_id,role,actor_user_id,actor_name,status,note,sla_hours,due_at,created_at)
        VALUES(?,?,'escalation',0,?,?,?,'active',?,?,?,?)`)
        .run(t.id, stepNo, step.role, target.id, target.name,
          `节点超过 ${cfg.sla_hours}h 未处理，超时升级给${ROLE_LABEL[target.role] || target.role}`,
          cfg.sla_hours, t.step_due_at, stamp)
    } catch (e) {
      if (!String(e?.message || '').includes('UNIQUE') && !String(e?.code || '').includes('CONSTRAINT')) throw e
      return
    }
    db.prepare('UPDATE approval_tasks SET version=version+1 WHERE id=?').run(t.id)
    db.prepare(`INSERT INTO approval_steps(task_id,step_no,role,action,actor_id,actor_name,note,acted_at)
                VALUES(?,?,?,?,?,?,?,?)`)
      .run(t.id, stepNo, step.role, 'escalate', 'system', '系统超时守护',
        `「${ROLE_LABEL[step.role] || step.role}」节点超过 ${cfg.sla_hours} 小时未处理（截止 ${t.step_due_at}），升级给 ${target.name}（${ROLE_LABEL[target.role] || target.role}）；原审批人仍可处理`, stamp)
    notify({
      recipientRole: target.role, recipientUserId: target.id,
      type: 'task_escalated',
      title: `⏰ 超时升级待审批：${TASK_TYPE_LABEL[t.type] || t.type} #${t.id}`,
      body: `原审批角色「${ROLE_LABEL[step.role] || step.role}」超时未处理，已升级给您；通过/退回均会记录升级审批`,
      taskId: t.id, appId: t.application_id, stepNo
    })
    notify({
      recipientRole: t.submitted_role,
      type: 'task_escalation_notice',
      title: `⏰ 您的${TASK_TYPE_LABEL[t.type] || t.type}申请已超时升级`,
      body: `申请 #${t.id} 在「${ROLE_LABEL[step.role] || step.role}」节点超过 ${cfg.sla_hours} 小时未处理，已升级给 ${target.name}`,
      taskId: t.id, appId: t.application_id, stepNo
    })
    out.push({ task_id: t.id, step: stepNo, role: step.role, target_user_id: target.id, target_name: target.name })
  })
  return out
}

function sweepTimeouts(at = now()) {
  return tx(() => {
    // 先收回到期委托（与撤销同一口径：在途路由作废 + 定向待办归并），再激活新窗口、升级超时任务
    const expired = expireActiveDelegations(at)
    const delegations = activateScheduledDelegations(at)
    const escalations = escalateDueTasks(at)
    return { delegations, expired, escalations, count: delegations.length + expired.length + escalations.length }
  })
}

// 生效中的委托越过结束窗口：置 expired、在途代理路由即时作废、定向待办归并（自动撤销口径）
function expireActiveDelegations(at = now()) {
  const due = db.prepare("SELECT * FROM delegations WHERE status='active' AND ends_at!='' AND ends_at<? ORDER BY id")
    .all(at)
  const expired = []
  const system = { id: 'system', name: '系统窗口守护' }
  due.forEach(d => {
    db.prepare("UPDATE delegations SET status='expired' WHERE id=?").run(d.id)
    const routes = supersedeDelegationRoutes(d, { user: system, reason: '委托时间窗到期，代理权限自动收回' })
    expired.push({ delegation_id: d.id, routes_closed: routes.length })
  })
  return expired
}

// ---------------- 委托管理 API ----------------
// 设立委托：任何用户可把「自己持有的审批角色」委托给其他角色成员（异角色，职责分离）
router.post('/delegations', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const role = String(b.granter_role || user.role)
  if (!ROLES.includes(role)) badRequest('未知审批角色', 'role_invalid')
  // 只有持有该角色的人可以设立委托
  if (user.role !== role) forbidden(`仅${ROLE_LABEL[role]}本人可以设立该角色的委托`, 'not_role_holder')
  const grantee = userById(b.grantee_id)
  if (!grantee) badRequest('代理人不存在', 'grantee_missing')
  if (grantee.id === user.id) badRequest('不能委托给自己', 'delegate_self')
  if (grantee.role === role) badRequest('同角色成员无需委托，请直接指定其处理', 'delegate_same_role')
  const reason = String(b.reason || '').trim()
  if (!reason) badRequest('委托必须填写事由（审计留痕）', 'reason_required')
  let types = Array.isArray(b.task_types) ? [...new Set(b.task_types.map(String))] : []
  const bad = types.find(t => !TASK_TYPES.includes(t))
  if (bad) badRequest(`未知审批类型：${bad}`, 'task_type_invalid')
  const starts = b.starts_at ? new Date(b.starts_at).toISOString() : ''
  const ends = b.ends_at ? new Date(b.ends_at).toISOString() : ''
  if (b.starts_at && Number.isNaN(Date.parse(b.starts_at))) badRequest('生效开始时间格式不正确', 'starts_invalid')
  if (b.ends_at && Number.isNaN(Date.parse(b.ends_at))) badRequest('生效结束时间格式不正确', 'ends_invalid')
  if (starts && ends && ends <= starts) badRequest('结束时间必须晚于开始时间', 'window_invalid')
  if (ends && ends <= new Date().toISOString()) badRequest('生效结束时间已过，请设置未来的时间窗', 'window_already_ended')

  const out = tx(() => {
    // 唯一索引兜底外的应用层检查，给出可读错误
    const dup = db.prepare(`SELECT id FROM delegations
                           WHERE grantee_id=? AND granter_role=? AND status IN ('active','scheduled')`)
      .get(grantee.id, role)
    if (dup) conflict(`代理人 ${grantee.name} 已持有「${ROLE_LABEL[role]}」的有效委托（#${dup.id}），请先撤销后再设立`, 'delegation_exists')
    const stamp = ts()
    const r = db.prepare(`INSERT INTO delegations
      (granter_role,granter_id,granter_name,grantee_id,grantee_name,scope_task_types,reason,status,starts_at,ends_at,created_by,created_at)
      VALUES(?,?,?,?,?, ?,?, ?,?,?,?,?)`)
      .run(role, user.id, user.name, grantee.id, grantee.name, JSON.stringify(types), reason,
        starts ? 'scheduled' : 'active', starts, ends, user.id, stamp)
    const id = Number(r.lastInsertRowid)
    let attachedCount = 0
    if (!starts) {
      // 立即生效：把当前等待在该角色节点的在途任务全部挂给代理人并投递定向待办
      const tasks = db.prepare("SELECT * FROM approval_tasks WHERE status='pending' ORDER BY id").all()
      tasks.forEach(t => {
        const chain = parseJSON(t.chain, [])
        const step = chain[num(t.current_step)]
        if (!step || step.role !== role) return
        if (!scopeCovers(JSON.stringify(types), t.type)) return
        attachedCount += attachDelegationRoutes(t.id, num(t.current_step), { notifyActors: true }).length
      })
      // 委托设立留痕通知（角色广播，便于角色相关成员知悉）
      notify({
        recipientRole: role, type: 'delegation_granted',
        title: `🔑 ${ROLE_LABEL[role]}审批权已委托`,
        body: `${user.name} 已把「${ROLE_LABEL[role]}」审批权委托给 ${grantee.name}（${ROLE_LABEL[grantee.role]}）：${reason}`,
        delegationId: id
      })
    }
    return { id, status: starts ? 'scheduled' : 'active', attached_tasks: attachedCount }
  })
  res.json({ ok: true, ...out })
}))

// 撤销委托：仅设立人可撤销；未消费的代理路由与定向通知在同一事务内失效/归并
router.post('/delegations/:id/revoke', wrap((req, res) => {
  const user = currentUser(req)
  const id = num(req.params.id)
  const reason = String(req.body?.reason || '').trim()
  const out = tx(() => {
    const d = getDelegation(id)
    if (!d) return { notFound: true }
    if (d.granter_id !== user.id) forbidden('仅委托设立人可以撤销该委托', 'not_granter')
    if (d.status === 'revoked') conflict('该委托已撤销', 'delegation_revoked')
    db.prepare(`UPDATE delegations SET status='revoked', revoked_by=?, revoked_at=?, revoke_reason=? WHERE id=?`)
      .run(user.id, ts(), reason, id)
    const routes = supersedeDelegationRoutes(d, { user, reason })
    notify({
      recipientRole: d.granter_role, type: 'delegation_revoked',
      title: `🔒 ${ROLE_LABEL[d.granter_role] || d.granter_role}委托已撤销`,
      body: `${user.name} 撤销了授予 ${d.grantee_name} 的代理审批权${routes.length ? `，${routes.length} 条在途待办已收回` : ''}${reason ? `：${reason}` : ''}`,
      delegationId: id
    })
    return { ok: true, routes_closed: routes.length }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// 超时/待生效委托扫描（幂等）：前端审批中心按钮与服务启动共用
router.get('/delegations/sweep', wrap((req, res) => {
  res.json({ ok: true, ...sweepTimeouts() })
}))

// 升级配置：按角色读取/修改（仅招聘负责人维护全局 SLA 与升级目标）
router.get('/escalation-config', wrap((req, res) => {
  res.json({ ok: true, config: ROLES.map(getEscalationConfig) })
}))
router.post('/escalation-config/:role', wrap((req, res) => {
  const user = currentUser(req)
  const role = String(req.params.role || '')
  if (!ROLES.includes(role)) return res.status(404).json({ ok: false, code: 'not_found' })
  if (user.role !== 'recruiter') forbidden('仅招聘负责人可维护超时升级配置', 'role_not_allowed')
  const b = req.body || {}
  const sla = Math.max(0, num(b.sla_hours, 48))
  const targetRole = String(b.target_role || '')
  if (targetRole && !ROLES.includes(targetRole)) badRequest('升级目标角色不存在', 'target_role_invalid')
  if (targetRole === role) badRequest('升级目标不能是原角色（无法形成升级）', 'target_role_same')
  let targetUserId = String(b.target_user_id || '')
  if (targetUserId) {
    const u = userById(targetUserId)
    if (!u) badRequest('指定升级人不存在', 'target_user_invalid')
    if (targetRole && u.role !== targetRole) badRequest('指定升级人的角色与升级目标角色不一致', 'target_user_role_mismatch')
  }
  tx(() => {
    db.prepare(`INSERT INTO escalation_config(role,sla_hours,target_role,target_user_id,updated_by,updated_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(role) DO UPDATE SET sla_hours=excluded.sla_hours,
                  target_role=excluded.target_role,target_user_id=excluded.target_user_id,
                  updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(role, sla, targetRole, targetUserId, user.name, ts())
  })
  res.json({ ok: true, config: getEscalationConfig(role) })
}))

// ---------------- 旧库迁移：存量在途任务补超时截止与当前有效委托路由 ----------------
function migrateApprovalRouting() {
  const at = now()
  tx(() => {
    const pending = db.prepare("SELECT * FROM approval_tasks WHERE status='pending'").all()
    pending.forEach(t => {
      const chain = parseJSON(t.chain, [])
      const step = chain[num(t.current_step)]
      if (!step) return
      if (!t.step_due_at) {
        // 存量任务从本次启动起重新计时，避免一上线就全部超时升级
        db.prepare('UPDATE approval_tasks SET step_due_at=? WHERE id=?').run(computeDueAt(step.role, at), t.id)
      }
      attachDelegationRoutes(t.id, num(t.current_step), { at, notifyActors: false })
    })
  })
}
migrateApprovalRouting()

// ---------------- 状态快照（供 /api/state 合并） ----------------
function getDelegationState() {
  const at = now()
  const delegations = db.prepare('SELECT * FROM delegations ORDER BY id DESC').all().map(d => ({
    ...d,
    scope_task_types: parseJSON(d.scope_task_types, []),
    effective_status: delegationStatus(d, at)
  }))
  const stepRoutes = db.prepare('SELECT * FROM approval_step_routes ORDER BY id DESC').all()
  const escalationConfig = ROLES.map(getEscalationConfig)
  return { delegations, stepRoutes, escalationConfig }
}

export {
  tx, notify, markTaskUnreadRead,
  findActiveDelegationForUser, getDelegation, resolveStepAuthority,
  consumeActiveRoutes, activeRoutesOfTask, attachDelegationRoutes, rearmStep,
  sweepTimeouts, getDelegationState, getEscalationConfig, computeDueAt,
  TASK_TYPES as ALL_TASK_TYPES
}
