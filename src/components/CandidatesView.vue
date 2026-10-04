<script setup>
import { ref, computed } from 'vue'
import { useHrStore } from '@/store/hr'

const store = useHrStore()
const q = ref('')
const channelFilter = ref('')
const open = ref(false)
const form = ref({ name: '', phone: '', years: 0, edu: '本科', school: '', city: '', exp_salary: 0, channel: '内推' })
const skillInput = ref('')
const skills = ref([])

const applied = cid => store.applications.map(a => a.candidate_id).includes(cid)

const list = computed(() => store.candidates.filter(c =>
  (!q.value || c.name.includes(q.value) || (c.raw || '').includes(q.value)) &&
  (!channelFilter.value || c.channel === channelFilter.value)
))

const channels = computed(() => [...new Set(store.candidates.map(c => c.channel))])

function addSkill() {
  const k = skillInput.value.trim()
  if (k) skills.value.push({ k, idx: 4 })
  skillInput.value = ''
}
function submit() {
  store.addCandidate({ ...form.value, skills: skills.value, raw: `候选人${form.value.name}，${form.value.years}年经验，擅长${skills.value.map(s => s.k).join('、')}` })
  open.value = false
  form.value = { name: '', phone: '', years: 0, edu: '本科', school: '', city: '', exp_salary: 0, channel: '内推' }
  skills.value = []
}
</script>

<template>
  <div class="cands">
    <div class="bar">
      <div class="filters">
        <input v-model="q" placeholder="🔍 搜索姓名 / 技能 / 简历" />
        <select v-model="channelFilter">
          <option value="">全部渠道</option>
          <option v-for="c in channels" :key="c">{{ c }}</option>
        </select>
      </div>
      <button class="primary" @click="open = true">＋ 新增候选人</button>
    </div>

    <div class="table card">
      <div class="thead">
        <span>候选人</span><span>技能</span><span>年限</span><span>学历</span><span>城市</span><span>期望薪资</span><span>渠道</span><span>简历摘要</span><span>状态</span>
      </div>
      <div class="trow" v-for="c in list" :key="c.id">
        <span><b>{{ c.name }}</b></span>
        <span class="chips"><span class="skill-chip" v-for="s in c.skills" :key="s.k">{{ s.k }}</span></span>
        <span>{{ c.years }}年</span>
        <span>{{ c.edu }}<em class="muted"> {{ c.school }}</em></span>
        <span>{{ c.city }}</span>
        <span class="money">¥{{ c.exp_salary.toLocaleString() }}</span>
        <span><span class="tag">{{ c.channel }}</span></span>
        <span class="sum"><em class="muted">{{ c.raw }}</em></span>
        <span><i class="dot" :class="applied(c.id) ? 'app' : ''"></i>{{ applied(c.id) ? '已投递' : '备选' }}</span>
      </div>
      <div class="empty" v-if="!list.length">没有匹配的候选人。</div>
    </div>

    <div class="modal" v-if="open">
      <div class="modal-box card">
        <h3>👤 新增候选人</h3>
        <div class="form">
          <div class="fg">
            <label>姓名<input v-model="form.name" /></label>
            <label>电话<input v-model="form.phone" /></label>
          </div>
          <div class="fg">
            <label>工作年限<input type="number" v-model.number="form.years" /></label>
            <label>学历<select v-model="form.edu"><option>博士</option><option>硕士</option><option>本科</option><option>大专</option></select></label>
          </div>
          <div class="fg">
            <label>毕业院校<input v-model="form.school" /></label>
            <label>现居城市<input v-model="form.city" /></label>
          </div>
          <div class="fg">
            <label>期望月薪<input type="number" v-model.number="form.exp_salary" /></label>
            <label>来源渠道<input v-model="form.channel" /></label>
          </div>
          <label>技能</label>
          <div class="skill-editor">
            <input v-model="skillInput" placeholder="输入技能回车添加" @keyup.enter="addSkill" />
            <button class="ghost" @click="addSkill">＋</button>
          </div>
          <div class="edit-chips"><span class="skill-chip" v-for="(s, i) in skills" :key="i">{{ s.k }} <a @click="skills.splice(i,1)">✕</a></span></div>
        </div>
        <div class="acts">
          <button class="primary" @click="submit">保存候选人</button>
          <button class="ghost" @click="open = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cands { display: flex; flex-direction: column; gap: 14px; }
.bar { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.filters { display: flex; gap: 8px; }
.filters input { width: 240px; }
.table { padding: 6px; overflow-x: auto; }
.thead, .trow { display: grid; grid-template-columns: .8fr 1.8fr .6fr 1.1fr .7fr .8fr .8fr 1.6fr .7fr; gap: 8px; align-items: center; padding: 10px 12px; min-width: 1080px; font-size: 13px; }
.thead { color: var(--muted); border-bottom: 1px solid var(--border); font-size: 12px; }
.trow { border-bottom: 1px solid var(--border); }
.trow:last-child { border-bottom: none; }
.chips { display: flex; flex-wrap: wrap; }
.em , .sum em { font-style: normal; font-size: 11px; }
.sum em { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 5px; }
.dot.app { background: var(--green); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 14px 0; }
.fg { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.skill-editor { display: flex; gap: 8px; }
.skill-editor input { flex: 1; }
.edit-chips a { cursor: pointer; color: var(--muted); margin-left: 4px; }
</style>