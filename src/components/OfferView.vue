<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const detail = ref(null)
const editTarget = ref(null)
const offerAmt = ref(20000)

// 待发：处于 Offer 阶段且没有进行中 Offer（含撤回/被拒后可重新发起）
const offerApps = computed(() => store.applications.filter(a =>
  a.stage === 'offer' && (!a.offer || ['withdrawn', 'rejected'].includes(a.offer.status))))
// 记录中：全部有 Offer 的应聘
const offerList = computed(() => store.applications.filter(a => a.offer))

// ---- 角色权限与审批联动 ----
// Offer 发放（发起/重新发起）由「招聘负责人」提交审批：用人经理审批，薪资超带宽自动加签终审；
// 审批通过后 Offer 才落库为「待回应」。调薪/接受/拒绝/入职/撤回为 HR 日常操作，限招聘负责人
const isRecruiter = computed(() => store.myRole === 'recruiter')
function pendingOfferTask(a) { return store.pendingTask(a.id, 'offer_issue') }

function openMake(a) {
  if (!isRecruiter.value) { store.notify('error', '发起 Offer 需「招聘负责人」身份'); return }
  detail.value = a
  const p = store.positions.find(p => p.id === a.position_id)
  offerAmt.value = Math.round(a.offer?.salary || (p ? (p.salary_min + p.salary_max) / 2 : 22000))
}
function makeOffer() {
  const a = detail.value
  store.submitApproval({ type: 'offer_issue', application_id: a.id, payload: { salary: offerAmt.value } })
  detail.value = null
}

function openEdit(a) {
  if (!isRecruiter.value) { store.notify('error', '调整薪资需「招聘负责人」身份'); return }
  editTarget.value = a
  offerAmt.value = a.offer.salary
}
function saveSalary() {
  const a = editTarget.value
  store.updateOffer(a.offer.id, { salary: offerAmt.value, version: a.version }, 'Offer 薪资已更新')
  editTarget.value = null
}

function setStatus(a, status) {
  if (!isRecruiter.value) { store.notify('error', '该操作需「招聘负责人」身份'); return }
  store.setOffer(a.offer.id, status, a.version)
}
function withdraw(a) {
  if (!isRecruiter.value) { store.notify('error', '该操作需「招聘负责人」身份'); return }
  store.updateOffer(a.offer.id, { status: 'withdrawn', version: a.version, note: 'HR 撤回 Offer' }, 'Offer 已撤回')
}

const ofStatus = s => ({
  pending: ['⏳', '待回应', 'var(--accent2)'], accepted: ['✅', '已接受', 'var(--green)'],
  rejected: ['❌', '已拒绝', 'var(--red)'], joined: ['🎉', '已入职', 'var(--green)'],
  withdrawn: ['↩️', '已撤回', 'var(--muted)']
}[s] || ['⏳', '待回应', 'var(--accent2)'])

// 超带宽检测：发起弹窗实时提示将触发加签终审（与服务端 buildChain 同一规则）
const bandMax = computed(() => {
  if (!detail.value) return 0
  const p = store.positions.find(p => p.id === detail.value.position_id)
  return p ? p.salary_max : 0
})
const overBand = computed(() => bandMax.value > 0 && Number(offerAmt.value) > bandMax.value)

const fmtTime = t => t ? String(t).replace('T', ' ').slice(0, 13) : ''
function busy(id) { return !!store.pending[`offer:${id}`] }
</script>

<template>
  <div class="offer">
    <div class="two">
      <div class="card">
        <h3>📤 待发 / 可重发 Offer <span class="tag">{{ offerApps.length }}</span></h3>
        <div class="olist">
          <div class="ocard" v-for="a in offerApps" :key="a.id">
            <div><b>{{ a.candidate }}</b><em class="muted">{{ a.position }}</em></div>
            <div class="muted">{{ a.city }}<span v-if="a.offer?.status === 'withdrawn'" class="reissue-hint">· 上次已撤回，可重新发起</span><span v-else-if="a.offer?.status === 'rejected'" class="reissue-hint">· 上次被拒绝，可重新发起</span></div>
            <span v-if="pendingOfferTask(a)" class="appr-pending-chip" :title="`发放审批 #${pendingOfferTask(a).id} 待审批`">⏳ 发放审批中</span>
            <button v-else class="primary" :disabled="!isRecruiter" :title="isRecruiter ? '提交 Offer 发放审批（用人经理审批）' : '需「招聘负责人」身份'" @click="openMake(a)">{{ a.offer ? '重新发起' : '发起 Offer' }}</button>
          </div>
          <div class="muted empty" v-if="!offerApps.length">当前无待发 Offer，先在「面试管理」给出通过结论并推进至 Offer 阶段。</div>
        </div>
      </div>

      <div class="card">
        <h3>💼 Offer 记录 <span class="tag">{{ offerList.length }}</span></h3>
        <div class="olist">
          <div class="ocard" v-for="a in offerList" :key="a.id" :class="['st-'+a.offer.status]">
            <div class="omain">
              <div><b>{{ a.candidate }}</b><em class="muted">{{ a.position }}</em></div>
              <div class="money">¥{{ a.offer.salary.toLocaleString() }}<em class="muted">/月</em></div>
            </div>
            <div class="op-acts">
              <span class="ostatus" :style="{ color: ofStatus(a.offer.status)[2], borderColor: ofStatus(a.offer.status)[2] }">
                {{ ofStatus(a.offer.status)[0] }} {{ ofStatus(a.offer.status)[1] }}
              </span>
              <!-- 待回应：可调薪/接受/拒绝/撤回 -->
              <template v-if="a.offer.status === 'pending'">
                <button class="ghost sm" :disabled="!isRecruiter" @click="openEdit(a)">✏️ 调薪</button>
                <button class="succ sm" :disabled="busy(a.offer.id) || !isRecruiter" @click="setStatus(a, 'accepted')">接受</button>
                <button class="primary sm" :disabled="busy(a.offer.id) || !isRecruiter" @click="setStatus(a, 'rejected')">拒绝</button>
                <button class="warn sm" :disabled="busy(a.offer.id) || !isRecruiter" @click="withdraw(a)">撤回</button>
              </template>
              <!-- 已接受（=录用待入职）：确认入职或撤回 -->
              <template v-else-if="a.offer.status === 'accepted'">
                <button class="primary sm" :disabled="busy(a.offer.id) || !isRecruiter" @click="setStatus(a, 'joined')">确认入职</button>
                <button class="warn sm" :disabled="busy(a.offer.id) || !isRecruiter" @click="withdraw(a)">撤回</button>
              </template>
              <!-- 已撤回/已拒绝：在 Offer 阶段时可重新发起 -->
              <button v-else-if="['withdrawn','rejected'].includes(a.offer.status) && a.stage === 'offer'" class="succ sm" @click="openMake(a)">重新发起</button>
            </div>
          </div>
          <div class="muted empty" v-if="!offerList.length">暂无 Offer 记录。</div>
        </div>
      </div>
    </div>

    <!-- 发起 / 重新发起 Offer（提交发放审批） -->
    <div class="modal" v-if="detail" @click.self="detail = null">
      <div class="modal-box card">
        <h3>📄 {{ detail.offer ? '重新发起 Offer' : '发起 Offer' }} · 提交审批</h3>
        <div class="ofinfo">
          <div><span class="muted">候选人</span><b>{{ detail.candidate }}</b></div>
          <div><span class="muted">职位</span><b>{{ detail.position }} · {{ detail.dept }}</b></div>
          <div><span class="muted">审批链</span><b>用人经理审批<span v-if="overBand"> → 招聘负责人终审（超带宽加签）</span></b></div>
        </div>
        <label class="muted">Offer 月薪（1,000 ~ 1,000,000；审批通过后 Offer 才生效并留痕）</label>
        <div class="sal-input">
          <input type="number" v-model.number="offerAmt" min="1000" max="1000000" />
          <span class="muted">¥/月</span>
        </div>
        <div class="band-tip" v-if="overBand">⚠️ 月薪超出职位带宽上限 ¥{{ bandMax.toLocaleString() }}，审批链将自动加签招聘负责人终审。</div>
        <div class="acts">
          <button class="primary" @click="makeOffer">提交发放审批</button>
          <button class="ghost" @click="detail = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 调整薪资（仅待回应可改） -->
    <div class="modal" v-if="editTarget" @click.self="editTarget = null">
      <div class="modal-box card">
        <h3>✏️ 调整 Offer 薪资 · {{ editTarget.candidate }}</h3>
        <div class="muted old-salary">原月薪 ¥{{ editTarget.offer.salary.toLocaleString() }}，调整会写入 Offer 变更记录。</div>
        <div class="sal-input">
          <input type="number" v-model.number="offerAmt" min="1000" max="1000000" />
          <span class="muted">¥/月</span>
        </div>
        <div class="acts">
          <button class="primary" @click="saveSalary">保存调整</button>
          <button class="ghost" @click="editTarget = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.offer { display: flex; flex-direction: column; gap: 16px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
.olist { display: flex; flex-direction: column; gap: 10px; }
.ocard { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 10px; flex-wrap: wrap; }
.ocard.st-joined { border-color: rgba(87,214,160,.45); background: rgba(87,214,160,.05); }
.ocard.st-rejected, .ocard.st-withdrawn { opacity: .8; }
.omain { display: flex; align-items: center; gap: 14px; }
.ocard b { display: block; }
.ocard em { font-style: normal; font-size: 11px; margin-left: 6px; }
.reissue-hint { margin-left: 4px; }
.op-acts { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ostatus { font-size: 11px; border: 1px solid; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
button.sm { font-size: 11px; padding: 4px 9px; }
.ofinfo { display: flex; flex-direction: column; gap: 8px; margin: 14px 0; }
.ofinfo div { display: flex; justify-content: space-between; }
.sal-input { display: flex; align-items: center; gap: 8px; margin: 8px 0 14px; }
.sal-input input { flex: 1; font-size: 18px; padding: 10px; }
.old-salary { font-size: 12px; margin-bottom: 8px; }
.appr-pending-chip { font-size: 11px; color: var(--accent2); background: rgba(255,209,102,.1); border: 1px solid rgba(255,209,102,.4); border-radius: 10px; padding: 3px 9px; white-space: nowrap; }
.band-tip { font-size: 12px; color: var(--accent2); background: rgba(255,209,102,.1); border: 1px solid rgba(255,209,102,.35); border-radius: 8px; padding: 7px 10px; margin-bottom: 12px; }
</style>
