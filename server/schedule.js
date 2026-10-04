// 候选人↔面试官双向预约沟通模块
// - 可用时段：面试官维护本人时段；候选人时段由招聘负责人代录（模拟电话/短信确认）
// - 双向确认：预约时间需候选人与面试官双方确认位都置 1 才落定为「已确认」
// - 确认改期：已确认预约可由任一方发起改期，进入 rescheduling；双方再次确认后才生效，拒绝则回退原安排
// - 提醒：sweep 扫描临近预约，分别在 24 小时 / 1 小时前向双方角色投递提醒（幂等标记）
// - 缺席：结束 15 分钟仍未签到的已确认预约系统初判缺席，招聘负责人可裁定（候选人/面试官/双方缺席）后重约
import express from 'express'
import db, { ts } from './db.js'
import { auditPassive, findActiveIncidentForApp, notifyIncidentRoles } from './crisis.js'
import {
  markUnreadScheduleRead, recordNoshowAdjudication, resolveOpenNoshows,
  upsertRescheduleRequest, settleRescheduleConfirmed, settleRescheduleRejected,
  recoverStageOnRebookConfirm, getScheduleRiskState
} from './schedule-risk.js'

export const router = express.Router()

// ---------------- 通用工具 ----------------
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const httpError = (status, code, msg) => Object.assign(new Error(msg), { status, code })
const badRequest = (m, c = 'invalid') => { throw httpError(400, c, m) }
const conflict = (m, c = 'conflict') => { throw httpError(409, c, m) }
const forbidden = (m, c = 'forbidden') => { throw httpError(403, c, m) }
const notFound = (m = '预约不存在', c = 'not_found') => { throw httpError(404, c, m) }
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

function currentUser(req) {
  const id = String(req.headers['x-user-id'] || '')
  const u = id ? db.prepare('SELECT * FROM users WHERE id=?').get(id) : null
  return u || db.prepare("SELECT * FROM users WHERE role='recruiter' ORDER BY id LIMIT 1").get()
}

const ROLE_OF_PARTY = { candidate: 'recruiter', interviewer: 'interviewer' }
const OTHER_PARTY = { candidate: 'interviewer', interviewer: 'candidate' }
const ACTIVE_STATUSES = ['negotiating', 'confirmed', 'rescheduling']
const STATUS_LABEL = {
  negotiating: '待确认', rescheduling: '改期协商中', confirmed: '已确认',
  declined: '已婉拒', completed: '已完成', no_show: '缺席未到', cancelled: '已取消'
}
const RESULT_LABEL = {
  completed: '正常完成', candidate_no_show: '候选人缺席', interviewer_no_show: '面试官缺席',
  both_no_show: '双方缺席', declined: '协商婉拒', cancelled: '预约取消'
}

// ---------------- 通知与沟通留痕 ----------------
function notifyRole(role, type, title, body, appId = 0) {
  db.prepare(`INSERT INTO notifications(recipient_role,type,title,body,application_id,is_read,created_at)
              VALUES(?,?,?,?,?,0,?)`).run(role, type, title, body, appId, ts())
}
// 向「另一方」投递：候选人侧通知招聘负责人（代为转达），面试官侧通知本人角色。
// 招聘负责人可代任一方操作：通知始终投递给被代方的相对方（候选人方动作→面试官；
// 面试官方动作→招聘负责人转达候选人），因此不存在「操作人=相对方」的自通知场景。
// 面试官本人操作时，候选人方通知给招聘负责人，由其转达。
function notifyOther(appt, actorParty, type, title, body) {
  const role = ROLE_OF_PARTY[OTHER_PARTY[actorParty]]
  if (role) notifyRole(role, type, title, body, appt.application_id)
}
// 双方通知（已确认/取消/完成/缺席等结果性事件），跳过操作人自身角色避免自通知
function notifyBoth(appt, actorRole, type, title, body) {
  ;['recruiter', 'interviewer'].forEach(role => {
    if (role !== actorRole) notifyRole(role, type, title, body, appt.application_id)
  })
}

function addMessage(apptId, { kind, party = 'system', actor, start = '', end = '', content = '' }) {
  db.prepare(`INSERT INTO appointment_messages(appointment_id,kind,party,actor_id,actor_name,start_at,end_at,content,created_at)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(apptId, kind, party, actor?.id || '', actor?.name || '', start, end, content, ts())
}

// ---------------- 时间与冲突 ----------------
function parseISO(v, field = '时间') {
  const t = new Date(v)
  if (isNaN(t.getTime())) badRequest(`${field}格式不正确`, 'time_invalid')
  return t
}
// 校验并返回 {start,end}：必须是未来时间且时长合理（15 分钟 ~ 8 小时）
function readInterval(body) {
  if (!body.start_at || !body.end_at) badRequest('请选择开始与结束时间', 'time_required')
  const start = parseISO(body.start_at, '开始时间')
  const end = parseISO(body.end_at, '结束时间')
  if (!(end - start >= 15 * 60 * 1000)) badRequest('面试时长至少 15 分钟', 'time_too_short')
  if (!(end - start <= 8 * 60 * 60 * 1000)) badRequest('面试时长不能超过 8 小时', 'time_too_long')
  if (start.getTime() <= Date.now()) badRequest('预约时间必须晚于当前时间', 'time_past')
  return { start: body.start_at, end: body.end_at }
}
const overlap = (s, e, s2, e2) => !(e <= s2 || s >= e2)

function assertNoConflict({ applicationId, interviewerId, start, end, excludeApptId = 0 }) {
  const apps = db.prepare(`SELECT id,application_id,interviewer_id,interviewer_name,start_at,end_at FROM appointments
                           WHERE status IN ('negotiating','confirmed','rescheduling') AND id<>?`)
    .all(excludeApptId)
  apps.forEach(a => {
    if (!overlap(start, end, a.start_at, a.end_at)) return
    if (String(a.interviewer_id || '') === String(interviewerId || '') && interviewerId) {
      conflict(`面试官 ${a.interviewer_name} 在该时段已有预约（#${a.id}）`, 'interviewer_busy')
    }
    if (num(a.application_id) === num(applicationId)) {
      conflict('该候选人在此时段已有进行中的预约，请勿重复安排', 'candidate_busy')
    }
  })
}

// ---------------- 时段占用（可用时段 ↔ 预约） ----------------
function occupyOwnerSlots(ownerType, ownerId, start, end, apptId) {
  const slot = db.prepare(`SELECT id FROM schedule_slots
                           WHERE owner_type=? AND owner_id=? AND status='open'
                             AND start_at<=? AND end_at>=? ORDER BY start_at LIMIT 1`)
    .get(ownerType, String(ownerId), start, end)
  if (slot) db.prepare('UPDATE schedule_slots SET status=?, appointment_id=? WHERE id=?').run('used', apptId, slot.id)
  return !!slot
}
function occupySlots(appt, start, end) {
  occupyOwnerSlots('interviewer', appt.interviewer_id, start, end, appt.id)
  const a = db.prepare('SELECT candidate_id FROM applications WHERE id=?').get(appt.application_id)
  if (a) occupyOwnerSlots('candidate', a.candidate_id, start, end, appt.id)
}
function releaseSlots(apptId) {
  db.prepare("UPDATE schedule_slots SET status='open', appointment_id=0 WHERE appointment_id=?").run(apptId)
}

// ---------------- 预约 ↔ interviews 表同步（面试评价/结论沿用既有页面） ----------------
function formatLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function syncInterview(appt, { cancelled = false, label = '' } = {}) {
  const a = db.prepare('SELECT id FROM applications WHERE id=?').get(appt.application_id)
  if (!a) return
  const exist = db.prepare('SELECT id FROM interviews WHERE application_id=? AND round=? ORDER BY id DESC LIMIT 1')
    .get(appt.application_id, appt.round)
  const text = label || (cancelled ? '预约已取消' : formatLocal(appt.start_at || appt.pending_start))
  if (exist) {
    db.prepare('UPDATE interviews SET interviewer=?, time=? WHERE id=?')
      .run(appt.interviewer_name || '面试官', text, exist.id)
  } else {
    db.prepare(`INSERT INTO interviews(application_id,interviewer,time,round,eval,result,conclusion)
                VALUES(?,?,?,?, '','pending','pending')`)
      .run(appt.application_id, appt.interviewer_name || '面试官', text, appt.round)
  }
}

// ---------------- 危机回退同步：挂起进行中的面试预约 ----------------
// 在危机模块事务内调用：negotiating/confirmed/rescheduling 一律置为 cancelled 并打 crisis_suspended 标记，
// 清空待确认提议与提醒幂等位、释放双方时段占用、同步 interviews 表并追加协商留痕；
// 不直接发通知（通知由危机模块统一投递并关联事件/责任人）。返回被挂起的预约清单供上链。
export function suspendAppointmentsForIncident(applicationId, { incidentId, actor, reason }) {
  const appId = num(applicationId)
  const rows = db.prepare(`SELECT * FROM appointments
                           WHERE application_id=? AND status IN ('negotiating','confirmed','rescheduling')
                           ORDER BY id`).all(appId)
  const stamp = ts()
  const suspended = rows.map(appt => ({
    id: appt.id, round: appt.round, status: appt.status,
    start_at: appt.start_at, end_at: appt.end_at,
    status_label: STATUS_LABEL[appt.status] || appt.status,
    interviewer_id: appt.interviewer_id, interviewer_name: appt.interviewer_name
  }))
  rows.forEach(appt => {
    db.prepare(`UPDATE appointments SET status='cancelled',final_result='cancelled',
                pending_start='',pending_end='',pending_format='',pending_location='',pending_by_party='',
                cand_confirmed=0,int_confirmed=0,reminded_24h=0,reminded_1h=0,checkin_flagged=0,
                crisis_suspended=1,incident_id=?,completed_at=?,updated_at=?,version=version+1 WHERE id=?`)
      .run(num(incidentId), stamp, stamp, appt.id)
    releaseSlots(appt.id)
    syncInterview({ ...appt, start_at: appt.start_at }, { cancelled: true, label: '危机处置：预约已挂起' })
    addMessage(appt.id, {
      kind: 'crisis_suspend', party: 'system',
      actor: actor || { id: 'system', name: '系统' },
      start: appt.status === 'rescheduling' ? (appt.pending_start || appt.start_at) : appt.start_at,
      end: appt.status === 'rescheduling' ? (appt.pending_end || appt.end_at) : appt.end_at,
      content: `危机事件处置：进行中预约同步挂起，时段已释放；原因：${reason}（可在本单重新协商恢复）`
    })
  })
  return suspended
}

// ---------------- 权限：解析「代候选人操作」的一方 ----------------
// 招聘负责人可代候选人（默认）或代面试官（电话确认后）操作；面试官只能代表本人
function resolveParty(user, body = {}, { allowRecruiter = false } = {}) {
  if (user.role === 'hiring_manager') forbidden('用人经理不参与预约协商，请切换身份', 'role_not_allowed')
  if (user.role === 'interviewer') {
    if (body.party && body.party !== 'interviewer') forbidden('面试官身份只能代表面试官一方操作', 'role_not_allowed')
    return 'interviewer'
  }
  const p = body.party === 'interviewer' ? 'interviewer' : (body.party === 'recruiter' && allowRecruiter ? 'recruiter' : 'candidate')
  return p
}
function assertActorOnAppt(user, appt, party) {
  if (user.role === 'interviewer' && String(appt.interviewer_id) !== String(user.id)) {
    forbidden('只能处理分配给您本人的预约', 'not_your_appointment')
  }
}
function getAppt(id) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(num(id))
  if (!appt) notFound()
  return appt
}
const appContext = appt => {
  const a = db.prepare(`SELECT ap.*, c.name candidate_name, p.name position_name
                        FROM applications ap
                        JOIN candidates c ON c.id=ap.candidate_id
                        JOIN positions p ON p.id=ap.position_id
                        WHERE ap.id=?`).get(appt.application_id)
  return a
}
function apptTitle(appt) {
  const ctx = appContext(appt)
  return `${ctx?.candidate_name || '候选人'} · ${ctx?.position_name || ''} · ${appt.round}`
}

// ================= 状态汇总（供 /api/state 挂载） =================
export function getScheduleState() {
  const risk = getScheduleRiskState()
  const riskByApp = new Map(risk.perApplication.map(m => [m.application_id, m]))
  const slots = db.prepare('SELECT * FROM schedule_slots ORDER BY start_at').all().map(s => ({
    ...s, owner_id: String(s.owner_id), appointment_id: num(s.appointment_id)
  }))
  const messages = db.prepare('SELECT * FROM appointment_messages ORDER BY id DESC LIMIT 1000').all()
  const appts = db.prepare('SELECT * FROM appointments ORDER BY id DESC').all().map(a => {
    const ctx = appContext(a)
    const riskOfApp = riskByApp.get(num(a.application_id)) || null
    return {
      ...a,
      cand_confirmed: !!a.cand_confirmed,
      int_confirmed: !!a.int_confirmed,
      reminded_24h: !!a.reminded_24h,
      reminded_1h: !!a.reminded_1h,
      checkin_flagged: !!a.checkin_flagged,
      crisis_suspended: !!a.crisis_suspended,
      incident_id: num(a.incident_id),
      candidate: ctx?.candidate_name || '',
      position: ctx?.position_name || '',
      candidate_id: ctx?.candidate_id ? num(ctx.candidate_id) : 0,
      app_stage: ctx?.stage || '',
      status_label: STATUS_LABEL[a.status] || a.status,
      result_label: RESULT_LABEL[a.final_result] || '',
      time_label: formatLocal(a.start_at),
      pending_time_label: formatLocal(a.pending_start),
      risk: riskOfApp ? {
        risk_level: riskOfApp.risk_level,
        risk_level_label: riskOfApp.risk_level_label,
        noshow_occasions: riskOfApp.noshow_occasions,
        open_noshow: riskOfApp.open_noshow,
        open_candidate_noshow: riskOfApp.open_candidate_noshow,
        reschedule_count: riskOfApp.reschedule_count,
        rebook_count: riskOfApp.rebook_count
      } : null,
      messages: messages.filter(m => m.appointment_id === a.id)
        .sort((x, y) => x.id - y.id)
    }
  })
  return { slots, appointments: appts, scheduleRisk: risk }
}

// ================= 可用时段 =================
// 新增单个可用时段；面试官只能维护本人时段，招聘负责人可代录任意一方
router.post('/slots', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const ownerType = b.owner_type === 'interviewer' ? 'interviewer' : 'candidate'
  let ownerId = String(b.owner_id || '')
  if (user.role === 'interviewer') {
    if (ownerType !== 'interviewer' || (ownerId && ownerId !== user.id)) forbidden('面试官只能维护本人的可用时段', 'role_not_allowed')
    ownerId = user.id
  } else if (user.role === 'hiring_manager') {
    forbidden('用人经理不维护可用时段', 'role_not_allowed')
  }
  if (!ownerId) badRequest('缺少时段归属人', 'owner_required')
  if (ownerType === 'interviewer' && !db.prepare('SELECT id FROM users WHERE id=? AND role=?').get(ownerId, 'interviewer')) {
    badRequest('面试官不存在', 'interviewer_missing')
  }
  if (ownerType === 'candidate' && !db.prepare('SELECT id FROM candidates WHERE id=?').get(ownerId)) {
    badRequest('候选人不存在', 'candidate_missing')
  }
  const { start, end } = readInterval(b)
  const out = tx(() => {
    const dup = db.prepare(`SELECT id FROM schedule_slots WHERE owner_type=? AND owner_id=? AND NOT(?>=end_at OR ?<=start_at)`)
      .get(ownerType, ownerId, start, end)
    if (dup) conflict('与该归属人已有时段重叠', 'slot_overlap')
    const r = db.prepare(`INSERT INTO schedule_slots(owner_type,owner_id,start_at,end_at,source,status,note,created_by,created_at)
                          VALUES(?,?,?,?,?,'open',?,?,?)`)
      .run(ownerType, ownerId, start, end,
        user.role === 'interviewer' ? 'self' : (b.source || (ownerType === 'candidate' ? 'recruiter' : 'self')),
        b.note || '', user.id, ts())
    return { id: Number(r.lastInsertRowid) }
  })
  res.json({ ok: true, ...out })
}))

// 批量生成工作日时段：{owner_type, owner_id, date(YYYY-MM-DD), starts:['10:00',...], duration:60}
router.post('/slots/bulk', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  if (user.role === 'hiring_manager') forbidden('用人经理不维护可用时段', 'role_not_allowed')
  const ownerType = b.owner_type === 'candidate' ? 'candidate' : 'interviewer'
  let ownerId = String(b.owner_id || '')
  if (user.role === 'interviewer') ownerId = user.id
  if (!ownerId) badRequest('缺少时段归属人', 'owner_required')
  const date = String(b.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) badRequest('请选择日期', 'date_invalid')
  const starts = Array.isArray(b.starts) ? b.starts : []
  const duration = Math.min(480, Math.max(15, num(b.duration, 60)))
  if (!starts.length) badRequest('请至少勾选一个开始时刻', 'starts_required')
  const out = tx(() => {
    let created = 0
    starts.forEach(hhmm => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm))
      if (!m) return
      const s = new Date(`${date}T${String(hhmm).padStart(5, '0')}:00`)
      const e = new Date(s.getTime() + duration * 60000)
      if (isNaN(s.getTime()) || s.getTime() <= Date.now()) return
      const start = s.toISOString(), end = e.toISOString()
      const dup = db.prepare(`SELECT id FROM schedule_slots WHERE owner_type=? AND owner_id=? AND NOT(?>=end_at OR ?<=start_at)`)
        .get(ownerType, ownerId, start, end)
      if (dup) return
      db.prepare(`INSERT INTO schedule_slots(owner_type,owner_id,start_at,end_at,source,status,note,created_by,created_at)
                  VALUES(?,?,?,?,?,'open',?,?,?)`)
        .run(ownerType, ownerId, start, end, user.role === 'interviewer' ? 'self' : 'recruiter',
          b.note || '', user.id, ts())
      created++
    })
    return { created }
  })
  res.json({ ok: true, created: out.created })
}))

router.delete('/slots/:id', wrap((req, res) => {
  const user = currentUser(req)
  const id = num(req.params.id)
  const out = tx(() => {
    const s = db.prepare('SELECT * FROM schedule_slots WHERE id=?').get(id)
    if (!s) return { notFound: true }
    if (user.role === 'hiring_manager') forbidden('无权删除时段', 'role_not_allowed')
    if (user.role === 'interviewer' && !(s.owner_type === 'interviewer' && s.owner_id === user.id)) {
      forbidden('只能删除本人的可用时段', 'role_not_allowed')
    }
    if (s.status !== 'open') conflict('该时段已被预约占用，请先取消/改期对应预约', 'slot_used')
    db.prepare('DELETE FROM schedule_slots WHERE id=?').run(id)
    return { ok: true }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found' })
  res.json(out)
}))

// ================= 发起预约（双向协商起点） =================
// body: {application_id, interviewer_id, round, format, location, start_at, end_at, note,
//        cand_confirmed?, int_confirmed?}
// 面试官发起：面试官确认位自动置 1；招聘负责人发起：可代候选人/面试官预置确认位，双方都确认则直接成立
router.post('/appointments', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const appId = num(b.application_id)
  const out = tx(() => {
    const a = db.prepare('SELECT * FROM applications WHERE id=?').get(appId)
    if (!a) return { notFound: true }
    if (a.stage === 'rejected') conflict('候选人已淘汰，不能安排预约；请先复活流程', 'terminal_locked')
    if (a.stage === 'hired') conflict('候选人已录用，无需再安排面试预约', 'terminal_locked')

    let interviewerId, interviewerName
    if (user.role === 'interviewer') {
      interviewerId = user.id; interviewerName = user.name
    } else if (user.role === 'recruiter') {
      const iv = db.prepare("SELECT * FROM users WHERE id=? AND role='interviewer'").get(String(b.interviewer_id || ''))
      if (!iv) badRequest('请选择面试官', 'interviewer_required')
      interviewerId = iv.id; interviewerName = iv.name
    } else {
      forbidden('用人经理不能发起预约', 'role_not_allowed')
    }

    const round = String(b.round || '初试')
    const dup = db.prepare(`SELECT id FROM appointments
                            WHERE application_id=? AND round=? AND status IN ('negotiating','confirmed','rescheduling')`)
      .get(appId, round)
    if (dup) conflict(`该候选人「${round}」已有进行中的预约 #${dup.id}`, 'appointment_duplicate')

    const { start, end } = readInterval(b)
    assertNoConflict({ applicationId: appId, interviewerId, start, end })

    let candBit = 0, intBit = 0, actorParty = 'recruiter'
    if (user.role === 'interviewer') {
      intBit = 1; actorParty = 'interviewer'
    } else {
      candBit = b.cand_confirmed === false ? 0 : 1   // 招聘负责人发起默认已与候选人电话确认
      intBit = b.int_confirmed === true ? 1 : 0
      actorParty = candBit ? 'candidate' : 'recruiter'
    }
    const confirmed = candBit && intBit
    const stamp = ts()
    const r = db.prepare(`INSERT INTO appointments
      (application_id,round,interviewer_id,interviewer_name,status,format,location,start_at,end_at,
       cand_confirmed,int_confirmed,note,created_by,created_at,confirmed_at,updated_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`)
      .run(appId, round, interviewerId, interviewerName,
        confirmed ? 'confirmed' : 'negotiating',
        String(b.format || '线上'), String(b.location || ''), start, end,
        candBit, intBit, String(b.note || ''), user.id, stamp, confirmed ? stamp : '', stamp)
    const apptId = Number(r.lastInsertRowid)
    const appt = getAppt(apptId)
    addMessage(apptId, {
      kind: 'create', party: actorParty, actor: user, start, end,
      content: b.note || (confirmed
        ? '双方时间已确认，预约成立'
        : `发起预约：${formatLocal(start)}（${b.format || '线上'}），待${candBit ? '面试官' : '候选人'}确认`)
    })
    if (confirmed) {
      occupySlots(appt, start, end)
      notifyBoth(appt, user.role, 'sched_confirmed', '面试预约已确认',
        `「${apptTitle(appt)}」已定于 ${formatLocal(start)}，请注意准时参加`)
    } else if (candBit) {
      notifyRole('interviewer', 'sched_proposed', '新的面试预约待您确认',
        `「${apptTitle(appt)}」候选人已确认 ${formatLocal(start)}，待您确认`, appId)
    } else {
      notifyRole('recruiter', 'sched_proposed', '面试预约已发起，待候选人确认',
        `「${apptTitle(appt)}」面试官建议 ${formatLocal(start)}，请联系候选人确认`, appId)
    }
    syncInterview(appt)
    return { ok: true, id: apptId, status: appt.status }
  })
  if (out.notFound) return res.status(404).json({ ok: false, code: 'not_found', msg: '应聘记录不存在' })
  res.json(out)
}))

// 内部：双方确认位齐备时落定（negotiating→confirmed / rescheduling→confirmed）
// skipAudit：调用方（危机挂起后直接重约确认）已自行上链时，避免重复写审计条目
// party：由哪一方的确认补齐备位；给出时按「通知被代方的相对方」投递，避免代操作自通知；
//        不给出（双方确认位预置直接成立的场景）则按操作人角色通知双方
function tryFullyConfirmed(appt, user, { skipAudit = false, party = '' } = {}) {
  const isReschedule = appt.status === 'rescheduling'
  const wasRebookOpen = appt.status === 'negotiating' && !!db.prepare(
    `SELECT id FROM schedule_risk_events WHERE appointment_id=? AND kind='noshow' AND status='open' LIMIT 1`
  ).get(appt.id)
  if (isReschedule) {
    // 改期双方确认：提议时间落定为正式时间
    const start = appt.pending_start, end = appt.pending_end
    assertNoConflict({ applicationId: appt.application_id, interviewerId: appt.interviewer_id, start, end, excludeApptId: appt.id })
    db.prepare(`UPDATE appointments SET status='confirmed',start_at=?,end_at=?,format=COALESCE(NULLIF(pending_format,''),format),
                location=COALESCE(NULLIF(pending_location,''),location),pending_start='',pending_end='',pending_format='',pending_location='',
                pending_by_party='',confirmed_at=?,updated_at=?,version=version+1 WHERE id=?`)
      .run(start, end, ts(), ts(), appt.id)
    Object.assign(appt, getAppt(appt.id))
    occupySlots(appt, start, end)
    settleRescheduleConfirmed(appt.id)
    addMessage(appt.id, {
      kind: 'confirm', party: 'system', actor: user, start, end,
      content: `双方已确认改期，新时间：${formatLocal(start)}`
    })
    // 改期确认落定：协商过程中的改期请求/单方确认未读通知归并，只保留最终确认一条
    markUnreadScheduleRead(appt.application_id, { types: ['sched_reschedule_request', 'sched_partial'] })
  } else {
    db.prepare(`UPDATE appointments SET status='confirmed',confirmed_at=?,updated_at=?,version=version+1 WHERE id=?`)
      .run(ts(), ts(), appt.id)
    Object.assign(appt, getAppt(appt.id))
    occupySlots(appt, appt.start_at, appt.end_at)
    // 缺席重约后双方确认：缺席场次闭环（resolved），责任记录保留
    if (wasRebookOpen) resolveOpenNoshows(appt.id, { actor: user, via: 'rebook_confirm' })
    addMessage(appt.id, {
      kind: 'confirm', party: 'system', actor: user, start: appt.start_at, end: appt.end_at,
      content: `双方已确认，预约成立：${formatLocal(appt.start_at)}`
    })
  }
  syncInterview(appt)
  // 危机挂起/缺席重约的预约在双方确认落定后：面试流程正式恢复；若回退把应用带到筛选阶段，
  // 这里在同一事务把阶段恢复回面试（复用主流程状态机），恢复动作与确认一起上链，审计/阶段同生共死
  let stageRecovered = null
  if (!skipAudit && (num(appt.incident_id) || wasRebookOpen) && findActiveIncidentForApp(appt.application_id)) {
    if (num(appt.incident_id)) stageRecovered = recoverStageOnRebookConfirm(appt, user)
    auditPassive({
      category: 'rollback', action: 'schedule.confirmed', actor: user, applicationId: appt.application_id,
      refType: 'appointment', refId: appt.id,
      summary: `危机相关预约 #${appt.id} 双方确认成立，面试流程恢复：${formatLocal(appt.start_at)}`
        + (stageRecovered ? '；招聘阶段同步恢复回「面试」' : ''),
      detail: {
        appointment_id: appt.id, incident_id: num(appt.incident_id), round: appt.round,
        start_at: appt.start_at, end_at: appt.end_at,
        via: isReschedule ? 'reschedule_confirm' : (wasRebookOpen ? 'rebook_confirm' : 'resume_confirm'),
        stage_recovered: stageRecovered ? { from: stageRecovered.from, to: stageRecovered.to } : null,
        by: { id: user.id, name: user.name, role: user.role }
      }
    })
    if (stageRecovered) notifyIncidentRoles('crisis_stage_recovered', {
      title: '♻️ 关联危机事件：面试阶段已随重约确认恢复',
      body: `预约 #${appt.id} 双方确认，「${apptTitle(appt)}」恢复进行；回退到筛选的应聘阶段已同步恢复回面试（操作人：${user.name}）`,
      appId: appt.application_id, incidentId: stageRecovered.incident_id
    })
  }
  // 协商期间的待确认通知在最终成立时统一归并（重约确认路径清理 rebooked 提醒），铃铛不残留旧待办
  if (wasRebookOpen) {
    markUnreadScheduleRead(appt.application_id, { types: ['sched_rebooked', 'sched_partial', 'sched_proposed'] })
  }
  if (party) {
    notifyOther(appt, party, 'sched_confirmed', '面试预约已确认',
      `「${apptTitle(appt)}」已定于 ${formatLocal(appt.start_at)}（${appt.format}${appt.location ? ' · ' + appt.location : ''}）`)
  } else {
    notifyBoth(appt, user.role, 'sched_confirmed', '面试预约已确认',
      `「${apptTitle(appt)}」已定于 ${formatLocal(appt.start_at)}（${appt.format}${appt.location ? ' · ' + appt.location : ''}）`)
  }
}

// 单方确认
router.post('/appointments/:id/confirm', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (!['negotiating', 'rescheduling'].includes(appt.status)) conflict('当前状态无需确认', 'status_not_pending')
    const party = resolveParty(user, b)
    assertActorOnAppt(user, appt, party)
    const targetTime = appt.status === 'rescheduling' ? appt.pending_start : appt.start_at
    if (!targetTime) badRequest('没有待确认的时间提议', 'no_pending_proposal')
    if (new Date(targetTime).getTime() <= Date.now()) conflict('提议时间已过，请发起新的改期', 'proposal_expired')

    if (party === 'interviewer' && appt.int_confirmed) return { ok: true, idempotent: true, status: appt.status }
    if (party === 'candidate' && appt.cand_confirmed) return { ok: true, idempotent: true, status: appt.status }

    if (party === 'interviewer') {
      db.prepare('UPDATE appointments SET int_confirmed=1, updated_at=? WHERE id=?').run(ts(), appt.id)
    } else {
      db.prepare('UPDATE appointments SET cand_confirmed=1, updated_at=? WHERE id=?').run(ts(), appt.id)
    }
    Object.assign(appt, getAppt(appt.id))
    addMessage(appt.id, {
      kind: 'confirm', party, actor: user, start: targetTime,
      end: appt.status === 'rescheduling' ? appt.pending_end : appt.end_at,
      content: (party === 'interviewer' ? '面试官' : '候选人') + '已确认该时间'
    })
    if (appt.cand_confirmed && appt.int_confirmed) {
      tryFullyConfirmed(appt, user, { party })
    } else {
      const waiting = appt.cand_confirmed ? '面试官' : '候选人'
      notifyOther(appt, party, 'sched_partial', '预约一方已确认',
        `「${apptTitle(appt)}」${party === 'interviewer' ? '面试官' : '候选人'}已确认，待${waiting}确认`)
    }
    return { ok: true, status: getAppt(appt.id).status }
  })
  res.json(out)
}))

// 发起改期 / 协商中更新提议：重置双方确认位，提议方置 1；已确认预约进入 rescheduling 并释放原占用
router.post('/appointments/:id/propose', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (!['negotiating', 'confirmed', 'rescheduling'].includes(appt.status)) {
      conflict('当前状态不能改期；缺席/取消后请使用「重新预约」', 'status_no_reschedule')
    }
    const party = resolveParty(user, b)
    assertActorOnAppt(user, appt, party)
    const { start, end } = readInterval(b)
    assertNoConflict({ applicationId: appt.application_id, interviewerId: appt.interviewer_id, start, end, excludeApptId: appt.id })

    const fmt = b.format !== undefined ? String(b.format) : ''
    const loc = b.location !== undefined ? String(b.location) : ''
    const reason = String(b.reason || '')
    if (appt.status === 'confirmed' && !reason.trim()) badRequest('改期必须填写原因', 'reason_required')

    if (appt.status === 'negotiating') {
      // 尚未成立：直接更换提议时间，双方重新确认
      db.prepare(`UPDATE appointments SET start_at=?,end_at=?,cand_confirmed=?,int_confirmed=?,updated_at=?,version=version+1 WHERE id=?`)
        .run(start, end, party === 'candidate' ? 1 : 0, party === 'interviewer' ? 1 : 0, ts(), appt.id)
      Object.assign(appt, getAppt(appt.id))
      addMessage(appt.id, { kind: 'propose', party, actor: user, start, end, content: reason || '更新了提议时间' })
      // 提议时间即面试页展示的待确认时间，保持 interviews 表同步
      syncInterview(appt)
    } else {
      // confirmed / rescheduling：原时间保留，提议放入 pending；进入/保持改期协商
      releaseSlots(appt.id)
      db.prepare(`UPDATE appointments SET status='rescheduling',pending_start=?,pending_end=?,pending_format=?,pending_location=?,
                  pending_by_party=?,cand_confirmed=?,int_confirmed=?,checkin_flagged=0,reminded_24h=0,reminded_1h=0,
                  updated_at=?,version=version+1 WHERE id=?`)
        .run(start, end, fmt, loc, party,
          party === 'candidate' ? 1 : 0, party === 'interviewer' ? 1 : 0, ts(), appt.id)
      Object.assign(appt, getAppt(appt.id))
      addMessage(appt.id, {
        kind: 'propose', party, actor: user, start, end,
        content: `申请改期至 ${formatLocal(start)}${reason ? `；原因：${reason}` : ''}`
      })
      // 统一责任判定：改期责任归发起方；同一次协商内反复更新提议只保留一条风险台账
      const req = upsertRescheduleRequest(appt, { party, reason, actor: user, incidentId: appt.incident_id })
      // 协商中再次更新提议：旧的改期请求通知已被新提议取代，归并未读避免同事项多红点
      if (req?.duplicated) {
        markUnreadScheduleRead(appt.application_id, { types: ['sched_reschedule_request'] })
      }
    }
    const other = party === 'candidate' ? '面试官' : '候选人'
    notifyOther(appt, party, 'sched_reschedule_request',
      appt.status === 'rescheduling' ? '收到改期申请，待确认' : '预约时间已更新，待确认',
      `「${apptTitle(appt)}」${party === 'candidate' ? '候选人' : '面试官'}提议 ${formatLocal(start)}，待${other}确认`)
    return { ok: true, status: appt.status }
  })
  res.json(out)
}))

// 拒绝改期：维持原时间，预约回到已确认（原时间双方曾共同确认）
router.post('/appointments/:id/reject-reschedule', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (appt.status !== 'rescheduling') conflict('仅改期协商中的预约可以拒绝改期', 'not_rescheduling')
    const party = resolveParty(user, b)
    assertActorOnAppt(user, appt, party)
    const note = String(b.note || '')
    if (!note.trim()) badRequest('请填写拒绝改期的说明', 'note_required')
    // 改期协商期间原时段已释放，可能已被其他预约占用；拒绝改期前必须重新校验原时间，
    // 冲突则拒绝回退（维持 rescheduling），由双方另行提议，避免确认位/时段/状态错配
    assertNoConflict({ applicationId: appt.application_id, interviewerId: appt.interviewer_id,
      start: appt.start_at, end: appt.end_at, excludeApptId: appt.id })
    db.prepare(`UPDATE appointments SET status='confirmed',pending_start='',pending_end='',pending_format='',pending_location='',
                pending_by_party='',cand_confirmed=1,int_confirmed=1,reminded_24h=0,reminded_1h=0,checkin_flagged=0,
                updated_at=?,version=version+1 WHERE id=?`)
      .run(ts(), appt.id)
    Object.assign(appt, getAppt(appt.id))
    occupySlots(appt, appt.start_at, appt.end_at)
    // 改期被拒绝：回到已确认，该次改期责任不落地（rejected，不计入风险次数）
    settleRescheduleRejected(appt.id)
    addMessage(appt.id, {
      kind: 'reject_reschedule', party, actor: user, start: appt.start_at, end: appt.end_at,
      content: `不同意改期，维持原时间 ${formatLocal(appt.start_at)}；说明：${note}`
    })
    // 协商期间的改期请求/单方确认未读通知随拒绝一并归并
    markUnreadScheduleRead(appt.application_id, { types: ['sched_reschedule_request', 'sched_partial'] })
    notifyOther(appt, party, 'sched_reschedule_rejected', '改期申请被拒绝',
      `「${apptTitle(appt)}」维持原时间 ${formatLocal(appt.start_at)}：${note}`)
    return { ok: true, status: 'confirmed' }
  })
  res.json(out)
}))

// 婉拒：协商未成，放弃本轮预约（释放时段占用）
router.post('/appointments/:id/decline', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (!['negotiating', 'rescheduling'].includes(appt.status)) conflict('仅协商中的预约可以婉拒', 'status_not_pending')
    const party = resolveParty(user, b)
    assertActorOnAppt(user, appt, party)
    const reason = String(b.reason || '')
    if (!reason.trim()) badRequest('请填写婉拒原因', 'reason_required')
    db.prepare(`UPDATE appointments SET status='declined',final_result='declined',
                pending_start='',pending_end='',pending_format='',pending_location='',pending_by_party='',
                cand_confirmed=0,int_confirmed=0,reminded_24h=0,reminded_1h=0,checkin_flagged=0,
                updated_at=?,completed_at=?,version=version+1 WHERE id=?`).run(ts(), ts(), appt.id)
    Object.assign(appt, getAppt(appt.id))
    releaseSlots(appt.id)
    syncInterview(appt, { cancelled: true })
    addMessage(appt.id, { kind: 'decline', party, actor: user, content: `婉拒本轮预约：${reason}` })
    // 婉拒后协商期间的待确认/改期通知全部失效，归并为已读
    markUnreadScheduleRead(appt.application_id, {
      types: ['sched_proposed', 'sched_partial', 'sched_reschedule_request', 'sched_rebooked']
    })
    notifyOther(appt, party, 'sched_declined', '面试预约被婉拒',
      `「${apptTitle(appt)}」${party === 'candidate' ? '候选人' : '面试官'}婉拒：${reason}`)
    return { ok: true, status: 'declined' }
  })
  res.json(out)
}))

// 取消已确认预约
router.post('/appointments/:id/cancel', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (appt.status !== 'confirmed') conflict('仅已确认的预约可以取消；协商中可婉拒', 'not_confirmed')
    if (user.role === 'hiring_manager') forbidden('用人经理不能取消预约', 'role_not_allowed')
    if (user.role === 'interviewer' && String(appt.interviewer_id) !== String(user.id)) forbidden('只能取消本人的预约', 'not_your_appointment')
    const reason = String(b.reason || '')
    if (!reason.trim()) badRequest('取消预约必须填写原因', 'reason_required')
    db.prepare(`UPDATE appointments SET status='cancelled',final_result='cancelled',updated_at=?,completed_at=?,version=version+1 WHERE id=?`)
      .run(ts(), ts(), appt.id)
    Object.assign(appt, getAppt(appt.id))
    releaseSlots(appt.id)
    syncInterview(appt, { cancelled: true })
    addMessage(appt.id, {
      kind: 'cancel', party: user.role === 'interviewer' ? 'interviewer' : 'recruiter',
      actor: user, start: appt.start_at, end: appt.end_at, content: `取消预约：${reason}`
    })
    // 取消后改期请求/提醒等未读通知全部失效，统一归并
    markUnreadScheduleRead(appt.application_id)
    notifyBoth(appt, user.role, 'sched_cancelled', '面试预约已取消',
      `「${apptTitle(appt)}」原定于 ${formatLocal(appt.start_at)} 的预约已取消：${reason}`)
    return { ok: true, status: 'cancelled' }
  })
  res.json(out)
}))

// 重新协商：婉拒/取消后在同一预约单上重启协商（保留历史时间线）
router.post('/appointments/:id/resume', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (!['declined', 'cancelled'].includes(appt.status)) conflict('仅婉拒/取消的预约可以重新协商', 'not_resumable')
    if (user.role === 'hiring_manager') forbidden('用人经理不能重启预约', 'role_not_allowed')
    if (user.role === 'interviewer' && String(appt.interviewer_id) !== String(user.id)) forbidden('只能处理分配给您本人的预约', 'not_your_appointment')
    const wasCrisisSuspended = !!appt.crisis_suspended
    const crisisIncidentId = num(appt.incident_id)
    const { start, end } = readInterval(b)
    assertNoConflict({ applicationId: appt.application_id, interviewerId: appt.interviewer_id, start, end, excludeApptId: appt.id })
    // 代操作方在发起重协时视为该方已电话确认，确认位置给被代方；
    // 招聘负责人若已同时与另一方电话确认，可预置对方确认位直接成立
    const party = resolveParty(user, b)
    let candBit = party === 'candidate' ? 1 : 0
    let intBit = party === 'interviewer' ? 1 : 0
    if (user.role === 'recruiter') {
      if (b.cand_confirmed === true) candBit = 1
      if (b.int_confirmed === true) intBit = 1
    }
    const confirmed = candBit && intBit
    db.prepare(`UPDATE appointments SET status=?,start_at=?,end_at=?,pending_start='',pending_end='',pending_format='',pending_location='',
                pending_by_party='',cand_confirmed=?,int_confirmed=?,final_result='',checkin_flagged=0,reminded_24h=0,reminded_1h=0,
                crisis_suspended=0,
                format=COALESCE(NULLIF(?, ''),format),location=COALESCE(NULLIF(?, ''),location),
                confirmed_at=?,completed_at='',updated_at=?,version=version+1 WHERE id=?`)
      .run(confirmed ? 'confirmed' : 'negotiating', start, end, candBit, intBit,
        String(b.format || ''), String(b.location || ''), confirmed ? ts() : '', ts(), appt.id)
    Object.assign(appt, getAppt(appt.id))
    addMessage(appt.id, {
      kind: wasCrisisSuspended ? 'crisis_resume' : 'resume', party,
      actor: user, start, end,
      content: wasCrisisSuspended
        ? `危机挂起后恢复协商：${formatLocal(start)}（重约恢复后续面试流程）`
        : `重新发起预约协商：${formatLocal(start)}`
    })
    syncInterview(appt)
    // 危机挂起的预约在原单上重约恢复：仅当关联事件仍在处置中，同事务被动追加审计条目
    let stageRecovered = null
    if (wasCrisisSuspended && crisisIncidentId && findActiveIncidentForApp(appt.application_id)) {
      // 双方确认位预置直接成立：阶段恢复也在本事务完成（后续单方确认补齐走 tryFullyConfirmed）
      if (confirmed) stageRecovered = recoverStageOnRebookConfirm(appt, user)
      auditPassive({
        category: 'rollback', action: 'schedule.rebook', actor: user, applicationId: appt.application_id,
        refType: 'appointment', refId: appt.id,
        summary: confirmed
          ? `危机挂起预约 #${appt.id} 已重约并双方确认，面试流程恢复：${formatLocal(start)}`
            + (stageRecovered ? '；招聘阶段同步恢复回「面试」' : '')
          : `危机挂起预约 #${appt.id} 已重新约期，待对方确认后恢复：${formatLocal(start)}`,
        detail: {
          appointment_id: appt.id, incident_id: crisisIncidentId, round: appt.round,
          start_at: start, end_at: end, confirmed,
          stage_recovered: stageRecovered ? { from: stageRecovered.from, to: stageRecovered.to } : null,
          resumed_by: { id: user.id, name: user.name, role: user.role }
        }
      })
      if (stageRecovered) notifyIncidentRoles('crisis_stage_recovered', {
        title: '♻️ 关联危机事件：面试阶段已随重约恢复',
        body: `挂起预约 #${appt.id} 已重约确认，「${apptTitle(appt)}」恢复进行；应聘阶段同步恢复回面试（操作人：${user.name}）`,
        appId: appt.application_id, incidentId: stageRecovered.incident_id
      })
    }
    if (confirmed) {
      occupySlots(appt, start, end)
      // 挂起时危机回退已把旧通知归并；重约直接成立时再清一遍可能的残留待确认通知
      markUnreadScheduleRead(appt.application_id, { types: ['sched_proposed', 'sched_partial', 'sched_rebooked'] })
      notifyBoth(appt, user.role, 'sched_confirmed', '面试预约已重新确认',
        `「${apptTitle(appt)}」已定于 ${formatLocal(start)}`)
    } else {
      notifyOther(appt, party, 'sched_proposed', '预约已重新发起，待确认',
        `「${apptTitle(appt)}」新提议 ${formatLocal(start)}，待确认`)
    }
    return { ok: true, status: appt.status }
  })
  res.json(out)
}))

// 缺席后重新约：no_show → negotiating（清空缺席标记，保留历史，沿用同一预约单）
router.post('/appointments/:id/rebook', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (appt.status !== 'no_show') conflict('仅缺席未到的预约可以重新约期', 'not_no_show')
    if (user.role === 'hiring_manager') forbidden('用人经理不能重新约期', 'role_not_allowed')
    if (user.role === 'interviewer' && String(appt.interviewer_id) !== String(user.id)) forbidden('只能处理本人的预约', 'not_your_appointment')
    const { start, end } = readInterval(b)
    assertNoConflict({ applicationId: appt.application_id, interviewerId: appt.interviewer_id, start, end, excludeApptId: appt.id })
    const party = resolveParty(user, b)
    const keptResult = appt.final_result
    db.prepare(`UPDATE appointments SET status='negotiating',start_at=?,end_at=?,pending_start='',pending_end='',
                cand_confirmed=?,int_confirmed=?,final_result='',checkin_flagged=0,reminded_24h=0,reminded_1h=0,
                completed_at='',updated_at=?,version=version+1 WHERE id=?`)
      .run(start, end, party === 'candidate' ? 1 : 0, party === 'interviewer' ? 1 : 0, ts(), appt.id)
    Object.assign(appt, getAppt(appt.id))
    addMessage(appt.id, {
      kind: 'rebook', party, actor: user, start, end,
      content: `缺席后重新约期：${formatLocal(start)}，待对方确认`
    })
    syncInterview(appt)
    // 仅关联处置中危机事件的应聘才被动上链：缺席重约意味着面试流程重新启动
    if (findActiveIncidentForApp(appt.application_id)) {
      auditPassive({
        category: 'rollback', action: 'schedule.rebook', actor: user, applicationId: appt.application_id,
        refType: 'appointment', refId: appt.id,
        summary: `缺席预约 #${appt.id} 已重新约期（保留缺席记录），待确认后恢复：${formatLocal(start)}`,
        detail: {
          appointment_id: appt.id, round: appt.round, start_at: start, end_at: end,
          kept_result: keptResult, by_party: party, by: { id: user.id, name: user.name, role: user.role }
        }
      })
    }
    notifyOther(appt, party, 'sched_rebooked', '缺席后已重新约期，待确认',
      `「${apptTitle(appt)}」缺席记录保留，新提议 ${formatLocal(start)}，请确认`)
    // 旧的缺席裁定通知已被「重约待确认」取代，归并未读避免铃铛同时挂两个同场次待办
    markUnreadScheduleRead(appt.application_id, { types: ['sched_noshow'] })
    return { ok: true, status: 'negotiating' }
  })
  res.json(out)
}))

// 标记完成（双方到场、面试结束）
router.post('/appointments/:id/complete', wrap((req, res) => {
  const user = currentUser(req)
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (appt.status !== 'confirmed') conflict('仅已确认的预约可以标记完成', 'not_confirmed')
    if (user.role === 'hiring_manager') forbidden('用人经理不能标记完成', 'role_not_allowed')
    if (user.role === 'interviewer' && String(appt.interviewer_id) !== String(user.id)) forbidden('只能处理本人的预约', 'not_your_appointment')
    const stamp = ts()
    db.prepare(`UPDATE appointments SET status='completed',final_result='completed',checkin_flagged=0,completed_at=?,updated_at=?,version=version+1 WHERE id=?`)
      .run(stamp, stamp, appt.id)
    Object.assign(appt, getAppt(appt.id))
    addMessage(appt.id, {
      kind: 'complete', party: user.role === 'interviewer' ? 'interviewer' : 'recruiter',
      actor: user, start: appt.start_at, content: req.body?.note ? `面试已完成：${req.body.note}` : '双方到场，面试已完成，可录入面试评价与结论'
    })
    // 完成后提醒/改期等待未读通知失效，归并为已读（保留缺席等结果类通知历史）
    markUnreadScheduleRead(appt.application_id, {
      types: ['sched_remind', 'sched_remind_24h', 'sched_remind_1h', 'sched_reschedule_request', 'sched_partial', 'sched_proposed']
    })
    notifyBoth(appt, user.role, 'sched_completed', '面试已完成',
      `「${apptTitle(appt)}」已于 ${formatLocal(appt.start_at)} 完成，等待面试结论`)
    return { ok: true, status: 'completed' }
  })
  res.json(out)
}))

// 缺席裁定：候选人缺席 / 面试官缺席 / 双方缺席（招聘负责人；系统 sweep 用 auto_noshow）
// 统一走 schedule_risk_events 责任台账：同结论重复裁定/扫描幂等（不重复通知），改判旧场次置 superseded
function adjudicateNoShow(appt, { result, bySystem = false, note = '', actor = null }) {
  const incidentId = num(appt.incident_id)
  const r = recordNoshowAdjudication(appt, {
    result, source: bySystem ? 'auto' : 'manual', actor, note, incidentId
  })
  if (r.error) badRequest(r.error, r.code)
  if (r.idempotent) return { idempotent: true }
  const stamp = ts()
  db.prepare(`UPDATE appointments SET status='no_show',final_result=?,checkin_flagged=1,completed_at=?,updated_at=?,version=version+1 WHERE id=?`)
    .run(result, stamp, stamp, appt.id)
  Object.assign(appt, getAppt(appt.id))
  releaseSlots(appt.id)
  addMessage(appt.id, {
    kind: bySystem ? 'auto_noshow' : 'noshow',
    party: bySystem ? 'system' : 'recruiter',
    actor: actor || { id: 'system', name: '系统' },
    start: appt.start_at,
    content: `${RESULT_LABEL[result]}${note ? `：${note}` : ''}${bySystem ? '（系统按结束后 15 分钟未签到初判，可由招聘负责人改判）' : r.occurrence > 1 ? `（第 ${r.occurrence} 场缺席）` : ''}`
  })
  const title = bySystem ? '系统初判：面试缺席' : (r.occurrence > 1 ? `面试缺席已记录（第 ${r.occurrence} 场）` : '面试缺席已记录')
  // 改判场景：上一条缺席通知已被新结论取代，归并后只通知最新责任判定
  markUnreadScheduleRead(appt.application_id, { types: ['sched_noshow'] })
  notifyBoth(appt, actor?.role || '', 'sched_noshow', title,
    `「${apptTitle(appt)}」原定于 ${formatLocal(appt.start_at)}：${RESULT_LABEL[result]}，请尽快重新约期或改判`)
  // 关联处置中危机事件：缺席裁定也是关键处置事实，同事务被动上链（责任判定随台账口径）
  if (findActiveIncidentForApp(appt.application_id)) {
    auditPassive({
      category: 'action', action: 'schedule.noshow', actor: actor || { id: 'system', name: '系统', role: 'system' },
      applicationId: appt.application_id, refType: 'appointment', refId: appt.id,
      summary: `预约 #${appt.id} 缺席裁定（第 ${r.occurrence} 场）：${RESULT_LABEL[result]}`,
      detail: {
        appointment_id: appt.id, round: appt.round, result,
        responsible_party: { candidate_no_show: 'candidate', interviewer_no_show: 'interviewer', both_no_show: 'both' }[result],
        occurrence: r.occurrence, source: bySystem ? 'auto' : 'manual', note,
        by: actor ? { id: actor.id, name: actor.name, role: actor.role } : { id: 'system', name: '系统' }
      }
    })
  }
  return { idempotent: false, occurrence: r.occurrence }
}
router.post('/appointments/:id/noshow', wrap((req, res) => {
  const user = currentUser(req)
  const b = req.body || {}
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (!['confirmed', 'no_show'].includes(appt.status)) conflict('仅已确认/已初判缺席的预约可以裁定缺席', 'not_confirmed')
    if (user.role !== 'recruiter') forbidden('缺席裁定需由招聘负责人处理', 'role_not_allowed')
    adjudicateNoShow(appt, { result: String(b.result || ''), note: String(b.note || ''), actor: user })
    return { ok: true, status: 'no_show', final_result: appt.final_result }
  })
  res.json(out)
}))

// 手动发送提醒（立即向双方推送，不改幂等标记）
router.post('/appointments/:id/remind', wrap((req, res) => {
  const user = currentUser(req)
  const out = tx(() => {
    const appt = getAppt(num(req.params.id))
    if (appt.status !== 'confirmed') conflict('仅已确认的预约可以发送提醒', 'not_confirmed')
    if (user.role === 'hiring_manager') forbidden('用人经理不发送提醒', 'role_not_allowed')
    addMessage(appt.id, { kind: 'remind', party: user.role === 'interviewer' ? 'interviewer' : 'recruiter', actor: user, start: appt.start_at, content: '手动发送了会前提醒' })
    notifyBoth(appt, user.role, 'sched_remind', '面试提醒（手动）',
      `「${apptTitle(appt)}」将于 ${formatLocal(appt.start_at)} 开始（${appt.format}${appt.location ? ' · ' + appt.location : ''}），请提前 10 分钟到场`)
    return { ok: true }
  })
  res.json(out)
}))

// ---------------- 定时扫描：提醒 + 缺席初判（前端页面加载时触发，幂等） ----------------
// - 开始前 24 小时窗口：首次提醒（双方）
// - 开始前 1 小时窗口：临近提醒（双方）
// - 结束 15 分钟后仍「已确认」且无完成记录：系统初判候选人缺席，待招聘负责人裁定/改判
router.get('/sweep', wrap((req, res) => {
  const user = currentUser(req)
  if (user.role !== 'recruiter') forbidden('提醒扫描仅招聘负责人可触发', 'role_not_allowed')
  const result = tx(() => {
    const nowMs = Date.now()
    let reminded24 = 0, reminded1 = 0, noShow = 0
    const confirmed = db.prepare("SELECT * FROM appointments WHERE status='confirmed'").all()
    confirmed.forEach(appt => {
      const startMs = new Date(appt.start_at).getTime()
      const endMs = new Date(appt.end_at).getTime()
      if (!isFinite(startMs)) return
      const title = apptTitle(appt)
      const place = `${appt.format}${appt.location ? ' · ' + appt.location : ''}`
      if (!appt.reminded_24h && startMs - nowMs <= 24 * 3600 * 1000 && startMs > nowMs) {
        db.prepare('UPDATE appointments SET reminded_24h=1 WHERE id=?').run(appt.id)
        addMessage(appt.id, { kind: 'remind24h', party: 'system', actor: { id: 'system', name: '系统' }, start: appt.start_at, content: '开始前 24 小时提醒已自动发送给双方' })
        notifyRole('interviewer', 'sched_remind_24h', '【24小时】明日面试提醒',
          `「${title}」将于 ${formatLocal(appt.start_at)} 开始（${place}），请提前安排时间`, appt.application_id)
        notifyRole('recruiter', 'sched_remind_24h', '【24小时】候选人明日面试提醒',
          `「${title}」将于 ${formatLocal(appt.start_at)} 开始，请提醒候选人准时参加（${place}）`, appt.application_id)
        reminded24++
      }
      if (!appt.reminded_1h && startMs - nowMs <= 3600 * 1000 && startMs > nowMs) {
        db.prepare('UPDATE appointments SET reminded_1h=1 WHERE id=?').run(appt.id)
        addMessage(appt.id, { kind: 'remind1h', party: 'system', actor: { id: 'system', name: '系统' }, start: appt.start_at, content: '开始前 1 小时临近提醒已自动发送给双方' })
        notifyRole('interviewer', 'sched_remind_1h', '【1小时】面试即将开始',
          `「${title}」将于 1 小时内开始（${formatLocal(appt.start_at)}，${place}），请提前 10 分钟到场`, appt.application_id)
        notifyRole('recruiter', 'sched_remind_1h', '【1小时】候选人面试临近',
          `「${title}」将于 1 小时内开始（${formatLocal(appt.start_at)}），请最后确认候选人到场方式：${place}`, appt.application_id)
        reminded1++
      }
      // 结束超过 15 分钟宽限期仍处已确认：初判缺席（默认候选人未到；若面试官也未到可由招聘负责人改判双方）
      if (!appt.checkin_flagged && nowMs > endMs + 15 * 60 * 1000) {
        const r = adjudicateNoShow(appt, { result: 'candidate_no_show', bySystem: true })
        if (!r.idempotent) noShow++
      }
    })
    return { reminded24, reminded1, noShow }
  })
  res.json({ ok: true, ...result, swept_at: ts() })
}))
