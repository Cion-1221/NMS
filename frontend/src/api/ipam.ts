import client from './client';
import type {
  RootPrefix, CreateRootPrefixReq, UpdateRootPrefixReq,
  SubnetNode, IPAMGroup, IPAMType, IPAMVRF, IPAMAuditLog,
} from '../types/ipam';

// ── Root Prefixes ──────────────────────────────────────────────────────────────

export const getRootPrefixes = () =>
  client.get<RootPrefix[]>('/ipam/root-prefixes');

export const createRootPrefix = (data: CreateRootPrefixReq) =>
  client.post<RootPrefix>('/ipam/root-prefixes', data);

export const updateRootPrefix = (id: number, data: UpdateRootPrefixReq) =>
  client.put<RootPrefix>(`/ipam/root-prefixes/${id}`, data);

export const deleteRootPrefix = (id: number) =>
  client.delete(`/ipam/root-prefixes/${id}`);

// ── Subnet Tree & Operations ───────────────────────────────────────────────────

export const getSubnetTree = (rootPrefixId: number) =>
  client.get<SubnetNode[]>(`/ipam/root-prefixes/${rootPrefixId}/tree`);

export const splitSubnet = (data: { target_type: 'root' | 'subnet'; target_id: number; target_bits: number }) =>
  client.post('/ipam/split', data);

export const mergeSubnets = (data: { subnet_ids: number[] }) =>
  client.post('/ipam/merge', data);

export const updateSubnet = (id: number, data: { group_id?: number | null; type_id?: number | null; vrf_id?: number | null; remark?: string }) =>
  client.put(`/ipam/subnets/${id}`, data);

// ── Groups ─────────────────────────────────────────────────────────────────────

export const getGroups = () =>
  client.get<IPAMGroup[]>('/ipam/groups');

export const createGroup = (data: { name: string; description?: string }) =>
  client.post<IPAMGroup>('/ipam/groups', data);

export const updateGroup = (id: number, data: { name: string; description?: string }) =>
  client.put<IPAMGroup>(`/ipam/groups/${id}`, data);

export const deleteGroup = (id: number) =>
  client.delete(`/ipam/groups/${id}`);

// ── Types ──────────────────────────────────────────────────────────────────────

export const getIPAMTypes = () =>
  client.get<IPAMType[]>('/ipam/types');

export const createIPAMType = (data: { name: string; description?: string }) =>
  client.post<IPAMType>('/ipam/types', data);

export const updateIPAMType = (id: number, data: { name: string; description?: string }) =>
  client.put<IPAMType>(`/ipam/types/${id}`, data);

export const deleteIPAMType = (id: number) =>
  client.delete(`/ipam/types/${id}`);

// ── VRFs ───────────────────────────────────────────────────────────────────────

export const getVRFs = () =>
  client.get<IPAMVRF[]>('/ipam/vrfs');

export const createVRF = (data: { name: string; rd?: string; description?: string }) =>
  client.post<IPAMVRF>('/ipam/vrfs', data);

export const updateVRF = (id: number, data: { name: string; rd?: string; description?: string }) =>
  client.put<IPAMVRF>(`/ipam/vrfs/${id}`, data);

export const deleteVRF = (id: number) =>
  client.delete(`/ipam/vrfs/${id}`);

// ── Audit Logs ─────────────────────────────────────────────────────────────────

export const getAuditLogs = (
  page: number,
  pageSize: number,
  filters?: { username?: string; action?: string; resource_type?: string },
) =>
  client.get<{ total: number; items: IPAMAuditLog[]; page: number; page_size: number }>(
    '/ipam/audit-logs', { params: { page, page_size: pageSize, ...filters } }
  );

export const purgeAuditLogs = (days: number) =>
  client.delete<{ deleted: number }>('/ipam/audit-logs', { params: { days } });
