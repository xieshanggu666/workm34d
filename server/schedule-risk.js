// 预约结果 → 统一责任判定 / 风险台账 / 通知去重 / 危机阶段恢复
// 缺席（系统初判与招聘负责人裁定/改判）、改期、重约三类结果统一写入 schedule_risk_events：
//  - 责任判定：候选人缺席→candidate，面试官缺席→interviewer，双方缺席→both；改期/重约按发起方
//  - 改判幂等：同一缺席场次的旧裁定置 superseded；同结论重复裁定不重复发通知
//  - 闭环：缺席重约且双方再次确认后该场次 resolved；仍 open 的候选人责任场次拦截进入 Offer
//  - 危机一致：重约/确认恢复在同一事务被动上链；关联处置中事件且回退到筛选的，随确认恢复回面试阶段
import db, { ts } from './db.js'

export const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

export const NOSHOW_RESULTS = ['candidate_no_show', 'interviewer_no_show', 'both_no_show']
// 缺席类型 → 责任方（统一责任判定口径，报表/阶段闸门/通知文案共用）
export const PARTY_OF_NOSHOW = {
  candidate_no_show: 'candidate',
  interviewer_no_show: 'interviewer',
  both_no_show: 'both'
}
export const PARTY_LABEL = {
  candidate: '候选人责任', interviewer: '面试官责任', both: '双方责任', system: '系统初判', '': '—'
}
export const RISK_LEVEL_LABEL = { high: '高风险', mid: '中风险', low: '低关注', none: '无风险' }

// 主流程注入的能力：阶段恢复复用与普通推进/回退完全相同的状态机；事件审计钩子由 schedule.js 注入
let core = null
export function bindScheduleCore(c) { core = c }

// ---------------- 通知去重 ----------------
// 结果性事件（改判/重约/完成/取消/改期确认/拒绝改期）发生后，把该应聘同类型的旧未读预约通知
// 统一归并为已读，铃铛/红点只保留最新一条待办，避免一个场次刷出多条失效提醒
export function markUnreadScheduleRead(applicationId, { types = null, excludeTypes = [], limitIds = null } = {}) {
  const appId = num(applicationId)
  if (!appId) return 0
  const clauses = ['application_id=?', 'is_read=0', "type LIKE 'sched_%'"]
  const vals = [appId]
  if (Array.isArray(types) && types.length) {
    clauses.push(`type IN (${types.map(() => '?').join(',')})`)
    vals.push(...types)
  }
  if (excludeTypes.length) {
    clauses.push(`type NOT IN (${excludeTypes.map(() => '?').join(',')})`)
    vals.push(...excludeTypes)
  }
  if (Array.isArray(limitIds) && limitIds.length) {
    clauses.push(`id NOT IN (${limitIds.map(() => '?').join(',')})`)
    vals.push(...limitIds.map(num))
  }
  const rows = db.prepare(`SELECT id FROM notifications WHERE ${clauses.join(' AND ')}`).all(...vals)
  if (rows.length) {
    const marks = rows.map(() => '?').join(',')
    db.prepare(`UPDATE notifications SET is_read=1 WHERE id IN (${marks})`).run(...rows.map(r => r.id))
  }
  return rows.length
}

// ---------------- 缺席场次台账 ----------------
// 该预约当前未闭环的缺席场次（status=open）；改判前的同场次旧裁定据此置 superseded
function openNoshowRow(appointmentId) {
  return db.prepare(`SELECT * FROM schedule_risk_events
                     WHERE appointment_id=? AND kind='noshow' AND status='open'
                     ORDER BY id DESC LIMIT 1`).get(num(appointmentId)) || null
}
// 该预约已发生过的缺席场次数（含已闭环、含被改判取代的场次，按场次号去重）
function noshowOccasionCount(appointmentId) {
  const row = db.prepare(`SELECT COUNT(DISTINCT occurrence) c FROM schedule_risk_events
                          WHERE appointment_id=? AND kind='noshow'`).get(num(appointmentId))
  return num(row?.c)
}

// 记录一次缺席裁定/系统初判/改判。返回 { idempotent, occurrence, changed }
//  - 与当前结论相同（含系统对已初判场次的重复扫描）：幂等，不发新通知
//  - 改判：同场次旧行 superseded，新结论沿用同一场次号，责任判定随之刷新
export function recordNoshowAdjudication(appt, { result, source = 'manual', actor = null, note = '', incidentId = 0 }) {
  if (!NOSHOW_RESULTS.includes(result)) return { error: '缺席类型不正确', code: 'result_invalid' }
  const stamp = ts()
  const open = openNoshowRow(appt.id)
  if (open && open.result === result) return { idempotent: true, occurrence: num(open.occurrence), changed: false }
  let occurrence
  if (open) {
    occurrence = num(open.occurrence)
    db.prepare(`UPDATE schedule_risk_events SET status='superseded', active=0, resolved_at=? WHERE id=?`)
      .run(stamp, open.id)
  } else {
    occurrence = noshowOccasionCount(appt.id) + 1
  }
  const r = db.prepare(`INSERT INTO schedule_risk_events
    (application_id,appointment_id,kind,result,responsible_party,occurrence,source,active,status,reason,
     actor_id,actor_name,actor_role,incident_id,created_at,resolved_at)
    VALUES(?,?, 'noshow', ?,?,?,?, 1,'open', ?,?,?,?,?,?, '')`)
    .run(appt.application_id, appt.id, result, PARTY_OF_NOSHOW[result], occurrence,
      source, note || '', actor?.id || (source === 'auto' ? 'system' : ''),
      actor?.name || (source === 'auto' ? '系统' : ''),
      actor?.role || (source === 'auto' ? 'system' : 'recruiter'), num(incidentId), stamp)
  return { id: Number(r.lastInsertRowid), idempotent: false, occurrence, changed: true }
}

// 缺席后重新约期：当前 open 缺席场次标记 resolved（保留历史行，责任判定留痕）
export function resolveOpenNoshows(appointmentId, { actor = null, via = 'rebook' } = {}) {
  const stamp = ts()
  const rows = db.prepare(`SELECT * FROM schedule_risk_events
                           WHERE appointment_id=? AND kind='noshow' AND status='open' ORDER BY id`).all(num(appointmentId))
  rows.forEach(row => {
    db.prepare(`UPDATE schedule_risk_events SET status='resolved', active=0, resolved_at=? WHERE id=?`).run(stamp, row.id)
  })
  if (rows.length) {
    const first = rows[0]
    db.prepare(`INSERT INTO schedule_risk_events
      (application_id,appointment_id,kind,result,responsible_party,occurrence,source,active,status,reason,
       actor_id,actor_name,actor_role,incident_id,created_at,resolved_at)
      VALUES(?,?, 'rebook','', ?,?, 'manual',1,'done', ?,?,?,?,?, ?,?)`)
      .run(first.application_id, first.appointment_id, first.responsible_party, num(first.occurrence),
        `缺席场次重约闭环（${via}）`, actor?.id || '', actor?.name || '', actor?.role || '',
        num(first.incident_id), stamp, stamp)
  }
  return rows.length
}

// ---------------- 改期台账 ----------------
// 已确认预约发起改期：同一预约单保留一条 active=1 的 requested 记录（反复更新提议不重复计数）；
// 待确认阶段（negotiating）更换提议时间不算正式改期，责任与风险均不累计
export function upsertRescheduleRequest(appt, { party, reason = '', actor = null, incidentId = 0 }) {
  if (appt.status !== 'confirmed' && appt.status !== 'rescheduling') return null
  const exist = db.prepare(`SELECT id FROM schedule_risk_events
                            WHERE appointment_id=? AND kind='reschedule' AND status='requested'
                            ORDER BY id DESC LIMIT 1`).get(appt.id)
  const stamp = ts()
  if (exist) {
    db.prepare(`UPDATE schedule_risk_events SET reason=?, actor_id=?, actor_name=?, actor_role=?, created_at=? WHERE id=?`)
      .run(reason, actor?.id || '', actor?.name || '', actor?.role || '', stamp, exist.id)
    return { id: exist.id, duplicated: true }
  }
  const r = db.prepare(`INSERT INTO schedule_risk_events
    (application_id,appointment_id,kind,result,responsible_party,occurrence,source,active,status,reason,
     actor_id,actor_name,actor_role,incident_id,created_at,resolved_at)
    VALUES(?,?, 'reschedule','', ?,0,'manual',1,'requested', ?,?,?,?,?,?, '')`)
    .run(appt.application_id, appt.id, party === 'interviewer' ? 'interviewer' : 'candidate',
      reason, actor?.id || '', actor?.name || '', actor?.role || '', num(incidentId), stamp)
  return { id: Number(r.lastInsertRowid), duplicated: false }
}

// 改期双方确认落定：申请记录置 confirmed（计入已落地改期次数）
export function settleRescheduleConfirmed(appointmentId) {
  const stamp = ts()
  const n = db.prepare(`UPDATE schedule_risk_events SET status='confirmed', resolved_at=?
                        WHERE appointment_id=? AND kind='reschedule' AND status='requested'`)
    .run(ts(), num(appointmentId)).changes
  return num(n)
}
// 拒绝改期：协商回到已确认，改期申请置 rejected 且不再计入风险（active=0）
export function settleRescheduleRejected(appointmentId) {
  const n = db.prepare(`UPDATE schedule_risk_events SET status='rejected', active=0, resolved_at=?
                        WHERE appointment_id=? AND kind='reschedule' AND status='requested'`)
    .run(ts(), num(appointmentId)).changes
  return num(n)
}

// ---------------- 阶段闸门：候选人责任的未闭环缺席 ----------------
export function openNoshowOfApp(applicationId) {
  return db.prepare(`SELECT * FROM schedule_risk_events
                     WHERE application_id=? AND kind='noshow' AND status='open'
                     ORDER BY id DESC`).all(num(applicationId))
}
// 候选人方需承担责任（候选人缺席/双方缺席）且未重约闭环的场次；面试官责任不拦截候选人推进
export function candidateOpenNoshow(applicationId) {
  return openNoshowOfApp(applicationId).filter(r => ['candidate', 'both'].includes(r.responsible_party))
}
export function assertNoOpenCandidateNoshow(applicationId) {
  const rows = candidateOpenNoshow(applicationId)
  if (rows.length) {
    const apps = db.prepare('SELECT a.id FROM appointments a WHERE a.id=?').get(rows[0].appointment_id)
    const err = new Error(`该候选人有 ${rows.length} 场缺席尚未重新约期闭环（预约 #${rows[0].appointment_id}），请先完成缺席重约再进入 Offer`)
    err.status = 409
    err.code = 'noshow_open'
    throw err
  }
}

// ---------------- 危机回退一致性：重约确认后的阶段恢复 ----------------
// 危机回退到筛选/投递时进行中预约被挂起；之后在原单重约并双方确认，且应用已随回退停在筛选阶段时，
// 在同一事务把阶段恢复回面试（复用主流程 moveStage），并由调用方被动上链。回退到投递的不自动跨两级。
// 已有待审推进任务时不自动恢复，避免与审批链双轨。
export function recoverStageOnRebookConfirm(appt, actor) {
  if (!core?.moveStageForSchedule) return null
  const inc = core.findActiveIncident ? core.findActiveIncident(appt.application_id) : null
  if (!inc) return null
  const crisisLinked = num(appt.incident_id) === num(inc.id) || !!appt.crisis_suspended
  if (!crisisLinked) return null
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(appt.application_id)
  if (!a || a.stage !== 'screening') return null
  const pending = db.prepare("SELECT COUNT(*) c FROM approval_tasks WHERE application_id=? AND type='stage_advance' AND status='pending'")
    .get(a.id)?.c
  if (num(pending) > 0) return null
  const r = core.moveStageForSchedule(a, 'interview', {
    operator: actor?.name || '系统', eventType: 'rollback', fromStage: 'screening'
  })
  return { from: 'screening', to: 'interview', snapshot: r?.snapshot || null, incident_id: num(inc.id) }
}

// ---------------- 风险汇总（供 /api/state 的 scheduleRisk 字段） ----------------
const NOSHOW_PARTY_LABEL = { candidate: '候选人', interviewer: '面试官', both: '双方' }

export function getScheduleRiskState() {
  const events = db.prepare('SELECT * FROM schedule_risk_events ORDER BY id DESC LIMIT 2000').all()
    .map(e => ({ ...e, occurrence: num(e.occurrence), incident_id: num(e.incident_id), active: !!e.active }))

  // 每个应用的风险画像：缺席按「场次」去重（改判沿用同场次号），改期只统计已落地（confirmed）
  const byApp = new Map()
  const ensureApp = id => {
    if (!byApp.has(id)) byApp.set(id, {
      application_id: id,
      noshow_occasions: 0,
      open_noshow: 0,
      open_candidate_noshow: 0,
      candidate_noshow: 0,
      interviewer_noshow: 0,
      both_noshow: 0,
      reschedule_count: 0,
      rebook_count: 0,
      last_at: ''
    })
    return byApp.get(id)
  }
  // 场次去重：appointment_id×occurrence 以「最新一条裁定」为准（改判把旧行置 superseded 后插入新行）
  const occasionLatest = new Map()
  events.slice().reverse().forEach(e => {
    const m = ensureApp(e.application_id)
    if (e.created_at > m.last_at) m.last_at = e.created_at
    if (e.kind === 'noshow') {
      // 正序遍历：后到的改判行覆盖同 key 的初判行
      occasionLatest.set(`${e.appointment_id}:${e.occurrence}`, e)
    } else if (e.kind === 'reschedule' && e.status === 'confirmed') {
      m.reschedule_count++
    } else if (e.kind === 'rebook' && e.status === 'done') {
      m.rebook_count++
    }
  })
  // 按应用归集每个缺席场次的最新裁定（时间线已按时间正序，Map 中保留的即最新）
  for (const e of occasionLatest.values()) {
    const m = ensureApp(e.application_id)
    m.noshow_occasions++
    if (e.status === 'open') {
      m.open_noshow++
      if (['candidate', 'both'].includes(e.responsible_party)) m.open_candidate_noshow++
    }
    if (e.responsible_party === 'candidate') m.candidate_noshow++
    else if (e.responsible_party === 'interviewer') m.interviewer_noshow++
    else if (e.responsible_party === 'both') m.both_noshow++
  }

  const perApplication = [...byApp.values()].map(m => {
    let level = 'none'
    if (m.open_candidate_noshow > 0 || m.noshow_occasions >= 2) level = 'high'
    else if (m.noshow_occasions > 0 || m.reschedule_count >= 2) level = 'mid'
    else if (m.reschedule_count > 0 || m.rebook_count > 0) level = 'low'
    return { ...m, risk_level: level, risk_level_label: RISK_LEVEL_LABEL[level] }
  }).sort((a, b) => (b.noshow_occasions - a.noshow_occasions) || (b.reschedule_count - a.reschedule_count))

  const held = db.prepare(`SELECT COUNT(*) c FROM appointments WHERE status IN ('negotiating','confirmed','rescheduling')`).get()?.c || 0
  const completed = db.prepare(`SELECT COUNT(*) c FROM appointments WHERE status='completed'`).get()?.c || 0
  const noshowApps = db.prepare(`SELECT COUNT(*) c FROM appointments WHERE status='no_show'`).get()?.c || 0

  // 总体口径：缺席场次（按去重场次）/ 已完成 + 缺席场次
  const totalOccasions = perApplication.reduce((s, m) => s + m.noshow_occasions, 0)
  const resolvedOccasions = totalOccasions - perApplication.reduce((s, m) => s + m.open_noshow, 0)
  return {
    events,
    perApplication,
    summary: {
      held_appointments: num(held),
      completed: num(completed),
      no_show_appointments: num(noshowApps),
      noshow_occasions: totalOccasions,
      open_noshow: perApplication.reduce((s, m) => s + m.open_noshow, 0),
      candidate_noshow: perApplication.reduce((s, m) => s + m.candidate_noshow, 0),
      interviewer_noshow: perApplication.reduce((s, m) => s + m.interviewer_noshow, 0),
      both_noshow: perApplication.reduce((s, m) => s + m.both_noshow, 0),
      resolved_occasions: resolvedOccasions,
      rebook_count: perApplication.reduce((s, m) => s + m.rebook_count, 0),
      reschedule_count: perApplication.reduce((s, m) => s + m.reschedule_count, 0),
      high_risk_apps: perApplication.filter(m => m.risk_level === 'high').length,
      mid_risk_apps: perApplication.filter(m => m.risk_level === 'mid').length,
      // 缺席率 = 缺席场次 /（已完成预约 + 缺席场次）；重约后完成的预约仍保留缺席场次证据
      noshow_rate: (completed + totalOccasions)
        ? Math.round(totalOccasions / (num(completed) + totalOccasions) * 100)
        : 0
    }
  }
}

// ---------------- 旧库回填：从预约状态 + 只追加沟通时间线重建风险台账 ----------------
// 仅在台账为空时执行；缺席场次以当前 no_show 预约为准，改期以 reschedule 类消息为准，重约以 rebook 消息为准
export function migrateScheduleRisk() {
  const n = db.prepare('SELECT COUNT(*) c FROM schedule_risk_events').get()?.c
  if (num(n) > 0) return
  const stamp = ts()
  const resultByLabel = label => {
    if (label.includes('双方')) return 'both_no_show'
    if (label.includes('面试官')) return 'interviewer_no_show'
    return 'candidate_no_show'
  }
  const appts = db.prepare('SELECT * FROM appointments').all()
  let backfilled = 0
  appts.forEach(appt => {
    const msgs = db.prepare('SELECT * FROM appointment_messages WHERE appointment_id=? ORDER BY id ASC').all(appt.id)
    // 缺席：以最新一条 noshow/auto_noshow 消息重建一场（历史改判旧库无结构化记录，按最新责任口径）
    const lastNoshow = msgs.filter(m => m.kind === 'noshow' || m.kind === 'auto_noshow').at(-1)
    const hasRebook = msgs.some(m => m.kind === 'rebook' || m.kind === 'crisis_resume')
    if (lastNoshow) {
      const result = NOSHOW_RESULTS.includes(appt.final_result)
        ? appt.final_result
        : resultByLabel(lastNoshow.content || '')
      const open = appt.status === 'no_show'
      db.prepare(`INSERT INTO schedule_risk_events
        (application_id,appointment_id,kind,result,responsible_party,occurrence,source,active,status,reason,
         actor_id,actor_name,actor_role,incident_id,created_at,resolved_at)
        VALUES(?,?,'noshow',?,?,1,?,?,?,'旧库台账回填',?,?,?,?,?,?)`)
        .run(appt.application_id, appt.id, result, PARTY_OF_NOSHOW[result],
          lastNoshow.kind === 'auto_noshow' ? 'auto' : 'manual',
          open ? 1 : 0, open ? 'open' : 'resolved',
          lastNoshow.actor_id, lastNoshow.actor_name, lastNoshow.party === 'system' ? 'system' : 'recruiter',
          num(appt.incident_id), lastNoshow.created_at || stamp, open ? '' : stamp)
      backfilled++
      if (!open && hasRebook) {
        db.prepare(`INSERT INTO schedule_risk_events
          (application_id,appointment_id,kind,result,responsible_party,occurrence,source,active,status,reason,
           actor_id,actor_name,actor_role,incident_id,created_at,resolved_at)
          VALUES(?,?,'rebook','',?,1,'manual',1,'done','旧库台账回填：缺席重约',?,?,?,?,?,?)`)
          .run(appt.application_id, appt.id, PARTY_OF_NOSHOW[result],
            'system', '系统', 'system', num(appt.incident_id), stamp, stamp)
      }
    }
    // 改期：被拒绝（reject_reschedule）的协商不计入；当前仍在 rescheduling 计 requested，曾经确认落地计 confirmed
    const requested = msgs.filter(m => m.kind === 'propose').length
    const rejected = msgs.filter(m => m.kind === 'reject_reschedule').length
    const landed = Math.max(0, requested - rejected)
    if (landed > 0 || appt.status === 'rescheduling') {
      const status = appt.status === 'rescheduling' ? 'requested' : 'confirmed'
      const proposal = msgs.filter(m => m.kind === 'propose').at(-1)
      db.prepare(`INSERT INTO schedule_risk_events
        (application_id,appointment_id,kind,result,responsible_party,occurrence,source,active,status,reason,
         actor_id,actor_name,actor_role,incident_id,created_at,resolved_at)
        VALUES(?,?,'reschedule','',?,0,'migration',?,?,'旧库台账回填',?,?,?,?,?,?)`)
        .run(appt.application_id, appt.id,
          proposal?.party === 'interviewer' ? 'interviewer' : 'candidate',
          status === 'requested' ? 1 : 0, status,
          proposal?.actor_id || '', proposal?.actor_name || '', proposal?.party || '',
          num(appt.incident_id), proposal?.created_at || stamp, status === 'requested' ? '' : stamp)
      backfilled++
    }
  })
  if (backfilled) console.log(`[HR] backfilled ${backfilled} schedule risk event(s) from appointment timeline`)
}
