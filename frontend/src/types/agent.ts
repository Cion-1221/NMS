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
  has_pending_previous: boolean;
  previous_ca_expiry?: string | null;
}

/** Agent 列表查询参数 — 服务端分页 + 过滤 */
export interface AgentListParams {
  page: number;
  page_size: number;
  q?: string;
  group_id?: number;
  status?: string;
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
