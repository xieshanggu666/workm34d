<script setup>
import { ref, onMounted } from 'vue'
import { useHrStore } from '@/store/hr'
import OverviewView from '@/components/OverviewView.vue'
import PositionsView from '@/components/PositionsView.vue'
import CandidatesView from '@/components/CandidatesView.vue'
import MatchView from '@/components/MatchView.vue'
import PipelineView from '@/components/PipelineView.vue'
import InterviewView from '@/components/InterviewView.vue'
import ScheduleView from '@/components/ScheduleView.vue'
import OfferView from '@/components/OfferView.vue'
import ApprovalView from '@/components/ApprovalView.vue'
import ReportsView from '@/components/ReportsView.vue'
import CrisisView from '@/components/CrisisView.vue'

const store = useHrStore()
const view = ref('overview')
const showNotify = ref(false)

const navs = [
  { k: 'overview', icon: '📊', label: '招聘总览' },
  { k: 'positions', icon: '📌', label: '职位管理' },
  { k: 'candidates', icon: '👥', label: '候选人库' },
  { k: 'match', icon: '🎯', label: '智能匹配' },
  { k: 'pipeline', icon: '🔄', label: '招聘流程' },
  { k: 'interview', icon: '💬', label: '面试管理' },
  { k: 'schedule', icon: '📅', label: '预约沟通' },
  { k: 'offer', icon: '📄', label: 'Offer 管理' },
  { k: 'approval', icon: '✅', label: '审批中心' },
  { k: 'crisis', icon: '🛡️', label: '危机审计' },
  { k: 'reports', icon: '📈', label: '报表中心' }
]

const roleIcon = { recruiter: '🧭', interviewer: '💬', hiring_manager: '🏢' }
const notifyIcon = {
  task_submitted: '📨', task_approved: '✅', task_returned: '↩️', task_resubmitted: '🔁',
  task_executed: '🎉', task_failed: '⚠️', task_cancelled: '🚫',
  task_escalated: '⏰', task_delegated: '🤝', task_delegation_revoked: '🔒',
  crisis_declared: '🚨', crisis_state: '⚡', crisis_commander: '🔀',
  crisis_grant: '🔑', crisis_grant_log: '🔑', crisis_grant_revoked: '🔒',
  crisis_rollback: '⏪', crisis_ticket: '🎫', crisis_ticket_assign: '🎫', crisis_ticket_update: '🎫',
  crisis_appt_suspended: '⏸️', crisis_task_cancelled: '⏸️',
  crisis_stage_recovered: '♻️',
  crisis_report: '📝', crisis_closed: '🧾',
  sched_proposed: '📨', sched_partial: '✅', sched_confirmed: '📅',
  sched_reschedule_request: '🔁', sched_reschedule_rejected: '↩️',
  sched_declined: '🚫', sched_cancelled: '❌', sched_completed: '🎉',
  sched_noshow: '⚠️', sched_rebooked: '🔄',
  sched_remind_24h: '⏰', sched_remind_1h: '🔔', sched_remind: '📣'
}

function onSwitchUser(e) {
  store.setUser(e.target.value)
  showNotify.value = false
  store.refresh()
}
function toggleNotify() {
  showNotify.value = !showNotify.value
}
function readAll() {
  store.markNotificationsRead()
}
// 点击通知跳转到对应中心并关闭面板：危机类 → 危机审计，预约类 → 预约沟通，其余 → 审批中心
function openNotify(n) {
  showNotify.value = false
  if (String(n?.type || '').startsWith('crisis_')) view.value = 'crisis'
  else if (String(n?.type || '').startsWith('sched_')) view.value = 'schedule'
  else view.value = 'approval'
}

onMounted(store.refresh)
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">
        <span class="logo">📋</span>
        <div><b>TalentFlow</b><em class="muted">招聘智能匹配平台</em></div>
      </div>
      <nav>
          <button v-for="n in navs" :key="n.k" class="navitem" :class="{ on: view === n.k }" @click="view = n.k">
            <span>{{ n.icon }}</span>{{ n.label }}
            <em v-if="n.k === 'approval' && store.todoCount" class="nav-badge">{{ store.todoCount }}</em>
            <em v-else-if="n.k === 'crisis' && store.crisisIncidents.filter(i => i.status !== 'closed').length" class="nav-badge crisis-badge">
              {{ store.crisisIncidents.filter(i => i.status !== 'closed').length }}
            </em>
            <em v-else-if="n.k === 'schedule' && store.scheduleTodoCount" class="nav-badge sched-badge">
              {{ store.scheduleTodoCount }}
            </em>
          </button>
      </nav>
      <div class="mini card">
        <div class="mini-row"><span class="muted">在招职位</span><b>{{ store.openPositions.length }}</b></div>
        <div class="mini-row"><span class="muted">候选池</span><b>{{ store.candidates.length }}</b></div>
        <div class="mini-row"><span class="muted">在途应聘</span><b>{{ store.applications.filter(a => !['hired','rejected'].includes(a.stage)).length }}</b></div>
      </div>
    </aside>

    <main>
      <header class="topbar">
        <h2>{{ navs.find(n => n.k === view)?.label }}</h2>
        <div class="pills">
          <span class="pill">💼 在招 <b>{{ store.openPositions.length }}</b></span>
          <span class="pill">👥 候选人 <b>{{ store.candidates.length }}</b></span>
          <span class="pill">🎉 已入职 <b>{{ store.offers.filter(o => o.status === 'joined').length }}</b></span>
        </div>
        <div class="idzone">
          <!-- 身份切换：演示环境模拟登录，角色决定可见操作与审批权限 -->
          <label class="idchip" :title="`当前身份：${store.currentUser?.title || ''}`">
            <span>{{ roleIcon[store.myRole] || '👤' }}</span>
            <select :value="store.userId" @change="onSwitchUser">
              <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ u.title }}</option>
            </select>
          </label>
          <!-- 审计通知铃铛 -->
          <div class="bell-wrap">
            <button class="bell" :class="{ on: showNotify }" @click="toggleNotify" title="审计通知">
              🔔<em v-if="store.unreadCount" class="bell-badge">{{ store.unreadCount > 99 ? '99+' : store.unreadCount }}</em>
            </button>
            <div class="notify-panel card" v-if="showNotify">
              <div class="np-head">
                <b>🔔 审计通知</b>
                <button class="ghost sm" :disabled="!store.unreadCount" @click="readAll">全部已读</button>
              </div>
              <div class="np-list">
                <div class="np-item" v-for="n in store.myNotifications.slice(0, 30)" :key="n.id" :class="{ unread: !n.is_read }" @click="openNotify(n)">
                  <span class="np-icon">{{ notifyIcon[n.type] || '📌' }}</span>
                  <div class="np-body">
                    <b>{{ n.title }}</b>
                    <p>{{ n.body }}</p>
                    <em class="muted">{{ n.created_at }}<template v-if="n.owner_name"> · 责任人 {{ n.owner_name }}</template></em>
                  </div>
                </div>
                <div class="empty" v-if="!store.myNotifications.length">暂无通知。</div>
              </div>
            </div>
          </div>
        </div>
      </header>
      <section class="views" @click="showNotify = false">
        <OverviewView v-if="view === 'overview'" />
        <PositionsView v-else-if="view === 'positions'" />
        <CandidatesView v-else-if="view === 'candidates'" />
        <MatchView v-else-if="view === 'match'" />
        <PipelineView v-else-if="view === 'pipeline'" />
        <InterviewView v-else-if="view === 'interview'" />
        <ScheduleView v-else-if="view === 'schedule'" />
        <OfferView v-else-if="view === 'offer'" />
        <ApprovalView v-else-if="view === 'approval'" />
        <CrisisView v-else-if="view === 'crisis'" />
        <ReportsView v-else />
      </section>
    </main>

    <!-- 全局操作反馈：业务约束（重复操作/状态冲突/版本过期）由服务端统一返回，此处统一展示 -->
    <transition name="toast">
      <div v-if="store.toast" class="toast" :class="store.toast.type">
        <span>{{ store.toast.type === 'success' ? '✅' : '⚠️' }}</span>{{ store.toast.msg }}
      </div>
    </transition>
  </div>
</template>

<style scoped>
.layout { display: flex; min-height: 100vh; }
.sidebar { width: 225px; flex-shrink: 0; padding: 18px 14px; background: rgba(13,18,32,.85); border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; position: sticky; top: 0; height: 100vh; }
.brand { display: flex; gap: 10px; align-items: center; padding: 4px 6px; }
.brand .logo { font-size: 28px; }
.brand b { font-size: 17px; display: block; }
.brand em { font-style: normal; font-size: 11px; }
nav { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.navitem { display: flex; align-items: center; gap: 10px; text-align: left; width: 100%; background: transparent; border: 1px solid transparent; color: var(--muted); font-size: 14px; padding: 10px 12px; }
.navitem:hover { background: var(--panel); color: var(--text); }
.navitem.on { background: linear-gradient(135deg, rgba(91,140,255,.2), rgba(91,140,255,.05)); border-color: rgba(91,140,255,.4); color: var(--accent); }
.mini { display: flex; flex-direction: column; gap: 8px; }
.mini-row { display: flex; justify-content: space-between; font-size: 13px; }
.mini-row b { color: var(--accent2); }
main { flex: 1; min-width: 0; }
.topbar { display: flex; justify-content: space-between; align-items: center; padding: 16px 24px; border-bottom: 1px solid var(--border); background: rgba(13,18,32,.6); position: sticky; top: 0; z-index: 20; backdrop-filter: blur(6px); }
.pills { display: flex; gap: 10px; }
.pill { font-size: 13px; color: var(--muted); background: var(--panel); border: 1px solid var(--border); padding: 6px 12px; border-radius: 20px; }
.pill b { color: var(--text); }
.nav-badge { margin-left: auto; font-style: normal; font-size: 10px; min-width: 17px; height: 17px; border-radius: 9px; background: var(--red); color: #fff; display: inline-flex; align-items: center; justify-content: center; padding: 0 4px; }
.nav-badge.crisis-badge { background: var(--purple); }
.nav-badge.sched-badge { background: var(--accent2); color: #1a1400; }
.idzone { display: flex; align-items: center; gap: 10px; }
.idchip { display: flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--border); border-radius: 20px; padding: 4px 6px 4px 12px; font-size: 13px; }
.idchip select { border: none; background: transparent; padding: 3px 4px; font-size: 13px; }
.bell-wrap { position: relative; }
.bell { position: relative; width: 36px; height: 36px; border-radius: 50%; padding: 0; font-size: 16px; display: flex; align-items: center; justify-content: center; }
.bell.on { border-color: var(--accent); background: rgba(91,140,255,.15); }
.bell-badge { position: absolute; top: -5px; right: -7px; font-style: normal; font-size: 10px; min-width: 17px; height: 17px; border-radius: 9px; background: var(--red); color: #fff; display: flex; align-items: center; justify-content: center; padding: 0 4px; }
.notify-panel { position: absolute; right: 0; top: 44px; width: 360px; max-height: 480px; z-index: 80; padding: 12px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow); }
.np-head { display: flex; justify-content: space-between; align-items: center; }
.np-head button { font-size: 11px; padding: 3px 8px; }
.np-list { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.np-item { display: flex; gap: 9px; padding: 9px 10px; border-radius: 9px; background: var(--panel2); border: 1px solid var(--border); cursor: pointer; font-size: 12px; }
.np-item:hover { border-color: var(--accent); }
.np-item.unread { border-left: 3px solid var(--accent); }
.np-icon { font-size: 15px; }
.np-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.np-body b { font-size: 12.5px; }
.np-body p { color: var(--muted); font-size: 11.5px; line-height: 1.45; word-break: break-all; }
.np-body em { font-style: normal; font-size: 10.5px; }
.toast { position: fixed; right: 22px; bottom: 22px; z-index: 100; padding: 11px 16px; border-radius: 10px; font-size: 13px;
  background: rgba(19,25,44,.96); border: 1px solid var(--border); box-shadow: 0 10px 30px rgba(0,0,0,.4);
  display: flex; align-items: center; gap: 8px; max-width: 380px; }
.toast.success { border-color: rgba(87,214,160,.5); color: var(--green); }
.toast.error { border-color: rgba(255,107,122,.55); color: var(--red); }
.toast-enter-active, .toast-leave-active { transition: .22s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(10px); }
</style>