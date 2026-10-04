<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const tab = ref('appointments')
const statusFilter = ref('active')
const detailId = ref(null)
const showCreate = ref(false)

// ---------------- 时间工具 ----------------
// 后端存 ISO（UTC）；表单与展示统一用浏览器本地时间
const pad = n => String(n).padStart(2, '0')
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtDT(iso) {
  if (!iso) return '待定'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtWeek(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '' : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}
const isPast = iso => iso && new Date(iso).getTime() < Date.now()

// ---------------- 列表与筛选 ----------------
const FILTERS = [
  { k: 'active', label: '进行中' },
  { k: 'negotiating', label: '待确认' },
  { k: 'rescheduling', label: '改期中' },
  { k: 'confirmed', label: '已确认' },
  { k: 'no_show', label: '缺席' },
  { k: 'done', label: '已完成/终态' },
  { k: 'all', label: '全部' }
]
const list = computed(() => {
  const rows = store.appointments.slice().sort((a, b) => (b.start_at || '').localeCompare(a.start_at || ''))
  const f = statusFilter.value
  if (f === 'active') return rows.filter(a => ['negotiating', 'rescheduling', 'confirmed'].includes(a.status))
  if (f === 'done') return rows.filter(a => ['completed', 'declined', 'cancelled'].includes(a.status))
  return rows.filter(a => a.status === f || f === 'all')
})
// 列表中的「当前关注时间」：改期中展示待确认的新提议
const focusTime = a => a.status === 'rescheduling' && a.pending_start ? a.pending_start : a.start_at
const detail = computed(() => store.appointments.find(a => a.id === detailId.value) || null)

function openDetail(a) { detailId.value = a.id }
function statusClass(s) {
  return { negotiating: 'pend', rescheduling: 'pend', confirmed: 'ok',
    completed: 'done', no_show: 'noshow', declined: 'dead', cancelled: 'dead' }[s] || ''
}

// 待当前身份处理的预约（卡片高亮）
function minePending(a) {
  if (store.myRole === 'interviewer') {
    return ['negotiating', 'rescheduling'].includes(a.status) && a.interviewer_id === store.currentUser?.id && !a.int_confirmed
  }
  if (store.myRole === 'recruiter') {
    return ((['negotiating', 'rescheduling'].includes(a.status)) && !a.cand_confirmed) ||
      (a.status === 'no_show' && a.checkin_flagged)
  }
  return false
}

// ---------------- 发起预约表单 ----------------
const interviewers = computed(() => store.users.filter(u => u.role === 'interviewer'))
// 可安排预约的在途应聘（筛选/面试阶段；已淘汰需先复活）
const schedulableApps = computed(() => store.applications
  .filter(a => !['rejected', 'hired'].includes(a.stage))
  .sort((x, y) => y.id - x.id))

const form = ref(blankForm())
function blankForm() {
  const d = new Date()
  d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0)
  const e = new Date(d.getTime() + 60 * 60000)
  return {
    application_id: '', round: '初试', interviewer_id: '',
    format: '线上', location: '',
    start: toLocalInput(d.toISOString()), end: toLocalInput(e.toISOString()),
    cand_confirmed: true, int_confirmed: false, note: ''
  }
}
function openCreate(aId) {
  form.value = blankForm()
  if (aId) {
    form.value.application_id = aId
    const app = store.applications.find(a => a.id === aId)
    const used = new Set((app?.interviews || []).map(i => i.round))
    form.value.round = ['初试', '复试', '终面', 'HR面'].find(r => !used.has(r)) || '复试'
  }
  showCreate.value = true
}
async function submitCreate() {
  const f = form.value
  if (!f.application_id) { store.notify('error', '请选择候选人应聘记录'); return }
  if (store.myRole === 'recruiter' && !f.interviewer_id) { store.notify('error', '请选择面试官'); return }
  const r = await store.createAppointment({
    application_id: f.application_id, round: f.round,
    interviewer_id: store.myRole === 'interviewer' ? store.currentUser.id : f.interviewer_id,
    format: f.format, location: f.location,
    start_at: new Date(f.start).toISOString(), end_at: new Date(f.end).toISOString(),
    cand_confirmed: f.cand_confirmed, int_confirmed: f.int_confirmed,
    note: f.note
  })
  if (r) { showCreate.value = false; statusFilter.value = 'active'; detailId.value = r.id }
}

// ---------------- 改期提议表单 ----------------
const showPropose = ref(false)
const pf = ref(blankPropose())
function blankPropose() {
  const d = new Date(); d.setDate(d.getDate() + 2); d.setHours(14, 0, 0, 0)
  const e = new Date(d.getTime() + 60 * 60000)
  return { start: toLocalInput(d.toISOString()), end: toLocalInput(e.toISOString()), reason: '', party: '' }
}
function openPropose() {
  pf.value = blankPropose()
  pf.value.party = store.myRole === 'interviewer' ? 'interviewer' : 'candidate'
  showPropose.value = true
}
async function submitPropose() {
  if (!pf.value.reason.trim() && detail.value.status === 'confirmed') { store.notify('error', '改期必须填写原因'); return }
  const r = await store.proposeAppointment(detail.value.id, {
    start_at: new Date(pf.value.start).toISOString(),
    end_at: new Date(pf.value.end).toISOString(),
    reason: pf.value.reason,
    party: pf.value.party
  })
  if (r) showPropose.value = false
}

// ---------------- 婉拒/取消（原因） ----------------
const showReason = ref(null) // 'decline' | 'cancel'
const reasonText = ref('')
function openReason(kind) { reasonText.value = ''; showReason.value = kind }
async function submitReason() {
  if (!reasonText.value.trim()) { store.notify('error', '请填写原因说明'); return }
  let r
  if (showReason.value === 'decline') {
    r = await store.declineAppointment(detail.value.id, reasonText.value, store.myRole === 'interviewer' ? 'interviewer' : 'candidate')
  } else {
    r = await store.cancelAppointment(detail.value.id, reasonText.value)
  }
  if (r) showReason.value = null
}

// ---------------- 缺席后重约 ----------------
const showRebook = ref(false)
const rbf = ref(blankPropose())
function openRebook() {
  rbf.value = blankPropose()
  rbf.value.party = store.myRole === 'interviewer' ? 'interviewer' : 'candidate'
  showRebook.value = true
}
async function submitRebook() {
  const r = await store.rebookAppointment(detail.value.id, {
    start_at: new Date(rbf.value.start).toISOString(),
    end_at: new Date(rbf.value.end).toISOString(),
    party: rbf.value.party
  })
  if (r) showRebook.value = false
}

// ---------------- 可用时段页 ----------------
const slotOwnerType = ref('interviewer')
const slotOwnerId = ref('')
const bulkDate = ref(new Date().toISOString().slice(0, 10))
const bulkDuration = ref(60)
const bulkStarts = ref([])
const TIME_GRID = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00', '17:00', '19:00']

const slotCandidates = computed(() => store.candidates.slice().sort((a, b) => a.id - b.id))
const effectiveSlotOwnerId = computed(() =>
  store.myRole === 'interviewer' ? store.currentUser.id : slotOwnerId.value)

const ownerSlots = computed(() => store.scheduleSlots
  .filter(s => s.owner_type === slotOwnerType.value && String(s.owner_id) === String(effectiveSlotOwnerId.value))
  .sort((a, b) => a.start_at.localeCompare(b.start_at)))

function toggleBulkStart(t) {
  const i = bulkStarts.value.indexOf(t)
  if (i >= 0) bulkStarts.value.splice(i, 1); else bulkStarts.value.push(t)
}
async function submitBulk() {
  if (!effectiveSlotOwnerId.value) { store.notify('error', '请先选择归属人'); return }
  if (!bulkStarts.value.length) { store.notify('error', '请勾选至少一个开始时刻'); return }
  const r = await store.bulkSlots({
    owner_type: slotOwnerType.value, owner_id: effectiveSlotOwnerId.value,
    date: bulkDate.value, starts: bulkStarts.value, duration: Number(bulkDuration.value)
  })
  if (r) bulkStarts.value = []
}

// 发起预约时推荐：候选人与面试官 open 时段的重叠
const overlapSuggestions = computed(() => {
  if (!form.value.application_id || !form.value.interviewer_id || store.myRole !== 'recruiter') return []
  const app = store.applications.find(a => a.id === Number(form.value.application_id))
  if (!app) return []
  const cs = store.scheduleSlots.filter(s => s.owner_type === 'candidate' && String(s.owner_id) === String(app.candidate_id) && s.status === 'open')
  const is2 = store.scheduleSlots.filter(s => s.owner_type === 'interviewer' && String(s.owner_id) === String(form.value.interviewer_id) && s.status === 'open')
  const out = []
  cs.forEach(c => {
    is2.forEach(i => {
      const s = Math.max(new Date(c.start_at).getTime(), new Date(i.start_at).getTime())
      const e = Math.min(new Date(c.end_at).getTime(), new Date(i.end_at).getTime())
      if (e - s >= 30 * 60 * 1000) out.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() })
    })
  })
  return out.filter(x => new Date(x.start).getTime() > Date.now())
    .sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6)
})
function applySuggestion(s) {
  form.value.start = toLocalInput(s.start)
  form.value.end = toLocalInput(s.end)
}

// ---------------- 终态（婉拒/取消）后重新协商 ----------------
const showResume = ref(false)
const rsf = ref(blankResume())
function blankResume() {
  const b = blankPropose()
  return { ...b, other_confirmed: false }
}
function openResume() {
  rsf.value = blankResume()
  rsf.value.party = store.myRole === 'interviewer' ? 'interviewer' : 'candidate'
  showResume.value = true
}
async function submitResume() {
  const payload = {
    start_at: new Date(rsf.value.start).toISOString(),
    end_at: new Date(rsf.value.end).toISOString(),
    party: rsf.value.party
  }
  // 招聘负责人已同时与另一方电话确认：预置对方确认位，重协即成立
  if (store.myRole === 'recruiter' && rsf.value.other_confirmed) {
    if (rsf.value.party === 'candidate') payload.int_confirmed = true
    else payload.cand_confirmed = true
  }
  const r = await store.resumeAppointment(detail.value.id, payload)
  if (r) showResume.value = false
}

// 消息时间线
const KIND_META = {
  create: ['📝', '发起预约'], propose: ['🔁', '提议改期'], confirm: ['✅', '确认'],
  decline: ['🚫', '婉拒'], reject_reschedule: ['↩️', '拒绝改期'], cancel: ['❌', '取消'],
  resume: ['🔄', '重新协商'], rebook: ['📅', '缺席后重约'], complete: ['🎉', '面试完成'],
  crisis_suspend: ['🛡️', '危机挂起'], crisis_resume: ['🛡️', '危机重约恢复'],
  noshow: ['⚠️', '缺席裁定'], auto_noshow: ['🤖', '系统初判缺席'],
  remind24h: ['⏰', '24小时提醒'], remind1h: ['🔔', '1小时提醒'], remind: ['📣', '手动提醒'],
  system: ['ℹ️', '系统']
}
const PARTY_LABEL = { candidate: '候选人方', interviewer: '面试官', recruiter: '招聘负责人', system: '系统' }
</script>

<template>
  <div class="sched">
    <!-- 顶部：页签 + 扫描提醒 -->
    <div class="bar">
      <div class="tabs">
        <button :class="{ on: tab === 'appointments' }" @click="tab = 'appointments'">
          📅 预约协商
          <em v-if="store.scheduleTodoCount" class="cnt">{{ store.scheduleTodoCount }}</em>
        </button>
        <button :class="{ on: tab === 'slots' }" @click="tab = 'slots'">🕒 可用时段</button>
      </div>
      <div class="bar-right">
        <button class="ghost sm" title="扫描临近预约：自动发送24小时/1小时提醒，并把结束后未签到的预约初判缺席"
          :disabled="store.myRole !== 'recruiter'" @click="store.sweepSchedule()">
          ⏰ 同步提醒/缺席扫描
        </button>
        <button v-if="tab === 'appointments'" class="primary sm"
          :disabled="store.myRole === 'hiring_manager'"
          @click="openCreate()">＋ 发起预约</button>
      </div>
    </div>
    <p class="muted rule">
      双向协商：候选人（招聘负责人代沟通）与面试官都确认后预约成立；已确认预约可发起改期，双方再次确认才生效，任一方可拒绝改期维持原时间。
      系统在开始前 24 小时 / 1 小时自动提醒双方，结束 15 分钟未签到初判缺席，由招聘负责人裁定并支持缺席后重约。
    </p>

    <!-- ================= 预约协商 ================= -->
    <template v-if="tab === 'appointments'">
      <div class="filters">
        <button v-for="f in FILTERS" :key="f.k" class="fchip" :class="{ on: statusFilter === f.k }" @click="statusFilter = f.k">
          {{ f.label }}
        </button>
      </div>

      <div class="alist">
        <div class="acard card" v-for="a in list" :key="a.id" :class="{ mine: minePending(a) }" @click="openDetail(a)">
          <div class="ac-top">
            <b>{{ a.candidate }}</b>
            <span class="tag">{{ a.position }}</span>
            <span class="round-tag">{{ a.round }}</span>
            <span class="st" :class="statusClass(a.status)">{{ a.status_label }}</span>
            <em v-if="a.crisis_suspended" class="crisis-flag" @click.stop>🛡️ 危机挂起</em>
            <em v-else-if="minePending(a)" class="mine-flag">待我处理</em>
          </div>
          <div class="ac-time">
            <span class="clock">🕒</span>
            <span :class="{ old: a.status === 'rescheduling' }">{{ fmtWeek(focusTime(a)) }} {{ fmtDT(focusTime(a)) }}</span>
            <span v-if="a.status === 'rescheduling'" class="newtime">→ 待确认新提议</span>
          </div>
          <div class="ac-sub muted">
            面试官 {{ a.interviewer_name || '-' }} · {{ a.format }}{{ a.location ? ' · ' + a.location : '' }}
          </div>
          <div class="confirm-bits">
            <span :class="{ yes: a.status === 'rescheduling' ? a.cand_confirmed : a.cand_confirmed }">
              {{ a.cand_confirmed ? '👤 候选人已确认' : '👤 待候选人确认' }}</span>
            <span :class="{ yes: a.int_confirmed }">{{ a.int_confirmed ? '💬 面试官已确认' : '💬 待面试官确认' }}</span>
            <span v-if="a.checkin_flagged && a.status === 'no_show'" class="flag-noshow">🤖 {{ a.result_label }}</span>
            <span v-else-if="a.status === 'no_show'" class="flag-noshow">{{ a.result_label }}</span>
          </div>
        </div>
        <div class="card empty" v-if="!list.length">暂无预约，点击右上角「发起预约」开始双向协商。</div>
      </div>
    </template>

    <!-- ================= 可用时段 ================= -->
    <template v-else>
      <div class="slots-wrap">
        <div class="card slots-panel">
          <h3>🕒 维护可用时段</h3>
          <div class="slot-owner">
            <label>归属方</label>
            <div class="seg" v-if="store.myRole !== 'interviewer'">
              <button :class="{ on: slotOwnerType === 'interviewer' }" @click="slotOwnerType = 'interviewer'; slotOwnerId = ''">💬 面试官</button>
              <button :class="{ on: slotOwnerType === 'candidate' }" @click="slotOwnerType = 'candidate'; slotOwnerId = ''">👤 候选人（代录）</button>
            </div>
            <b v-else class="muted">本人（面试官）</b>
          </div>
          <div class="slot-owner" v-if="store.myRole !== 'interviewer'">
            <label>选择{{ slotOwnerType === 'interviewer' ? '面试官' : '候选人' }}</label>
            <select v-if="slotOwnerType === 'interviewer'" v-model="slotOwnerId">
              <option value="" disabled>请选择面试官</option>
              <option v-for="u in interviewers" :key="u.id" :value="u.id">{{ u.name }} · {{ u.title }}</option>
            </select>
            <select v-else v-model="slotOwnerId">
              <option value="" disabled>请选择候选人</option>
              <option v-for="c in slotCandidates" :key="c.id" :value="c.id">{{ c.name }}（#{{ c.id }}）</option>
            </select>
          </div>

          <div class="bulk-box" v-if="effectiveSlotOwnerId">
            <div class="bulk-row">
              <label>日期</label><input type="date" v-model="bulkDate" />
              <label>时长</label>
              <select v-model="bulkDuration"><option :value="30">30 分钟</option><option :value="60">60 分钟</option><option :value="90">90 分钟</option></select>
            </div>
            <div class="time-grid">
              <button v-for="t in TIME_GRID" :key="t" class="tcell" :class="{ on: bulkStarts.includes(t) }" @click="toggleBulkStart(t)">{{ t }}</button>
            </div>
            <p class="muted tip">勾选开始时刻后批量生成；候选人时段为招聘负责人电话/短信确认后代录（source=recruiter）。</p>
            <button class="primary" @click="submitBulk">批量生成时段</button>
          </div>
          <p class="muted tip" v-else>请先选择归属人。</p>
        </div>

        <div class="card slots-list-card">
          <h3>📋 已有时段 <span class="muted" v-if="effectiveSlotOwnerId">（{{ ownerSlots.length }}）</span></h3>
          <div class="slot-items">
            <div class="slot-item" v-for="s in ownerSlots" :key="s.id" :class="{ used: s.status === 'used', past: isPast(s.end_at) }">
              <div class="si-main">
                <b>{{ fmtWeek(s.start_at) }} {{ fmtDT(s.start_at) }} - {{ fmtDT(s.end_at).split(' ')[1] }}</b>
                <span class="muted">{{ s.source === 'self' ? '本人维护' : 'HR 代录' }}<template v-if="s.note"> · {{ s.note }}</template></span>
              </div>
              <div class="si-right">
                <span v-if="s.status === 'used'" class="used-tag">已占用 #{{ s.appointment_id }}</span>
                <span v-else-if="isPast(s.end_at)" class="past-tag">已过期</span>
                <button v-else class="danger sm" @click="store.delSlot(s.id)">删除</button>
              </div>
            </div>
            <div class="empty" v-if="effectiveSlotOwnerId && !ownerSlots.length">暂无可用时段。</div>
          </div>
        </div>
      </div>
    </template>

    <!-- ================= 发起预约弹窗 ================= -->
    <div class="modal" v-if="showCreate" @click.self="showCreate = false">
      <div class="modal-box wide card">
        <h3>📅 发起面试预约</h3>
        <div class="form-grid">
          <label><span>候选人应聘 *</span>
            <select v-model="form.application_id">
              <option value="" disabled>选择在途应聘</option>
              <option v-for="a in schedulableApps" :key="a.id" :value="a.id">
                {{ a.candidate }} · {{ a.position }}（{{ a.stage === 'screening' ? '筛选' : a.stage === 'interview' ? '面试' : a.stage }}）
              </option>
            </select>
          </label>
          <label><span>轮次</span>
            <select v-model="form.round"><option v-for="r in ['初试','复试','终面','HR面']" :key="r">{{ r }}</option></select>
          </label>
          <label v-if="store.myRole === 'recruiter'"><span>面试官 *</span>
            <select v-model="form.interviewer_id">
              <option value="" disabled>选择面试官</option>
              <option v-for="u in interviewers" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </label>
          <label><span>形式</span>
            <select v-model="form.format"><option>线上</option><option>线下</option><option>电话</option></select>
          </label>
          <label class="span2"><span>会议链接 / 地点</span><input v-model="form.location" placeholder="如：腾讯会议 880-2166 / 总部 3F 302" /></label>
          <label><span>开始时间 *</span><input type="datetime-local" v-model="form.start" /></label>
          <label><span>结束时间 *</span><input type="datetime-local" v-model="form.end" /></label>
          <label class="span2" v-if="store.myRole === 'recruiter'">
            <span>发起时确认位</span>
            <span class="checks">
              <label class="ck"><input type="checkbox" v-model="form.cand_confirmed" /> 已与候选人电话确认</label>
              <label class="ck"><input type="checkbox" v-model="form.int_confirmed" /> 已与面试官确认（双方都勾选则预约直接成立）</label>
            </span>
          </label>
          <label class="span2"><span>备注</span><input v-model="form.note" placeholder="给双方的说明（可选）" /></label>
        </div>

        <!-- 时段重叠推荐 -->
        <div class="suggest" v-if="overlapSuggestions.length">
          <b class="muted">👥 双方可用时段重叠（点击填充）：</b>
          <div class="sug-items">
            <button v-for="(s, i) in overlapSuggestions" :key="i" class="sug" @click="applySuggestion(s)">
              {{ fmtWeek(s.start) }} {{ fmtDT(s.start) }}~{{ fmtDT(s.end).split(' ')[1] }}
            </button>
          </div>
        </div>

        <div class="acts">
          <button class="primary" @click="submitCreate">发起预约</button>
          <button class="ghost" @click="showCreate = false">取消</button>
        </div>
      </div>
    </div>

    <!-- ================= 预约详情/协商抽屉 ================= -->
    <div class="modal" v-if="detail" @click.self="detailId = null">
      <div class="modal-box wide card detail-box">
        <h3>
          📅 {{ detail.candidate }} <span class="tag">{{ detail.position }}</span>
          <span class="round-tag">{{ detail.round }}</span>
          <span class="st" :class="statusClass(detail.status)">{{ detail.status_label }}</span>
          <span v-if="detail.crisis_suspended" class="crisis-flag big">🛡️ 危机处置挂起</span>
        </h3>
        <div class="crisis-banner" v-if="detail.crisis_suspended">
          🛡️ 该预约因关联危机事件的流程回退被同步挂起，时段已释放；可在本单<b>重新协商</b>恢复，双方确认后面试流程继续，恢复动作会写入危机审计链。
        </div>

        <!-- 时间与确认位 -->
        <div class="d-timecard" :class="{ resch: detail.status === 'rescheduling' }">
          <template v-if="detail.status === 'rescheduling'">
            <div class="oldline muted">原时间：{{ fmtWeek(detail.start_at) }} {{ fmtDT(detail.start_at) }}（待改期结果，拒绝则维持）</div>
            <div class="newline">🔁 待确认新提议：{{ fmtWeek(detail.pending_start) }} {{ fmtDT(detail.pending_start) }}
              <em class="muted">由{{ detail.pending_by_party === 'interviewer' ? '面试官' : '候选人方' }}发起</em>
            </div>
          </template>
          <template v-else>
            <div class="newline">🕒 {{ fmtWeek(detail.start_at) }} {{ fmtDT(detail.start_at) }} ~ {{ fmtDT(detail.end_at).split(' ')[1] }}</div>
          </template>
          <div class="d-place muted">面试官 {{ detail.interviewer_name }} · {{ detail.format }}{{ detail.location ? ' · ' + detail.location : '' }}</div>
          <div class="confirm-bits big">
            <span :class="{ yes: detail.cand_confirmed }">{{ detail.cand_confirmed ? '👤 候选人已确认' : '👤 待候选人确认' }}</span>
            <span :class="{ yes: detail.int_confirmed }">{{ detail.int_confirmed ? '💬 面试官已确认' : '💬 待面试官确认' }}</span>
            <span v-if="detail.reminded_24h" class="rem">⏰ 已发24h提醒</span>
            <span v-if="detail.reminded_1h" class="rem">🔔 已发1h提醒</span>
          </div>
        </div>

        <!-- 缺席裁定条 -->
        <div class="noshow-bar" v-if="detail.status === 'no_show'">
          <b>⚠️ {{ detail.result_label }}</b>
          <span class="muted" v-if="detail.checkin_flagged">系统于结束 15 分钟后初判，招聘负责人可改判或安排重约。</span>
        </div>

        <!-- 操作区（按角色/状态） -->
        <div class="d-acts acts">
          <template v-if="['negotiating','rescheduling'].includes(detail.status)">
            <!-- 面试官确认 -->
            <button v-if="store.myRole === 'interviewer' && detail.interviewer_id === store.currentUser?.id && !detail.int_confirmed"
              class="succ" @click="store.confirmAppointment(detail.id, 'interviewer')">✅ 我（面试官）确认</button>
            <!-- 招聘负责人代候选人确认 -->
            <button v-if="store.myRole === 'recruiter' && !detail.cand_confirmed"
              class="succ" @click="store.confirmAppointment(detail.id, 'candidate')">📞 已联系到候选人，代为确认</button>
            <!-- 招聘负责人代面试官确认（电话确认后代操作） -->
            <button v-if="store.myRole === 'recruiter' && !detail.int_confirmed"
              class="succ" @click="store.confirmAppointment(detail.id, 'interviewer')">📞 已与面试官确认，代为确认</button>
            <button v-if="store.myRole !== 'hiring_manager'" class="warn" @click="openPropose">
              {{ detail.status === 'rescheduling' ? '🔁 再提一个时间' : '🔁 时间不合适，提议改期' }}
            </button>
            <button v-if="detail.status === 'rescheduling' && store.myRole !== 'hiring_manager'" class="ghost"
              @click="store.rejectReschedule(detail.id, '不同意改期，维持原安排')">↩️ 拒绝改期（维持原时间）</button>
            <button v-if="store.myRole !== 'hiring_manager'" class="danger" @click="openReason('decline')">🚫 婉拒本轮</button>
          </template>

          <template v-if="detail.status === 'confirmed'">
            <button class="succ" :disabled="store.myRole === 'hiring_manager'"
              @click="store.completeAppointment(detail.id)">🎉 双方到场，标记完成</button>
            <button class="warn" :disabled="store.myRole === 'hiring_manager'" @click="openPropose">🔁 申请改期</button>
            <button class="ghost" :disabled="store.myRole === 'hiring_manager'" @click="store.remindAppointment(detail.id)">📣 立即提醒</button>
            <button class="danger" :disabled="store.myRole === 'hiring_manager'" @click="openReason('cancel')">❌ 取消预约</button>
            <div class="judge" v-if="store.myRole === 'recruiter' && !isPast(detail.end_at)">
              <span class="muted">若确认无法到场：</span>
              <button class="danger sm" @click="store.noShowAppointment(detail.id, 'candidate_no_show', '提前确认候选人无法到场')">候选人缺席</button>
              <button class="danger sm" @click="store.noShowAppointment(detail.id, 'interviewer_no_show', '面试官临时无法参加')">面试官缺席</button>
              <button class="danger sm" @click="store.noShowAppointment(detail.id, 'both_no_show', '双方均无法参加')">双方缺席</button>
            </div>
          </template>

          <template v-if="detail.status === 'no_show'">
            <template v-if="store.myRole === 'recruiter'">
              <button class="warn sm" @click="store.noShowAppointment(detail.id, 'interviewer_no_show', '改判：面试官缺席')">改判面试官缺席</button>
              <button class="warn sm" @click="store.noShowAppointment(detail.id, 'both_no_show', '改判：双方缺席')">改判双方缺席</button>
              <button class="warn sm" @click="store.noShowAppointment(detail.id, 'candidate_no_show', '改判：候选人缺席')">改判候选人缺席</button>
            </template>
            <button class="primary" :disabled="store.myRole === 'hiring_manager'" @click="openRebook">📅 缺席后重新约期</button>
          </template>

          <template v-if="['declined','cancelled'].includes(detail.status)">
            <button class="primary" :disabled="store.myRole === 'hiring_manager'" @click="openResume">
              {{ detail.crisis_suspended ? '🛡️ 在原单重约，恢复面试流程' : '↻ 在本单上重新协商' }}
            </button>
          </template>

          <button class="ghost" @click="detailId = null">关闭</button>
        </div>

        <!-- 沟通时间线 -->
        <div class="timeline">
          <h4>💬 双向沟通记录</h4>
          <div class="msg" v-for="m in detail.messages" :key="m.id">
            <span class="m-icon">{{ KIND_META[m.kind]?.[0] || '📌' }}</span>
            <div class="m-body">
              <div class="m-head">
                <b>{{ PARTY_LABEL[m.party] || m.party }} · {{ m.actor_name || KIND_META[m.kind]?.[1] || m.kind }}</b>
                <em class="muted">{{ m.created_at }}</em>
              </div>
              <p>{{ m.content }}</p>
              <em class="muted" v-if="m.start_at">相关时间：{{ fmtDT(m.start_at) }}</em>
            </div>
          </div>
          <div class="empty" v-if="!detail.messages.length">暂无沟通记录。</div>
        </div>
      </div>
    </div>

    <!-- 改期弹窗 -->
    <div class="modal" v-if="showPropose" @click.self="showPropose = false">
      <div class="modal-box card">
        <h3>🔁 {{ detail?.status === 'confirmed' ? '申请改期（需双方再次确认）' : '提议新时间' }}</h3>
        <div class="form-grid one">
          <label><span>开始时间 *</span><input type="datetime-local" v-model="pf.start" /></label>
          <label><span>结束时间 *</span><input type="datetime-local" v-model="pf.end" /></label>
          <label v-if="detail?.status === 'confirmed'"><span>改期原因 *</span>
            <input v-model="pf.reason" placeholder="如：面试官临时有会 / 候选人出差，改期原因会通知对方" /></label>
          <label v-if="store.myRole === 'recruiter'"><span>提议代表方</span>
            <select v-model="pf.party"><option value="candidate">候选人方（电话确认后代提）</option><option value="interviewer">代面试官提议</option></select>
          </label>
        </div>
        <div class="acts">
          <button class="primary" @click="submitPropose">发送改期提议</button>
          <button class="ghost" @click="showPropose = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 婉拒/取消弹窗 -->
    <div class="modal" v-if="showReason" @click.self="showReason = null">
      <div class="modal-box card">
        <h3>{{ showReason === 'decline' ? '🚫 婉拒本轮预约' : '❌ 取消已确认预约' }}</h3>
        <textarea v-model="reasonText" rows="3" :placeholder="showReason === 'decline' ? '婉拒原因（必填，将通知对方，之后可重新协商）' : '取消原因（必填，将通知双方）'"></textarea>
        <div class="acts">
          <button class="danger" @click="submitReason">确认{{ showReason === 'decline' ? '婉拒' : '取消' }}</button>
          <button class="ghost" @click="showReason = null">返回</button>
        </div>
      </div>
    </div>

    <!-- 缺席后重约弹窗 -->
    <div class="modal" v-if="showRebook" @click.self="showRebook = false">
      <div class="modal-box card">
        <h3>📅 缺席后重新约期</h3>
        <p class="muted">缺席记录保留在沟通时间线中；新时间需对方确认后成立。</p>
        <div class="form-grid one">
          <label><span>新开始时间 *</span><input type="datetime-local" v-model="rbf.start" /></label>
          <label><span>新结束时间 *</span><input type="datetime-local" v-model="rbf.end" /></label>
          <label v-if="store.myRole === 'recruiter'"><span>重约代表方</span>
            <select v-model="rbf.party"><option value="candidate">候选人方（已电话确认）</option><option value="interviewer">代面试官重约</option></select>
          </label>
        </div>
        <div class="acts">
          <button class="primary" @click="submitRebook">发起重约</button>
          <button class="ghost" @click="showRebook = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 终态重新协商弹窗 -->
    <div class="modal" v-if="showResume" @click.self="showResume = false">
      <div class="modal-box card">
        <h3>↻ 重新发起预约协商</h3>
        <p class="muted">原预约已{{ detail?.status === 'declined' ? '婉拒' : '取消' }}，历史沟通保留；新时间需对方确认。</p>
        <div class="form-grid one">
          <label><span>开始时间 *</span><input type="datetime-local" v-model="rsf.start" /></label>
          <label><span>结束时间 *</span><input type="datetime-local" v-model="rsf.end" /></label>
          <label v-if="store.myRole === 'recruiter'"><span>提议代表方</span>
            <select v-model="rsf.party"><option value="candidate">候选人方（已电话确认）</option><option value="interviewer">代面试官提议</option></select>
          </label>
          <label v-if="store.myRole === 'recruiter'"><span>&nbsp;</span>
            <label class="ck"><input type="checkbox" v-model="rsf.other_confirmed" /> 已同时与另一方电话确认（重协即直接成立）</label>
          </label>
        </div>
        <div class="acts">
          <button class="primary" @click="submitResume">重新发起</button>
          <button class="ghost" @click="showResume = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sched { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
.tabs { display: flex; gap: 8px; }
.tabs button { position: relative; font-size: 14px; padding: 9px 16px; }
.tabs button.on { background: rgba(91,140,255,.18); border-color: var(--accent); color: var(--accent); }
.cnt { position: absolute; top: -7px; right: -7px; font-style: normal; font-size: 10px; min-width: 17px; height: 17px; border-radius: 9px; background: var(--red); color: #fff; display: inline-flex; align-items: center; justify-content: center; padding: 0 4px; }
.bar-right { display: flex; gap: 8px; }
.rule { line-height: 1.6; }
.filters { display: flex; gap: 7px; flex-wrap: wrap; }
.fchip { font-size: 12px; padding: 5px 12px; border-radius: 16px; }
.fchip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.alist { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 13px; }
.acard { cursor: pointer; transition: .18s; display: flex; flex-direction: column; gap: 7px; }
.acard:hover { border-color: var(--accent); transform: translateY(-2px); }
.acard.mine { border-color: rgba(255,209,102,.55); box-shadow: 0 0 0 1px rgba(255,209,102,.25); }
.ac-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ac-top b { font-size: 15px; }
.round-tag { font-size: 11px; background: rgba(167,139,250,.15); color: var(--purple); border: 1px solid rgba(167,139,250,.4); padding: 2px 8px; border-radius: 10px; }
.st { font-size: 11px; padding: 2px 9px; border-radius: 10px; border: 1px solid; }
.st.pend { color: var(--accent2); border-color: rgba(255,209,102,.45); background: rgba(255,209,102,.08); }
.st.ok { color: var(--green); border-color: rgba(87,214,160,.45); background: rgba(87,214,160,.08); }
.st.done { color: var(--muted); border-color: var(--border); background: var(--panel2); }
.st.noshow { color: var(--red); border-color: rgba(255,107,122,.5); background: rgba(255,107,122,.1); }
.st.dead { color: var(--muted); border-color: var(--border); }
.mine-flag { margin-left: auto; font-style: normal; font-size: 10px; color: #1a1400; background: var(--accent2); border-radius: 9px; padding: 1px 8px; }
.crisis-flag { margin-left: auto; font-style: normal; font-size: 10px; font-weight: 700; color: var(--purple); background: rgba(167,139,250,.15); border: 1px solid rgba(167,139,250,.5); border-radius: 9px; padding: 1px 8px; }
.crisis-flag.big { font-size: 12px; margin-left: 10px; padding: 2px 10px; }
.crisis-banner { font-size: 12.5px; line-height: 1.7; color: var(--purple); background: rgba(167,139,250,.08); border: 1px solid rgba(167,139,250,.35); border-radius: 10px; padding: 9px 13px; }
.crisis-banner b { color: var(--purple); }
.ac-time { font-size: 15px; display: flex; gap: 7px; align-items: center; }
.ac-time .old { text-decoration: line-through; color: var(--muted); }
.newtime { font-size: 12px; color: var(--accent2); }
.ac-sub { font-size: 12px; }
.confirm-bits { display: flex; gap: 8px; flex-wrap: wrap; }
.confirm-bits span { font-size: 11px; color: var(--muted); background: var(--panel2); border: 1px solid var(--border); border-radius: 9px; padding: 2px 8px; }
.confirm-bits span.yes { color: var(--green); border-color: rgba(87,214,160,.4); }
.confirm-bits .flag-noshow { color: var(--red); border-color: rgba(255,107,122,.45); }
.confirm-bits.big span { font-size: 12px; padding: 4px 10px; }
.confirm-bits .rem { color: var(--cyan); border-color: rgba(79,195,247,.4); }

/* 可用时段 */
.slots-wrap { display: grid; grid-template-columns: minmax(300px, 420px) 1fr; gap: 14px; align-items: start; }
.slots-panel { display: flex; flex-direction: column; gap: 12px; }
.slot-owner { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.slot-owner label { font-size: 13px; color: var(--muted); min-width: 64px; }
.slot-owner select { flex: 1; min-width: 180px; }
.seg { display: flex; gap: 6px; }
.seg button.on { background: rgba(91,140,255,.18); border-color: var(--accent); color: var(--accent); }
.bulk-box { border: 1px dashed var(--border); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.bulk-row { display: flex; gap: 8px; align-items: center; }
.bulk-row label { font-size: 12px; color: var(--muted); }
.bulk-row input, .bulk-row select { padding: 6px 8px; }
.time-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
.tcell { padding: 8px 0; font-size: 13px; }
.tcell.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.tip { line-height: 1.5; }
.slots-list-card { min-height: 200px; }
.slot-items { display: flex; flex-direction: column; gap: 8px; max-height: 460px; overflow: auto; }
.slot-item { display: flex; justify-content: space-between; align-items: center; gap: 10px;
  background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.slot-item.used { opacity: .75; }
.slot-item.past { opacity: .55; }
.si-main { display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
.used-tag { font-size: 11px; color: var(--cyan); border: 1px solid rgba(79,195,247,.4); border-radius: 9px; padding: 2px 8px; }
.past-tag { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 9px; padding: 2px 8px; }

/* 表单 */
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 6px 0 14px; }
.form-grid.one { grid-template-columns: 1fr; }
.form-grid label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.form-grid label.span2 { grid-column: span 2; }
.form-grid input, .form-grid select { width: 100%; }
.checks { display: flex; gap: 16px; flex-wrap: wrap; }
.ck { display: flex; align-items: center; gap: 6px; flex-direction: row !important; color: var(--text) !important; font-size: 13px !important; }
.ck input { width: auto; }
.suggest { border: 1px solid rgba(87,214,160,.35); background: rgba(87,214,160,.06); border-radius: 10px; padding: 10px 12px; margin-bottom: 12px; }
.sug-items { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 7px; }
.sug { font-size: 12px; padding: 5px 10px; border-color: rgba(87,214,160,.45); color: var(--green); }

/* 详情 */
.detail-box { max-height: 92vh; }
.d-timecard { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; display: flex; flex-direction: column; gap: 7px; margin-bottom: 12px; }
.d-timecard.resch { border-color: rgba(255,209,102,.5); }
.oldline { font-size: 12.5px; text-decoration: line-through; }
.newline { font-size: 16px; font-weight: 600; }
.newline em { font-style: normal; font-weight: 400; font-size: 12px; margin-left: 8px; }
.d-place { font-size: 12.5px; }
.noshow-bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; border: 1px solid rgba(255,107,122,.45); background: rgba(255,107,122,.07); border-radius: 10px; padding: 10px 13px; margin-bottom: 12px; }
.d-acts { margin-bottom: 14px; }
.judge { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; width: 100%; }
.timeline { border-top: 1px solid var(--border); padding-top: 10px; }
.timeline h4 { font-size: 13.5px; margin-bottom: 10px; }
.msg { display: flex; gap: 9px; padding: 8px 4px; border-bottom: 1px dashed var(--border); }
.m-icon { font-size: 15px; }
.m-body { flex: 1; min-width: 0; }
.m-head { display: flex; justify-content: space-between; gap: 8px; }
.m-head b { font-size: 12.5px; }
.m-head em { font-style: normal; font-size: 11px; }
.m-body p { font-size: 13px; line-height: 1.55; margin: 2px 0; }
.m-body > em { font-style: normal; font-size: 11px; }
textarea { width: 100%; background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; margin-bottom: 12px; }
</style>
