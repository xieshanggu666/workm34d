import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const db = new DatabaseSync(join(__dirname, 'hr.db'))

db.exec(`
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  dept TEXT NOT NULL,
  city TEXT NOT NULL,
  level TEXT NOT NULL,
  salary_min INTEGER NOT NULL,
  salary_max INTEGER NOT NULL,
  skills TEXT NOT NULL DEFAULT '[]',   -- [{k:"Vue",w:5}] 技能权重
  years INTEGER NOT NULL DEFAULT 2,
  slots INTEGER NOT NULL DEFAULT 1,    -- 编制
  status TEXT NOT NULL DEFAULT 'open', -- open/closed
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',   -- [{k:"Vue",idx:5}] 技能及熟练度
  years INTEGER NOT NULL DEFAULT 0,
  edu TEXT NOT NULL DEFAULT '本科',
  school TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  exp_salary INTEGER NOT NULL DEFAULT 0,
  channel TEXT NOT NULL DEFAULT '内推',
  raw TEXT NOT NULL DEFAULT ''        -- 解析出的简历文本
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  dims TEXT NOT NULL DEFAULT '[]',   -- [{k:"技能",score:80,w:0.4}]
  reason TEXT NOT NULL DEFAULT '',
  weakness TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL DEFAULT '',  -- 最近一次按策略重算的时间（最新结果）
  strategy_id INTEGER NOT NULL DEFAULT 0, -- 重算时使用的策略版本（0=系统默认/历史数据）
  weights TEXT NOT NULL DEFAULT '{}', -- 该结果实际使用的五维权重（灰度/回滚后仍可还原证据）
  keyword_cap INTEGER NOT NULL DEFAULT 5,
  is_canary INTEGER NOT NULL DEFAULT 0,   -- 1=该候选人命中灰度版本
  strategy_mode TEXT NOT NULL DEFAULT 'full' -- default/full/canary
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'submitted', -- submitted/screening/interview/offer/hired/rejected
  updated TEXT NOT NULL,
  recruiter TEXT NOT NULL DEFAULT '',
  match_snapshot TEXT NOT NULL DEFAULT '', -- 投递时的评分依据快照（永不随重算改变）
  matched_at TEXT NOT NULL DEFAULT '',     -- 快照评分时间
  stage_snapshot TEXT NOT NULL DEFAULT '', -- 进入「当前阶段」时的评分快照（随阶段进入/回退/复活更新）
  entered_at TEXT NOT NULL DEFAULT '',     -- 进入当前阶段的时间
  reject_from TEXT NOT NULL DEFAULT '',    -- 淘汰前所在阶段（供异常回退/复活定位来源）
  version INTEGER NOT NULL DEFAULT 1       -- 乐观锁版本：每次阶段协同 +1，防重复/并发操作
);

-- 每个职位独立发布的人岗匹配策略（无记录=使用系统默认五维权重）
CREATE TABLE IF NOT EXISTS match_strategies (
  position_id INTEGER PRIMARY KEY,
  weights TEXT NOT NULL DEFAULT '{}', -- {skill,year,salary,edu,city} 归一化后合计为1
  keyword_cap INTEGER NOT NULL DEFAULT 5, -- 简历关键词加分上限（0=关闭）
  active_version_id INTEGER NOT NULL DEFAULT 0, -- 当前全量生效版本（0=系统默认，区别于待审/灰度版本）
  effective_start TEXT NOT NULL DEFAULT '',
  effective_end TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL DEFAULT '',
  published_by TEXT NOT NULL DEFAULT ''
);

-- 策略发布留痕与版本治理：待审/灰度/全量/过期/回滚全程保留，支持按版本追溯每次重算依据
CREATE TABLE IF NOT EXISTS strategy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  weights TEXT NOT NULL DEFAULT '{}',
  keyword_cap INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'full', -- pending/canary/full/expired/rolled_back/cancelled/failed
  rollout_mode TEXT NOT NULL DEFAULT 'full', -- full/canary
  canary_percent INTEGER NOT NULL DEFAULT 0,
  canary_candidate_ids TEXT NOT NULL DEFAULT '[]',
  effective_start TEXT NOT NULL DEFAULT '', -- datetime-local/中文库时间；空=立即生效
  effective_end TEXT NOT NULL DEFAULT '',   -- 灰度窗口结束；空=长期有效
  baseline_version_id INTEGER NOT NULL DEFAULT 0,
  change_note TEXT NOT NULL DEFAULT '',
  approval_task_id INTEGER NOT NULL DEFAULT 0,
  promoted_version_id INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT '',
  approved_at TEXT NOT NULL DEFAULT '',
  published_by TEXT NOT NULL DEFAULT '',
  rolled_back_by TEXT NOT NULL DEFAULT '',
  rolled_back_at TEXT NOT NULL DEFAULT '',
  rollback_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_pos ON strategy_versions(position_id);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_status ON strategy_versions(position_id, status);

-- 重算批次：把策略发布/手动重算/启动迁移与每一次批量评分关联起来
CREATE TABLE IF NOT EXISTS recalc_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL, -- strategy_publish/strategy_canary/strategy_promote/strategy_rollback/manual/startup
  scope TEXT NOT NULL,        -- position/global/startup
  position_id INTEGER NOT NULL DEFAULT 0,
  strategy_id INTEGER NOT NULL DEFAULT 0,
  rollout_mode TEXT NOT NULL DEFAULT 'full', -- full/canary
  canary_version_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  pair_count INTEGER NOT NULL DEFAULT 0,
  canary_count INTEGER NOT NULL DEFAULT 0,
  baseline_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  triggered_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recalc_jobs_strategy ON recalc_jobs(strategy_id);

-- 重算明细：不可变的批次评分结果，用于核对 matches 当前最新分由哪个批次/策略产生
CREATE TABLE IF NOT EXISTS recalc_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  strategy_id INTEGER NOT NULL DEFAULT 0,
  weights TEXT NOT NULL DEFAULT '{}',
  keyword_cap INTEGER NOT NULL DEFAULT 5,
  is_canary INTEGER NOT NULL DEFAULT 0,
  strategy_mode TEXT NOT NULL DEFAULT 'full',
  score INTEGER NOT NULL DEFAULT 0,
  dims TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  weakness TEXT NOT NULL DEFAULT '',
  computed_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recalc_items_job ON recalc_items(job_id);
CREATE INDEX IF NOT EXISTS idx_recalc_items_pair ON recalc_items(position_id, candidate_id, id);

-- 流程事件：候选人每次进入阶段时固化当时评分，形成“策略版本→评分→阶段决策”的证据链
-- backfilled=0 的正式事件，每个 application×stage 只保留最新一条（重新进入阶段时刷新该行）；
-- backfilled=1 的补录事件保留多行历史，不参与唯一约束
CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  from_stage TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT 'advance',
  event_at TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '',
  score_snapshot TEXT NOT NULL DEFAULT '',
  match_score INTEGER NOT NULL DEFAULT 0,
  strategy_id INTEGER NOT NULL DEFAULT 0,
  recalc_job_id INTEGER NOT NULL DEFAULT 0,
  backfilled INTEGER NOT NULL DEFAULT 0
);
-- 索引在文件末尾的兼容迁移段统一创建（部分唯一索引需先清理旧库重复行）
CREATE INDEX IF NOT EXISTS idx_app_events_app ON application_events(application_id, id);

-- Offer 变更留痕：发起/改薪/改期/接受/拒绝/入职/撤回，只追加不改写，供事件追溯与审计
CREATE TABLE IF NOT EXISTS offer_change_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL,
  application_id INTEGER NOT NULL,
  change_type TEXT NOT NULL,  -- create/update_salary/update_due/accept/reject/join/reopen
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  from_salary INTEGER NOT NULL DEFAULT 0,
  to_salary INTEGER NOT NULL DEFAULT 0,
  changed_at TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_offer_logs_offer ON offer_change_logs(offer_id, id);
CREATE INDEX IF NOT EXISTS idx_offer_logs_app ON offer_change_logs(application_id, id);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  interviewer TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL DEFAULT '',
  round TEXT NOT NULL DEFAULT '初试',
  eval TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'pending', -- pending/pass/fail
  conclusion TEXT NOT NULL DEFAULT 'pending', -- pending/pass/fail 面试结论（与评价协同，结论驱动阶段联动）
  decided_at TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  salary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/accepted/rejected/joined
  due TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  joined_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 0
);

-- 平台用户与角色：recruiter 招聘负责人 / interviewer 面试官 / hiring_manager 用人经理
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);

-- 审批任务：候选人推进 / 面试结论 / Offer 发放三类关键动作的前置闸门
-- 审批链在提交时固化为 JSON（含动态加签节点），任务推进只移动 current_step 指针
CREATE TABLE IF NOT EXISTS approval_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                 -- stage_advance/interview_conclusion/offer_issue
  application_id INTEGER NOT NULL,
  interview_id INTEGER NOT NULL DEFAULT 0,
  offer_id INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}', -- 申请内容快照（目标阶段/结论/薪资等，重提时整体替换）
  chain TEXT NOT NULL DEFAULT '[]',   -- [{role,reason?}] 提交时固化的审批链
  current_step INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending/approved/returned/cancelled/failed
  submitted_by TEXT NOT NULL DEFAULT '',
  submitted_by_name TEXT NOT NULL DEFAULT '',
  submitted_role TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  decide_note TEXT NOT NULL DEFAULT '',
  result_note TEXT NOT NULL DEFAULT '',   -- 终审执行结果/失败原因（业务状态漂移导致）
  version INTEGER NOT NULL DEFAULT 1      -- 乐观锁：防两人同时审批同一任务
);
CREATE INDEX IF NOT EXISTS idx_approval_tasks_app ON approval_tasks(application_id, status);

-- 审批步骤留痕：提交/逐级通过/退回/重提/撤销/执行回写，只追加不改写（审计证据链）
CREATE TABLE IF NOT EXISTS approval_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  step_no INTEGER NOT NULL DEFAULT -1,  -- -1=申请人动作；>=0=审批链节点序号
  role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',      -- submit/approve/return/resubmit/cancel/execute/failed
  actor_id TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  acted_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_approval_steps_task ON approval_steps(task_id, id);

-- 审计通知：任务提交/通过/退回/重提/生效/失败按角色投递，接收人角色可标记已读
-- incident_id/ticket_id/owner_* 为危机处置审计模块的责任回写字段（见文件末尾兼容迁移）
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_role TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',        -- task_submitted/.../crisis_declared/crisis_grant/crisis_rollback/crisis_ticket/crisis_report/...
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  task_id INTEGER NOT NULL DEFAULT 0,
  application_id INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  incident_id INTEGER NOT NULL DEFAULT 0,
  ticket_id INTEGER NOT NULL DEFAULT 0,
  owner_name TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notifications_role ON notifications(recipient_role, is_read, id);
CREATE INDEX IF NOT EXISTS idx_notifications_incident ON notifications(incident_id, id);

-- ---------------- 按角色审批委托 ----------------
-- 委托人把本人角色在指定审批类型上的审批权临时授予代理人；可限定适用应聘范围与到期时间。
-- 撤销/到期后代理人立即失去在途任务的处理权，其个人待办通知在同一事务内归并已读。
CREATE TABLE IF NOT EXISTS approval_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delegator_id TEXT NOT NULL,             -- 委托人 users.id（本人角色须 = role）
  delegator_name TEXT NOT NULL DEFAULT '',
  delegatee_id TEXT NOT NULL,             -- 代理人 users.id（可为任意角色）
  delegatee_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,                     -- 被代理的审批节点角色
  task_types TEXT NOT NULL DEFAULT '[]',  -- 适用审批类型 JSON：stage_advance/interview_conclusion/offer_issue
  scope TEXT NOT NULL DEFAULT 'all',      -- all=该类型全部在途任务 / applications=仅指定应聘
  application_ids TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',          -- 委托事由（必填留痕）
  status TEXT NOT NULL DEFAULT 'active',  -- active/revoked/expired
  expires_at TEXT NOT NULL DEFAULT '',    -- ISO 到期时间，空=长期有效（撤销前一直有效）
  created_at TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  revoke_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_delegations_delegatee ON approval_delegations(delegatee_id, status);
CREATE INDEX IF NOT EXISTS idx_delegations_delegator ON approval_delegations(delegator_id, id);
CREATE INDEX IF NOT EXISTS idx_delegations_role ON approval_delegations(role, status);

-- ---------------- 审批超时升级规则（按 审批类型×节点角色 配置 SLA） ----------------
-- 规则在任务提交/重提/升级产生新节点时快照进审批链（chain[].sla），改规则不影响已在途节点；
-- 超时后系统在链尾追加升级节点（原节点保留），审批链快照完整可审计，且做防环检查。
CREATE TABLE IF NOT EXISTS approval_escalation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type TEXT NOT NULL,                -- stage_advance/interview_conclusion/offer_issue
  role TEXT NOT NULL,                     -- 超时的审批节点角色
  timeout_hours REAL NOT NULL DEFAULT 24, -- SLA 时限（小时，支持小数，便于演示）
  escalate_to TEXT NOT NULL DEFAULT '',   -- 升级目标角色
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  UNIQUE(task_type, role)
);

-- ---------------- 跨角色危机处置审计模块 ----------------
-- 危机事件：立案后由指挥官（commander）承担跨角色处置责任，可关联一条在途应聘
CREATE TABLE IF NOT EXISTS crisis_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',            -- CR-YYYYMMDD-NNN 人类可读事件号
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'major',   -- critical(P0)/major(P1)/minor(P2)
  status TEXT NOT NULL DEFAULT 'declared',  -- declared/responding/contained/reviewing/closed
  application_id INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  declared_by TEXT NOT NULL DEFAULT '',
  declared_by_name TEXT NOT NULL DEFAULT '',
  declared_role TEXT NOT NULL DEFAULT '',
  declared_at TEXT NOT NULL DEFAULT '',
  commander_id TEXT NOT NULL DEFAULT '',
  commander_name TEXT NOT NULL DEFAULT '',
  commander_role TEXT NOT NULL DEFAULT '',
  contained_at TEXT NOT NULL DEFAULT '',
  closed_at TEXT NOT NULL DEFAULT '',
  report_hash TEXT NOT NULL DEFAULT '',     -- 复盘定稿时固化的链顶哈希
  report_finalized_at TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1
);

-- 危机审计条目（哈希链）：只追加；每条哈希=SHA256(prev_hash + 本条规范化内容)
-- 配合文件末尾的 BEFORE UPDATE/DELETE 触发器，数据库层面拒绝任何改写/删除
CREATE TABLE IF NOT EXISTS crisis_audit_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,                     -- 事件内序号，从 0（立案根条目）递增
  category TEXT NOT NULL,                   -- declare/action/authorization/rollback/decision/ticket/report/close
  action TEXT NOT NULL,                     -- incident.declare/state.rollback/authz.grant/approval.execute/...
  actor_id TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  target_role TEXT NOT NULL DEFAULT '',     -- 授权变更时被授予/收回的角色
  ref_type TEXT NOT NULL DEFAULT '',        -- application/approval/offer/grant/ticket/report
  ref_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',        -- 变更前后快照、原因、责任矩阵等
  acted_at TEXT NOT NULL DEFAULT '',
  prev_hash TEXT NOT NULL DEFAULT '',
  entry_hash TEXT NOT NULL DEFAULT '',
  UNIQUE(incident_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_crisis_entries_inc ON crisis_audit_entries(incident_id, seq);

-- 危机期间的临时跨角色授权（授权变更留痕：授予/收回各上一条链）
CREATE TABLE IF NOT EXISTS crisis_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  grantee_id TEXT NOT NULL,
  grantee_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,                       -- 临时获得的角色 recruiter/interviewer/hiring_manager
  reason TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'incident',   -- incident=仅限本事件处置操作
  status TEXT NOT NULL DEFAULT 'active',    -- active/revoked
  granted_by TEXT NOT NULL DEFAULT '',
  granted_by_name TEXT NOT NULL DEFAULT '',
  granted_at TEXT NOT NULL DEFAULT '',
  revoked_by TEXT NOT NULL DEFAULT '',
  revoked_by_name TEXT NOT NULL DEFAULT '',
  revoked_at TEXT NOT NULL DEFAULT '',
  entry_id INTEGER NOT NULL DEFAULT 0,
  revoke_entry_id INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_crisis_grants_inc ON crisis_grants(incident_id, status);

-- 危机处置工单：责任到人（owner），改派/解决均上链并把责任人回写通知
CREATE TABLE IF NOT EXISTS crisis_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'P2',      -- P0/P1/P2/P3
  status TEXT NOT NULL DEFAULT 'open',      -- open/processing/resolved/closed
  owner_id TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  owner_role TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL DEFAULT '',
  application_id INTEGER NOT NULL DEFAULT 0,
  entry_id INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_crisis_tickets_inc ON crisis_tickets(incident_id, id);

-- 危机复盘报告：定稿时从审计链汇总责任矩阵并固化链顶哈希，结案前必须定稿
CREATE TABLE IF NOT EXISTS crisis_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  root_cause TEXT NOT NULL DEFAULT '',
  improvements TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',     -- draft/finalized
  owner_id TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  entries_count INTEGER NOT NULL DEFAULT 0,
  report_hash TEXT NOT NULL DEFAULT '',     -- 定稿瞬间（定稿条目上链前）的链顶哈希
  responsibilities TEXT NOT NULL DEFAULT '{}', -- 从审计链/授权/工单汇总的责任信息
  finalized_at TEXT NOT NULL DEFAULT '',
  finalized_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

-- ---------------- 候选人↔面试官双向预约沟通模块 ----------------
-- 可用时段池：面试官维护本人时段（self），候选人时段由招聘负责人代录（recruiter，模拟电话/短信确认结果）
CREATE TABLE IF NOT EXISTS schedule_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL,             -- interviewer/candidate
  owner_id TEXT NOT NULL,               -- interviewer=users.id；candidate=candidates.id
  start_at TEXT NOT NULL,               -- ISO 时间（UTC，带 Z，字典序即可比较先后）
  end_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'self',  -- self 本人维护 / recruiter 招聘负责人代录
  status TEXT NOT NULL DEFAULT 'open',  -- open 空闲 / used 已被确认预约占用
  appointment_id INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_slots_owner ON schedule_slots(owner_type, owner_id, start_at);
CREATE INDEX IF NOT EXISTS idx_slots_appt ON schedule_slots(appointment_id);

-- 预约单：双向协商状态机。正式时间（start_at）仅在双方都确认 pending 提议后落定；
-- 改期期间原正式时间保留，新提议放在 pending_* 字段，拒绝改期可回退原安排
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  round TEXT NOT NULL DEFAULT '初试',
  interviewer_id TEXT NOT NULL DEFAULT '',
  interviewer_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'negotiating', -- negotiating/confirmed/rescheduling/declined/completed/no_show/cancelled
  format TEXT NOT NULL DEFAULT '线上',        -- 线上/线下
  location TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',          -- 已确认正式时间（ISO）
  end_at TEXT NOT NULL DEFAULT '',
  pending_start TEXT NOT NULL DEFAULT '',     -- 待双方确认的提议时间（改期/新提）
  pending_end TEXT NOT NULL DEFAULT '',
  pending_format TEXT NOT NULL DEFAULT '',
  pending_location TEXT NOT NULL DEFAULT '',
  pending_by_party TEXT NOT NULL DEFAULT '',  -- 提议方 candidate/interviewer/recruiter
  cand_confirmed INTEGER NOT NULL DEFAULT 0,  -- 候选人对「当前提议/正式时间」的确认位
  int_confirmed INTEGER NOT NULL DEFAULT 0,   -- 面试官对「当前提议/正式时间」的确认位
  reminded_24h INTEGER NOT NULL DEFAULT 0,    -- 24 小时提醒已发
  reminded_1h INTEGER NOT NULL DEFAULT 0,     -- 1 小时提醒已发
  checkin_flagged INTEGER NOT NULL DEFAULT 0, -- 结束后宽限期过仍未签到，系统已初判缺席
  final_result TEXT NOT NULL DEFAULT '',      -- completed/candidate_no_show/interviewer_no_show/both_no_show/cancelled
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_appts_app ON appointments(application_id, id);
CREATE INDEX IF NOT EXISTS idx_appts_status ON appointments(status, start_at);
CREATE INDEX IF NOT EXISTS idx_appts_interviewer ON appointments(interviewer_id, status);

-- 预约沟通留痕：提议/确认/改期/拒绝/提醒/缺席裁定只追加不改写，形成双向协商时间线
CREATE TABLE IF NOT EXISTS appointment_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- create/propose/confirm/decline/reject_reschedule/cancel/resume/rebook/complete/noshow/auto_noshow/remind24h/remind1h/remind/system
  party TEXT NOT NULL DEFAULT 'system',  -- candidate/interviewer/recruiter/system
  actor_id TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',
  end_at TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_appt_msgs_appt ON appointment_messages(appointment_id, id);

-- ---------------- 预约结果风险台账（缺席/改期/重约 → 统一责任判定 → 阶段闸门/风险报表） ----------------
-- 每次缺席裁定、改期申请、缺席重约都在此留痕；改判会把同一场次的旧裁定置为 superseded，
-- 重约闭环把未解决缺席置为 resolved；报表与招聘阶段统一读本台账，口径不再各算各的
CREATE TABLE IF NOT EXISTS schedule_risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  appointment_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                    -- noshow/reschedule/rebook
  result TEXT NOT NULL DEFAULT '',       -- noshow: candidate_no_show/interviewer_no_show/both_no_show
  responsible_party TEXT NOT NULL DEFAULT '', -- candidate/interviewer/both/system
  occurrence INTEGER NOT NULL DEFAULT 1, -- 该预约单第几次缺席（改判沿用同一场次号）
  source TEXT NOT NULL DEFAULT 'manual', -- auto=系统 sweep 初判 / manual=招聘负责人裁定
  active INTEGER NOT NULL DEFAULT 1,     -- 0=已被改判取代(superseded)或改期被拒绝
  status TEXT NOT NULL DEFAULT 'open',   -- noshow: open/resolved/superseded；reschedule: requested/confirmed/rejected；rebook: done
  reason TEXT NOT NULL DEFAULT '',
  actor_id TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  actor_role TEXT NOT NULL DEFAULT '',
  incident_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_risk_app ON schedule_risk_events(application_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_risk_appt ON schedule_risk_events(appointment_id, id);

-- 不可篡改兜底：危机审计链拒绝 UPDATE / DELETE（应用层哈希校验 + 数据库触发器双重保护）
CREATE TRIGGER IF NOT EXISTS trg_crisis_entries_no_update
BEFORE UPDATE ON crisis_audit_entries
BEGIN
  SELECT RAISE(ABORT, 'crisis_audit_entries 为只追加审计链，禁止 UPDATE');
END;
CREATE TRIGGER IF NOT EXISTS trg_crisis_entries_no_delete
BEFORE DELETE ON crisis_audit_entries
BEGIN
  SELECT RAISE(ABORT, 'crisis_audit_entries 为只追加审计链，禁止 DELETE');
END;
`)

// ---------------- 兼容已有库：补列迁移 ----------------
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)
}
function addColumn(table, col, ddl) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
}
addColumn('matches', 'computed_at', `TEXT NOT NULL DEFAULT ''`)
addColumn('matches', 'strategy_id', `INTEGER NOT NULL DEFAULT 0`)
addColumn('applications', 'match_snapshot', `TEXT NOT NULL DEFAULT ''`)
addColumn('applications', 'matched_at', `TEXT NOT NULL DEFAULT ''`)
addColumn('applications', 'stage_snapshot', `TEXT NOT NULL DEFAULT ''`)
addColumn('applications', 'entered_at', `TEXT NOT NULL DEFAULT ''`)
addColumn('applications', 'reject_from', `TEXT NOT NULL DEFAULT ''`)
addColumn('applications', 'version', `INTEGER NOT NULL DEFAULT 1`)
addColumn('interviews', 'conclusion', `TEXT NOT NULL DEFAULT 'pending'`)
addColumn('interviews', 'decided_at', `TEXT NOT NULL DEFAULT ''`)
addColumn('interviews', 'decided_by', `TEXT NOT NULL DEFAULT ''`)
addColumn('offers', 'decided_at', `TEXT NOT NULL DEFAULT ''`)
addColumn('offers', 'decided_by', `TEXT NOT NULL DEFAULT ''`)
addColumn('offers', 'joined_at', `TEXT NOT NULL DEFAULT ''`)

// 策略版本治理（旧库升级）：生效窗口、灰度范围、审批与回滚元数据
addColumn('matches', 'weights', `TEXT NOT NULL DEFAULT '{}'`)
addColumn('matches', 'keyword_cap', `INTEGER NOT NULL DEFAULT 5`)
addColumn('matches', 'is_canary', `INTEGER NOT NULL DEFAULT 0`)
addColumn('matches', 'strategy_mode', `TEXT NOT NULL DEFAULT 'full'`)
addColumn('match_strategies', 'active_version_id', `INTEGER NOT NULL DEFAULT 0`)
addColumn('match_strategies', 'effective_start', `TEXT NOT NULL DEFAULT ''`)
addColumn('match_strategies', 'effective_end', `TEXT NOT NULL DEFAULT ''`)
;[
  ['status', `TEXT NOT NULL DEFAULT 'full'`],
  ['rollout_mode', `TEXT NOT NULL DEFAULT 'full'`],
  ['canary_percent', `INTEGER NOT NULL DEFAULT 0`],
  ['canary_candidate_ids', `TEXT NOT NULL DEFAULT '[]'`],
  ['effective_start', `TEXT NOT NULL DEFAULT ''`],
  ['effective_end', `TEXT NOT NULL DEFAULT ''`],
  ['baseline_version_id', `INTEGER NOT NULL DEFAULT 0`],
  ['change_note', `TEXT NOT NULL DEFAULT ''`],
  ['approval_task_id', `INTEGER NOT NULL DEFAULT 0`],
  ['promoted_version_id', `INTEGER NOT NULL DEFAULT 0`],
  ['approved_at', `TEXT NOT NULL DEFAULT ''`],
  ['rolled_back_by', `TEXT NOT NULL DEFAULT ''`],
  ['rolled_back_at', `TEXT NOT NULL DEFAULT ''`],
  ['rollback_reason', `TEXT NOT NULL DEFAULT ''`]
].forEach(([col, ddl]) => addColumn('strategy_versions', col, ddl))
addColumn('recalc_jobs', 'rollout_mode', `TEXT NOT NULL DEFAULT 'full'`)
addColumn('recalc_jobs', 'canary_version_id', `INTEGER NOT NULL DEFAULT 0`)
addColumn('recalc_jobs', 'canary_count', `INTEGER NOT NULL DEFAULT 0`)
addColumn('recalc_jobs', 'baseline_count', `INTEGER NOT NULL DEFAULT 0`)
addColumn('recalc_items', 'weights', `TEXT NOT NULL DEFAULT '{}'`)
addColumn('recalc_items', 'keyword_cap', `INTEGER NOT NULL DEFAULT 5`)
addColumn('recalc_items', 'is_canary', `INTEGER NOT NULL DEFAULT 0`)
addColumn('recalc_items', 'strategy_mode', `TEXT NOT NULL DEFAULT 'full'`)

// 危机回退同步：进行中的预约被危机处置挂起（status 复用 cancelled，crisis_suspended=1 标记），
// 之后可在原单上「重新协商」恢复后续流程；incident_id 保留来源事件用于追溯
addColumn('appointments', 'crisis_suspended', `INTEGER NOT NULL DEFAULT 0`)
addColumn('appointments', 'incident_id', `INTEGER NOT NULL DEFAULT 0`)

// 危机处置审计模块：通知表补齐「责任回写」列（旧库升级）
addColumn('notifications', 'incident_id', `INTEGER NOT NULL DEFAULT 0`)
addColumn('notifications', 'ticket_id', `INTEGER NOT NULL DEFAULT 0`)
addColumn('notifications', 'owner_name', `TEXT NOT NULL DEFAULT ''`)
addColumn('notifications', 'owner_user_id', `TEXT NOT NULL DEFAULT ''`)
// 按角色委托/超时升级：个人收件人（空=按角色桶投递，非空=仅该用户可见，如代理人/升级对象）
addColumn('notifications', 'recipient_id', `TEXT NOT NULL DEFAULT ''`)
addColumn('notifications', 'delegation_id', `INTEGER NOT NULL DEFAULT 0`)
db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(recipient_id, is_read, id)')
// 审批留痕补充：代理审批时记录所依据的委托；升级/委托/撤销等节点动作与普通通过同表留痕
// via: direct/delegate/escalated
addColumn('approval_steps', 'via', `TEXT NOT NULL DEFAULT ''`)
addColumn('approval_steps', 'delegation_id', `INTEGER NOT NULL DEFAULT 0`)

// 旧库索引迁移：正式事件改为「每个 application×stage 仅保留最新一条」（部分唯一索引）
const evIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='application_events'").all().map(i => i.name)
// 旧版该索引是 (application_id,stage,event_type) 唯一索引：先删除，清理重复行后重建为普通索引
if (evIndexes.includes('idx_app_events_once')) db.exec('DROP INDEX idx_app_events_once')
// 旧约束下 rejected 阶段可能同时存在 reject / offer_rejected 两行；保留最早的正式行，其余降为历史行
db.prepare(`UPDATE application_events SET backfilled=1
            WHERE backfilled=0 AND id NOT IN (SELECT MIN(id) FROM application_events WHERE backfilled=0 GROUP BY application_id, stage)`).run()
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_app_events_live_once ON application_events(application_id, stage) WHERE backfilled=0')
db.exec('CREATE INDEX IF NOT EXISTS idx_app_events_once ON application_events(application_id, stage, event_type)')

// 并发发布保护：同职位最多一个待审版本、一个灰度版本；升级前若有开发期重复数据，保留最新一条
db.prepare(`UPDATE strategy_versions SET status='cancelled'
            WHERE status='pending'
              AND id NOT IN (SELECT MAX(id) FROM strategy_versions WHERE status='pending' GROUP BY position_id)`).run()
db.prepare(`UPDATE strategy_versions SET status='superseded'
            WHERE status='canary'
              AND id NOT IN (SELECT MAX(id) FROM strategy_versions WHERE status='canary' GROUP BY position_id)`).run()
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_versions_pending_once
  ON strategy_versions(position_id) WHERE status='pending'`)
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_versions_canary_once
  ON strategy_versions(position_id) WHERE status='canary'`)

// 旧数据补齐：当前阶段快照取自该阶段正式事件（无正式事件时保持空串，由启动迁移按补录事件回填）
db.prepare(`UPDATE applications SET stage_snapshot=COALESCE((
                SELECT e.score_snapshot FROM application_events e
                WHERE e.application_id=applications.id AND e.stage=applications.stage AND e.backfilled=0
                ORDER BY e.id DESC LIMIT 1),''),
              entered_at=COALESCE((
                SELECT e.event_at FROM application_events e
                WHERE e.application_id=applications.id AND e.stage=applications.stage AND e.backfilled=0
                ORDER BY e.id DESC LIMIT 1),'')
            WHERE stage_snapshot=''`).run()
db.prepare("UPDATE interviews SET conclusion=result WHERE conclusion='pending' AND result!='pending'").run()
db.prepare(`UPDATE applications SET reject_from=(
                SELECT e.from_stage FROM application_events e
                WHERE e.application_id=applications.id AND e.stage='rejected'
                ORDER BY e.id DESC LIMIT 1)
            WHERE stage='rejected' AND reject_from='' AND EXISTS (
                SELECT 1 FROM application_events e WHERE e.application_id=applications.id AND e.stage='rejected')`).run()

// 策略版本治理旧库迁移：历史最新发布版本视为已全量生效；评分证据补齐当时的权重/关键词上限
db.prepare(`UPDATE strategy_versions
            SET status='full', rollout_mode='full'
            WHERE status NOT IN ('pending','canary','expired','rolled_back','cancelled','failed','scheduled','returned','superseded')`).run()
db.prepare(`UPDATE strategy_versions
            SET status='superseded'
            WHERE status='full'
              AND id NOT IN (SELECT MAX(id) FROM strategy_versions sv2 WHERE sv2.position_id=strategy_versions.position_id)`).run()
db.prepare(`UPDATE strategy_versions
            SET baseline_version_id=COALESCE((
              SELECT MAX(p.id) FROM strategy_versions p
              WHERE p.position_id=strategy_versions.position_id AND p.id<strategy_versions.id),0)
            WHERE baseline_version_id=0`).run()
db.prepare(`UPDATE match_strategies
            SET active_version_id=(
                  SELECT MAX(sv.id) FROM strategy_versions sv
                  WHERE sv.position_id=match_strategies.position_id),
                effective_start=COALESCE(NULLIF(effective_start,''), published_at)
            WHERE active_version_id=0`).run()
db.prepare(`UPDATE matches
            SET weights=(SELECT weights FROM strategy_versions sv WHERE sv.id=matches.strategy_id),
                keyword_cap=(SELECT keyword_cap FROM strategy_versions sv WHERE sv.id=matches.strategy_id),
                strategy_mode=CASE WHEN strategy_id>0 THEN 'full' ELSE 'default' END,
                is_canary=0
            WHERE strategy_id>0 AND (weights IS NULL OR weights='' OR weights='{}')`).run()
db.prepare(`UPDATE recalc_items
            SET weights=(SELECT weights FROM strategy_versions sv WHERE sv.id=recalc_items.strategy_id),
                keyword_cap=(SELECT keyword_cap FROM strategy_versions sv WHERE sv.id=recalc_items.strategy_id),
                strategy_mode=CASE WHEN strategy_id>0 THEN 'full' ELSE 'default' END,
                is_canary=0
            WHERE strategy_id>0 AND (weights IS NULL OR weights='' OR weights='{}')`).run()
db.prepare(`UPDATE recalc_jobs
            SET rollout_mode='full', canary_version_id=0, canary_count=0, baseline_count=pair_count
            WHERE rollout_mode NOT IN ('full','canary')`).run()

// 系统默认匹配策略：五维权重合计 1.0，简历关键词为封顶附加分
const DEFAULT_WEIGHTS = { skill: 0.4, year: 0.2, salary: 0.15, edu: 0.15, city: 0.1 }
const DEFAULT_KEYWORD_CAP = 5

const now = () => new Date().toISOString()
const ts = () => new Date().toLocaleString('zh-CN')

function seed() {
  const n = db.prepare('SELECT COUNT(*) c FROM positions').get().c
  if (n > 0) return

  const iP = db.prepare('INSERT INTO positions(name,dept,city,level,salary_min,salary_max,skills,years,slots,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
  const P = [
    ['前端开发工程师', '技术部', '上海', 'P5-P6', 18000, 32000, JSON.stringify([{ k: 'Vue', w: 5 }, { k: 'JavaScript', w: 5 }, { k: 'TypeScript', w: 4 }, { k: 'CSS', w: 3 }, { k: 'Node', w: 3 }]), 3, 2, 'open', ts()],
    ['后端开发工程师', '技术部', '北京', 'P5-P6', 20000, 38000, JSON.stringify([{ k: 'Java', w: 5 }, { k: 'Spring', w: 4 }, { k: 'MySQL', w: 4 }, { k: 'Redis', w: 3 }, { k: '微服务', w: 3 }]), 3, 3, 'open', ts()],
    ['产品经理', '产品部', '深圳', 'P6-P7', 22000, 42000, JSON.stringify([{ k: '需求分析', w: 5 }, { k: 'Axure', w: 4 }, { k: '数据分析', w: 4 }, { k: '项目管理', w: 3 }]), 4, 1, 'open', ts()],
    ['UI设计师', '设计部', '杭州', 'P5-P6', 15000, 28000, JSON.stringify([{ k: 'Figma', w: 5 }, { k: 'UI设计', w: 5 }, { k: '交互设计', w: 4 }]), 2, 2, 'open', ts()],
    ['数据分析师', '数据部', '上海', 'P5-P6', 18000, 33000, JSON.stringify([{ k: 'SQL', w: 5 }, { k: 'Python', w: 4 }, { k: 'Tableau', w: 3 }, { k: '统计学', w: 4 }]), 2, 1, 'closed', ts()],
    ['测试工程师', '质量部', '广州', 'P4-P5', 12000, 22000, JSON.stringify([{ k: '自动化测试', w: 4 }, { k: 'Python', w: 3 }, { k: 'Selenium', w: 3 }]), 1, 2, 'open', ts()]
  ]
  P.forEach(p => iP.run(...p))

  const iC = db.prepare('INSERT INTO candidates(name,phone,skills,years,edu,school,city,exp_salary,channel,raw) VALUES(?,?,?,?,?,?,?,?,?,?)')
  const skillPool = {
    'Vue': ['Vue', 'JavaScript', 'TypeScript', 'CSS', 'Node', 'Vite'],  // 前端集合用
    'Java': ['Java', 'Spring', 'MySQL', 'Redis', '微服务'],
    '产品': ['需求分析', 'Axure', '数据分析', '项目管理'],
    'UI': ['Figma', 'UI设计', '交互设计', 'PS'],
    '数据': ['SQL', 'Python', 'Tableau', '统计学'],
    '测试': ['自动化测试', 'Python', 'Selenium', 'JIRA']
  }
  const C = [
    ['林小雨', 'Vue', 4, '硕士', '上海交大', '上海', 30000, '猎头', '5年web开发经验，精通Vue3、TypeScript，主导过微前端改造'],
    ['周健', 'Vue', 2, '本科', '武汉理工', '杭州', 22000, '内推', 'Vue和JavaScript熟练，参与过大型后台系统开发'],
    ['王浩然', 'Java', 5, '硕士', '北邮', '北京', 38000, 'Boss直聘', 'Java后端专家，熟悉Spring Cloud微服务与高并发'],
    ['陈思远', 'Java', 3, '本科', '华中科大', '武汉', 28000, '内推', '掌握Java/Spring/MySQL，做过分布式订单系统'],
    ['刘一鸣', 'Java', 1, '本科', '郑州大学', '郑州', 15000, '校招', 'Java基础扎实，实习参与过支付模块'],
    ['黄梦琪', '产品', 5, '硕士', '复旦', '深圳', 40000, '猎头', '资深产品经理，擅长电商与增长，数据驱动'],
    ['孙明亮', '产品', 2, '本科', '中山大学', '广州', 23000, '内推', '需求分析与原型能力，跟进过3个上线产品'],
    ['吴雅琴', 'UI', 4, '本科', '江南大学', '杭州', 26000, '站酷', 'Figma熟练，擅长C端与B端UI，获奖多次'],
    ['郑晓彤', 'UI', 1, '本科', '四川美院', '成都', 16000, '校招', '视觉与交互设计，作品集丰富，掌握Figma'],
    ['何俊杰', '数据', 3, '硕士', '浙大', '上海', 30000, '内推', 'SQL与Python熟练，负责过用户行为数据仓库'],
    ['罗欣怡', '数据', 2, '本科', '厦大', '厦门', 21000, 'Boss直聘', '掌握SQL与Tableau，熟悉统计学与AB测试'],
    ['唐国强', '测试', 3, '本科', '电子科大', '成都', 19000, '内推', '自动化测试与Python，搭建过CI测试框架']
  ]
  C.forEach(c => {
    const [name, kind, years, edu, school, city, salary, channel, raw] = c
    const skills = JSON.stringify((skillPool[kind] || []).map((k, i) => ({ k, idx: Math.max(2, 5 - Math.floor(i / 2) + Math.floor(Math.random() * 2)) })))
    iC.run(name, '138' + String(10000000 + Math.floor(Math.random() * 89999999)), skills, years, edu, school, city, salary, channel, raw)
  })

  const iCh = db.prepare('INSERT INTO channels(name,cost) VALUES(?,?)')
  ;[['内推', 0], ['Boss直聘', 6000], ['猎头', 20000], ['校招', 8000], ['站酷', 4000]].forEach(ch => iCh.run(...ch))
}
seed()

// 内置三类角色用户：招聘负责人 / 面试官 / 用人经理（演示环境固定账号，前端顶栏可切换身份）
// 另设招聘总监：超时升级的兜底审批人（offer_issue 终审加签节点也升级到该角色）
function seedUsers() {
  const iU = db.prepare('INSERT INTO users(id,name,role,title) VALUES(?,?,?,?)')
  ;[
    ['u-sandy', 'Sandy 陈', 'recruiter', '招聘负责人'],
    ['u-li', '李工', 'interviewer', '面试官'],
    ['u-wang', '王经理', 'hiring_manager', '用人经理']
  ].forEach(u => {
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(u[0])) iU.run(...u)
  })
  if (!db.prepare("SELECT id FROM users WHERE id='u-zhao'").get()) {
    iU.run('u-zhao', '赵总监', 'hr_director', '招聘总监')
  }
}
seedUsers()

// 默认超时升级规则（仅三类关键审批；只在规则表为空时播种，管理员可在审批中心调整）
function seedEscalationRules() {
  const n = db.prepare('SELECT COUNT(*) c FROM approval_escalation_rules').get().c
  if (n > 0) return
  const iR = db.prepare(`INSERT INTO approval_escalation_rules(task_type,role,timeout_hours,escalate_to,enabled,updated_by,updated_at)
                        VALUES(?,?,?,?,1,'system',?)`)
  ;[
    ['stage_advance', 'hiring_manager', 24, 'hr_director'],
    ['interview_conclusion', 'recruiter', 12, 'hr_director'],
    ['offer_issue', 'hiring_manager', 24, 'hr_director'],
    ['offer_issue', 'recruiter', 12, 'hr_director']
  ].forEach(r => iR.run(...r, ts()))
}
seedEscalationRules()

// ---------------- 预约模块演示数据（仅空表时播种，复用既有应聘与面试官） ----------------
// 生成今天起 offset 天的 ISO 时间（HH:MM 本地时刻），保证演示时段始终在当前时间前后可交互
function demoISO(offsetDays, hh, mm = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  d.setHours(hh, mm, 0, 0)
  return d.toISOString()
}

function seedSchedule() {
  const slotCount = db.prepare('SELECT COUNT(*) c FROM schedule_slots').get().c
  if (slotCount > 0) return
  const interviewer = db.prepare("SELECT id FROM users WHERE role='interviewer' ORDER BY id LIMIT 1").get()
  if (!interviewer) return

  // 全新库在播种阶段尚无应聘记录（应聘一般由 API 创建）；这里补两条演示应聘，
  // 服务端启动时的 migrateHistory 会统一回填匹配快照与阶段事件（标记补录）
  const appCount = db.prepare('SELECT COUNT(*) c FROM applications').get().c
  let demoAppIds = db.prepare(`SELECT a.id, a.candidate_id FROM applications a
                               WHERE a.stage IN ('screening','interview') ORDER BY a.id LIMIT 2`).all()
  if (!demoAppIds.length && appCount === 0) {
    const pairs = [
      { pid: 1, cid: 1, stage: 'interview' }, // 林小雨 → 前端
      { pid: 2, cid: 3, stage: 'screening' }  // 王浩然 → 后端
    ]
    pairs.forEach(({ pid, cid, stage }) => {
      db.prepare(`INSERT INTO applications(position_id,candidate_id,stage,updated,recruiter,version)
                  VALUES(?,?,?,?, 'HR-Sandy',1)`).run(pid, cid, stage, ts())
    })
    demoAppIds = db.prepare(`SELECT a.id, a.candidate_id FROM applications a
                             WHERE a.stage IN ('screening','interview') ORDER BY a.id LIMIT 2`).all()
  }

  const iSlot = db.prepare(`INSERT INTO schedule_slots(owner_type,owner_id,start_at,end_at,source,status,note,created_by,created_at)
                            VALUES(?,?,?,?,?,'open',?,?,?)`)
  const iCSlot = db.prepare(`INSERT INTO schedule_slots(owner_type,owner_id,start_at,end_at,source,status,note,created_by,created_at)
                             VALUES(?,?,?,?,?,?,?,?,?)`)
  // 面试官未来一周的可用时段
  ;[
    [1, 10, 11], [1, 14, 15], [2, 10, 11], [2, 15, 16],
    [3, 11, 12], [4, 14, 15], [5, 10, 11], [7, 14, 15]
  ].forEach(([off, s, e]) => {
    iSlot.run('interviewer', interviewer.id, demoISO(off, s), demoISO(off, e),
      'self', '', interviewer.id, ts())
  })
  // 给前两位在途候选人代录可用时段（招聘负责人电话确认）
  demoAppIds.forEach((row, idx) => {
    const off = idx === 0 ? 1 : 2
    iCSlot.run('candidate', String(row.candidate_id), demoISO(off, 10), demoISO(off, 11),
      'recruiter', 'open', '电话确认可参加', 'u-sandy', ts())
    iCSlot.run('candidate', String(row.candidate_id), demoISO(off + 1, 15), demoISO(off + 1, 16),
      'recruiter', 'open', '候选人偏好下午', 'u-sandy', ts())
  })

  // 一条「待双向确认」的初试预约：面试官已确认，等待候选人（招聘负责人代为）确认
  const appRow = demoAppIds[0]
  if (appRow) {
    const start = demoISO(1, 10), end = demoISO(1, 11)
    const stamp = ts()
    // 一条「待双向确认」的初试预约：面试官已确认，等待候选人（招聘负责人代为）确认
    db.prepare(`INSERT INTO appointments
      (application_id,round,interviewer_id,interviewer_name,status,format,location,start_at,end_at,
       cand_confirmed,int_confirmed,reminded_24h,reminded_1h,created_by,created_at,updated_at,version)
      VALUES(?,?,?,?,?,?,?,?,?,0,1,0,0,?,?,?,1)`)
      .run(appRow.id, '初试', interviewer.id, '李工', 'negotiating', '线上', '腾讯会议 880-2166',
        start, end, 'u-sandy', stamp, stamp)
    const apptId = Number(db.prepare('SELECT last_insert_rowid() id').get().id)
    const iMsg = db.prepare(`INSERT INTO appointment_messages(appointment_id,kind,party,actor_id,actor_name,start_at,end_at,content,created_at)
                             VALUES(?,?,?,?,?,?,?,?,?)`)
    iMsg.run(apptId, 'create', 'recruiter', 'u-sandy', 'Sandy 陈', start, end,
      '已与面试官初排该时段，请候选人确认是否可参加', stamp)
    iMsg.run(apptId, 'confirm', 'interviewer', interviewer.id, '李工', start, end,
      '面试官已确认该时段', stamp)
  }
}
seedSchedule()

export default db
export { now, ts, DEFAULT_WEIGHTS, DEFAULT_KEYWORD_CAP }