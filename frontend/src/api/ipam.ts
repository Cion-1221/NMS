import client from './client';
import { RootPrefix, CreateRootPrefixReq, UpdateRootPrefixReq, SubnetNode } from '../types/ipam';

export const getRootPrefixes = () =>
  client.get<RootPrefix[]>('/ipam/root-prefixes');

export const createRootPrefix = (data: CreateRootPrefixReq) =>
  client.post<RootPrefix>('/ipam/root-prefixes', data);

export const updateRootPrefix = (id: number, data: UpdateRootPrefixReq) =>
  client.put(`/ipam/root-prefixes/${id}`, data);

export const deleteRootPrefix = (id: number) =>
  client.delete(`/ipam/root-prefixes/${id}`);

export const getSubnetTree = (rootPrefixId: number) =>
  client.get<SubnetNode[]>(`/ipam/root-prefixes/${rootPrefixId}/tree`);

export const splitSubnet = (data: { target_type: 'root' | 'subnet'; target_id: number; target_bits: number }) =>
  client.post('/ipam/split', data);

export const mergeSubnets = (data: { subnet_ids: number[] }) =>
  client.post('/ipam/merge', data);
