<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()

const ROLE_LABEL = { recruiter: '招聘负责人', interviewer: '面试官', hiring_manager: '用人经理' }
const SEVERITY = { critical: ['🔴', 'P0 特急', 'var(--red)'], major: ['🟠', 'P1 重大', 'var(--accent2)'], minor: ['🟡', 'P2 一般', 'var(--cyan)'] }
const ISTATUS = {
  declared: ['🚨', '已立案', 'var(--red)'], responding: ['⚡', '处置中', 'var(--accent2)'],
  contained: ['🛑', '已遏制', 'var(--cyan)'], reviewing: ['📝', '复盘中', 'var(--purple)'], closed: ['🧾', '已结案', 'var(--green)']
}
const CAT = {
  declare: ['🚨', '立案', 'var(--red)'], action: ['🔧', '关键操作', 'var(--cyan)'],
  authorization: ['🔑', '授权变更', 'var(--purple)'], rollback: ['⏪', '状态回退', 'var(--accent2)'],
  decision: ['⚖️', '审批决策', 'var(--accent)'], ticket: ['🎫', '处置工单', 'var(--cyan)'],
  report: ['📝', '复盘定稿', 'var(--green)'], close: ['🧾', '结案归档', 'var(--green)']
}
const TK_STATUS = { open: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' }

const filter = ref('active')
const selectedId = ref(0)
const tab = ref('chain')

const list = computed(() => store.crisisIncidents.filter(i =>
  filter.value === 'all' ? true : filter.value === 'closed' ? i.status === 'closed' : i.status !== 'closed'))
const selected = computed(() => store.crisisIncidents.find(i => i.id === selectedId.value) || null)
const chain = computed(() => selected.value ? store.crisisEntriesOf(selected.value.id) : [])
const grants = computed(() => selected.value ? store.crisisGrantsOf(selected.value.id) : [])
const tickets = computed(() => selected.value ? store.crisisTicketsOf(selected.value.id) : [])
const report = computed(() => selected.value ? store.crisisReportOf(selected.value.id) : null)
const verify = computed(() => selected.value ? store.crisisVerification[selected.value.id] : null)
const appOf = id => store.applications.find(a => a.id === id)
const me = computed(() => store.currentUser)
const isCommander = computed(() => selected.value?.commander_id === me.value?.id)
const isMember = computed(() => store.isIncidentMember(selected.value))
const busy = k => !!store.pending[k]
const fmt = t => t ? String(t).replace('T', ' ').slice(5, 16) : ''

function appLabel(appId) {
  const a = appOf(appId)
  return a ? `${a.candidate} · ${a.position}` : ''
}
function openIncident(i) { selectedId.value = i.id; tab.value = 'chain' }
function closeDrawer() { selectedId.value = 0 }

// 立案表单
const showDeclare = ref(false)
const f = ref({ title: '', severity: 'major', application_id: 0, commander_id: '', description: '' })
function openDeclare() {
  f.value = { title: '', severity: 'major', application_id: 0, commander_id: '', description: '' }
  showDeclare.value = true
}
async function confirmDeclare() {
  const r = await store.declareCrisis({
    title: f.value.title, severity: f.value.severity,
    application_id: f.value.application_id || undefined,
    commander_id: f.value.commander_id || undefined,
    description: f.value.description
  })
  if (r?.ok) { showDeclare.value = false; openIncident(r.id) }
}

// 关键操作 / 授权 / 改派 / 工单 / 回退 的轻量表单
const actionNote = ref('')
const actCategory = ref('action')
async function addAction() {
  if (!actionNote.value.trim()) { store.notify('error', '请填写操作内容'); return }
  const r = await store.crisisAction(selected.value.id, { category: actCategory.value, summary: actionNote.value })
  if (r?.ok) actionNote.value = ''
}
const gForm = ref({ grantee_id: '', role: 'interviewer', reason: '' })
async function addGrant() {
  if (!gForm.value.grantee_id) { store.notify('error', '请选择被授权人'); return }
  if (!gForm.value.reason.trim()) { store.notify('error', '请填写授权事由'); return }
  const r = await store.grantRole(selected.value.id, { ...gForm.value })
  if (r?.ok) gForm.value = { grantee_id: '', role: 'interviewer', reason: '' }
}
const rbReason = ref('')
async function doRollback() {
  if (!rbReason.value.trim()) { store.notify('error', '危机回退必须填写处置原因'); return }
  const r = await store.crisisRollback(selected.value.id, { reason: rbReason.value })
  if (r?.ok) {
    rbReason.value = ''
    const parts = [`已回退：${r.fromLabel} → ${r.toLabel}${r.revived ? '（淘汰复活）' : ''}`]
    parts.push(`挂起预约 ${r.appointments_suspended?.length || 0}`)
    parts.push(`撤销待审 ${r.tasks_cancelled?.length || 0}`)
    parts.push(`归并未读 ${r.notifications_read || 0}`)
    store.notify('success', parts.join(' · '))
  }
}
const tkForm = ref({ title: '', content: '', priority: 'P2', owner_id: '' })
async function addTicket() {
  if (!tkForm.value.title.trim()) { store.notify('error', '请填写工单标题'); return }
  const r = await store.createTicket(selected.value.id, {
    ...tkForm.value, owner_id: tkForm.value.owner_id || me.value?.id
  })
  if (r?.ok) tkForm.value = { title: '', content: '', priority: 'P2', owner_id: '' }
}
const tkResolve = ref({})
function nextTicketStatus(t) { return ({ open: 'processing', processing: 'resolved', resolved: 'closed' })[t.status] || null }
async function moveTicket(t) {
  const payload = { status: nextTicketStatus(t) }
  if (payload.status === 'resolved') {
    const resolution = (tkResolve.value[t.id] || '').trim()
    if (!resolution) { store.notify('error', '请填写处置结果'); return }
    payload.resolution = resolution
  }
  const r = await store.updateTicket(t.id, payload)
  if (r?.ok) tkResolve.value[t.id] = ''
}
async function assignTicket(t, e) {
  if (!e.target.value || e.target.value === String(t.owner_id)) return
  await store.updateTicket(t.id, { owner_id: e.target.value })
}
const assignCommander = ref('')
async function changeCommander() {
  if (!assignCommander.value) return
  const r = await store.changeCommander(selected.value.id, assignCommander.value, '')
  if (r?.ok) assignCommander.value = ''
}
async function setState(s) { await store.crisisState(selected.value.id, s, '') }

// 复盘
const rp = ref({ summary: '', root_cause: '', improvementsText: '' })
const rpLoaded = ref(false)
function loadReport() {
  if (rpLoaded.value) return
  const r = report.value
  rp.value = {
    summary: r?.summary || '', root_cause: r?.root_cause || '',
    improvementsText: (r?.improvements || []).join('\n')
  }
  rpLoaded.value = true
}
function openReportTab() { tab.value = 'report'; loadReport() }
async function saveReport() {
  await store.saveReport(selected.value.id, {
    summary: rp.value.summary, root_cause: rp.value.root_cause,
    improvements: rp.value.improvementsText.split('\n').map(s => s.trim()).filter(Boolean)
  })
}
async function finalizeReport() {
  if (!rp.value.summary.trim() || !rp.value.root_cause.trim()) { store.notify('error', '请先完善复盘结论与根因分析'); return }
  const saved = await store.saveReport(selected.value.id, {
    summary: rp.value.summary, root_cause: rp.value.root_cause,
    improvements: rp.value.improvementsText.split('\n').map(s => s.trim()).filter(Boolean)
  })
  if (!saved) return
  await store.finalizeReport(selected.value.id)
}
const closeNote = ref('')
async function closeIncident() {
  await store.closeIncident(selected.value.id, closeNote.value)
  closeNote.value = ''
}
async function reVerify() {
  const r = await store.verifyIncident(selected.value.id)
  if (r?.ok) store.notify('success', `哈希链重算通过：${r.count} 条，链顶 ${r.head_hash.slice(0, 10)}…`)
}
const downloadHref = computed(() => selected.value ? `${store.exportIncidentUrl(selected.value.id)}` : '')

const activeCount = computed(() => store.crisisIncidents.filter(i => i.status !== 'closed').length)
const brokenCount = computed(() => store.crisisIncidents.filter(i => store.crisisVerification[i.id] && !store.crisisVerification[i.id].ok).length)
const openTicketCount = computed(() => store.crisisTickets.filter(t => ['open', 'processing'].includes(t.status)).length)
const activeGrants = computed(() => store.crisisGrants.filter(g => g.status === 'active').length)

function roleChip(role) { return ROLE_LABEL[role] || role }
</script>

<template>
  <div class="crisis">
    <div class="head-row">
      <div class="role-banner card">
        <span>🛡️ <b>跨角色危机处置审计</b>：对危机事件中的<b>关键操作</b>、<b>授权变更</b>与<b>状态回退</b>逐条上链（SHA-256 哈希链，数据库触发器禁止改写/删除）；通知、工单与复盘报告统一从审计链回写责任人。</span>
      </div>
      <button class="primary" @click="openDeclare">🚨 事件立案</button>
    </div>

    <div class="stat-row">
      <div class="card stat" :class="{ on: filter === 'active' }" @click="filter = 'active'">
        <span>🚨</span><b>{{ activeCount }}</b><em>处置中事件</em>
      </div>
      <div class="card stat" :class="{ on: filter === 'closed' }" @click="filter = 'closed'">
        <span>🧾</span><b>{{ store.crisisIncidents.filter(i => i.status === 'closed').length }}</b><em>已结案归档</em>
      </div>
      <div class="card stat">
        <span>🎫</span><b>{{ openTicketCount }}</b><em>未完成工单</em>
      </div>
      <div class="card stat">
        <span>🔑</span><b>{{ activeGrants }}</b><em>有效临时授权</em>
      </div>
      <div class="card stat" :class="{ danger: brokenCount }" :title="brokenCount ? '存在审计链被破坏的事件' : '全部审计链校验通过'">
        <span>{{ brokenCount ? '⛓️‍💥' : '🔗' }}</span><b>{{ brokenCount }}</b><em>链异常事件</em>
      </div>
    </div>

    <div class="ilist">
      <div class="icard card" v-for="i in list" :key="i.id" @click="openIncident(i)">
        <div class="ic-top">
          <span class="sev" :style="{ color: SEVERITY[i.severity]?.[2] }">{{ SEVERITY[i.severity]?.[0] }} {{ SEVERITY[i.severity]?.[1] }}</span>
          <span class="ist" :style="{ color: ISTATUS[i.status][2] }">{{ ISTATUS[i.status][0] }} {{ ISTATUS[i.status][1] }}</span>
          <em class="code muted">{{ i.code }}</em>
        </div>
        <b class="ic-title">{{ i.title }}</b>
        <div class="ic-meta muted">
          <span v-if="i.application_id">👤 {{ appLabel(i.application_id) }}</span>
          <span>🧭 指挥官 {{ i.commander_name }}</span>
          <span>🔗 {{ store.crisisEntriesOf(i.id).length }} 条审计</span>
          <span v-if="store.crisisVerification[i.id] && !store.crisisVerification[i.id].ok" class="broken">⛓️‍💥 链异常</span>
          <span v-else class="chain-ok">🔗 链完整</span>
        </div>
      </div>
      <div class="card empty" v-if="!list.length">暂无{{ filter === 'closed' ? '已结案' : '处置中' }}的危机事件。</div>
    </div>

    <!-- 立案 -->
    <div class="modal" v-if="showDeclare" @click.self="showDeclare = false">
      <div class="modal-box card">
        <h3>🚨 危机事件立案</h3>
        <label class="muted">事件标题</label>
        <input v-model="f.title" placeholder="如：候选人 Offer 超带宽误发 / 面试结论误判" />
        <div class="fgrid">
          <div>
            <label class="muted">严重级别</label>
            <select v-model="f.severity">
              <option value="critical">🔴 P0 特急</option>
              <option value="major">🟠 P1 重大</option>
              <option value="minor">🟡 P2 一般</option>
            </select>
          </div>
          <div>
            <label class="muted">关联在途应聘（可选）</label>
            <select v-model.number="f.application_id">
              <option :value="0">不关联</option>
              <option v-for="a in store.applications.filter(x => x.stage !== 'hired')" :key="a.id" :value="a.id">
                {{ a.candidate }} · {{ a.position }}（{{ {submitted:'投递',screening:'筛选',interview:'面试',offer:'Offer',hired:'录用',rejected:'淘汰'}[a.stage] }}）
              </option>
            </select>
          </div>
        </div>
        <label class="muted">事件指挥官（默认招聘负责人，可跨角色指定）</label>
        <select v-model="f.commander_id">
          <option value="">默认：招聘负责人</option>
          <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ roleChip(u.role) }}</option>
        </select>
        <label class="muted">事件描述</label>
        <textarea v-model="f.description" rows="3" placeholder="危机背景、影响范围、初步判断"></textarea>
        <div class="acts">
          <button class="danger" @click="confirmDeclare">确认立案并生成审计链</button>
          <button class="ghost" @click="showDeclare = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 事件详情抽屉 -->
    <div class="drawer-mask" v-if="selected" @click.self="closeDrawer">
      <div class="drawer card">
        <div class="d-head">
          <div>
            <div class="d-title-row">
              <h3>{{ selected.title }}</h3>
              <em class="code">{{ selected.code }}</em>
            </div>
            <div class="d-sub muted">
              <span :style="{ color: SEVERITY[selected.severity]?.[2] }">{{ SEVERITY[selected.severity]?.[0] }} {{ SEVERITY[selected.severity]?.[1] }}</span>
              <span :style="{ color: ISTATUS[selected.status][2] }">{{ ISTATUS[selected.status][0] }} {{ ISTATUS[selected.status][1] }}</span>
              <span v-if="selected.application_id">👤 {{ appLabel(selected.application_id) }}</span>
              <span>立案 {{ fmt(selected.declared_at) }}</span>
            </div>
          </div>
          <button class="ghost" @click="closeDrawer">✕</button>
        </div>

        <!-- 责任条 -->
        <div class="resp-bar">
          <div class="resp"><em class="muted">指挥官</em><b>🧭 {{ selected.commander_name }}</b><span class="tag">{{ roleChip(selected.commander_role) }}</span></div>
          <div class="resp"><em class="muted">立案人</em><b>{{ selected.declared_by_name }}</b><span class="tag">{{ roleChip(selected.declared_role) }}</span></div>
          <div class="resp chain-state" :class="{ bad: verify && !verify.ok }">
            <em class="muted">审计链</em>
            <b v-if="verify">{{ verify.ok ? '🔗 校验通过' : '⛓️‍💥 校验失败' }} · {{ verify.count }} 条</b>
            <button class="ghost sm" @click="reVerify">重算校验</button>
          </div>
        </div>

        <div class="d-acts" v-if="selected.status !== 'closed'">
          <template v-if="isCommander">
            <button v-if="selected.status === 'declared'" class="warn" @click="setState('responding')">⚡ 开始处置</button>
            <button v-if="selected.status === 'responding'" class="primary" @click="setState('contained')">🛑 标记遏制</button>
            <button v-if="['contained','responding'].includes(selected.status)" class="ghost" @click="openReportTab">📝 进入复盘</button>
            <button v-if="selected.status === 'contained'" class="warn" @click="setState('responding')">↩️ 遏制解除</button>
          </template>
          <a :href="downloadHref" class="dl" target="_blank"><button class="ghost">⬇️ 导出审计链 JSON</button></a>
        </div>

        <div class="tabs">
          <button :class="{ on: tab === 'chain' }" @click="tab = 'chain'">🔗 审计链（{{ chain.length }}）</button>
          <button :class="{ on: tab === 'command' }" @click="tab = 'command'">🛠️ 处置操作</button>
          <button :class="{ on: tab === 'grants' }" @click="tab = 'grants'">🔑 临时授权（{{ grants.length }}）</button>
          <button :class="{ on: tab === 'tickets' }" @click="tab = 'tickets'">🎫 工单（{{ tickets.length }}）</button>
          <button :class="{ on: tab === 'report' }" @click="openReportTab">📝 复盘报告</button>
        </div>

        <!-- 审计链时间线 -->
        <div class="panel" v-if="tab === 'chain'">
          <div class="chain-verify card" :class="{ bad: verify && !verify.ok }">
            <span v-if="verify?.ok">🔗 哈希链完整：{{ verify.count }} 条记录顺序连续，根条目为立案，链顶 <code>{{ verify.head_hash.slice(0, 18) }}…</code></span>
            <span v-else-if="verify">⛓️‍💥 审计链存在断裂/篡改：{{ verify.broken.map(b => `#${b.seq} ${b.reason}`).join('；') }}</span>
          </div>
          <div class="timeline">
            <div class="node" v-for="(e, idx) in chain" :key="e.id">
              <div class="n-rail">
                <i class="n-dot" :style="{ color: CAT[e.category]?.[2] }">{{ CAT[e.category]?.[0] || '•' }}</i>
                <em v-if="idx < chain.length - 1" class="n-line"></em>
              </div>
              <div class="n-body card">
                <div class="n-top">
                  <span class="n-cat" :style="{ color: CAT[e.category]?.[2] }">#{{ e.seq }} {{ CAT[e.category]?.[1] || e.category }}</span>
                  <em class="muted">{{ fmt(e.acted_at) }} · {{ e.actor_name }}<template v-if="e.actor_role">（{{ roleChip(e.actor_role) }}）</template></em>
                </div>
                <b class="n-summary">{{ e.summary }}</b>
                <div class="n-hash muted">
                  <span v-if="e.target_role">🔑 涉及角色：<b>{{ roleChip(e.target_role) }}</b> · </span>
                  <span v-if="e.ref_type">{{ {application:'应聘',approval:'审批',offer:'Offer',grant:'授权',ticket:'工单',report:'复盘',appointment:'预约',notification:'通知'}[e.ref_type] || e.ref_type }} <template v-if="e.ref_id">#{{ e.ref_id }}</template> · </span>
                  hash <code :title="e.entry_hash">{{ e.entry_hash.slice(0, 14) }}…</code>
                </div>
                <details v-if="e.detail && Object.keys(e.detail).length">
                  <summary class="muted">条目详情</summary>
                  <pre>{{ JSON.stringify(e.detail, null, 2) }}</pre>
                </details>
              </div>
            </div>
          </div>
        </div>

        <!-- 处置操作 -->
        <div class="panel" v-if="tab === 'command'">
          <div v-if="!isMember" class="card empty warn-box">您不是该事件处置成员，需由指挥官在「临时授权」页授予权限后才能操作；审计链对所有角色只读可见。</div>
          <template v-else>
            <div class="op-card card">
              <h3>🔧 记录关键操作 / 决策</h3>
              <div class="acts" style="margin-bottom:8px">
                <button class="ghost sm" :class="{ on: actCategory === 'action' }" @click="actCategory = 'action'">关键操作</button>
                <button class="ghost sm" :class="{ on: actCategory === 'decision' }" @click="actCategory = 'decision'">处置决策</button>
              </div>
              <textarea v-model="actionNote" rows="2" placeholder="如：暂停该职位全部 Offer 发放、联系候选人重新核实薪资凭证"></textarea>
              <button class="primary" :disabled="busy('crisis-act')" @click="addAction">上链记录</button>
            </div>
            <div class="op-card card" v-if="selected.application_id">
              <h3>⏪ 危机状态回退</h3>
              <p class="muted">将关联应聘「{{ appLabel(selected.application_id) }}」回退到上一阶段（淘汰记录按来源复活；Offer 阶段会联动撤回 Offer）。回退在<b>同一事务</b>内同步处置并逐条上链：</p>
              <ul class="rb-sync muted">
                <li>📅 回退到筛选/投递阶段时，<b>挂起进行中的面试预约</b>并释放时段（可在原单重约恢复）；复活回面试阶段时保留协商</li>
                <li>⚖️ <b>撤销全部待审批任务</b>并补写撤销留痕（流程恢复后可重新发起）</li>
                <li>🔔 <b>归并已失效的预约/审批未读通知</b>，清除铃铛与红点残留</li>
                <li>🔄 之后在原单上<b>重约/确认</b>恢复预约时，审计链被动追加恢复条目</li>
              </ul>
              <textarea v-model="rbReason" rows="2" placeholder="处置原因（必填，将随审计链永久留痕）"></textarea>
              <button class="warn" :disabled="busy(`crisis-rb:${selected.id}`)" @click="doRollback">执行回退并上链</button>
            </div>
            <div class="op-card card" v-if="isCommander">
              <h3>🔀 移交指挥权（责任变更回写通知）</h3>
              <div class="inline">
                <select v-model="assignCommander">
                  <option value="">选择新指挥官…</option>
                  <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ roleChip(u.role) }}</option>
                </select>
                <button class="ghost" :disabled="!assignCommander || busy(`crisis-cmdr:${selected.id}`)" @click="changeCommander">移交</button>
              </div>
            </div>
          </template>
        </div>

        <!-- 临时授权 -->
        <div class="panel" v-if="tab === 'grants'">
          <div class="op-card card" v-if="isCommander && selected.status !== 'closed'">
            <h3>🔑 授予临时跨角色权限</h3>
            <div class="fgrid">
              <select v-model="gForm.grantee_id">
                <option value="">选择成员…</option>
                <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ roleChip(u.role) }}</option>
              </select>
              <select v-model="gForm.role">
                <option value="recruiter">招聘负责人权限</option>
                <option value="interviewer">面试官权限</option>
                <option value="hiring_manager">用人经理权限</option>
              </select>
            </div>
            <input v-model="gForm.reason" placeholder="授权事由（必填，留痕）" style="margin:8px 0" />
            <button class="primary" @click="addGrant">授权并上链</button>
          </div>
          <div class="g-list">
            <div class="g-card card" v-for="g in grants" :key="g.id">
              <div class="g-top">
                <b>{{ g.grantee_name }}</b>
                <span class="tag" :class="{ active: g.status === 'active' }">{{ g.status === 'active' ? '✅ 有效' : '🚫 已收回' }}</span>
              </div>
              <div class="muted">临时角色：<b style="color:var(--purple)">{{ roleChip(g.role) }}</b> · {{ fmt(g.granted_at) }} 由 {{ g.granted_by_name }} 授予</div>
              <p class="g-reason">事由：{{ g.reason }}</p>
              <div class="muted" v-if="g.status !== 'active'">收回于 {{ fmt(g.revoked_at) }} · {{ g.revoked_by_name }}</div>
              <button v-if="g.status === 'active' && isCommander && selected.status !== 'closed'" class="danger sm"
                      :disabled="busy(`crisis-revoke:${g.id}`)" @click="store.revokeGrant(g.id)">收回授权</button>
            </div>
            <div class="card empty" v-if="!grants.length">暂无临时授权记录。</div>
          </div>
        </div>

        <!-- 工单 -->
        <div class="panel" v-if="tab === 'tickets'">
          <div class="op-card card" v-if="isMember && selected.status !== 'closed'">
            <h3>🎫 创建处置工单（责任到人）</h3>
            <input v-model="tkForm.title" placeholder="工单标题，如：重发符合带宽的 Offer" />
            <textarea v-model="tkForm.content" rows="2" placeholder="处置内容与验收标准" style="margin:8px 0"></textarea>
            <div class="fgrid">
              <select v-model="tkForm.priority">
                <option>P0</option><option>P1</option><option selected>P2</option><option>P3</option>
              </select>
              <select v-model="tkForm.owner_id">
                <option value="">责任人：自己</option>
                <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ roleChip(u.role) }}</option>
              </select>
            </div>
            <button class="primary" style="margin-top:8px" @click="addTicket">创建并通知责任人</button>
          </div>
          <div class="t-list">
            <div class="t-card card" v-for="t in tickets" :key="t.id">
              <div class="t-top">
                <b>{{ t.title }}</b>
                <span class="tag" :class="`p-${t.priority}`">{{ t.priority }}</span>
                <span class="tag" :class="{ open: t.status !== 'closed' }">{{ TK_STATUS[t.status] }}</span>
              </div>
              <p class="muted" v-if="t.content">{{ t.content }}</p>
              <div class="t-owner">
                <em class="muted">责任人</em>
                <select :value="t.owner_id" :disabled="!isMember || selected.status === 'closed'" @change="e => assignTicket(t, e)">
                  <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ roleChip(u.role) }}</option>
                </select>
              </div>
              <p class="resolution" v-if="t.resolution">✅ {{ t.resolution }}</p>
              <div class="t-acts" v-if="isMember && nextTicketStatus(t) && selected.status !== 'closed'">
                <textarea v-if="nextTicketStatus(t) === 'resolved'" v-model="tkResolve[t.id]" rows="2" placeholder="处置结果（必填）" style="margin:6px 0"></textarea>
                <button class="succ sm" @click="moveTicket(t)">
                  {{ { processing: '开始处理', resolved: '标记解决', closed: '关闭工单' }[nextTicketStatus(t)] }}
                </button>
              </div>
            </div>
            <div class="card empty" v-if="!tickets.length">暂无处置工单。</div>
          </div>
        </div>

        <!-- 复盘报告 -->
        <div class="panel" v-if="tab === 'report'">
          <template v-if="report && report.status === 'finalized'">
            <div class="final-box card">
              <h3>📝 复盘报告已定稿 · 责任矩阵已固化</h3>
              <p class="muted">定稿于 {{ fmt(report.finalized_at) }} · {{ report.finalized_by }} · 审计链 {{ report.entries_count }} 条</p>
              <div class="hash-line muted">链顶哈希 <code>{{ report.report_hash }}</code></div>
            </div>
            <div class="card"><h4>复盘结论</h4><p class="rp-text">{{ report.summary }}</p></div>
            <div class="card"><h4>根因分析</h4><p class="rp-text">{{ report.root_cause }}</p></div>
            <div class="card">
              <h4>改进措施</h4>
              <ol class="impr"><li v-for="(x, i) in report.improvements" :key="i">{{ x }}</li></ol>
            </div>
            <div class="card resp-matrix">
              <h4>🧭 责任信息（从审计链回写）</h4>
              <div class="rm-row"><em class="muted">总指挥</em><b>{{ report.responsibilities?.commander?.name }}</b><span class="tag">{{ roleChip(report.responsibilities?.commander?.role) }}</span></div>
              <div class="rm-row"><em class="muted">立案人</em><b>{{ report.responsibilities?.declared_by?.name }}</b><span class="tag">{{ roleChip(report.responsibilities?.declared_by?.role) }}</span></div>
              <table>
                <thead><tr><th>处置人</th><th>角色</th><th>操作数</th><th>涉及类别</th><th>最后操作</th></tr></thead>
                <tbody>
                  <tr v-for="p in report.responsibilities?.participants || []" :key="p.user_id">
                    <td>{{ p.name }}</td><td>{{ roleChip(p.role) }}</td><td>{{ p.actions }}</td>
                    <td><span class="mini-tag" v-for="c in p.categories" :key="c">{{ CAT[c]?.[1] || c }}</span></td>
                    <td class="muted">{{ fmt(p.last_at) }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="rm-sub muted">
                状态回退 {{ report.responsibilities?.rollback_count }} 次 ·
                临时授权 {{ report.responsibilities?.grants?.length }} 笔 ·
                未关闭工单 {{ report.responsibilities?.open_ticket_count }} 张
              </div>
            </div>
            <div class="close-box card" v-if="isCommander && selected.status !== 'closed'">
              <h4>🧾 结案归档</h4>
              <p class="muted">结案将自动收回全部有效临时授权，并追加不可篡改的结案条目。</p>
              <input v-model="closeNote" placeholder="结案备注（可选）" style="margin:8px 0;width:100%" />
              <button class="succ" @click="closeIncident">确认结案</button>
            </div>
          </template>

          <template v-else>
            <div class="op-card card" v-if="!isMember">
              <div class="empty warn-box">仅事件成员可撰写复盘草稿，指挥官可定稿。</div>
            </div>
            <template v-else>
              <div class="op-card card">
                <h3>📝 复盘报告草稿</h3>
                <label class="muted">复盘结论</label>
                <textarea v-model="rp.summary" rows="3" placeholder="事件经过、影响与处置结果"></textarea>
                <label class="muted">根因分析</label>
                <textarea v-model="rp.root_cause" rows="3" placeholder="直接原因 / 流程根因 / 权限缺口"></textarea>
                <label class="muted">改进措施（每行一条）</label>
                <textarea v-model="rp.improvementsText" rows="3" placeholder="Offer 超带宽强制二次确认&#10;审批链加签规则自动化巡检"></textarea>
                <div class="acts" style="margin-top:8px">
                  <button class="ghost" @click="saveReport">💾 保存草稿</button>
                  <button v-if="isCommander" class="succ" @click="finalizeReport">🔗 校验链并定稿（固化责任矩阵）</button>
                  <span v-else class="muted">定稿需由指挥官执行；定稿前系统会强制重算哈希链，且所有工单须已解决。</span>
                </div>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.crisis { display: flex; flex-direction: column; gap: 14px; }
.head-row { display: flex; gap: 12px; align-items: stretch; }
.role-banner { flex: 1; padding: 12px 16px; font-size: 12.5px; color: var(--muted); background: rgba(167,139,250,.07); border-color: rgba(167,139,250,.3); }
.role-banner b { color: var(--purple); margin: 0 2px; }
.head-row > button { white-space: nowrap; padding: 0 18px; }
.stat-row { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 14px; cursor: pointer; }
.stat:hover { border-color: var(--accent); }
.stat.on { border-color: var(--purple); background: rgba(167,139,250,.08); }
.stat.danger { border-color: var(--red); }
.stat span { font-size: 20px; }
.stat b { font-size: 22px; }
.stat em { font-style: normal; font-size: 12px; color: var(--muted); }
.ilist { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 12px; }
.icard { padding: 14px 16px; cursor: pointer; display: flex; flex-direction: column; gap: 8px; }
.icard:hover { border-color: var(--purple); transform: translateY(-2px); }
.ic-top { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.ic-top .code { margin-left: auto; font-style: normal; }
.ic-title { font-size: 15px; }
.ic-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; }
.chain-ok { color: var(--green); }
.broken { color: var(--red); font-weight: 700; }
.modal-box .fgrid, .fgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.modal-box label { display: block; margin: 8px 0 4px; font-size: 12px; }
.modal-box input, .modal-box select, .modal-box textarea { width: 100%; }
textarea { width: 100%; background: #101731; border: 1px solid var(--border); border-radius: 8px; color: var(--text); padding: 8px; font-size: 13px; font-family: inherit; resize: vertical; margin: 6px 0; }

.drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 70; display: flex; justify-content: flex-end; }
.drawer { width: min(820px, 96vw); height: 100vh; border-radius: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.d-head { display: flex; justify-content: space-between; align-items: flex-start; }
.d-title-row { display: flex; align-items: baseline; gap: 10px; }
.d-title-row h3 { margin: 0; font-size: 17px; }
.code { font-style: normal; font-size: 12px; color: var(--muted); font-family: ui-monospace, monospace; }
.d-sub { display: flex; gap: 14px; margin-top: 4px; font-size: 12px; }
.resp-bar { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 10px; }
.resp { background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; display: flex; align-items: center; gap: 8px; font-size: 13px; }
.resp em { font-style: normal; font-size: 11px; }
.chain-state.ok { border-color: rgba(87,214,160,.4); }
.chain-state.bad { border-color: var(--red); }
.d-acts { display: flex; gap: 8px; flex-wrap: wrap; }
.dl { text-decoration: none; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
.tabs button { font-size: 12.5px; padding: 6px 12px; opacity: .85; }
.tabs button.on { opacity: 1; border-color: var(--purple); background: rgba(167,139,250,.15); color: var(--purple); }
.panel { display: flex; flex-direction: column; gap: 12px; }
.chain-verify { padding: 10px 14px; font-size: 12.5px; color: var(--green); background: rgba(87,214,160,.07); border-color: rgba(87,214,160,.3); }
.chain-verify.bad { color: var(--red); background: rgba(255,107,122,.07); border-color: rgba(255,107,122,.4); }
.chain-verify code, .n-hash code, .hash-line code { font-family: ui-monospace, monospace; font-size: 11px; color: var(--cyan); }

.timeline { display: flex; flex-direction: column; }
.node { display: flex; gap: 10px; }
.n-rail { display: flex; flex-direction: column; align-items: center; width: 26px; flex-shrink: 0; }
.n-dot { font-style: normal; font-size: 16px; }
.n-line { flex: 1; width: 2px; background: var(--border); font-style: normal; min-height: 18px; }
.n-body { flex: 1; padding: 11px 14px; margin-bottom: 10px; }
.n-top { display: flex; justify-content: space-between; align-items: center; font-size: 11.5px; }
.n-cat { font-weight: 700; font-size: 12.5px; }
.n-summary { display: block; font-size: 13.5px; margin: 4px 0; }
.n-hash { font-size: 11px; }
.n-body details { margin-top: 4px; }
.n-body summary { cursor: pointer; font-size: 11.5px; }
.n-body pre { font-size: 11px; background: #0b1126; border: 1px solid var(--border); border-radius: 8px; padding: 8px; overflow-x: auto; margin-top: 6px; color: var(--muted); }

.op-card { padding: 13px 15px; }
.op-card h3 { margin: 0 0 8px; font-size: 13.5px; }
.op-card textarea, .op-card input { width: 100%; }
.inline { display: flex; gap: 8px; }
.inline select { flex: 1; }
.warn-box { color: var(--accent2); }
.rb-sync { margin: 6px 0 8px; padding-left: 18px; font-size: 12px; line-height: 1.7; }
.rb-sync b { color: var(--text); font-weight: 600; }

.g-list, .t-list { display: flex; flex-direction: column; gap: 10px; }
.g-card, .t-card { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.g-top, .t-top { display: flex; align-items: center; gap: 10px; }
.tag.active { color: var(--green); border-color: rgba(87,214,160,.4); }
.g-reason { font-size: 12.5px; }
button.sm { font-size: 11px; padding: 3px 9px; align-self: flex-start; }
.t-owner { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.t-owner select { padding: 4px 8px; font-size: 12px; }
.resolution { font-size: 12.5px; color: var(--green); }
.t-acts { display: flex; flex-direction: column; align-items: flex-start; }
.t-acts textarea { width: 100%; }

.final-box { border-color: rgba(87,214,160,.4); background: rgba(87,214,160,.06); }
.rp-text { white-space: pre-wrap; font-size: 13px; line-height: 1.7; margin-top: 6px; }
.impr { padding-left: 20px; font-size: 13px; line-height: 1.9; }
.resp-matrix h4 { margin-bottom: 10px; }
.rm-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
.rm-row em { font-style: normal; width: 56px; }
table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 500; }
.mini-tag { display: inline-block; font-size: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1px 6px; margin: 1px 2px; }
.rm-sub { margin-top: 8px; font-size: 11.5px; }
.hash-line { margin-top: 6px; word-break: break-all; }
.close-box { border-color: rgba(87,214,160,.4); }
.empty { padding: 24px; text-align: center; color: var(--muted); }
</style>
