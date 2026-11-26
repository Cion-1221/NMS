export type TaskType =
  | 'ping' | 'tcpping' | 'httpcheck' | 'dnscheck' | 'traceroute' | 'mtr' | 'meshping' | 'meshmtr';

export type TaskScope = 'global' | 'group' | 'agent';

export type AgentStatus = 'online' | 'offline';

export type AgentTokenStatus = 'unused' | 'used' | 'revoked';

export interface AgentGroup {
  id: number;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  agent_id: string;
  hostname: string;
  group_id?: number | null;
  group?: AgentGroup | null;
  connection_ip: string;
  connection_ipv4: string;
  connection_ipv6: string;
  source_ip_override?: string | null;
  status: AgentStatus;
  version?: string;
  os?: string;
  arch?: string;
  registered_at: string;
  cert_expiry: string;
  revoked: boolean;
  last_seen_at?: string | null;
}

/** GET /agents/summary — Agent List 顶部健康汇总卡片 */
export interface AgentSummary {
  total_agents: number;
  online_agents: number;
  offline_agents: number;
  revoked_agents: number;
  recent_probes_1h: number;
  recent_failed_1h: number;
  recent_failure_rate_pct: number;
}

/** GET /agents/ca/status — Token Tab 顶部 CA 状态面板 */
export interface PKIStatus {
  active_ca_expiry: string;
  active_ca_serial: string;
  active_ca_fp: string;
  has_prepared_next: boolean;
  next_ca_expiry?: string | null;
  next_ca_fp?: string;
  has_pending_previous: boolean;
  previous_ca_expiry?: string | null;
  previous_ca_fp?: string;
  restart_required: boolean;
  online_agents: number;
  next_ca_trusted_agents: number;
  active_ca_issued_agents: number;
}

/** Agent 列表查询参数 — 服务端分页 + 过滤 */
export interface AgentListParams {
  page: number;
  page_size: number;
  q?: string;
  group_id?: number;
  /** online | offline | revoked：前两者只匹配未作废的 Agent（与汇总卡片口径一致） */
  status?: string;
  version?: string;
  os?: string;
  arch?: string;
}

/** GET /agents/filter-options — Agent List 筛选栏下拉候选（全量去重，不受分页影响） */
export interface AgentFilterOptions {
  versions: string[];
  profiles: { os: string; arch: string }[];
}

export interface AgentListResp {
  total: number;
  items: Agent[];
  page: number;
  page_size: number;
}

export interface UpdateAgentReq {
  hostname: string;
  source_ip_override: string; // 空字符串 = 清除
  group_id?: number | null;   // null = 清除分组
}

/**
 * 域名 target 的解析地址族：auto = 跟随系统解析偏好；v4/v6 = 限定该族；
 * both = v4+v6 各探测一次（Agent 端结果以 " (v4)"/" (v6)" 后缀区分两条序列）。
 * 字面 IP target 始终按自身地址族探测，不受此设置影响。
 */
export type AddressFamily = 'auto' | 'v4' | 'v6' | 'both';

export interface AgentTask {
  id: number;
  name: string;
  type: TaskType;
  targets_raw: string;
  interval_seconds: number;
  scope: TaskScope;
  group_id?: number | null;
  group?: AgentGroup | null;
  agent_id?: string | null;
  agent?: Agent | null;
  enabled: boolean;
  /** 仅 httpcheck 使用：跳过证书校验（裸 IP / 自签证书设备） */
  skip_tls_verify: boolean;
  address_family: AddressFamily;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentTasksReq {
  name: string;
  types: TaskType[];
  targets_raw: string;
  interval_seconds: number;
  scope: TaskScope;
  group_id?: number | null;
  agent_id?: string | null;
  skip_tls_verify?: boolean;
  address_family?: AddressFamily;
}

export interface UpdateAgentTaskReq {
  name: string;
  type: TaskType;
  targets_raw: string;
  interval_seconds: number;
  scope: TaskScope;
  group_id?: number | null;
  agent_id?: string | null;
  enabled: boolean;
  skip_tls_verify?: boolean;
  address_family?: AddressFamily;
}

export interface AgentToken {
  id: number;
  status: AgentTokenStatus;
  preset_group_id?: number | null;
  preset_group?: AgentGroup | null;
  expires_at: string;
  used_by_agent_id?: string | null;
  used_at?: string | null;
  created_by: string;
  created_at: string;
}

export interface AgentTokenListResp {
  total: number;
  items: AgentToken[];
  page: number;
  page_size: number;
}

export interface CreateAgentTokenReq {
  expires_in_minutes: number;
  preset_group_id?: number | null;
}

export interface AgentRelease {
  id: number;
  version: string;
  os: string;
  arch: string;
  file_path: string;
  file_size: number;
  sha256: string;
  notes: string;
  active: boolean;
  created_by: string;
  created_at: string;
}

export interface AgentReleaseProgressItem {
  agent_id: string;
  hostname: string;
  current_version: string;
  updated: boolean;
  status: string;
  last_seen_at: string | null;
}

export interface AgentReleaseProgress {
  release_version: string;
  os: string;
  arch: string;
  total: number;
  updated_count: number;
  agents: AgentReleaseProgressItem[];
}

export interface CreateAgentTokenResp {
  id: number;
  token: string;
  expires_at: string;
}

export interface MtrHop {
  ttl: number;
  host: string;
  loss_rate: number;
  avg_rtt_ms: number;
  best_rtt_ms: number;
  worst_rtt_ms: number;
  stddev_rtt_ms?: number;
}

export interface TraceHop {
  ttl: number;
  ip?: string;
  rtt_ms?: number;
  timeout?: boolean;
}

export interface TraceDetail {
  hops: TraceHop[];
  reached: boolean;
}

export interface AgentLiteItem {
  agent_id: string;
  hostname: string;
  status: AgentStatus;
  revoked?: boolean;
  group_name: string;
  last_seen_at?: string | null;
}

export interface ProbeResult {
  id: number;
  agent_id: string;
  task_id?: number | null;
  type: TaskType;
  target: string;
  success: boolean;
  latency_ms?: number | null;
  detail?: string;
  reported_at: string;
}

/** 延迟趋势序列单点 — 对应 GET /probe-results/latency-series */
export interface LatencySeriesPoint {
  ts: number;               // 桶起始时间（Unix 秒，UTC 对齐）
  avg_ms: number | null;    // null = 该桶全部失败
  min_ms: number | null;
  max_ms: number | null;
  runs: number;
  failed: number;
}

export interface LatencySeriesSummary {
  avg_ms: number | null;
  min_ms: number | null;
  max_ms: number | null;
  runs: number;
  failed: number;
  loss_pct: number;
}

export interface LatencySeriesResp {
  source: 'raw' | 'rollup';        // raw = 原始点；rollup = 归档层
  source_bucket_seconds: number;   // 实际显示粒度（秒）
  interval_seconds: number;        // 该序列的任务 Interval
  points: LatencySeriesPoint[];
  summary: LatencySeriesSummary | null;
}

/** Probe Results 通用查询参数 — 服务端分页 + 过滤（type 固定，由各 Tab 传入） */
export interface ProbeResultListParams {
  page: number;
  page_size: number;
  type: TaskType;
  q?: string;
  agent_id?: string;
  target?: string;   // 精确 target IP，用于 MeshPing→MTR 跳转查询
  success?: boolean;
  /** ISO 8601 / RFC3339，配合 DatePicker.RangePicker 使用 */
  start?: string;
  end?: string;
}

export interface ProbeResultListResp {
  total: number;
  items: ProbeResult[];
  page: number;
  page_size: number;
}

/**
 * GET /probe-results/jobs/:id — 清理历史数据 / 批量删除的后台任务快照。
 * purge 以行数计进度（total_rows 为启动时统计的待删行数）；bulk_delete 以组合数计
 * （pairs_done / pairs_total），deleted_rows 仅作展示。counting = 清理任务正在统计行数。
 */
export interface ProbeJob {
  id: string;
  kind: 'purge' | 'bulk_delete';
  status: 'counting' | 'running' | 'done' | 'failed';
  total_rows: number;
  deleted_rows: number;
  pairs_total: number;
  pairs_done: number;
  error?: string;
  created_by: string;
  started_at: string;
  finished_at?: string | null;
}

export interface MeshPingProto {
  success: boolean;
  latency_ms: number | null;
  reported_at: string;
  target_ip?: string; // 实际探测 IP，用于从 MeshPing 格子跳转到 MTR 查询
}

export interface MeshPingCell {
  v4?: MeshPingProto;
  v6?: MeshPingProto;
}

export interface MeshPingMatrixResp {
  agents: { agent_id: string; hostname: string }[];
  matrix: Record<string, Record<string, MeshPingCell | undefined>>;
}

export interface MeshPingMatrixParams {
  group_id?: number;
  q?: string;
}

export interface AgentAuditLog {
  id: number;
  username: string;
  action: string;
  resource_type: string;
  resource_id: string;
  detail: string;
  created_at: string;
}

