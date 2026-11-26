import client from './client';
import type {
  Agent, AgentListParams, AgentListResp, UpdateAgentReq, AgentSummary, PKIStatus,
  AgentFilterOptions, AgentGroup, AgentLiteItem,
  AgentTask, CreateAgentTasksReq, UpdateAgentTaskReq,
  AgentTokenListResp, CreateAgentTokenReq, CreateAgentTokenResp,
  AgentRelease, AgentReleaseProgress,
  ProbeResultListParams, ProbeResultListResp, MeshPingMatrixResp, MeshPingMatrixParams,
  LatencySeriesResp, ProbeJob, AgentAuditLog,
} from '../types/agent';

// ── Agent 管理 ────────────────────────────────────────────────────────────────
// 服务端分页：undefined 的过滤参数会被 axios 自动从 query string 中剔除
export const getAgents = (params: AgentListParams) =>
  client.get<AgentListResp>('/agents', { params });

// 轻量级全量 Agent 元数据（登录即可读，无 200 条分页截断）
export const getAgentsLite = (includeRevoked = false) =>
  client.get<AgentLiteItem[]>('/agents-lite', includeRevoked ? { params: { include_revoked: 'true' } } : undefined);

export const getAgentSummary = () =>
  client.get<AgentSummary>('/agents/summary');

// 筛选栏 Version / System Profile 下拉的候选值（服务端去重，不受分页影响）
export const getAgentFilterOptions = () =>
  client.get<AgentFilterOptions>('/agents/filter-options');

export const updateAgent = (agentId: string, data: UpdateAgentReq) =>
  client.put<Agent>(`/agents/${agentId}`, data);

export const deleteAgent = (agentId: string, purge = false) =>
  client.delete(`/agents/${agentId}`, { params: purge ? { purge: 'true' } : undefined });

export const revokeAgent = (agentId: string) =>
  client.post(`/agents/${agentId}/revoke`);

export const getAgentCACert = () =>
  client.get<string>('/agents/ca-cert', { responseType: 'text' });

// ── CA 状态/轮换 ─────────────────────────────────────────────────────────────
export const getCAStatus = () =>
  client.get<PKIStatus>('/agents/ca/status');

export const prepareCA = () =>
  client.post<{ message: string }>('/agents/ca/prepare');

export const rotateCA = (force = false) =>
  client.post<{ message: string }>('/agents/ca/rotate', undefined, force ? { params: { force: 'true' } } : undefined);

export const finalizeCA = () =>
  client.post<{ message: string }>('/agents/ca/finalize');

// ── Group ────────────────────────────────────────────────────────────────────
export const getAgentGroups = () =>
  client.get<AgentGroup[]>('/agent-groups');

export const createAgentGroup = (data: { name: string; description?: string }) =>
  client.post<AgentGroup>('/agent-groups', data);

export const updateAgentGroup = (id: number, data: { name: string; description?: string }) =>
  client.put<AgentGroup>(`/agent-groups/${id}`, data);

export const deleteAgentGroup = (id: number) =>
  client.delete(`/agent-groups/${id}`);

// ── Probe Config (AgentTask) ────────────────────────────────────────────────
export const getAgentTasks = () =>
  client.get<AgentTask[]>('/agent-tasks');

export const createAgentTasks = (data: CreateAgentTasksReq) =>
  client.post<AgentTask[]>('/agent-tasks', data);

export const updateAgentTask = (id: number, data: UpdateAgentTaskReq) =>
  client.put<AgentTask>(`/agent-tasks/${id}`, data);

export const deleteAgentTask = (id: number) =>
  client.delete(`/agent-tasks/${id}`);

// ── Token ────────────────────────────────────────────────────────────────────
export const getAgentTokens = (page: number, pageSize: number) =>
  client.get<AgentTokenListResp>('/agent-tokens', { params: { page, page_size: pageSize } });

export const createAgentToken = (data: CreateAgentTokenReq) =>
  client.post<CreateAgentTokenResp>('/agent-tokens', data);

export const revokeAgentToken = (id: number) =>
  client.post(`/agent-tokens/${id}/revoke`);

// ── Agent Releases ───────────────────────────────────────────────────────────
export const getAgentReleases = () =>
  client.get<AgentRelease[]>('/agent-releases');

// onProgress 收到 0–100 的上传百分比（浏览器 → NMS 的传输进度）。服务端是流式
// 落盘 + 同步算 SHA256，传输一结束就基本完成，不需要再做异步任务。
export const createAgentRelease = (data: FormData, onProgress?: (percent: number) => void) =>
  client.post<AgentRelease>('/agent-releases', data, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // Agent 二进制动辄几十 MB，不能吃全局 10s 超时；0 = 不限时，交给网络层约束
    timeout: 0,
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });

export const deleteAgentRelease = (id: number) =>
  client.delete(`/agent-releases/${id}`);

export const setAgentReleaseActive = (id: number, active: boolean) =>
  client.post<AgentRelease>(`/agent-releases/${id}/set-active`, { active });

export const getAgentReleaseProgress = (id: number) =>
  client.get<AgentReleaseProgress>(`/agent-releases/${id}/progress`);

// ── Probe Results ────────────────────────────────────────────────────────────
export const getProbeResults = (params: ProbeResultListParams) =>
  client.get<ProbeResultListResp>('/probe-results', { params });

// "当前状态"快照：每个 Agent+Target 组合只返回最新一条，而非完整历史
export const getLatestProbeResults = (params: ProbeResultListParams) =>
  client.get<ProbeResultListResp>('/probe-results/latest', { params });

export const getMeshPingMatrix = (params: MeshPingMatrixParams) =>
  client.get<MeshPingMatrixResp>('/probe-results/meshping-matrix', { params });

export const deleteProbeResultPair = (agentId: string, target: string, type: string) =>
  client.delete('/probe-results/pair', { params: { agent_id: agentId, target, type } });

// 批量删除多个 (agent_id, target) 组合的全部历史（管理员），单次最多 200 个组合。
// 后端立即返回 job_id，删除在后台串行分片执行，进度用 getProbeJob 轮询；
// 已有任务在跑时返回 409 probe.job_running + 该任务的 job_id
export const deleteProbeResultPairs = (type: string, pairs: { agent_id: string; target: string }[]) =>
  client.post<{ job_id: string }>('/probe-results/pairs/bulk-delete', { type, pairs });

// 维护任务（清理 / 批量删除）进度快照；任务过期或后端重启后返回 404
export const getProbeJob = (id: string) =>
  client.get<ProbeJob>(`/probe-results/jobs/${id}`);

// 正在运行的维护任务（无则 job 为 null）：页面刷新后据此重新挂上进度框
export const getCurrentProbeJob = () =>
  client.get<{ job: ProbeJob | null }>('/probe-results/jobs/current');

// Target 下拉候选：该类型（可再限定 Agent）下去重后的 target，服务端聚合
export const getProbeResultTargets = (type: string, agentId?: string) =>
  client.get<{ targets: string[] }>('/probe-results/targets', { params: { type, agent_id: agentId || undefined } });

// 延迟趋势序列：服务端自动选源（原始点/归档层）并聚合到 ≤500 个显示点
export const getLatencySeries = (params: {
  agent_id: string; target: string; type: string; start: string; end: string;
}) => client.get<LatencySeriesResp>('/probe-results/latency-series', { params });

// 清理历史数据：后端立即返回 job_id，分片删除在后台执行（千万级表可能跑数分钟），
// 进度用 getProbeJob 轮询；已有任务在跑时返回 409 probe.job_running + job_id
export const purgeProbeResults = (days: number) =>
  client.delete<{ job_id: string }>('/probe-results', { params: { days } });

// ── ASN Lookup ────────────────────────────────────────────────────────────────
export const lookupASN = (ips: string[]) =>
  client.get<Record<string, { asn: number; name: string } | null>>(
    '/asn', { params: { ips: ips.join(',') } },
  );

// ── Agent Audit Logs ──────────────────────────────────────────────────────────
export const getAgentAuditLogs = (
  page: number,
  pageSize: number,
  filters?: { username?: string; action?: string; resource_type?: string },
) =>
  client.get<{ total: number; items: AgentAuditLog[]; page: number; page_size: number }>(
    '/agents/audit-logs',
    { params: { page, page_size: pageSize, ...filters } },
  );

export const purgeAgentAuditLogs = (days: number) =>
  client.delete<{ deleted: number }>('/agents/audit-logs', { params: { days } });

