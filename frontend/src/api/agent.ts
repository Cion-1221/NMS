import client from './client';
import type {
  Agent, AgentListParams, AgentListResp, UpdateAgentReq, AgentSummary, PKIStatus,
  AgentFilterOptions, AgentGroup,
  AgentTask, CreateAgentTasksReq, UpdateAgentTaskReq,
  AgentTokenListResp, CreateAgentTokenReq, CreateAgentTokenResp,
  AgentRelease, AgentReleaseProgress,
  ProbeResultListParams, ProbeResultListResp, MeshPingMatrixResp, MeshPingMatrixParams,
  LatencySeriesResp,
} from '../types/agent';

// ── Agent 管理 ────────────────────────────────────────────────────────────────
// 服务端分页：undefined 的过滤参数会被 axios 自动从 query string 中剔除
export const getAgents = (params: AgentListParams) =>
  client.get<AgentListResp>('/agents', { params });

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

export const rotateCA = () =>
  client.post<{ message: string }>('/agents/ca/rotate');

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

export const createAgentRelease = (data: FormData) =>
  client.post<AgentRelease>('/agent-releases', data, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // Agent 二进制动辄几十 MB，不能吃全局 10s 超时；0 = 不限时，交给网络层约束
    timeout: 0,
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

// 批量删除多个 (agent_id, target) 组合的全部历史（管理员）；后端串行分片删除，
// 单次最多 200 个组合（与列表单页上限一致）
export const deleteProbeResultPairs = (type: string, pairs: { agent_id: string; target: string }[]) =>
  client.post<{ deleted: number; pairs: number }>('/probe-results/pairs/bulk-delete', { type, pairs }, {
    // 逐对分片删除，历史越长耗时越久，不能吃全局 10s 超时；确认框的 OK 按钮
    // 会一直转圈直到后端返回。0 = 不限时，交给网络层（反向代理）约束
    timeout: 0,
  });

// Target 下拉候选：该类型（可再限定 Agent）下去重后的 target，服务端聚合
export const getProbeResultTargets = (type: string, agentId?: string) =>
  client.get<{ targets: string[] }>('/probe-results/targets', { params: { type, agent_id: agentId || undefined } });

// 延迟趋势序列：服务端自动选源（原始点/归档层）并聚合到 ≤500 个显示点
export const getLatencySeries = (params: {
  agent_id: string; target: string; type: string; start: string; end: string;
}) => client.get<LatencySeriesResp>('/probe-results/latency-series', { params });

export const purgeProbeResults = (days: number) =>
  client.delete<{ deleted: number }>('/probe-results', { params: { days } });

// ── ASN Lookup ────────────────────────────────────────────────────────────────
export const lookupASN = (ips: string[]) =>
  client.get<Record<string, { asn: number; name: string } | null>>(
    '/asn', { params: { ips: ips.join(',') } },
  );
