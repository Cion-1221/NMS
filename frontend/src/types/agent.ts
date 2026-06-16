export type TaskType =
  | 'ping' | 'tcpping' | 'httpcheck' | 'dnscheck' | 'traceroute' | 'mtr' | 'meshping';

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
  source_ip_override?: string | null;
  status: AgentStatus;
  version?: string;
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

export interface CreateAgentTokenResp {
  id: number;
  token: string;
  expires_at: string;
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

/** Probe Results 通用查询参数 — 服务端分页 + 过滤（type 固定，由各 Tab 传入） */
export interface ProbeResultListParams {
  page: number;
  page_size: number;
  type: TaskType;
  q?: string;
  agent_id?: string;
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

export interface MeshPingCell {
  success: boolean;
  latency_ms: number | null;
  reported_at: string;
}

export interface MeshPingMatrixResp {
  agents: { agent_id: string; hostname: string }[];
  matrix: Record<string, Record<string, MeshPingCell | undefined>>;
}

export interface MeshPingMatrixParams {
  group_id?: number;
  q?: string;
}
