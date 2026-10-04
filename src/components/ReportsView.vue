<script setup>
import { computed, ref } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
// 匹配度分布口径：snapshot=投递时历史评分；stage=进入当前阶段时评分；latest=按最新策略重算结果
const scoreView = ref('snapshot')
// 漏斗口径：current=按当前所处阶段；reached=按曾经到达（事件去重，回退后仍计入到达过）
const funnelMode = ref('current')

const STAGE_ORDER = ['submitted', 'screening', 'interview', 'offer', 'hired']
const STAGE_NAME = { submitted: '投递', screening: '筛选', interview: '面试', offer: 'Offer', hired: '录用' }

// 某应聘是否曾到达某阶段：正式事件（含回退事件）为准；hired 需 offer_accepted/hired 事件
function reachedStage(a, idx) {
  const target = STAGE_ORDER[idx]
  if (funnelMode.value === 'current') {
    const cur = STAGE_ORDER.indexOf(a.stage)
    return cur >= 0 && cur >= idx
  }
  // reached：事件中存在该阶段（回退后再次进入会刷新该阶段正式事件，仍然算到达）
  return (a.events || []).some(e => e.stage === target)
}

const funnel = computed(() =>
  STAGE_ORDER.map((s, idx) => {
    const count = store.applications.filter(a => reachedStage(a, idx)).length
    const prev = idx === 0 ? null : store.applications.filter(a => reachedStage(a, idx - 1)).length
    const conv = prev ? Math.round((count / prev) * 100) : null
    return { s, label: STAGE_NAME[s], count, conv }
  })
)

const overallConv = computed(() => {
  const sub = funnel.value[0]?.count || 0
  const hire = funnel.value[4]?.count || 0
  return sub ? Math.round(hire / sub * 100) : 0
})

const offerAcceptedCount = computed(() => store.offers.filter(o => ['accepted', 'joined'].includes(o.status)).length)
const joinedCount = computed(() => store.offers.filter(o => o.status === 'joined').length)
const pendingOfferCount = computed(() => store.offers.filter(o => o.status === 'pending').length)
// Offer→入职转化：口径为已入职 / 接受过 Offer
const offerJoinRate = computed(() => offerAcceptedCount.value
  ? Math.round(joinedCount.value / offerAcceptedCount.value * 100) : 0)

const channelCost = computed(() => {
  const map = {}
  store.candidates.forEach(c => map[c.channel] = (map[c.channel] || 0) + 1)
  const channelOfApp = a => store.candidates.find(c => c.id === a.candidate_id)?.channel
  return store.channels.map(ch => {
    const count = map[ch.name] || 0
    const joined = store.applications.filter(a => a.offer?.status === 'joined' && channelOfApp(a) === ch.name).length
    const accepted = store.applications.filter(a => ['accepted', 'joined'].includes(a.offer?.status) && channelOfApp(a) === ch.name).length
    return { name: ch.name, cost: ch.cost, count, cpc: count ? Math.round(ch.cost / count) : 0, joined, accepted }
  }).sort((a, b) => a.cpc - b.cpc)
})

const deptProgress = computed(() => {
  const map = {}
  store.applications.forEach(a => {
    const dept = a.dept
    map[dept] = map[dept] || { total: 0, hired: 0, joined: 0, offer: 0, interview: 0 }
    map[dept].total++
    if (a.offer?.status === 'joined') { map[dept].joined++; map[dept].hired++ }
    else if (a.stage === 'hired') map[dept].hired++
    if (a.stage === 'offer' || a.stage === 'hired') map[dept].offer++
    if (a.stage === 'interview' || a.stage === 'offer' || a.stage === 'hired') map[dept].interview++
  })
  return Object.entries(map).map(([k, v]) => ({ dept: k, ...v }))
})

const scoreOf = a => {
  if (scoreView.value === 'latest') return a.match?.score ?? a.stageSnapshot?.score ?? a.matchSnapshot?.score ?? null
  if (scoreView.value === 'stage') return a.stageSnapshot?.score ?? a.matchSnapshot?.score ?? a.match?.score ?? null
  return a.matchSnapshot?.score ?? a.stageSnapshot?.score ?? a.match?.score ?? null
}

const matchDist = computed(() => {
  const buckets = { sink: { label: '低匹配 0-59', count: 0, color: 'var(--red)' }, mid: { label: '一般 60-79', count: 0, color: 'var(--accent2)' }, hi: { label: '高匹配 80+', count: 0, color: 'var(--green)' } }
  store.applications.forEach(a => {
    const s = scoreOf(a)
    if (s == null) return
    if (s >= 80) buckets.hi.count++
    else if (s >= 60) buckets.mid.count++
    else buckets.sink.count++
  })
  return Object.values(buckets)
})
const matchTotal = computed(() => matchDist.value.reduce((s, b) => s + b.count, 0) || 1)

const avgOfView = view => {
  const pick = a => view === 'latest'
    ? (a.match?.score ?? a.stageSnapshot?.score ?? a.matchSnapshot?.score)
    : view === 'stage'
      ? (a.stageSnapshot?.score ?? a.matchSnapshot?.score ?? a.match?.score)
      : (a.matchSnapshot?.score ?? a.stageSnapshot?.score ?? a.match?.score)
  const vals = store.applications.map(pick).filter(s => s != null)
  return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : 0
}
const avgSnapshot = computed(() => avgOfView('snapshot'))
const avgStage = computed(() => avgOfView('stage'))
const avgLatest = computed(() => avgOfView('latest'))
const avgCurrent = computed(() => ({ snapshot: avgSnapshot, stage: avgStage, latest: avgLatest }[scoreView.value].value))

const donutSegs = computed(() => matchDist.value.map((b, i) => {
  const len = (b.count / matchTotal.value) * 389.4
  return { ...b, len, offset: -(matchDist.value.slice(0, i).reduce((s, x) => s + ((x.count / matchTotal.value) * 389.4), 0)) }
}))

const avgSalary = computed(() => {
  const offers = store.offers.filter(o => o.status === 'accepted' || o.status === 'joined')
  return offers.length ? Math.round(offers.reduce((s, o) => s + o.salary, 0) / offers.length) : 0
})

const strategyGovernance = computed(() => {
  const count = status => store.strategyVersions.filter(v => v.status === status).length
  const jobs = store.recalcJobs.slice(0, 8)
  const canaryMatches = store.matches.filter(m => m.is_canary)
  const baselineMatches = store.matches.filter(m => !m.is_canary)
  const avg = rows => rows.length ? Math.round(rows.reduce((s, m) => s + m.score, 0) / rows.length) : 0
  return {
    pending: count('pending') + count('returned') + count('scheduled'),
    canary: count('canary'),
    full: count('full'),
    rolledBack: count('rolled_back'),
    canaryPairs: canaryMatches.length,
    canaryAvg: avg(canaryMatches),
    baselineAvg: avg(baselineMatches),
    totalJobs: store.recalcJobs.length,
    totalPairs: store.recalcJobs.reduce((s, j) => s + (Number(j.pair_count) || 0), 0),
    jobs
  }
})
const triggerLabel = {
  strategy_publish: '全量发布', strategy_canary: '灰度发布', strategy_promote: '灰度转正',
  strategy_rollback: '策略回滚', manual: '手动重算', startup: '启动迁移'
}

// ---------------- 预约风险与责任（缺席/改期/重约统一台账口径） ----------------
const riskSummary = computed(() => store.scheduleRisk.summary || {})
const RISK_PARTY_LABEL = { candidate: '候选人', interviewer: '面试官', both: '双方' }
const riskLevelMeta = {
  high: { label: '高风险', cls: 'r-high' }, mid: { label: '中风险', cls: 'r-mid' },
  low: { label: '低关注', cls: 'r-low' }, none: { label: '无风险', cls: 'r-none' }
}
// 有缺席/改期记录的应聘（风险画像），与招聘看板徽标共用同一数据源
const riskApps = computed(() => {
  const map = new Map((store.scheduleRisk.perApplication || []).map(m => [m.application_id, m]))
  return store.applications
    .map(a => ({ app: a, risk: map.get(a.id) }))
    .filter(x => x.risk && (x.risk.noshow_occasions > 0 || x.risk.reschedule_count > 0 || x.risk.rebook_count > 0))
    .sort((x, y) => {
      const order = { high: 0, mid: 1, low: 2, none: 3 }
      return (order[x.risk.risk_level] ?? 9) - (order[y.risk.risk_level] ?? 9)
        || y.risk.noshow_occasions - x.risk.noshow_occasions
    })
})
// 责任归属：按缺席场次统计（改判沿用同一场次号，只计最终责任判定）
const responsibilityRows = computed(() => [
  { key: 'candidate', label: '候选人缺席', count: riskSummary.value.candidate_noshow || 0, cls: 'r-high' },
  { key: 'interviewer', label: '面试官缺席', count: riskSummary.value.interviewer_noshow || 0, cls: 'r-mid' },
  { key: 'both', label: '双方缺席', count: riskSummary.value.both_noshow || 0, cls: 'r-mid' }
])
// 缺席闭环率 = 已重约闭环场次 / 缺席场次
const noshowResolveRate = computed(() => riskSummary.value.noshow_occasions
  ? Math.round((riskSummary.value.resolved_occasions || 0) / riskSummary.value.noshow_occasions * 100)
  : 100)
</script>

<template>
  <div class="reports" v-if="store.loaded">
    <div class="stat-grid">
      <div class="card stat"><span>🔻</span><b>{{ overallConv }}%</b><em>投递→录用总转化</em></div>
      <div class="card stat"><span>💵</span><b class="money">¥{{ avgSalary.toLocaleString() }}</b><em>接受 Offer 平均薪资</em></div>
      <div class="card stat"><span>🎉</span><b class="money">{{ joinedCount }}</b><em>已入职人数</em></div>
      <div class="card stat"><span>✅</span><b class="money">{{ offerAcceptedCount }}</b><em>已接受 Offer</em></div>
      <div class="card stat"><span>⏳</span><b>{{ pendingOfferCount }}</b><em>待回应 Offer</em></div>
    </div>

    <div class="row">
      <div class="card">
        <h3>🔻 招聘漏斗转化率
          <span class="mode-switch">
            口径：
            <button :class="{ on: funnelMode === 'current' }" @click="funnelMode = 'current'">当前阶段</button>
            <button :class="{ on: funnelMode === 'reached' }" @click="funnelMode = 'reached'">曾经到达</button>
          </span>
        </h3>
        <div class="funnel">
          <div v-for="(f, i) in funnel" :key="f.s">
            <div class="fl">
              <span class="flabel">{{ f.label }}</span>
              <b>{{ f.count }}</b>
              <span class="conv" v-if="f.conv != null">{{ f.conv }}%</span>
              <i class="arrow" v-if="i < funnel.length - 1">↓</i>
            </div>
          </div>
        </div>
        <div class="muted tip">「当前阶段」为实时快照口径；「曾经到达」按阶段事件去重统计，异常回退后候选人仍计入其到达过的阶段。</div>
      </div>

      <div class="card">
        <h3>💴 渠道成本与效率</h3>
        <div class="clist">
          <div v-for="c in channelCost" :key="c.name" class="crow">
            <span class="cname">{{ c.name }}</span>
            <span class="muted">获取 {{ c.count }} 人</span>
            <b class="cpc">¥{{ c.cpc }}</b>
            <span class="hired-tag" v-if="c.joined">入职{{ c.joined }}</span>
          </div>
        </div>
        <div class="muted tip">单位成本 = 渠道费用 ÷ 获取候选人数，入职数以 Offer 状态「已入职」为准，与 Offer 页同口径。</div>
      </div>

      <div class="card">
        <h3>🏢 部门招聘进度</h3>
        <div class="dlist">
          <div v-for="d in deptProgress" :key="d.dept" class="drow">
            <div class="dhead">
              <span>{{ d.dept }}</span>
              <span class="muted">录用 {{ d.hired }}/{{ d.total }} · 入职 {{ d.joined }}</span>
            </div>
            <div class="bar"><i :style="{ width: (d.hired / (d.total || 1)) * 100 + '%', background: 'var(--green)' }"></i></div>
          </div>
        </div>
      </div>
    </div>

    <div class="row2">
      <div class="card">
        <h3>🎯 候选人匹配度分布</h3>
        <div class="caliber">
          <button :class="{ on: scoreView === 'snapshot' }" @click="scoreView = 'snapshot'">🕘 投递时评分</button>
          <button :class="{ on: scoreView === 'stage' }" @click="scoreView = 'stage'">🧭 当前阶段</button>
          <button :class="{ on: scoreView === 'latest' }" @click="scoreView = 'latest'">🆕 最新结果</button>
        </div>
        <div class="donut-wrap">
          <svg viewBox="0 0 160 160" class="donut">
            <circle cx="80" cy="80" r="62" fill="none" stroke="#222a4a" stroke-width="26"/>
            <circle v-for="(s, i) in donutSegs" :key="s.label" cx="80" cy="80" r="62" fill="none"
              :stroke="s.color" stroke-width="26"
              :stroke-dasharray="s.len" :stroke-dashoffset="s.offset" transform="rotate(-90 80 80)"/>
          </svg>
          <div class="center"><b>{{ avgCurrent }}</b><em class="muted">{{ { snapshot: '投递时平均分', stage: '当前阶段平均分', latest: '最新平均分' }[scoreView] }}</em></div>
        </div>
        <div class="avg-cmp muted">
          投递 <b :class="avgSnapshot >= 75 ? 's-hi' : avgSnapshot >= 55 ? 's-mid' : 's-lo'">{{ avgSnapshot }}</b>
          → 当前阶段 <b :class="avgStage >= 75 ? 's-hi' : avgStage >= 55 ? 's-mid' : 's-lo'">{{ avgStage }}</b>
          → 最新 <b :class="avgLatest >= 75 ? 's-hi' : avgLatest >= 55 ? 's-mid' : 's-lo'">{{ avgLatest }}</b>
          <span v-if="avgLatest - avgSnapshot" :class="avgLatest - avgSnapshot > 0 ? 'up' : 'down'">
            （{{ avgLatest - avgSnapshot > 0 ? '+' : '' }}{{ avgLatest - avgSnapshot }}）
          </span>
        </div>
        <div class="leg">
          <div v-for="s in matchDist" :key="s.label"><span class="sw" :style="{background:s.color}"></span>{{ s.label }}<b>{{ s.count }}人</b></div>
        </div>
        <div class="muted tip">三种口径与招聘流程看板完全一致：投递快照永不改变、当前阶段快照随推进/回退刷新、最新结果仅由显式重算更新。</div>
      </div>

      <div class="card">
        <h3>📊 招聘效率概况</h3>
        <div class="kpis">
          <div><em class="muted">简历投递 → 筛选</em><b>{{ funnel[1]?.conv ?? 0 }}%</b></div>
          <div><em class="muted">筛选 → 面试</em><b>{{ funnel[2]?.conv ?? 0 }}%</b></div>
          <div><em class="muted">面试 → Offer（需通过结论）</em><b>{{ funnel[3]?.conv ?? 0 }}%</b></div>
          <div><em class="muted">Offer → 录用接受</em><b>{{ funnel[4]?.conv ?? 0 }}%</b></div>
          <div class="wide"><em class="muted">录用 → 入职（接受 Offer 后确认）</em><b>{{ offerJoinRate }}%</b></div>
        </div>
        <div class="muted tip">建议：若「筛选→面试」转化低，可优化职位JD与筛选标准；「Offer→录用」低则需复核薪酬竞争力与流程效率；「录用→入职」低需关注放鸽子与入职跟进。</div>
      </div>
    </div>

    <div class="card risk-card">
      <h3>⚠️ 预约风险与责任（缺席 / 改期 / 重约）
        <span class="muted risk-sub">缺席裁定、改期协商、重约闭环统一读取风险台账：改判沿用同场次号，重约确认后场次闭环</span>
      </h3>
      <div class="risk-kpis">
        <div class="rk"><em>缺席场次</em><b class="r-high">{{ riskSummary.noshow_occasions || 0 }}</b></div>
        <div class="rk"><em>缺席率（占完成+缺席）</em><b>{{ riskSummary.noshow_rate || 0 }}%</b></div>
        <div class="rk"><em>未闭环缺席</em><b :class="{ 'r-high': riskSummary.open_noshow > 0 }">{{ riskSummary.open_noshow || 0 }}</b></div>
        <div class="rk"><em>缺席重约闭环率</em><b class="r-green">{{ noshowResolveRate }}%</b></div>
        <div class="rk"><em>已落地改期</em><b>{{ riskSummary.reschedule_count || 0 }}</b></div>
        <div class="rk"><em>缺席后重约次数</em><b>{{ riskSummary.rebook_count || 0 }}</b></div>
        <div class="rk"><em>高/中风险应聘</em>
          <b><span class="r-high">{{ riskSummary.high_risk_apps || 0 }}</span> / <span class="r-mid">{{ riskSummary.mid_risk_apps || 0 }}</span></b>
        </div>
      </div>

      <div class="risk-body">
        <div class="resp-box">
          <h4>🧭 缺席责任判定（按场次，含改判最终口径）</h4>
          <div class="resp-rows">
            <div v-for="r in responsibilityRows" :key="r.key" class="resp-row">
              <span>{{ r.label }}</span>
              <b :class="r.cls">{{ r.count }}</b>
              <i class="rbar"><em :class="r.cls" :style="{ width: (riskSummary.noshow_occasions ? r.count / riskSummary.noshow_occasions * 100 : 0) + '%' }"></em></i>
            </div>
            <div class="muted tip" style="margin:4px 0 0">候选人/双方责任的未闭环场次会在进入 Offer 前拦截；面试官责任不拦截候选人推进，但计入面试官风险画像。</div>
          </div>
        </div>
        <div class="risk-list-box">
          <h4>🚨 应聘风险清单</h4>
          <div class="risk-rows">
            <div v-for="x in riskApps.slice(0, 8)" :key="x.app.id" class="risk-row">
              <span class="rname">{{ x.app.candidate }} · {{ x.app.position }}</span>
              <span class="rlvl" :class="riskLevelMeta[x.risk.risk_level].cls">{{ riskLevelMeta[x.risk.risk_level].label }}</span>
              <span class="rtags">
                <em v-if="x.risk.noshow_occasions" class="tag-no">缺席 {{ x.risk.noshow_occasions }}</em>
                <em v-if="x.risk.open_noshow" class="tag-open">未闭环 {{ x.risk.open_noshow }}</em>
                <em v-if="x.risk.reschedule_count" class="tag-rs">改期 {{ x.risk.reschedule_count }}</em>
                <em v-if="x.risk.rebook_count" class="tag-rb">重约 {{ x.risk.rebook_count }}</em>
              </span>
            </div>
            <div class="muted empty-mini" v-if="!riskApps.length">暂无缺席/改期风险记录。</div>
          </div>
        </div>
      </div>
      <div class="muted tip">口径：同一预约单的改判沿用同一缺席场次号（旧裁定 superseded）；拒绝改期不计入改期次数；重约经双方确认成立后该缺席场次置 resolved；危机回退挂起的预约重约恢复同样走本台账。</div>
    </div>

    <div class="card governance-card">
      <h3>🧪 策略版本治理与灰度效果</h3>
      <div class="gov-kpis">
        <div><em>待审/待生效</em><b>{{ strategyGovernance.pending }}</b></div>
        <div><em>灰度中版本</em><b>{{ strategyGovernance.canary }}</b></div>
        <div><em>全量版本</em><b>{{ strategyGovernance.full }}</b></div>
        <div><em>累计回滚</em><b>{{ strategyGovernance.rolledBack }}</b></div>
        <div><em>灰度命中匹配</em><b>{{ strategyGovernance.canaryPairs }}</b></div>
        <div><em>灰度/基线均分</em><b>{{ strategyGovernance.canaryAvg }} / {{ strategyGovernance.baselineAvg }}</b></div>
      </div>
      <div class="job-table">
        <div class="job-row job-head"><span>批次</span><span>触发</span><span>版本</span><span>灰度/基线</span><span>总分</span><span>状态</span></div>
        <div class="job-row" v-for="j in strategyGovernance.jobs" :key="j.id">
          <span>#{{ j.id }}</span>
          <span>{{ triggerLabel[j.trigger_type] || j.trigger_type }}</span>
          <span>{{ j.strategy_id ? `v${j.strategy_id}` : 'v0' }}</span>
          <span>{{ j.canary_count || 0 }} / {{ j.baseline_count || j.pair_count || 0 }}</span>
          <span>{{ j.pair_count }}</span>
          <span>{{ j.status }}</span>
        </div>
      </div>
      <div class="muted tip">报表只统计最新匹配与不可变重算批次；投递时评分和阶段评分快照仍按审批/投递当时版本统计，策略全量或回滚均不重写历史决策证据。</div>
    </div>
  </div>
</template>

<style scoped>
.reports { display: flex; flex-direction: column; gap: 16px; }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat span { font-size: 24px; }
.stat b { font-size: 24px; }
.stat em { font-style: normal; color: var(--muted); font-size: 13px; }
.row { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 16px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 1000px) { .row, .row2 { grid-template-columns: 1fr; } }
.mode-switch { font-size: 11px; font-weight: 400; margin-left: 8px; }
.mode-switch button { padding: 2px 8px; font-size: 11px; opacity: .75; }
.mode-switch button.on { opacity: 1; border-color: var(--accent); background: rgba(91,140,255,.15); color: var(--accent); }
.funnel { display: flex; flex-direction: column; gap: 2px; }
.fl { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--panel2); border-radius: 8px; }
.flabel { width: 90px; }
.fl b { font-size: 20px; }
.conv { margin-left: auto; background: rgba(87,214,160,.16); color: var(--green); padding: 2px 8px; border-radius: 10px; font-size: 12px; }
.arrow { color: var(--muted); text-align: center; display: block; padding: 2px 0 2px 100px; }
.clist, .dlist { display: flex; flex-direction: column; gap: 10px; }
.crow { display: flex; align-items: center; gap: 12px; padding: 9px 10px; background: var(--panel2); border-radius: 8px; font-size: 13px; }
.cname { width: 90px; font-weight: 600; }
.cpc { margin-left: auto; font-size: 16px; color: var(--accent2); }
.hired-tag { font-size: 11px; background: rgba(87,214,160,.15); color: var(--green); padding: 2px 8px; border-radius: 10px; }
.tip { margin-top: 10px; line-height: 1.6; }
.drow { display: flex; flex-direction: column; gap: 6px; }
.dhead { display: flex; justify-content: space-between; font-size: 13px; }
.bar { height: 9px; background: var(--panel2); border-radius: 5px; overflow: hidden; }
.bar i { display: block; height: 100%; transition: .4s; }
.donut-wrap { position: relative; width: 160px; margin: 6px auto; }
.donut { width: 160px; height: 160px; }
.center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.center b { font-size: 26px; }
.caliber { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.caliber button { padding: 5px 10px; font-size: 12px; opacity: .75; }
.caliber button.on { opacity: 1; border-color: var(--accent); background: rgba(91,140,255,.15); color: var(--accent); }
.avg-cmp { text-align: center; font-size: 12px; margin-top: 4px; }
.avg-cmp b { padding: 1px 7px; border-radius: 8px; margin: 0 2px; }
.avg-cmp .up { color: var(--green); }
.avg-cmp .down { color: var(--red); }
.leg { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.leg div { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.leg b { margin-left: auto; }
.sw { width: 10px; height: 10px; border-radius: 3px; }
.kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.kpis div { background: var(--panel2); border-radius: 10px; padding: 14px; text-align: center; }
.kpis div.wide { grid-column: 1 / -1; }
.kpis em { display: block; font-style: normal; font-size: 12px; }
.kpis b { font-size: 24px; color: var(--accent); }
.governance-card { margin-top: 0; }
.gov-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 14px; }
.gov-kpis div { background: var(--panel2); border-radius: 10px; padding: 12px; text-align: center; }
.gov-kpis em { display: block; font-style: normal; font-size: 12px; color: var(--muted); }
.gov-kpis b { display: block; font-size: 21px; color: var(--purple); margin-top: 4px; }
.job-table { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.job-row { display: grid; grid-template-columns: .6fr 1fr .6fr 1fr .6fr .8fr; gap: 8px; padding: 8px 10px; font-size: 12px; }
.job-row:nth-child(odd):not(.job-head) { background: var(--panel2); }
.job-head { background: rgba(91,140,255,.1); font-weight: 700; color: var(--accent); }

/* 预约风险与责任 */
.risk-sub { font-size: 11px; font-weight: 400; margin-left: 8px; }
.risk-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 10px 0 14px; }
.risk-kpis .rk { background: var(--panel2); border-radius: 10px; padding: 11px; text-align: center; }
.risk-kpis em { display: block; font-style: normal; font-size: 11.5px; color: var(--muted); min-height: 32px; }
.risk-kpis b { display: block; font-size: 22px; color: var(--accent); margin-top: 4px; }
.r-high { color: var(--red) !important; }
.r-mid { color: var(--accent2) !important; }
.r-low { color: var(--cyan) !important; }
.r-green { color: var(--green) !important; }
.risk-body { display: grid; grid-template-columns: 1fr 1.2fr; gap: 14px; }
@media (max-width: 900px) { .risk-body { grid-template-columns: 1fr; } }
.risk-body h4 { font-size: 13px; margin: 0 0 9px; }
.resp-rows { display: flex; flex-direction: column; gap: 9px; }
.resp-row { display: grid; grid-template-columns: 80px 34px 1fr; align-items: center; gap: 10px; font-size: 12.5px; }
.resp-row b { font-size: 16px; text-align: right; }
.rbar { position: relative; height: 8px; background: var(--panel2); border-radius: 5px; overflow: hidden; }
.rbar em { position: absolute; inset: 0 auto 0 0; border-radius: 5px; display:block; }
.rbar em.r-high { background: var(--red); }
.rbar em.r-mid { background: var(--accent2); }
.risk-rows { display: flex; flex-direction: column; gap: 7px; max-height: 220px; overflow: auto; }
.risk-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--panel2); border-radius: 9px; font-size: 12.5px; }
.rname { font-weight: 600; }
.rlvl { font-size: 11px; border-radius: 9px; padding: 2px 9px; border: 1px solid var(--border); color: var(--muted); }
.rlvl.r-high { color: var(--red); border-color: rgba(255,107,122,.5); background: rgba(255,107,122,.08); }
.rlvl.r-mid { color: var(--accent2); border-color: rgba(255,209,102,.45); background: rgba(255,209,102,.08); }
.rlvl.r-low { color: var(--cyan); border-color: rgba(79,195,247,.4); background: rgba(79,195,247,.08); }
.rtags { margin-left: auto; display: flex; gap: 5px; }
.rtags em { font-style: normal; font-size: 10.5px; border-radius: 8px; padding: 1px 7px; border: 1px solid var(--border); color: var(--muted); }
.rtags .tag-no { color: var(--red); border-color: rgba(255,107,122,.4); }
.rtags .tag-open { color: #fff; background: var(--red); border-color: var(--red); }
.rtags .tag-rs { color: var(--accent2); border-color: rgba(255,209,102,.4); }
.rtags .tag-rb { color: var(--green); border-color: rgba(87,214,160,.4); }
.empty-mini { font-size: 12px; padding: 10px; text-align: center; }
</style>
