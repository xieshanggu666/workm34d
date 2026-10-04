<script setup>
import { ref, computed } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const mode = ref('pos') // pos: 按职位看候选人, cand: 按候选人看职位
const selPos = ref(null)
const selCand = ref(null)
const result = ref(null)
const loading = ref(false)
const recomputing = ref(false)
const recomputeMsg = ref('')

const appliedPair = (pid, cid) => store.applications.find(a => a.position_id === pid && a.candidate_id === cid)

// 全局批量重算：按各职位已发布策略刷新全部推荐结果（不改变投递时快照）
async function recomputeAll() {
  recomputing.value = true
  recomputeMsg.value = ''
  const r = await store.recomputeAll()
  recomputing.value = false
  if (r?.ok) {
    recomputeMsg.value = `批次 #${r.job_id || '-'} 已重算 ${r.positions} 个职位共 ${r.pairs} 组匹配（灰度 ${r.canary || 0} / 基线 ${r.baseline ?? r.pairs ?? 0}）`
    if (result.value) runMatch()
    setTimeout(() => { recomputeMsg.value = '' }, 4000)
  }
}

const strategyTitle = st => st
  ? `当前策略：技能${Math.round(st.weights.skill * 100)}% · 年限${Math.round(st.weights.year * 100)}% · 薪资${Math.round(st.weights.salary * 100)}% · 学历${Math.round(st.weights.edu * 100)}% · 城市${Math.round(st.weights.city * 100)}% · 关键词+${st.keywordCap}`
  : ''

async function loadMatchPos() {
  if (!selPos.value) return
  loading.value = true
  result.value = await store.matchPos(selPos.value)
  loading.value = false
}
async function loadMatchCand() {
  if (!selCand.value) return
  loading.value = true
  result.value = await store.matchCand(selCand.value)
  loading.value = false
}
function runMatch() {
  mode.value === 'pos' ? loadMatchPos() : loadMatchCand()
}

const scoreClass = s => s >= 75 ? 's-hi' : s >= 55 ? 's-mid' : 's-lo'

const topN = computed(() => (result.value?.candidates || result.value?.positions || []).filter(m => (m.score || 0) >= 55).length)
</script>

<template>
  <div class="match">
    <div class="card ctrl">
      <div class="mode-toggle">
        <button :class="{ on: mode === 'pos' }" @click="mode='pos'; result=null">🎯 按职位匹配候选人</button>
        <button :class="{ on: mode === 'cand' }" @click="mode='cand'; result=null">👤 按候选人推荐职位</button>
      </div>
      <div class="pick">
        <template v-if="mode === 'pos'">
          <span class="muted">选择职位：</span>
          <select v-model="selPos">
            <option :value="null" disabled>请选择职位</option>
            <option v-for="p in store.openPositions" :key="p.id" :value="p.id">{{ p.name }} · {{ p.dept }}</option>
          </select>
        </template>
        <template v-else>
          <span class="muted">选择候选人：</span>
          <select v-model="selCand">
            <option :value="null" disabled>请选择候选人</option>
            <option v-for="c in store.candidates" :key="c.id" :value="c.id">{{ c.name }} · {{ c.years }}年·{{ c.city }}</option>
          </select>
        </template>
        <button class="primary" @click="runMatch" :disabled="(mode==='pos'&&!selPos)||(mode==='cand'&&!selCand)">开始匹配</button>
        <span class="recalc-zone">
          <button class="warn" :disabled="recomputing" @click="recomputeAll">
            {{ recomputing ? '重算中…' : '🔁 按策略批量重算全部推荐' }}
          </button>
          <em v-if="recomputeMsg" class="recalc-msg">{{ recomputeMsg }}</em>
        </span>
      </div>
    </div>

    <div v-if="loading" class="card empty">计算人岗匹配度中……</div>

    <!-- 按职位匹配候选人 -->
    <template v-else-if="result && mode === 'pos'">
      <div class="result-head card">
        <div>
          <h3>{{ result.position.name }} <span class="tag">{{ result.position.dept }} · {{ result.position.city }}</span></h3>
          <div class="muted">薪资 ¥{{ result.position.salary_min }}K-{{ result.position.salary_max }}K · 经验 {{ result.position.years }}年+</div>
          <div class="st-badge" :class="{ custom: result.strategy && !result.strategy.isDefault, canary: result.strategy?.is_canary }" :title="strategyTitle(result.strategy)">
            {{ result.strategy?.is_canary ? '🧪 灰度策略' : result.strategy?.isDefault === false ? '职位定制策略' : '默认匹配策略' }}
            <b class="ver-id">{{ result.strategy?.versionId ? `v${result.strategy.versionId}` : 'v0' }}</b>：
            技{{ Math.round((result.strategy?.weights.skill ?? 0.4) * 100) }}% ·
            年限{{ Math.round((result.strategy?.weights.year ?? 0.2) * 100) }}% ·
            薪{{ Math.round((result.strategy?.weights.salary ?? 0.15) * 100) }}% ·
            学历{{ Math.round((result.strategy?.weights.edu ?? 0.15) * 100) }}% ·
            城{{ Math.round((result.strategy?.weights.city ?? 0.1) * 100) }}%
          </div>
        </div>
        <div class="req-chips"><span class="skill-chip" v-for="s in result.position.skills" :key="s.k">{{ s.k }} x{{ s.w }}</span></div>
        <div class="h-metric"><b>{{ result.candidates.length }}</b><em class="muted">候选匹配</em><em class="canary-total" v-if="result.canary_count">🧪 灰度 {{ result.canary_count }}</em></div>
      </div>

      <div class="mlist">
        <div class="mcard card" v-for="(m, i) in result.candidates" :key="m.candidate_id" :class="m.score >= 55 ? 'rec' : ''">
          <div class="rank">{{ i + 1 }}</div>
          <div class="score" :class="scoreClass(m.score)">{{ m.score }}</div>
          <div class="body">
            <div class="nm">{{ m.name }} <span class="tag" v-if="m.score >= 75">高匹配</span><span class="canary-chip" v-if="m.is_canary">🧪 灰度</span></div>
            <div class="sub muted">{{ m.years }}年 · {{ m.edu }} · {{ m.city }} · 期望¥{{ m.exp_salary.toLocaleString() }}</div>
            <div class="chips"><span class="skill-chip" v-for="s in m.skills" :key="s.k">{{ s.k }}</span></div>
            <div class="reason">
              <div v-for="d in m.dims" :key="d.k" class="dim">
                <span>{{ d.k }}</span>
                <div class="bar"><i :style="{ width: d.score + '%', background: d.score >= 75 ? 'var(--green)' : d.score >= 55 ? 'var(--accent2)' : 'var(--red)' }"></i></div>
                <b>{{ d.score }}</b>
              </div>
            </div>
            <div class="weak" v-if="m.weakness && m.weakness !== '无显著短板'"><em>短板：</em>{{ m.weakness }}</div>
            <div class="muted note">{{ m.reason }}</div>
            <div class="acts">
              <button v-if="!appliedPair(result.position.id, m.candidate_id)" class="succ" @click="store.apply(result.position.id, m.candidate_id)">纳入招聘流程</button>
              <button v-else class="primary" disabled>已投递</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 按候选人推荐职位 -->
    <template v-else-if="result && mode === 'cand'">
      <div class="result-head card">
        <div>
          <h3>👤 {{ result.candidate.name }} <span class="muted">{{ result.candidate.years }}年经验</span></h3>
          <div class="chips"><span class="skill-chip" v-for="s in result.candidate.skills" :key="s.k">{{ s.k }}</span></div>
        </div>
        <div class="h-metric"><b>{{ result.positions.length }}</b><em class="muted">可匹配职位</em></div>
      </div>
      <div class="mlist">
        <div class="mcard card" v-for="(m, i) in result.positions" :key="m.position_id" :class="m.score >= 55 ? 'rec' : ''">
          <div class="rank">{{ i + 1 }}</div>
          <div class="score" :class="scoreClass(m.score)">{{ m.score }}</div>
          <div class="body">
            <div class="nm">{{ m.name }} <span class="tag">{{ m.dept }}</span><span class="canary-chip" v-if="m.is_canary">🧪 灰度</span></div>
            <div class="sub muted">{{ m.city }} · {{ m.level }} · ¥{{ m.salary_min }}K-{{ m.salary_max }}K</div>
            <div class="reason">
              <div v-for="d in m.dims" :key="d.k" class="dim">
                <span>{{ d.k }}</span>
                <div class="bar"><i :style="{ width: d.score + '%', background: d.score >= 75 ? 'var(--green)' : d.score >= 55 ? 'var(--accent2)' : 'var(--red)' }"></i></div>
                <b>{{ d.score }}</b>
              </div>
            </div>
            <div class="weak" v-if="m.weakness && m.weakness !== '无显著短板'"><em>短板：</em>{{ m.weakness }}</div>
            <div class="muted note">{{ m.reason }}</div>
            <div class="acts">
              <button v-if="!appliedPair(m.position_id, selCand)" class="succ" @click="store.apply(m.position_id, selCand)">为其投递此职位</button>
              <button v-else class="primary" disabled>已投递</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div class="card empty" v-else>请选择{{ mode === 'pos' ? '职位' : '候选人' }}并点击「开始匹配」，查看人岗匹配评分与推荐理由。</div>
  </div>
</template>

<style scoped>
.match { display: flex; flex-direction: column; gap: 14px; }
.ctrl { display: flex; flex-direction: column; gap: 12px; }
.mode-toggle { display: flex; gap: 8px; }
.mode-toggle button.on { border-color: var(--accent); background: rgba(91,140,255,.15); color: var(--accent); }
.pick { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.pick select { min-width: 240px; }
.recalc-zone { display: inline-flex; align-items: center; gap: 10px; margin-left: auto; }
.recalc-msg { font-style: normal; font-size: 12px; color: var(--green); }
.st-badge { margin-top: 6px; font-size: 11px; color: var(--muted); background: var(--panel2); border: 1px solid var(--border); border-radius: 8px; padding: 3px 8px; display: inline-block; }
.st-badge.custom { color: var(--purple); border-color: rgba(167,139,250,.4); background: rgba(167,139,250,.1); }
.st-badge.canary { color: var(--purple); border-color: rgba(167,139,250,.65); background: rgba(167,139,250,.16); }
.canary-chip { font-size: 10px; color: var(--purple); border: 1px solid rgba(167,139,250,.45); background: rgba(167,139,250,.12); border-radius: 9px; padding: 1px 6px; }
.ver-id { color: var(--accent2); margin: 0 2px; font-style: normal; }
.result-head { display: flex; align-items: center; gap: 20px; justify-content: space-between; flex-wrap: wrap; }
.h-metric { text-align: center; }
.h-metric b { font-size: 30px; color: var(--accent); display: block; }
.canary-total { display: block; font-style: normal; font-size: 11px; color: var(--purple); margin-top: 3px; }
.mlist { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; }
.mcard { display: flex; gap: 12px; position: relative; }
.mcard.rec { border-color: rgba(87,214,160,.45); background: linear-gradient(180deg, rgba(87,214,160,.06), var(--panel)); }
.rank { width: 26px; height: 26px; background: var(--panel2); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--muted); flex-shrink: 0; }
.mcard.rec .rank { background: var(--green); color: #06231a; }
.score { flex-shrink: 0; align-self: flex-start; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.nm { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sub { font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; }
.reason { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dim { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
.dim span { width: 52px; }
.dim .bar { flex: 1; height: 6px; background: var(--panel2); border-radius: 4px; overflow: hidden; }
.dim .bar i { display: block; height: 100%; }
.dim b { width: 24px; text-align: right; color: var(--text); }
.weak { font-size: 12px; color: var(--red); }
.weak em { font-style: normal; }
.note { font-size: 11px; }
.acts { display: flex; gap: 8px; }
</style>