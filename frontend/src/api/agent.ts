import client from './client';
import type {
  Agent, AgentListParams, AgentListResp, UpdateAgentReq, AgentSummary, PKIStatus,
  AgentGroup,
  AgentTask, CreateAgentTasksReq, UpdateAgentTaskReq,
  AgentTokenListResp, CreateAgentTokenReq, CreateAgentTokenResp,
  AgentRelease,
  ProbeResultListParams, ProbeResultListResp, MeshPingMatrixResp, MeshPingMatrixParams,
} from '../types/agent';

// ── Agent 管理 ────────────────────────────────────────────────────────────────
// 服务端分页：undefined 的过滤参数会被 axios 自动从 query string 中剔除
export const getAgents = (params: AgentListParams) =>
  client.get<AgentListResp>('/agents', { params });

export const getAgentSummary = () =>
  client.get<AgentSummary>('/agents/summary');

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
  });

export const deleteAgentRelease = (id: number) =>
  client.delete(`/agent-releases/${id}`);

export const setAgentReleaseActive = (id: number, active: boolean) =>
  client.post<AgentRelease>(`/agent-releases/${id}/set-active`, { active });

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

export const purgeProbeResults = (days: number) =>
  client.delete<{ deleted: number }>('/probe-results', { params: { days } });
