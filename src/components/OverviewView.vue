<script setup>
import { computed, onMounted, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const summary = ref(null)
onMounted(async () => { summary.value = await store.summary() })

const stageMeta = {
  submitted: { label: '简历投递', color: '#5b8cff' },
  screening: { label: '简历筛选', color: '#a78bfa' },
  interview: { label: '面试中', color: '#4fc3f7' },
  offer: { label: 'Offer中', color: '#ffd166' },
  hired: { label: '已录用', color: '#57d6a0' },
  rejected: { label: '已淘汰', color: '#ff6b7a' }
}

const appByStage = computed(() => {
  const m = {}
  store.applications.forEach(a => { m[a.stage] = (m[a.stage] || 0) + 1 })
  return m
})

const hiredCount = computed(() => store.applications.filter(a => a.stage === 'hired').length)
const joinedCount = computed(() => store.offers.filter(o => o.status === 'joined').length)
const pendingOffer = computed(() => store.offers.filter(o => o.status === 'pending').length)

const pipeline = computed(() => ['submitted', 'screening', 'interview', 'offer', 'hired'].map((s, i) => ({
  stage: s, label: stageMeta[s].label, color: stageMeta[s].color, count: appByStage.value[s] || 0
})))

const funnelMax = computed(() => Math.max(...pipeline.value.map(p => p.count), 1))
const widthFactor = p => 30 + (p.count / funnelMax.value) * 70

const positionPie = computed(() => {
  const byDept = {}
  store.positions.forEach(p => { byDept[p.dept] = (byDept[p.dept] || 0) + 1 })
  const entries = Object.entries(byDept)
  const total = entries.reduce((s, e) => s + e[1], 0) || 1
  let off = 0
  const colors = ['#5b8cff', '#a78bfa', '#4fc3f7', '#ffd166', '#57d6a0']
  return entries.map((e, i) => {
    const len = (e[1] / total) * 387
    const seg = { k: e[0], v: e[1], pct: Math.round(e[1] / total * 100), off: -off, color: colors[i % colors.length] }
    off += len
    return seg
  })
})

const channelCount = computed(() => {
  const m = {}
  store.candidates.forEach(c => { m[c.channel] = (m[c.channel] || 0) + 1 })
  return Object.entries(m).sort((a, b) => b[1] - a[1])
})
</script>

<template>
  <div class="ov" v-if="store.loaded">
    <div class="stat-grid">
      <div class="card stat"><span>📌</span><b>{{ store.positions.filter(p => p.status === 'open').length }}</b><em>在招职位</em></div>
      <div class="card stat"><span>👥</span><b>{{ store.candidates.length }}</b><em>候选人池</em></div>
      <div class="card stat"><span>🔄</span><b>{{ store.applications.length }}</b><em>累计应聘</em></div>
      <div class="card stat"><span>✅</span><b class="money">{{ hiredCount }}</b><em>已录用（接受Offer）</em></div>
      <div class="card stat"><span>🎉</span><b class="money">{{ joinedCount }}</b><em>已入职</em></div>
      <div class="card stat"><span>⏱️</span><b>{{ Math.max(1, store.applications.filter(a => !['hired','rejected'].includes(a.stage)).length) }}</b><em>流程在途</em></div>
      <div class="card stat"><span>📄</span><b>{{ pendingOffer }}</b><em>待回应 Offer</em></div>
    </div>

    <div class="row">
      <div class="card">
        <h3>🔻 招聘漏斗 <span class="muted">(各阶段人数)</span></h3>
        <div class="funnel">
          <div v-for="p in pipeline" :key="p.stage" class="frow">
            <span class="flabel">{{ p.label }}</span>
            <div class="fbar"><i :style="{ width: widthFactor(p) + '%', background: p.color }"></i><b>{{ p.count }}</b></div>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>🏢 部门职位分布</h3>
        <div class="donut-wrap">
          <svg viewBox="0 0 160 160" class="donut">
            <circle cx="80" cy="80" r="62" fill="none" stroke="#222a4a" stroke-width="26"/>
            <circle v-for="s in positionPie" :key="s.k" cx="80" cy="80" r="62" fill="none"
              :stroke="s.color" stroke-width="26"
              stroke-dasharray="389.4" :stroke-dashoffset="s.off" transform="rotate(-90 80 80)"/>
          </svg>
          <div class="center"><b>{{ store.positions.length }}</b><em class="muted">职位总数</em></div>
        </div>
        <div class="leg">
          <div v-for="s in positionPie" :key="s.k"><span class="sw" :style="{background:s.color}"></span>{{ s.k }}<b>{{ s.pct }}%</b></div>
        </div>
      </div>

      <div class="card">
        <h3>📡 渠道候选人来源</h3>
        <div class="chan-list">
          <div v-for="(c, i) in channelCount" :key="c[0]">
            <span class="no">{{ i + 1 }}</span><span>{{ c[0] }}</span>
            <div class="cbar"><i :style="{ width: (c[1] / (channelCount[0]?.[1] || 1)) * 100 + '%', background: ['#5b8cff','#a78bfa','#4fc3f7','#ffd166','#57d6a0'][i % 5] }"></i></div>
            <b>{{ c[1] }}人</b>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ov { display: flex; flex-direction: column; gap: 16px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat span { font-size: 24px; }
.stat b { font-size: 26px; }
.stat em { font-style: normal; color: var(--muted); font-size: 13px; }
.row { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 16px; }
@media (max-width: 1000px) { .row { grid-template-columns: 1fr; } }
.funnel { display: flex; flex-direction: column; gap: 12px; }
.frow { display: flex; align-items: center; gap: 12px; }
.flabel { width: 80px; font-size: 13px; color: var(--muted); text-align: right; }
.fbar { flex: 1; height: 28px; background: var(--panel2); border-radius: 8px; position: relative; overflow: hidden; }
.fbar i { display: block; height: 100%; transition: .4s; }
.fbar b { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 14px; }
.donut-wrap { position: relative; width: 160px; margin: 6px auto; }
.donut { width: 160px; height: 160px; }
.center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.center b { font-size: 26px; }
.leg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
.leg div { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.leg b { margin-left: auto; color: var(--text); }
.sw { width: 10px; height: 10px; border-radius: 3px; }
.chan-list { display: flex; flex-direction: column; gap: 10px; }
.chan-list > div { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.chan-list .no { width: 20px; height: 20px; background: var(--panel2); display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; font-size: 11px; color: var(--muted); }
.cbar { flex: 1; height: 10px; background: var(--panel2); border-radius: 5px; overflow: hidden; }
.cbar i { display: block; height: 100%; }
</style>