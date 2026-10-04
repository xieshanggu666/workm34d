<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const open = ref(false)
const editing = ref(null)
const form = ref({ name: '', dept: '技术部', city: '上海', level: 'P5', salary_min: 15000, salary_max: 30000, years: 2, slots: 1 })
const skillInput = ref('')
const skills = ref([])

const depts = ['技术部', '产品部', '设计部', '数据部', '质量部', '市场部']
const cities = ['北京', '上海', '深圳', '杭州', '广州', '成都', '武汉', '南京']

const appCount = pid => store.applications.filter(a => a.position_id === pid).length
const canGovern = computed(() => store.canSubmitTask('strategy_publish'))

// ---------------- 按职位匹配策略 ----------------
const DIM_META = [
  { k: 'skill', label: '技能匹配' },
  { k: 'year', label: '经验年限' },
  { k: 'salary', label: '薪资带宽' },
  { k: 'edu', label: '学历' },
  { k: 'city', label: '城市地点' }
]
const STATUS_META = {
  pending: ['待审批', 'var(--accent2)'], returned: ['已退回', 'var(--red)'],
  scheduled: ['待生效', 'var(--accent)'], canary: ['灰度中', 'var(--purple)'],
  full: ['全量生效', 'var(--green)'], superseded: ['被替代', 'var(--muted)'],
  expired: ['已过期', 'var(--muted)'], rolled_back: ['已回滚', 'var(--red)'],
  cancelled: ['已撤销', 'var(--muted)'], failed: ['执行失败', 'var(--red)'],
  default: ['默认策略', 'var(--muted)']
}
const strategyOpen = ref(false)
const strategyPos = ref(null)
const strategyVersions = ref([])
const currentStrategy = ref(null)
const strategyForm = ref(defaultForm())
const strategySaving = ref(false)
const strategyMsg = ref('')
const rollbackTarget = ref(null)
const rollbackReason = ref('')

function defaultForm() {
  return {
    weights: { ...store.defaultStrategy.weights },
    keyword_cap: store.defaultStrategy.keywordCap,
    rollout_mode: 'full',
    canary_percent: 20,
    canary_candidate_ids: [],
    effective_start: '',
    effective_end: '',
    change_note: ''
  }
}
const weightPct = k => Math.round((strategyForm.value.weights[k] || 0) * 100)
const weightSumPct = computed(() => Object.values(strategyForm.value.weights).reduce((s, v) => s + (Number(v) || 0), 0))
const versionsOf = pid => store.strategyVersions.filter(v => v.position_id === pid)
const activeVersionOf = p => {
  const id = Number(p.strategy?.active_version_id || 0)
  return id ? store.strategyVersions.find(v => v.id === id) : null
}
const canaryVersionOf = pid => store.strategyVersions.find(v => v.position_id === pid && v.status === 'canary')
const pendingVersionOf = pid => store.strategyVersions.find(v => v.position_id === pid && ['pending', 'returned'].includes(v.status))
function versionStatus(v) { return STATUS_META[v.status]?.[0] || v.status }
function versionStatusClass(v) { return `st-${v.status}` }
function fmtTime(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : '' }

async function openStrategy(p) {
  strategyPos.value = p
  strategyMsg.value = ''
  const r = await store.getStrategy(p.id)
  currentStrategy.value = r.strategy || null
  strategyVersions.value = r.versions || []
  strategyForm.value = defaultForm()
  strategyOpen.value = true
}
function editVersion(v) {
  strategyForm.value = {
    weights: { ...v.weights },
    keyword_cap: Number(v.keyword_cap),
    rollout_mode: v.rollout_mode || 'full',
    canary_percent: Number(v.canary_percent || 0),
    canary_candidate_ids: [...(v.canary_candidate_ids || [])],
    effective_start: toLocalInput(v.effective_start),
    effective_end: toLocalInput(v.effective_end),
    change_note: v.change_note || ''
  }
  strategyMsg.value = `正在修改退回版本 v${v.id}，重新提交后仍需审批`
}
function resetWeights() {
  strategyForm.value.weights = { ...store.defaultStrategy.weights }
  strategyForm.value.keyword_cap = store.defaultStrategy.keywordCap
}
function setWeight(k, pct) { strategyForm.value.weights[k] = Math.round(Number(pct)) / 100 }
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
async function submitStrategy(reset = false) {
  if (strategyForm.value.rollout_mode === 'canary' && !strategyForm.value.effective_end) {
    store.notify('error', '灰度发布必须设置观察窗口结束时间')
    return
  }
  strategySaving.value = true
  strategyMsg.value = ''
  const r = await store.publishStrategy(strategyPos.value.id, {
    reset,
    weights: strategyForm.value.weights,
    keyword_cap: Number(strategyForm.value.keyword_cap),
    rollout_mode: strategyForm.value.rollout_mode,
    canary_percent: Number(strategyForm.value.canary_percent),
    canary_candidate_ids: strategyForm.value.canary_candidate_ids.map(Number),
    effective_start: strategyForm.value.effective_start,
    effective_end: strategyForm.value.effective_end,
    change_note: strategyForm.value.change_note
  })
  strategySaving.value = false
  if (r?.ok) {
    strategyMsg.value = `v${r.version_id} 已提交审批（审批单 #${r.task_id}）；通过并进入生效窗口后联动批量重算`
    setTimeout(() => { strategyOpen.value = false }, 1200)
  }
}
async function resubmitVersion(v) {
  await store.resubmitStrategy(v.approval_task_id, {
    weights: strategyForm.value.weights,
    keyword_cap: Number(strategyForm.value.keyword_cap),
    rollout_mode: strategyForm.value.rollout_mode,
    canary_percent: Number(strategyForm.value.canary_percent),
    canary_candidate_ids: strategyForm.value.canary_candidate_ids.map(Number),
    effective_start: strategyForm.value.effective_start,
    effective_end: strategyForm.value.effective_end,
    change_note: strategyForm.value.change_note
  })
  strategyOpen.value = false
}
async function promote(v) { await store.promoteStrategy(v.id); strategyOpen.value = false }
function askRollback(v) { rollbackTarget.value = v; rollbackReason.value = '' }
async function confirmRollback() {
  if (!rollbackReason.value.trim()) { store.notify('error', '回滚原因必填'); return }
  await store.rollbackStrategy(rollbackTarget.value.id, rollbackReason.value)
  rollbackTarget.value = null
}
async function sweep() { await store.sweepStrategies() }

function openNew() {
  editing.value = null
  form.value = { name: '', dept: '技术部', city: '上海', level: 'P5', salary_min: 15000, salary_max: 30000, years: 2, slots: 1 }
  skills.value = []
  skillInput.value = ''
  open.value = true
}
function openEdit(p) {
  editing.value = p
  form.value = { name: p.name, dept: p.dept, city: p.city, level: p.level, salary_min: p.salary_min, salary_max: p.salary_max, years: p.years, slots: p.slots }
  skills.value = p.skills.map(s => ({ ...s }))
  skillInput.value = ''
  open.value = true
}
function addSkill() {
  const k = skillInput.value.trim()
  if (k) skills.value.push({ k, w: 5 })
  skillInput.value = ''
}
function submit() {
  const payload = { ...form.value, skills: skills.value }
  if (editing.value) store.updatePosition(editing.value.id, { status: 'open' })
  else store.addPosition(payload)
  open.value = false
}
</script>

<template>
  <div class="positions">
    <div class="bar">
      <span class="muted">共 {{ store.positions.length }} 个职位 · 在招 {{ store.openPositions.length }}</span>
      <div class="bar-acts">
        <button class="ghost" :disabled="!canGovern" @click="sweep">⏱ 同步策略生效窗口</button>
        <button class="primary" @click="openNew">＋ 发布职位</button>
      </div>
    </div>

    <div class="cards">
      <div class="pcard card" v-for="p in store.positions" :key="p.id" :class="{ closed: p.status === 'closed' }">
        <div class="phead">
          <div>
            <b>{{ p.name }}</b>
            <span class="tag" :class="p.status">{{ p.status === 'open' ? '🔥 招聘中' : '⏸ 已关闭' }}</span>
          </div>
          <div class="meta muted"><span>🏢 {{ p.dept }}</span><span>📍 {{ p.city }}</span><span>{{ p.level }}</span></div>
        </div>
        <div class="sal money">¥{{ p.salary_min.toLocaleString() }} - {{ p.salary_max.toLocaleString() }}</div>
        <div class="chips"><span class="skill-chip" v-for="s in p.skills" :key="s.k">{{ s.k }} <i>x{{ s.w }}</i></span></div>
        <div class="pmeta muted">
          <span>经验 {{ p.years }} 年+</span><span>编制 {{ p.slots }}</span><span>应聘 {{ appCount(p.id) }}</span>
        </div>
        <div class="stline">
          <template v-if="canaryVersionOf(p.id)">
            <span class="st-tag st-canary">🧪 灰度 v{{ canaryVersionOf(p.id).id }} · {{ canaryVersionOf(p.id).canary_candidate_ids?.length ? canaryVersionOf(p.id).canary_candidate_ids.length + '人' : canaryVersionOf(p.id).canary_percent + '%' }}</span>
            <span class="muted st-w">至 {{ fmtTime(canaryVersionOf(p.id).effective_end_text || canaryVersionOf(p.id).effective_end) }}</span>
          </template>
          <template v-else-if="pendingVersionOf(p.id)">
            <span class="st-tag" :class="versionStatusClass(pendingVersionOf(p.id))">⏳ {{ versionStatus(pendingVersionOf(p.id)) }} v{{ pendingVersionOf(p.id).id }}</span>
          </template>
          <template v-else-if="activeVersionOf(p)">
            <span class="st-tag custom">⚙️ 全量 v{{ activeVersionOf(p).id }}</span>
            <span class="muted st-w">
              技{{ Math.round(activeVersionOf(p).weights.skill * 100) }}% · 薪{{ Math.round(activeVersionOf(p).weights.salary * 100) }}% · 词+{{ activeVersionOf(p).keyword_cap }}
            </span>
          </template>
          <span v-else class="st-tag">⚙️ 默认匹配策略 v0</span>
        </div>
        <div class="acts">
          <button class="ghost" @click="openEdit(p)">编辑</button>
          <button class="ghost" :disabled="!canGovern" @click="openStrategy(p)">⚙️ 策略治理</button>
          <button class="warn" v-if="p.status === 'open'" @click="store.updatePosition(p.id, { status: 'closed' })">关闭职位</button>
          <button class="succ" v-else @click="store.updatePosition(p.id, { status: 'open' })">重新开放</button>
        </div>
      </div>
    </div>

    <div class="modal" v-if="open">
      <div class="modal-box card">
        <h3>{{ editing ? '✏️ 编辑职位' : '📌 发布新职位' }}</h3>
        <div class="form">
          <div class="fg">
            <label>职位名称<input v-model="form.name" placeholder="如 前端开发工程师" /></label>
            <label>部门<select v-model="form.dept"><option v-for="d in depts" :key="d">{{ d }}</option></select></label>
          </div>
          <div class="fg">
            <label>城市<select v-model="form.city"><option v-for="c in cities" :key="c">{{ c }}</option></select></label>
            <label>职级<select v-model="form.level"><option v-for="l in ['P4','P5','P6','P7','P8']" :key="l">{{ l }}</option></select></label>
          </div>
          <div class="fg">
            <label>最低薪资<input type="number" v-model.number="form.salary_min" /></label>
            <label>最高薪资<input type="number" v-model.number="form.salary_max" /></label>
          </div>
          <div class="fg">
            <label>经验年限<input type="number" v-model.number="form.years" /></label>
            <label>编制人数<input type="number" v-model.number="form.slots" /></label>
          </div>
          <label>技能要求（权重5=必备）</label>
          <div class="skill-editor">
            <input v-model="skillInput" placeholder="输入技能回车添加" @keyup.enter="addSkill" />
            <button class="ghost" @click="addSkill">＋ 添加</button>
          </div>
          <div class="edit-chips">
            <span v-for="(s, i) in skills" :key="i" class="chipx">
              {{ s.k }}<select v-model.number="s.w"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option></select>
              <button class="x" @click="skills.splice(i, 1)">✕</button>
            </span>
          </div>
        </div>
        <div class="acts"><button class="primary" @click="submit">{{ editing ? '保存' : '发布' }}</button><button class="ghost" @click="open = false">取消</button></div>
      </div>
    </div>

    <div class="modal" v-if="strategyOpen">
      <div class="modal-box card strategy-box">
        <h3>⚙️ 策略版本治理 · {{ strategyPos?.name }}</h3>
        <div class="st-tip muted">
          发布先进入审批；可配置生效窗口与候选人灰度。审批通过后联动批量重算，投递快照、阶段评分快照和审批证据保持原版本，回滚只恢复最新匹配，不改写历史证据。
        </div>
        <div class="role-tip" v-if="!canGovern">当前身份仅可查看版本治理；发布、转正与回滚需切换到招聘负责人。</div>

        <div class="govern-grid">
          <div class="editor-panel">
            <h4>新版本配置</h4>
            <div class="st-form">
              <div class="st-row" v-for="d in DIM_META" :key="d.k">
                <label>{{ d.label }}</label>
                <input type="range" min="0" max="100" step="5" :value="weightPct(d.k)" @input="setWeight(d.k, $event.target.value)" />
                <b>{{ weightPct(d.k) }}%</b>
              </div>
              <div class="st-row">
                <label>关键词加分上限</label>
                <input type="range" min="0" max="10" step="1" v-model.number="strategyForm.keyword_cap" />
                <b>+{{ strategyForm.keyword_cap }}</b>
              </div>
            </div>
            <div class="rollout-pick">
              <button :class="{ on: strategyForm.rollout_mode === 'full' }" @click="strategyForm.rollout_mode = 'full'">全量发布</button>
              <button :class="{ on: strategyForm.rollout_mode === 'canary' }" @click="strategyForm.rollout_mode = 'canary'">🧪 灰度发布</button>
            </div>
            <div v-if="strategyForm.rollout_mode === 'canary'" class="canary-box">
              <label>灰度比例（未指定候选人时按候选人 ID 稳定落桶）
                <input type="range" min="0" max="100" step="10" v-model.number="strategyForm.canary_percent" />
                <b>{{ strategyForm.canary_percent }}%</b>
              </label>
              <label>指定灰度候选人（优先于比例，可多选）
                <select multiple v-model="strategyForm.canary_candidate_ids" class="cand-select">
                  <option v-for="c in store.candidates" :key="c.id" :value="c.id">{{ c.id }} · {{ c.name }} · {{ c.city }}</option>
                </select>
              </label>
            </div>
            <div class="window-grid">
              <label>生效开始（空=审批后立即）<input type="datetime-local" v-model="strategyForm.effective_start" /></label>
              <label :class="{ req: strategyForm.rollout_mode === 'canary' }">窗口结束{{ strategyForm.rollout_mode === 'canary' ? '（灰度必填）' : '' }}
                <input type="datetime-local" v-model="strategyForm.effective_end" />
              </label>
            </div>
            <label class="note-label">发布说明 / 回滚预案<input v-model="strategyForm.change_note" placeholder="说明调整原因、观察指标与异常回滚条件" /></label>
            <div class="st-sum" :class="{ ok: weightSumPct === 1, bad: weightSumPct !== 1 }">
              权重合计 {{ Math.round(weightSumPct * 100) }}%<em v-if="weightSumPct !== 1">（发布时自动归一化）</em>
            </div>
            <div v-if="strategyMsg" class="st-msg">✅ {{ strategyMsg }}</div>
            <div class="acts wrap">
              <button class="primary" :disabled="strategySaving || !canGovern" @click="submitStrategy(false)">提交审批</button>
              <button class="warn" :disabled="strategySaving || !canGovern" @click="resetWeights(); strategyForm.change_note = '恢复系统默认策略'">恢复默认权重</button>
              <button class="ghost" @click="strategyOpen = false">关闭</button>
            </div>
          </div>

          <div class="history-panel">
            <h4>版本历史与操作</h4>
            <div class="version-list">
              <div class="version-card" v-for="v in versionsOf(strategyPos.id)" :key="v.id" :class="versionStatusClass(v)">
                <div class="v-head">
                  <b>v{{ v.id }}</b><span class="vstatus">{{ versionStatus(v) }}</span>
                  <em class="muted">{{ v.rollout_mode === 'canary' ? '灰度' : '全量' }}</em>
                </div>
                <div class="muted v-note">{{ v.change_note || '无发布说明' }}</div>
                <div class="muted v-window">
                  {{ fmtTime(v.effective_start_text || v.effective_start) || '立即' }} → {{ fmtTime(v.effective_end_text || v.effective_end) || '长期' }}
                </div>
                <div v-if="v.status === 'canary'" class="scope">
                  灰度：{{ v.canary_candidate_ids?.length ? `${v.canary_candidate_ids.length} 人指定` : `${v.canary_percent}%` }}
                </div>
                <div class="weight-line">技{{ Math.round(v.weights.skill * 100) }}% · 薪{{ Math.round(v.weights.salary * 100) }}% · 词+{{ v.keyword_cap }}</div>
                <div class="v-acts">
                  <button class="succ" v-if="v.status === 'canary'" :disabled="!canGovern" @click="promote(v)">全量化</button>
                  <button class="warn" v-if="['canary','full','scheduled','expired'].includes(v.status)" :disabled="!canGovern" @click="askRollback(v)">回滚</button>
                  <button class="ghost" v-if="v.status === 'returned'" :disabled="!canGovern" @click="editVersion(v)">载入修改</button>
                  <button class="primary" v-if="v.status === 'returned'" :disabled="!canGovern" @click="resubmitVersion(v)">提交修改</button>
                </div>
                <div class="muted vmeta">基线 {{ v.baseline_version_id ? `v${v.baseline_version_id}` : 'v0' }} · {{ v.published_by }} · {{ fmtTime(v.published_at) }}</div>
                <div class="muted vmeta" v-if="v.rollback_reason">回滚：{{ v.rollback_reason }}</div>
              </div>
              <div class="empty-mini muted">暂无自定义版本，当前使用系统默认 v0。</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="modal" v-if="rollbackTarget" @click.self="rollbackTarget = null">
      <div class="modal-box card rollback-box">
        <h3>↩️ 回滚策略 v{{ rollbackTarget.id }}</h3>
        <p class="muted">将恢复到 <b>{{ rollbackTarget.baseline_version_id ? `v${rollbackTarget.baseline_version_id}` : 'v0 默认策略' }}</b>，并在同一事务中批量重算该职位全部推荐；投递和阶段快照不会被改写。</p>
        <textarea v-model="rollbackReason" rows="4" placeholder="请填写回滚原因与影响范围（必填）"></textarea>
        <div class="acts"><button class="warn" :disabled="!canGovern" @click="confirmRollback">确认回滚并重算</button><button class="ghost" @click="rollbackTarget = null">取消</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.positions { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; }
.bar-acts { display: flex; gap: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.pcard { display: flex; flex-direction: column; gap: 10px; }
.pcard.closed { opacity: .6; }
.phead { display: flex; justify-content: space-between; align-items: flex-start; }
.phead b { font-size: 16px; }
.meta { display: flex; gap: 8px; font-size: 12px; }
.sal { font-size: 15px; }
.chips { display: flex; flex-wrap: wrap; }
.chips i { font-style: normal; opacity: .7; font-size: 10px; }
.pmeta { display: flex; gap: 12px; font-size: 12px; }
.tag.open { background: rgba(87,214,160,.15); color: var(--green); border-color: rgba(87,214,160,.4); }
.tag.closed { background: rgba(140,149,176,.1); }
.acts { display: flex; gap: 6px; }
.acts.wrap { flex-wrap: wrap; }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.fg { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form label, .editor-panel label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.skill-editor { display: flex; gap: 8px; }
.skill-editor input { flex: 1; }
.edit-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chipx { display: inline-flex; align-items: center; gap: 4px; background: rgba(91,140,255,.14); border: 1px solid rgba(91,140,255,.35); padding: 2px 6px; border-radius: 10px; font-size: 12px; }
.chipx select { background: transparent; border: none; color: var(--accent2); width: 34px; }
.chipx .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 0 2px; }
.stline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.st-tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.st-tag.custom, .st-tag.st-full { color: var(--green); border-color: rgba(87,214,160,.4); background: rgba(87,214,160,.1); }
.st-tag.st-canary { color: var(--purple); border-color: rgba(167,139,250,.45); background: rgba(167,139,250,.12); }
.st-tag.st-pending, .st-tag.st-returned { color: var(--accent2); border-color: rgba(255,209,102,.45); background: rgba(255,209,102,.1); }
.st-w { font-size: 11px; }
.strategy-box { width: min(1120px, 94vw); max-height: 90vh; overflow-y: auto; }
.st-tip { line-height: 1.7; margin: 8px 0 12px; }
.role-tip { font-size: 12px; color: var(--accent2); background: rgba(255,209,102,.09); border: 1px solid rgba(255,209,102,.25); border-radius: 8px; padding: 7px 10px; margin-bottom: 10px; }
.govern-grid { display: grid; grid-template-columns: 1fr 370px; gap: 16px; }
.editor-panel, .history-panel { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 12px; }
.editor-panel h4, .history-panel h4 { margin: 0 0 12px; }
.st-form { display: flex; flex-direction: column; gap: 10px; }
.st-row { display: grid; grid-template-columns: 120px 1fr 48px; align-items: center; gap: 10px; font-size: 13px; }
.st-row input[type=range] { width: 100%; padding: 0; accent-color: var(--accent); }
.st-row b { text-align: right; color: var(--accent2); }
.rollout-pick { display: flex; gap: 8px; margin: 12px 0; }
.rollout-pick button { flex: 1; }
.rollout-pick button.on { border-color: var(--accent); background: rgba(91,140,255,.15); color: var(--accent); }
.canary-box { display: flex; flex-direction: column; gap: 10px; background: rgba(167,139,250,.08); border: 1px solid rgba(167,139,250,.25); border-radius: 10px; padding: 10px; }
.canary-box label { font-size: 12px; }
.canary-box label:first-child { display: grid; grid-template-columns: 1fr 100px 42px; gap: 8px; align-items: center; }
.cand-select { min-height: 86px; }
.window-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 12px 0; }
.window-grid input { margin-top: 5px; }
.note-label { margin-bottom: 10px; }
.note-label input { margin-top: 5px; }
.req { color: var(--red); }
.st-sum { margin: 12px 0; font-size: 13px; padding: 8px 10px; border-radius: 8px; background: var(--panel); }
.st-sum.ok { color: var(--green); }
.st-sum.bad { color: var(--accent2); }
.st-sum em { font-style: normal; font-size: 11px; color: var(--muted); }
.st-msg { margin-bottom: 10px; font-size: 12px; color: var(--green); }
.version-list { display: flex; flex-direction: column; gap: 9px; max-height: 560px; overflow-y: auto; }
.version-card { border: 1px solid var(--border); border-radius: 10px; padding: 10px; background: var(--panel); display: flex; flex-direction: column; gap: 5px; }
.version-card.canary { border-color: rgba(167,139,250,.45); }
.version-card.full { border-color: rgba(87,214,160,.35); }
.v-head { display: flex; align-items: center; gap: 8px; }
.vstatus { font-size: 10px; border: 1px solid var(--border); border-radius: 10px; padding: 2px 7px; color: var(--muted); }
.canary .vstatus { color: var(--purple); border-color: rgba(167,139,250,.4); }
.full .vstatus { color: var(--green); border-color: rgba(87,214,160,.4); }
.v-head em { margin-left: auto; font-style: normal; font-size: 11px; }
.v-note, .v-window, .weight-line, .vmeta { font-size: 11px; line-height: 1.4; }
.scope { font-size: 11px; color: var(--purple); }
.weight-line { color: var(--accent2); }
.v-acts { display: flex; gap: 5px; flex-wrap: wrap; }
.v-acts button { font-size: 11px; padding: 4px 8px; }
.empty-mini { padding: 16px 8px; text-align: center; font-size: 12px; }
.rollback-box { width: min(560px, 92vw); }
.rollback-box textarea { width: 100%; margin: 12px 0; }
@media (max-width: 900px) { .govern-grid, .window-grid { grid-template-columns: 1fr; } }
</style>
