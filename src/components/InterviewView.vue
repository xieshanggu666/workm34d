<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const roundFilter = ref('all')
const detail = ref(null) // application pipline row

// 面试管理页覆盖「面试中」与「因最近一轮不通过被自动淘汰（可改判复活）」的应聘
const interviewApps = computed(() => store.applications.filter(a =>
  a.stage === 'interview' ||
  (a.stage === 'rejected' && ['screening', 'interview'].includes(a.reject_from) && a.interviews?.length)
))
const list = computed(() => interviewApps.value.filter(a =>
  roundFilter.value === 'all' || a.interviews.some(i => i.round === roundFilter.value)
))

function openDetail(a) { detail.value = a }

const ivResult = r => ({
  pending: ['⏳', '待定'], pass: ['✅', '通过'], fail: ['❌', '不通过']
}[r] || ['⏳', '待定'])

function lastInterview(a) {
  return (a.interviews || []).slice().sort((x, y) => x.id - y.id).at(-1) || null
}
function conclusionOf(iv) { return iv.conclusion || iv.result || 'pending' }

// 仅评价文本/面试官变更，不打 toast（评价录入属日常协作，不纳入审批）
function saveEval(iv) { store.setInterview(iv.id, { eval: iv.eval, interviewer: iv.interviewer }) }

// ---- 角色权限与审批联动 ----
// 面试结论（通过/不通过）由「面试官」提交审批，招聘负责人审批后生效并联动阶段；「待定」非终论可直接保存
const isInterviewer = computed(() => store.myRole === 'interviewer')
const isRecruiter = computed(() => store.myRole === 'recruiter')
// 该面试是否存在进行中的结论审批
function pendingConclusionTask(a, iv) {
  const t = store.pendingTask(a.id, 'interview_conclusion')
  return t && t.payload?.interview_id === iv.id ? t : null
}
function setConclusion(iv, c) {
  if (conclusionOf(iv) === c) return
  if (c === 'pending') { store.setInterview(iv.id, { conclusion: 'pending' }); return }
  if (!isInterviewer.value) { store.notify('error', '面试结论需由「面试官」身份提交审批，请切换身份'); return }
  store.submitApproval({
    type: 'interview_conclusion',
    application_id: detail.value.id,
    payload: { interview_id: iv.id, conclusion: c }
  })
}
const roundOpts = ['初试', '复试', '终面', 'HR面']
function addRound() {
  if (!isRecruiter.value) { store.notify('error', '安排面试需「招聘负责人」身份'); return }
  const used = new Set((detail.value.interviews || []).map(i => i.round))
  const round = roundOpts.find(r => !used.has(r)) || `第${(detail.value.interviews?.length || 0) + 1}轮`
  store.addInterview(detail.value.id, { round, interviewer: '', time: '待定' })
}
// 结论已通过 → 提请推进到 Offer（招聘负责人提交，用人经理审批后回写阶段）
function passAndAdvance(a) {
  const iv = lastInterview(a)
  if (!iv || conclusionOf(iv) !== 'pass') return
  if (!isRecruiter.value) { store.notify('error', '提请推进需「招聘负责人」身份'); return }
  store.submitApproval({ type: 'stage_advance', application_id: a.id, payload: { target_stage: 'offer' } })
}
</script>

<template>
  <div class="interview">
    <div class="bar">
      <span class="muted">面试相关应聘 {{ interviewApps.length }} 份（含最近一轮不通过待复核）</span>
      <select v-model="roundFilter" class="round-filter">
        <option value="all">全部轮次</option>
        <option v-for="r in ['初试','复试','终面','HR面']" :key="r" :value="r">{{ r }}</option>
      </select>
    </div>

    <div class="ilist">
      <div class="icard card" v-for="a in list" :key="a.id" @click="openDetail(a)">
        <div class="ihead">
          <b>{{ a.candidate }}</b>
          <span class="tag">{{ a.position }}</span>
          <span v-if="a.stage === 'rejected'" class="stage-tag reject">已淘汰·可改判</span>
        </div>
        <div class="isub muted">{{ a.interviews.length ? a.interviews[a.interviews.length - 1].round : '待安排' }} · 面试官 {{ a.interviews.length ? a.interviews[a.interviews.length-1].interviewer || '-' : '-' }}</div>
        <div class="irounds">
          <div v-for="iv in a.interviews" :key="iv.id" class="iround">
            <span class="rtag">{{ iv.round }}</span>
            <span class="rres" :class="conclusionOf(iv)">{{ ivResult(conclusionOf(iv))[0] }} {{ ivResult(conclusionOf(iv))[1] }}</span>
          </div>
          <div v-if="!a.interviews.length" class="muted">尚未安排面试</div>
        </div>
      </div>
      <div class="card empty" v-if="!list.length">当前无面试中的候选人。</div>
    </div>

    <!-- 面试详情 -->
    <div class="modal" v-if="detail" @click.self="detail = null">
      <div class="modal-box wide card">
        <h3>💬 面试管理 · {{ detail.candidate }} <span class="tag">{{ detail.position }}</span>
          <span v-if="detail.stage === 'rejected'" class="stage-tag reject">已淘汰（改判结论可复活）</span>
        </h3>
        <div class="iv-list">
          <div class="iv-item card" v-for="iv in detail.interviews" :key="iv.id">
            <div class="ivtop">
              <span class="rtag">{{ iv.round }}</span>
              <input v-model="iv.interviewer" placeholder="面试官姓名" @change="saveEval(iv)" />
              <div class="ivres">
                <button class="succ" :class="{ on: conclusionOf(iv) === 'pass' }"
                  :disabled="!!pendingConclusionTask(detail, iv)"
                  :title="isInterviewer ? '提交「通过」结论审批（招聘负责人审批后生效）' : '需「面试官」身份提交结论审批'"
                  @click="setConclusion(iv, 'pass')">✅ 通过</button>
                <button class="danger" :class="{ on: conclusionOf(iv) === 'fail' }"
                  :disabled="!!pendingConclusionTask(detail, iv)"
                  :title="isInterviewer ? '提交「不通过」结论审批（招聘负责人审批后生效）' : '需「面试官」身份提交结论审批'"
                  @click="setConclusion(iv, 'fail')">❌ 不通过</button>
                <button class="ghost" :class="{ on: conclusionOf(iv) === 'pending' }"
                  :disabled="!!pendingConclusionTask(detail, iv)"
                  title="「待定」非终论，直接保存无需审批"
                  @click="setConclusion(iv, 'pending')">⏳ 待定</button>
              </div>
            </div>
            <div class="appr-pending" v-if="pendingConclusionTask(detail, iv)">
              ⏳ 结论审批中（{{ pendingConclusionTask(detail, iv).payload?.conclusion === 'pass' ? '通过' : '不通过' }}），待招聘负责人审批 · #{{ pendingConclusionTask(detail, iv).id }}
            </div>
            <textarea v-model="iv.eval" placeholder="填写面试评价……" rows="2" @change="saveEval(iv)"></textarea>
            <div class="muted" v-if="iv.id === lastInterview(detail)?.id">
              {{ conclusionOf(iv) === 'fail'
                ? '最近一轮结论为「不通过」：应聘已自动淘汰；如属误判，改回通过即可复活。'
                : conclusionOf(iv) === 'pass'
                  ? '最近一轮结论为「通过」：可提请推进到 Offer 阶段（用人经理审批）。'
                  : '这是最后一轮评价，「通过/不通过」结论需提交审批，由招聘负责人审批后生效。' }}
            </div>
          </div>
        </div>
        <div class="acts">
          <button class="primary" :disabled="!isRecruiter" :title="isRecruiter ? '' : '需「招聘负责人」身份安排面试'" @click="addRound">＋ 添加下一轮面试</button>
          <button class="succ" :disabled="detail.stage !== 'interview' || conclusionOf(lastInterview(detail)) !== 'pass' || !isRecruiter || !!store.pendingTask(detail.id, 'stage_advance')"
            :title="!isRecruiter ? '需「招聘负责人」身份提请推进' : store.pendingTask(detail.id, 'stage_advance') ? '推进审批中' : '提交推进审批（用人经理审批后进入 Offer）'"
            @click="passAndAdvance(detail)">
            {{ store.pendingTask(detail.id, 'stage_advance') ? '⏳ 推进审批中' : '→ 提请推进到 Offer' }}
          </button>
          <button class="ghost" @click="detail = null">关闭</button>
        </div>
        <div class="muted tip">面试结论是进入 Offer 的硬约束；结论经审批生效后与阶段联动、阶段快照在同一事务提交。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.interview { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; }
.round-filter { min-width: 120px; padding: 5px 8px; }
.ilist { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.icard { cursor: pointer; transition: .18s; }
.icard:hover { border-color: var(--accent); transform: translateY(-2px); }
.ihead { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.ihead b { font-size: 15px; }
.stage-tag { font-size: 10px; border-radius: 9px; padding: 2px 7px; border: 1px solid; }
.stage-tag.reject { color: var(--red); border-color: rgba(255,107,122,.45); background: rgba(255,107,122,.08); }
.isub { font-size: 12px; margin: 6px 0; }
.irounds { display: flex; flex-direction: column; gap: 6px; }
.iround { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.rtag { font-size: 11px; background: var(--panel2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 10px; }
.rres.pass { color: var(--green); }
.rres.fail { color: var(--red); }
.iv-list { display: flex; flex-direction: column; gap: 12px; margin: 14px 0; }
.iv-item { border-color: var(--border); }
.ivtop { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.ivtop input { flex: 1; min-width: 140px; }
.ivres { display: flex; gap: 6px; margin-left: auto; }
.ivres button.on.succ { background: var(--green); color: #06231a; }
.ivres button.on.danger { background: var(--red); color: #fff; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; }
.appr-pending { font-size: 11px; color: var(--accent2); background: rgba(255,209,102,.1); border: 1px solid rgba(255,209,102,.35); border-radius: 8px; padding: 5px 9px; margin-bottom: 8px; }
.tip { margin-top: 10px; font-size: 12px; }
textarea { width: 100%; background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; }
</style>
