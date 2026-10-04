<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const tab = ref('todo')
const returnTarget = ref(null)   // 待退回的任务
const returnNote = ref('')
const resubmitTarget = ref(null) // 待重提的任务
const resubmitSalary = ref(0)
const resubmitNote = ref('')
const resubmitConclusion = ref('pass')
const resubmitStrategy = ref({
  rollout_mode: 'full', canary_percent: 20, canary_candidate_ids: [],
  effective_start: '', effective_end: '', change_note: ''
})
const expandSteps = ref({})      // taskId -> bool 展开审批记录

const STAGE_LABEL = { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用', rejected: '淘汰' }
const TYPE_META = {
  stage_advance: { icon: '🔄', label: '候选人推进', submitRole: 'recruiter' },
  interview_conclusion: { icon: '💬', label: '面试结论', submitRole: 'interviewer' },
  offer_issue: { icon: '📄', label: 'Offer 发放', submitRole: 'recruiter' },
  strategy_publish: { icon: '⚙️', label: '匹配策略发布', submitRole: 'recruiter' }
}
const STATUS_META = {
  pending: ['⏳', '审批中', 'var(--accent2)'],
  returned: ['↩️', '已退回', 'var(--red)'],
  approved: ['✅', '已通过·已生效', 'var(--green)'],
  scheduled: ['🕒', '待生效', 'var(--accent)'],
  cancelled: ['🚫', '已撤销', 'var(--muted)'],
  failed: ['⚠️', '执行失败', 'var(--red)']
}
const fmtInput = iso => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtWindow = iso => iso ? String(iso).replace('T', ' ').slice(0, 16) : '立即'
const positionName = id => store.positions.find(p => p.id === Number(id))?.name || `职位 #${id}`
const STEP_ACTION = {
  submit: ['📨', '提交申请'], approve: ['✅', '审批通过'], return: ['↩️', '退回'],
  resubmit: ['🔁', '修改重提'], cancel: ['🚫', '撤销'], execute: ['⚡', '执行回写'], failed: ['⚠️', '执行失败']
}
const ROLE_LABEL = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }

const myId = computed(() => store.userId)
const myRole = computed(() => store.myRole)

// 待我审批：进行中且当前节点角色 = 我的角色
const todoList = computed(() => store.approvals.filter(t =>
  t.status === 'pending' && t.chain[t.current_step]?.role === myRole.value))
// 我发起的
const mineList = computed(() => store.approvals.filter(t => t.submitted_by === myId.value))
const returnedMine = computed(() => mineList.value.filter(t => t.status === 'returned'))
const list = computed(() =>
  tab.value === 'todo' ? todoList.value : tab.value === 'mine' ? mineList.value : store.approvals)

const closedCount = computed(() => store.approvals.filter(t => ['approved', 'failed', 'cancelled'].includes(t.status)).length)

function payloadSummary(t) {
  const p = t.payload || {}
  if (t.type === 'stage_advance') return `推进「${STAGE_LABEL[p.from_stage] || p.from_stage} → ${STAGE_LABEL[p.target_stage] || p.target_stage}」`
  if (t.type === 'interview_conclusion') return `「${p.round}」结论：${p.conclusion === 'pass' ? '✅ 通过' : '❌ 不通过'}`
  if (t.type === 'offer_issue') return `月薪 ¥${Number(p.salary || 0).toLocaleString()}${p.note ? ` · ${p.note}` : ''}`
  if (t.type === 'strategy_publish') {
    const scope = p.rollout_mode === 'canary'
      ? `灰度 ${p.canary_candidate_ids?.length ? p.canary_candidate_ids.length + '人' : p.canary_percent + '%'}`
      : '全量'
    return `${positionName(p.position_id)} v${p.strategy_version_id} · ${scope} · ${fmtWindow(p.effective_start)} → ${p.effective_end ? fmtWindow(p.effective_end) : '长期'}`
  }
  return ''
}
// 审批链节点展示：提交 → 各级审批；当前等待节点高亮
function chainNodes(t) {
  return [
    { label: '提交', role: t.submitted_role, who: t.submitted_by_name },
    ...t.chain.map(c => ({ label: ROLE_LABEL[c.role] || c.role, role: c.role, reason: c.reason || '' }))
  ]
}
function nodeState(t, idx) {
  if (t.status === 'approved') return 'done'
  if (t.status === 'cancelled' || t.status === 'failed') return idx === 0 ? 'done' : 'off'
  if (t.status === 'returned') return idx === 0 ? 'current' : 'off'
  // pending：0=提交已完成；current_step+1=等待中的节点
  if (idx === 0) return 'done'
  if (idx === t.current_step + 1) return 'current'
  if (idx <= t.current_step) return 'done'
  return 'off'
}
const canDecide = t => t.status === 'pending' && t.chain[t.current_step]?.role === myRole.value
const canOperate = t => t.submitted_by === myId.value && ['pending', 'returned'].includes(t.status)
const busy = id => !!store.pending[`appr:${id}`]

function onApprove(t) { store.decideApproval(t.id, { action: 'approve', version: t.version }, '已通过审批') }
function openReturn(t) { returnTarget.value = t; returnNote.value = '' }
function confirmReturn() {
  const t = returnTarget.value
  if (!returnNote.value.trim()) { store.notify('error', '退回必须填写退回意见'); return }
  store.decideApproval(t.id, { action: 'return', note: returnNote.value, version: t.version }, '已退回申请人')
  returnTarget.value = null
}
function onCancel(t) { store.cancelApproval(t.id) }
function openResubmit(t) {
  resubmitTarget.value = t
  resubmitSalary.value = t.payload?.salary || 20000
  resubmitNote.value = t.payload?.note || ''
  resubmitConclusion.value = t.payload?.conclusion || 'pass'
  resubmitStrategy.value = {
    rollout_mode: t.payload?.rollout_mode || 'full',
    canary_percent: t.payload?.canary_percent ?? 20,
    canary_candidate_ids: [...(t.payload?.canary_candidate_ids || [])],
    effective_start: fmtInput(t.payload?.effective_start),
    effective_end: fmtInput(t.payload?.effective_end),
    change_note: t.payload?.change_note || ''
  }
}
function confirmResubmit() {
  const t = resubmitTarget.value
  const payload = {}
  if (t.type === 'offer_issue') { payload.salary = resubmitSalary.value; payload.note = resubmitNote.value }
  if (t.type === 'interview_conclusion') payload.conclusion = resubmitConclusion.value
  if (t.type === 'strategy_publish') {
    if (resubmitStrategy.value.rollout_mode === 'canary' && !resubmitStrategy.value.effective_end) {
      store.notify('error', '灰度窗口结束时间必填')
      return
    }
    Object.assign(payload, {
      ...resubmitStrategy.value,
      canary_candidate_ids: resubmitStrategy.value.canary_candidate_ids.map(Number)
    })
    store.resubmitStrategy(t.id, payload)
    resubmitTarget.value = null
    return
  }
  store.resubmitApproval(t.id, payload)
  resubmitTarget.value = null
}
function toggleSteps(t) { expandSteps.value = { ...expandSteps.value, [t.id]: !expandSteps.value[t.id] } }
const fmtTime = t => t ? String(t).replace('T', ' ').slice(0, 16) : ''
</script>

<template>
  <div class="approval">
    <!-- 角色权限说明：当前身份决定可发起的申请类型与可审批的节点 -->
    <div class="role-banner card">
      <span v-if="myRole === 'recruiter'">🧭 当前身份「招聘负责人」：可提请<b>候选人推进</b>、发起<b>Offer 发放</b>与<b>匹配策略灰度/全量发布</b>申请，并审批面试官提交的<b>面试结论</b>；超带宽 Offer 由您终审。</span>
      <span v-else-if="myRole === 'interviewer'">💬 当前身份「面试官」：可提交<b>面试结论</b>申请（通过/不通过），由招聘负责人审批后生效。</span>
      <span v-else>🏢 当前身份「用人经理」：审批<b>候选人推进</b>、<b>Offer 发放</b>与<b>匹配策略发布</b>申请；可退回并附意见，申请人修改后可重新提交。</span>
    </div>

    <div class="stat-row">
      <div class="card stat" :class="{ on: tab === 'todo' }" @click="tab = 'todo'">
        <span>📥</span><b>{{ todoList.length }}</b><em>待我审批</em>
      </div>
      <div class="card stat" :class="{ on: tab === 'mine' }" @click="tab = 'mine'">
        <span>📤</span><b>{{ mineList.filter(t => t.status === 'pending').length }}</b><em>我发起的·进行中</em>
      </div>
      <div class="card stat" :class="{ on: tab === 'mine' }" @click="tab = 'mine'">
        <span>↩️</span><b>{{ returnedMine.length }}</b><em>被退回待处理</em>
      </div>
      <div class="card stat" :class="{ on: tab === 'all' }" @click="tab = 'all'">
        <span>🗂️</span><b>{{ closedCount }}</b><em>已结案（审计）</em>
      </div>
    </div>

    <div class="tabs">
      <button :class="{ on: tab === 'todo' }" @click="tab = 'todo'">📥 待我审批 <em class="cnt" v-if="todoList.length">{{ todoList.length }}</em></button>
      <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">📤 我发起的 <em class="cnt warn" v-if="returnedMine.length">{{ returnedMine.length }} 退回</em></button>
      <button :class="{ on: tab === 'all' }" @click="tab = 'all'">🗂️ 全部记录</button>
    </div>

    <div class="tlist">
      <div class="tcard card" v-for="t in list" :key="t.id">
        <div class="t-head">
          <span class="t-type">{{ TYPE_META[t.type]?.icon }} {{ t.type_label }}</span>
          <span class="t-status" :style="{ color: STATUS_META[t.status][2], borderColor: STATUS_META[t.status][2] }">
            {{ STATUS_META[t.status][0] }} {{ STATUS_META[t.status][1] }}
          </span>
          <em class="muted">#{{ t.id }}</em>
        </div>
        <div class="t-main">
          <b>{{ t.candidate || (t.type === 'strategy_publish' ? positionName(t.payload.position_id) : '') }}</b>
          <span class="muted">{{ t.position || (t.type === 'strategy_publish' ? '匹配策略治理' : t.dept) }}</span>
          <span class="t-summary">{{ payloadSummary(t) }}</span>
        </div>
        <!-- 审批链进度：提交 → 逐级审批，当前等待节点高亮 -->
        <div class="chain">
          <template v-for="(n, i) in chainNodes(t)" :key="i">
            <div class="cnode" :class="nodeState(t, i)" :title="n.reason || n.who || ''">
              <i>{{ nodeState(t, i) === 'done' ? '✓' : i === 0 ? '📨' : '⏳' }}</i>
              <span>{{ n.label }}</span>
            </div>
            <em v-if="i < chainNodes(t).length - 1" class="carrow">→</em>
          </template>
        </div>
        <div class="t-meta muted">
          申请人 {{ t.submitted_by_name }} · {{ fmtTime(t.submitted_at) }}
          <template v-if="t.decided_at"> · 处理于 {{ fmtTime(t.decided_at) }}</template>
        </div>
        <div class="t-note return" v-if="t.status === 'returned' && t.decide_note">↩️ 退回意见：{{ t.decide_note }}</div>
        <div class="t-note ok" v-if="t.status === 'approved' && t.result_note">⚡ {{ t.result_note }}</div>
        <div class="t-note fail" v-if="t.status === 'failed' && t.result_note">⚠️ {{ t.result_note }}</div>

        <div class="t-acts">
          <template v-if="canDecide(t)">
            <button class="succ" :disabled="busy(t.id)" @click="onApprove(t)">✅ 通过</button>
            <button class="warn" :disabled="busy(t.id)" @click="openReturn(t)">↩️ 退回</button>
          </template>
          <template v-if="canOperate(t)">
            <button v-if="t.status === 'returned'" class="primary" :disabled="busy(t.id)" @click="openResubmit(t)">✏️ 修改重提</button>
            <button class="ghost" :disabled="busy(t.id)" @click="onCancel(t)">🚫 撤销</button>
          </template>
          <button class="ghost steps-toggle" @click="toggleSteps(t)">
            {{ expandSteps[t.id] ? '▾ 收起记录' : '▸ 审批记录' }}（{{ t.steps.length }}）
          </button>
        </div>

        <!-- 审批步骤留痕：提交/通过/退回/重提/执行回写全程可审计 -->
        <div class="steps" v-if="expandSteps[t.id]">
          <div class="step" v-for="s in t.steps" :key="s.id">
            <span class="s-icon">{{ STEP_ACTION[s.action]?.[0] || '•' }}</span>
            <div class="s-body">
              <b>{{ STEP_ACTION[s.action]?.[1] || s.action }}</b>
              <span class="muted">{{ s.actor_name }}<template v-if="s.role">（{{ ROLE_LABEL[s.role] || s.role }}）</template> · {{ fmtTime(s.acted_at) }}</span>
              <p v-if="s.note">{{ s.note }}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="card empty" v-if="!list.length">
        {{ tab === 'todo' ? '暂无待您审批的任务。' : tab === 'mine' ? '您还没有发起过审批申请。' : '暂无审批记录。' }}
      </div>
    </div>

    <!-- 退回意见 -->
    <div class="modal" v-if="returnTarget" @click.self="returnTarget = null">
      <div class="modal-box card">
        <h3>↩️ 退回申请 · {{ returnTarget.candidate }}</h3>
        <p class="muted">{{ returnTarget.type_label }}：{{ payloadSummary(returnTarget) }}</p>
        <textarea v-model="returnNote" rows="3" placeholder="请填写退回意见（必填），申请人修改后可重新提交"></textarea>
        <div class="acts">
          <button class="warn" :disabled="busy(returnTarget.id)" @click="confirmReturn">确认退回</button>
          <button class="ghost" @click="returnTarget = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 修改重提 -->
    <div class="modal" v-if="resubmitTarget" @click.self="resubmitTarget = null">
      <div class="modal-box card">
        <h3>✏️ 修改并重新提交 · {{ resubmitTarget.candidate }}</h3>
        <p class="muted" v-if="resubmitTarget.decide_note">退回意见：{{ resubmitTarget.decide_note }}</p>
        <template v-if="resubmitTarget.type === 'offer_issue'">
          <label class="muted">Offer 月薪</label>
          <div class="sal-input">
            <input type="number" v-model.number="resubmitSalary" min="1000" max="1000000" />
            <span class="muted">¥/月</span>
          </div>
          <label class="muted">备注</label>
          <input v-model="resubmitNote" placeholder="补充说明（可选）" />
        </template>
        <template v-else-if="resubmitTarget.type === 'interview_conclusion'">
          <label class="muted">面试结论</label>
          <div class="acts">
            <button class="succ" :class="{ on: resubmitConclusion === 'pass' }" @click="resubmitConclusion = 'pass'">✅ 通过</button>
            <button class="danger" :class="{ on: resubmitConclusion === 'fail' }" @click="resubmitConclusion = 'fail'">❌ 不通过</button>
          </div>
        </template>
        <template v-else-if="resubmitTarget.type === 'strategy_publish'">
          <label class="muted">发布方式</label>
          <div class="acts">
            <button class="primary" :class="{ on: resubmitStrategy.rollout_mode === 'full' }" @click="resubmitStrategy.rollout_mode = 'full'">全量发布</button>
            <button class="succ" :class="{ on: resubmitStrategy.rollout_mode === 'canary' }" @click="resubmitStrategy.rollout_mode = 'canary'">灰度发布</button>
          </div>
          <template v-if="resubmitStrategy.rollout_mode === 'canary'">
            <label class="muted">灰度比例：{{ resubmitStrategy.canary_percent }}%<input type="range" min="0" max="100" step="10" v-model.number="resubmitStrategy.canary_percent" /></label>
            <label class="muted">指定灰度候选人
              <select multiple v-model="resubmitStrategy.canary_candidate_ids" class="strategy-cands">
                <option v-for="c in store.candidates" :key="c.id" :value="c.id">{{ c.id }} · {{ c.name }}</option>
              </select>
            </label>
          </template>
          <div class="strategy-window">
            <label class="muted">生效开始<input type="datetime-local" v-model="resubmitStrategy.effective_start" /></label>
            <label class="muted">窗口结束<input type="datetime-local" v-model="resubmitStrategy.effective_end" /></label>
          </div>
          <label class="muted">发布说明 / 回滚预案<input v-model="resubmitStrategy.change_note" /></label>
        </template>
        <p class="muted" v-else>推进目标阶段不可修改，确认后将重新提交审批。</p>
        <div class="acts" style="margin-top:12px">
          <button class="primary" :disabled="busy(resubmitTarget.id)" @click="confirmResubmit">重新提交</button>
          <button class="ghost" @click="resubmitTarget = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.approval { display: flex; flex-direction: column; gap: 14px; }
.role-banner { padding: 10px 14px; font-size: 12.5px; color: var(--muted); background: rgba(91,140,255,.07); border-color: rgba(91,140,255,.28); }
.role-banner b { color: var(--accent); margin: 0 2px; }
.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 14px; cursor: pointer; transition: .18s; }
.stat:hover { border-color: var(--accent); }
.stat.on { border-color: var(--accent); background: rgba(91,140,255,.08); }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.tabs { display: flex; gap: 8px; }
.tabs button { padding: 7px 14px; font-size: 13px; opacity: .8; }
.tabs button.on { opacity: 1; border-color: var(--accent); background: rgba(91,140,255,.15); color: var(--accent); }
.cnt { font-style: normal; font-size: 10px; background: var(--red); color: #fff; border-radius: 8px; padding: 1px 6px; margin-left: 4px; }
.cnt.warn { background: var(--accent2); color: #3a2c00; }
.tlist { display: flex; flex-direction: column; gap: 12px; }
.tcard { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; }
.t-head { display: flex; align-items: center; gap: 10px; }
.t-type { font-weight: 700; font-size: 14px; }
.t-status { font-size: 11px; border: 1px solid; border-radius: 10px; padding: 2px 8px; }
.t-head em { margin-left: auto; font-style: normal; }
.t-main { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 14px; }
.t-summary { color: var(--accent2); font-size: 13px; }
.chain { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.cnode { display: flex; align-items: center; gap: 5px; font-size: 11.5px; padding: 3px 9px; border-radius: 12px; border: 1px solid var(--border); color: var(--muted); background: var(--panel2); }
.cnode i { font-style: normal; }
.cnode.done { color: var(--green); border-color: rgba(87,214,160,.4); background: rgba(87,214,160,.08); }
.cnode.current { color: var(--accent2); border-color: rgba(255,209,102,.5); background: rgba(255,209,102,.1); box-shadow: 0 0 0 2px rgba(255,209,102,.12); }
.carrow { color: var(--muted); font-style: normal; font-size: 11px; }
.t-meta { font-size: 11.5px; }
.t-note { font-size: 12px; border-radius: 8px; padding: 7px 10px; }
.t-note.return { color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.3); }
.t-note.ok { color: var(--green); background: rgba(87,214,160,.08); border: 1px solid rgba(87,214,160,.3); }
.t-note.fail { color: var(--red); background: rgba(255,107,122,.08); border: 1px solid rgba(255,107,122,.3); }
.t-acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.t-acts button { font-size: 12px; padding: 5px 11px; }
.steps-toggle { margin-left: auto; font-size: 11px; color: var(--muted); }
.steps { border-top: 1px dashed var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.step { display: flex; gap: 9px; font-size: 12px; }
.s-icon { width: 22px; text-align: center; }
.s-body { display: flex; flex-direction: column; gap: 1px; }
.s-body b { font-size: 12px; }
.s-body .muted { font-size: 11px; }
.s-body p { color: var(--text); font-size: 12px; margin-top: 2px; }
textarea { width: 100%; background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; margin: 10px 0; }
.sal-input { display: flex; align-items: center; gap: 8px; margin: 8px 0 12px; }
.sal-input input { flex: 1; font-size: 17px; padding: 9px; }
.strategy-window { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 8px 0; }
.strategy-cands { min-height: 92px; }
.modal-box label { display: block; margin: 8px 0 4px; font-size: 12px; }
.modal-box input { width: 100%; }
.modal-box .acts button.on.succ { background: var(--green); color: #06231a; }
.modal-box .acts button.on.danger { background: var(--red); color: #fff; }
.empty { padding: 30px; text-align: center; color: var(--muted); }
</style>
