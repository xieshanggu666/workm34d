import { defineStore } from 'pinia'

const BASE = '/api'
// 当前登录身份（演示环境顶栏切换，持久化到 localStorage）；每次请求携带供服务端做角色权限校验
let currentUserId = localStorage.getItem('hr-user-id') || 'u-sandy'
async function j(method, path, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json', 'x-user-id': currentUserId } }
  if (body !== undefined) opt.body = JSON.stringify(body)
  let r
  try {
    r = await fetch(BASE + path, opt)
  } catch {
    throw Object.assign(new Error('网络异常，请稍后重试'), { code: 'network' })
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.msg || '操作失败'), { code: data.code || `http_${r.status}`, data })
  return data
}

export const useHrStore = defineStore('hr', {
  state: () => ({
    data: null,
    loaded: false,
    userId: currentUserId,
    // 全局轻提示：服务端 4xx 约束（重复操作/状态冲突/乐观锁）统一在此提示，保证各页面口径一致
    toast: null,
    // 进行中的操作键（如 advance:3）：按钮置灰，防止重复点击/并发提交
    pending: {}
  }),
  getters: {
    positions: s => s.data?.positions || [],
    candidates: s => s.data?.candidates || [],
    applications: s => s.data?.applications || [],
    interviews: s => s.data?.interviews || [],
    offers: s => s.data?.offers || [],
    offerLogs: s => s.data?.offerLogs || [],
    channels: s => s.data?.channels || [],
    matches: s => s.data?.matches || [],
    strategyVersions: s => s.data?.strategyVersions || [],
    recalcJobs: s => s.data?.recalcJobs || [],
    recalcItems: s => s.data?.recalcItems || [],
    users: s => s.data?.users || [],
    approvals: s => s.data?.approvals || [],
    notifications: s => s.data?.notifications || [],
    // 按角色审批委托 / 超时升级规则
    delegations: s => s.data?.delegations || [],
    escalationRules: s => s.data?.escalationRules || [],
    activeDelegations(s) {
      return this.delegations.filter(d => d.status === 'active' && (!d.expires_at || new Date(d.expires_at) > new Date()))
    },
    // 我作为代理人持有的有效委托
    myDelegated(s) {
      return this.activeDelegations.filter(d => d.delegatee_id === s.userId)
    },
    // 我委托给别人的有效委托
    myDelegationsOut(s) {
      return this.activeDelegations.filter(d => d.delegator_id === s.userId)
    },
    userById() {
      return id => (this.data?.users || []).find(u => u.id === id) || null
    },
    // 跨角色危机处置审计
    crisisIncidents: s => s.data?.crisisIncidents || [],
    crisisEntries: s => s.data?.crisisEntries || [],
    crisisGrants: s => s.data?.crisisGrants || [],
    crisisTickets: s => s.data?.crisisTickets || [],
    crisisReports: s => s.data?.crisisReports || [],
    crisisVerification: s => s.data?.crisisVerification || {},
    // 候选人↔面试官双向预约
    scheduleSlots: s => s.data?.slots || [],
    appointments: s => s.data?.appointments || [],
    // 预约结果风险台账（缺席责任/改期/重约 → 统一口径供报表与看板使用）
    scheduleRisk: s => s.data?.scheduleRisk || { summary: {}, perApplication: [], events: [] },
    appRisk: s => appId =>
      (s.data?.scheduleRisk?.perApplication || []).find(m => m.application_id === appId) || null,
    defaultStrategy: s => s.data?.defaultStrategy || { weights: { skill: 0.4, year: 0.2, salary: 0.15, edu: 0.15, city: 0.1 }, keywordCap: 5 },
    openPositions: s => (s.data?.positions || []).filter(p => p.status === 'open'),
    isBusy: s => key => !!s.pending[key],
    // 当前身份与角色能力：关键动作（提请推进/给结论/发起 Offer/审批）按角色在 UI 层前置拦截
    currentUser(s) { return (s.data?.users || []).find(u => u.id === s.userId) || null },
    myRole() { return this.currentUser?.role || 'recruiter' },
    // 通知：角色桶（recipient_id 为空）+ 定向给本人的代理/升级个人通知
    myNotifications() {
      return this.notifications.filter(n =>
        n.recipient_role === this.myRole || n.recipient_id === this.userId)
    },
    unreadCount() { return this.myNotifications.filter(n => !n.is_read).length },
    // 我对某任务当前节点是否有审批权：直接（角色匹配）或持有有效委托（类型/应聘范围匹配）
    myStepAuthority: s => (task, stepOverride = null) => {
      const me = s.currentUser
      if (!me) return null
      const step = stepOverride || task?.chain?.[task.current_step]
      if (!step) return null
      if (me.role === step.role) return { via: 'direct', role: step.role }
      const nowMs = Date.now()
      for (const d of s.activeDelegations) {
        if (d.delegatee_id !== me.id || d.role !== step.role) continue
        if (d.task_types?.length && !d.task_types.includes(task.type)) continue
        if (d.scope === 'applications' && task.application_id &&
            !(d.application_ids || []).includes(Number(task.application_id))) continue
        if (d.expires_at && new Date(d.expires_at).getTime() <= nowMs) continue
        return { via: 'delegate', role: step.role, delegation: d }
      }
      return null
    },
    // 某应聘是否存在进行中的审批（可选指定类型）：看板/面试/Offer 页用来显示「审批中」并禁止重复提请
    pendingTask: s => (appId, type) =>
      (s.data?.approvals || []).find(t => t.application_id === appId && t.status === 'pending' && (!type || t.type === type)) || null,
    // 待当前身份审批的任务数（直接审批 + 代理审批），审批中心红点口径
    todoCount() {
      return this.approvals.filter(t =>
        t.status === 'pending' && !!this.myStepAuthority(t)).length
    },
    // 预约协商待办：面试官=待本人确认/改期确认的预约；招聘负责人=待候选人确认 + 系统初判缺席待裁定
    scheduleTodoCount() {
      const my = this.currentUser
      return this.appointments.filter(a => {
        if (my?.role === 'interviewer') {
          return (a.status === 'negotiating' || a.status === 'rescheduling') &&
            a.interviewer_id === my.id && !a.int_confirmed
        }
        if (my?.role === 'recruiter') {
          return ((a.status === 'negotiating' || a.status === 'rescheduling') && !a.cand_confirmed) ||
            (a.status === 'no_show' && a.checkin_flagged)
        }
        return false
      }).length
    }
  },
  actions: {
    notify(type, msg) {
      this.toast = { type, msg, at: Date.now() }
      if (this._toastTimer) clearTimeout(this._toastTimer)
      this._toastTimer = setTimeout(() => { this.toast = null }, 3600)
    },
    // 串行化同一键的操作：重复触发直接复用进行中的 Promise，杜绝重复提交
    async runBusy(key, fn) {
      if (this.pending[key]) return this.pending[key]
      const p = Promise.resolve().then(fn)
      this.pending = { ...this.pending, [key]: p }
      try {
        return await p
      } finally {
        const next = { ...this.pending }
        delete next[key]
        this.pending = next
      }
    },
    async refresh() {
      try {
        this.data = await j('GET', '/state')
        this.loaded = true
      } catch (e) {
        this.notify('error', e.message)
      }
    },
    async api(method, path, body, opts = {}) {
      try {
        const r = await j(method, path, body)
        await this.refresh()
        if (opts.success) this.notify('success', opts.success)
        return r
      } catch (e) {
        // 版本冲突说明页面数据已过期，先刷新再提示
        if (e.code === 'version_conflict') await this.refresh()
        this.notify('error', e.message)
        return null
      }
    },
    async matchPos(pid) {
      try { return await j('GET', `/match/pos/${pid}`) } catch (e) { this.notify('error', e.message); return null }
    },
    async matchCand(cid) {
      try { return await j('GET', `/match/cand/${cid}`) } catch (e) { this.notify('error', e.message); return null }
    },
    async summary() {
      try { return await j('GET', '/summary') } catch { return null }
    },
    async getStrategy(pid) {
      try { return await j('GET', `/positions/${pid}/strategy`) } catch (e) { this.notify('error', e.message); return null }
    },
    publishStrategy(pid, payload) { return this.api('POST', `/positions/${pid}/strategy`, payload) },
    promoteStrategy(versionId) {
      return this.runBusy(`strategy-promote:${versionId}`, () =>
        this.api('POST', `/strategy-versions/${versionId}/promote`, {}, { success: '灰度版本已全量生效并重算' }))
    },
    rollbackStrategy(versionId, reason) {
      return this.runBusy(`strategy-rollback:${versionId}`, () =>
        this.api('POST', `/strategy-versions/${versionId}/rollback`, { reason }, { success: '策略已回滚，批量重算已完成' }))
    },
    resubmitStrategy(id, payload) {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/resubmit`, { payload }, { success: '策略发布申请已修改重提' }))
    },
    sweepStrategies() {
      return this.runBusy('strategy-sweep', async () => {
        try {
          const r = await j('GET', '/strategies/sweep')
          await this.refresh()
          this.notify('success', r.count ? `已推进 ${r.count} 个生效窗口` : '生效窗口已是最新')
          return r
        } catch (e) { this.notify('error', e.message); return null }
      })
    },
    recomputeAll(positionId) {
      return this.api('POST', '/match/recompute', positionId ? { position_id: positionId } : {})
    },
    addPosition(p) { return this.api('POST', '/positions', p) },
    updatePosition(id, p) { return this.api('POST', `/positions/${id}`, p) },
    addCandidate(c) { return this.api('POST', '/candidates', c) },
    delCandidate(id) { return this.api('DELETE', `/candidates/${id}`) },
    apply(pid, cid) {
      return this.runBusy(`apply:${pid}:${cid}`, () =>
        this.api('POST', '/applications', { position_id: pid, candidate_id: cid }, { success: '已纳入招聘流程' }))
    },
    advance(id, version) {
      return this.runBusy(`stage:${id}`, () =>
        this.api('POST', `/applications/${id}/advance`, { version }, { success: '阶段已推进' }))
    },
    reject(id, version, reason) {
      return this.runBusy(`stage:${id}`, () =>
        this.api('POST', `/applications/${id}/reject`, { version, reason }, { success: '已淘汰' }))
    },
    rollback(id, version, reason) {
      return this.runBusy(`stage:${id}`, () =>
        this.api('POST', `/applications/${id}/rollback`, { version, reason }, { success: '已回退到上一阶段' }))
    },
    addInterview(id, p) {
      return this.runBusy(`iv-add:${id}`, () =>
        this.api('POST', `/applications/${id}/interview`, p, { success: '面试已安排' }))
    },
    setInterview(ivId, p) {
      // 评价录入不打成功提示，避免每输入一次都弹 toast；结论变更才提示
      return this.runBusy(`iv:${ivId}`, () =>
        this.api('POST', `/interviews/${ivId}`, p, p.conclusion ? { success: '面试结论已更新' } : {}))
    },
    addOffer(id, p = {}) {
      return this.runBusy(`offer-add:${id}`, () =>
        this.api('POST', `/applications/${id}/offer`, p, { success: 'Offer 已发起' }))
    },
    updateOffer(ofId, p = {}, successMsg) {
      return this.runBusy(`offer:${ofId}`, () =>
        this.api('POST', `/offers/${ofId}`, p, successMsg ? { success: successMsg } : {}))
    },
    // 兼容旧调用
    setOffer(ofId, status, version) {
      const msg = { accepted: '候选人已接受 Offer', rejected: 'Offer 已拒绝', joined: '已确认入职', withdrawn: 'Offer 已撤回' }[status]
      return this.updateOffer(ofId, { status, version }, msg)
    },
    // ---------------- 身份与审批 ----------------
    setUser(id) {
      this.userId = id
      currentUserId = id
      localStorage.setItem('hr-user-id', id)
    },
    // 提交审批申请（候选人推进/面试结论/Offer 发放）
    submitApproval(payload) {
      return this.runBusy(`appr-new:${payload.type}:${payload.application_id}`, () =>
        this.api('POST', '/approvals', payload, { success: '审批申请已提交，待审批人处理' }))
    },
    // 审批决定：approve 通过 / return 退回（退回必须带意见）
    decideApproval(id, payload, successMsg) {
      return this.runBusy(`appr:${id}`, async () => {
        const r = await this.api('POST', `/approvals/${id}/decide`, payload, successMsg ? { success: successMsg } : {})
        // 终审通过但业务回写失败（流程状态漂移）：接口仍返回 ok，这里把失败原因提示出来
        if (r?.status === 'failed') this.notify('error', `审批已通过但执行失败：${r.msg}`)
        return r
      })
    },
    resubmitApproval(id, payload) {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/resubmit`, { payload }, { success: '已修改并重新提交审批' }))
    },
    cancelApproval(id) {
      return this.runBusy(`appr:${id}`, () =>
        this.api('POST', `/approvals/${id}/cancel`, {}, { success: '申请已撤销' }))
    },
    // ---------------- 按角色委托与超时升级 ----------------
    grantDelegation(payload) {
      return this.runBusy(`delegate-new:${payload.role}:${payload.delegatee_id}`, () =>
        this.api('POST', '/delegations', payload, { success: '委托已生效，代理人可处理在途任务' }))
    },
    revokeDelegation(id, note) {
      return this.runBusy(`delegate-revoke:${id}`, () =>
        this.api('POST', `/delegations/${id}/revoke`, { note }, { success: '委托已撤销，代理权限立即收回' }))
    },
    saveEscalationRules(rules) {
      return this.runBusy('escalation-rules-save', () =>
        this.api('POST', '/escalation-rules', { rules }, { success: '超时升级规则已保存（仅影响新任务）' }))
    },
    sweepApprovals() {
      return this.runBusy('approval-sweep', async () => {
        try {
          const r = await j('GET', '/approvals/sweep')
          await this.refresh()
          if (r.count || r.delegations_expired) {
            this.notify('success', `扫描完成：${r.count} 个任务超时升级，${r.delegations_expired} 个委托到期`)
          } else {
            this.notify('success', '暂无超时任务，审批时限已是最新')
          }
          return r
        } catch (e) { this.notify('error', e.message); return null }
      })
    },
    markNotificationsRead(ids) {
      return this.api('POST', '/notifications/read', ids?.length ? { ids } : {})
    },
    // ---------------- 跨角色危机处置审计 ----------------
    activeIncidentOf(appId) {
      return (this.data?.crisisIncidents || [])
        .find(i => i.application_id === appId && i.status !== 'closed') || null
    },
    // 当前身份是否事件处置成员（指挥官/立案人/有效临时授权）
    isIncidentMember(inc) {
      if (!inc) return false
      const me = this.currentUser
      if (!me) return false
      if (inc.commander_id === me.id || inc.declared_by === me.id) return true
      return (this.data?.crisisGrants || []).some(g =>
        g.incident_id === inc.id && g.grantee_id === me.id && g.status === 'active')
    },
    crisisEntriesOf(incidentId) {
      return this.crisisEntries.filter(e => e.incident_id === incidentId)
    },
    crisisGrantsOf(incidentId) {
      return this.crisisGrants.filter(g => g.incident_id === incidentId)
    },
    crisisTicketsOf(incidentId) {
      return this.crisisTickets.filter(t => t.incident_id === incidentId)
    },
    crisisReportOf(incidentId) {
      return this.crisisReports.find(r => r.incident_id === incidentId) || null
    },
    declareCrisis(payload) {
      return this.runBusy('crisis:declare', () =>
        this.api('POST', '/crisis/incidents', payload, { success: '危机事件已立案，审计链已生成' }))
    },
    crisisState(id, status, note) {
      return this.runBusy(`crisis-state:${id}`, () =>
        this.api('POST', `/crisis/incidents/${id}/state`, { status, note }, { success: '事件状态已更新' }))
    },
    changeCommander(id, commanderId, note) {
      return this.runBusy(`crisis-cmdr:${id}`, () =>
        this.api('POST', `/crisis/incidents/${id}/commander`, { commander_id: commanderId, note }, { success: '指挥官已变更，责任已移交' }))
    },
    grantRole(id, payload) {
      return this.runBusy(`crisis-grant:${id}`, () =>
        this.api('POST', `/crisis/incidents/${id}/grants`, payload, { success: '临时授权已授予并上链' }))
    },
    revokeGrant(grantId, note) {
      return this.runBusy(`crisis-revoke:${grantId}`, () =>
        this.api('POST', `/crisis/grants/${grantId}/revoke`, { note }, { success: '临时授权已收回' }))
    },
    crisisRollback(id, payload) {
      return this.runBusy(`crisis-rb:${id}`, () =>
        this.api('POST', `/crisis/incidents/${id}/rollback`, payload, { success: '危机回退已执行并写入审计链' }))
    },
    crisisAction(id, payload) {
      return this.runBusy(`crisis-act:${id}:${Date.now()}`, () =>
        this.api('POST', `/crisis/incidents/${id}/actions`, payload, { success: '关键操作已上链' }))
    },
    createTicket(id, payload) {
      return this.runBusy(`crisis-tk-new:${id}`, () =>
        this.api('POST', `/crisis/incidents/${id}/tickets`, payload, { success: '工单已创建并通知责任人' }))
    },
    updateTicket(ticketId, payload) {
      return this.runBusy(`crisis-tk:${ticketId}`, () =>
        this.api('POST', `/crisis/tickets/${ticketId}`, payload, { success: '工单已更新' }))
    },
    saveReport(id, payload) {
      return this.api('PUT', `/crisis/incidents/${id}/report`, payload, { success: '复盘草稿已保存' })
    },
    finalizeReport(id) {
      return this.runBusy(`crisis-rpt:${id}`, () =>
        this.api('POST', `/crisis/incidents/${id}/report/finalize`, {}, { success: '复盘已定稿，责任矩阵已固化' }))
    },
    closeIncident(id, note) {
      return this.runBusy(`crisis-close:${id}`, () =>
        this.api('POST', `/crisis/incidents/${id}/close`, { note }, { success: '事件已结案归档' }))
    },
    async verifyIncident(id) {
      try {
        const r = await j('GET', `/crisis/incidents/${id}/verify`)
        this.notify(r.ok ? 'success' : 'error', r.ok ? `审计链校验通过（${r.count} 条）` : `审计链异常：${r.broken?.[0]?.reason || '校验失败'}`)
        return r
      } catch (e) { this.notify('error', e.message); return null }
    },
    exportIncidentUrl(id) { return `/api/crisis/incidents/${id}/export` },
    // ---------------- 候选人↔面试官双向预约 ----------------
    addSlot(p) {
      return this.runBusy(`slot-add:${p.owner_type}:${p.owner_id}:${p.start_at}`, () =>
        this.api('POST', '/schedule/slots', p, { success: '可用时段已添加' }))
    },
    bulkSlots(p) {
      return this.runBusy(`slot-bulk:${p.owner_type}:${p.owner_id}:${p.date}`, () =>
        this.api('POST', '/schedule/slots/bulk', p, { success: '可用时段已批量生成' }))
    },
    delSlot(id) {
      return this.runBusy(`slot-del:${id}`, () =>
        this.api('DELETE', `/schedule/slots/${id}`, {}, { success: '时段已删除' }))
    },
    createAppointment(p) {
      return this.runBusy(`appt-new:${p.application_id}:${p.round}`, () =>
        this.api('POST', '/schedule/appointments', p, { success: '预约已发起' }))
    },
    confirmAppointment(id, party) {
      return this.runBusy(`appt-confirm:${id}:${party || ''}`, () =>
        this.api('POST', `/schedule/appointments/${id}/confirm`, party ? { party } : {}, { success: '已确认该时间' }))
    },
    proposeAppointment(id, p) {
      return this.runBusy(`appt-propose:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/propose`, p, p.reason ? { success: '改期申请已发起，待对方确认' } : { success: '新时间已提议' }))
    },
    rejectReschedule(id, note) {
      return this.runBusy(`appt-rejectrs:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/reject-reschedule`, { note }, { success: '已拒绝改期，维持原时间' }))
    },
    declineAppointment(id, reason, party) {
      return this.runBusy(`appt-decline:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/decline`, { reason, party }, { success: '已婉拒本轮预约' }))
    },
    cancelAppointment(id, reason) {
      return this.runBusy(`appt-cancel:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/cancel`, { reason }, { success: '预约已取消' }))
    },
    resumeAppointment(id, p) {
      return this.runBusy(`appt-resume:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/resume`, p, { success: '已重新发起预约协商' }))
    },
    rebookAppointment(id, p) {
      return this.runBusy(`appt-rebook:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/rebook`, p, { success: '缺席后已重新约期，待对方确认' }))
    },
    completeAppointment(id) {
      return this.runBusy(`appt-done:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/complete`, {}, { success: '已标记面试完成' }))
    },
    noShowAppointment(id, result, note) {
      return this.runBusy(`appt-noshow:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/noshow`, { result, note }, { success: '缺席裁定已记录' }))
    },
    remindAppointment(id) {
      return this.runBusy(`appt-remind:${id}`, () =>
        this.api('POST', `/schedule/appointments/${id}/remind`, {}, { success: '会前提醒已发送给双方' }))
    },
    async sweepSchedule() {
      try {
        const r = await j('GET', '/schedule/sweep')
        if ((r.reminded24 || r.reminded1 || r.noShow)) {
          this.notify('success', `提醒已发送：24小时 ${r.reminded24} 条 / 1小时 ${r.reminded1} 条${r.noShow ? `；新初判缺席 ${r.noShow} 条` : ''}`)
        }
        await this.refresh()
        return r
      } catch (e) { this.notify('error', e.message); return null }
    }
  }
})
