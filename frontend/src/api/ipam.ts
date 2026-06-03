import axios from 'axios';
import { RootPrefix, CreateRootPrefixReq, UpdateRootPrefixReq, SubnetNode } from '../types/ipam';

const apiClient = axios.create({
  baseURL: '/api/v1/ipam',
  timeout: 10000,
});

export const getRootPrefixes = () => 
  apiClient.get<RootPrefix[]>('/root-prefixes');

export const createRootPrefix = (data: CreateRootPrefixReq) => 
  apiClient.post<RootPrefix>('/root-prefixes', data);

export const updateRootPrefix = (id: number, data: UpdateRootPrefixReq) => 
  apiClient.put(`/root-prefixes/${id}`, data);

export const deleteRootPrefix = (id: number) => 
  apiClient.delete(`/root-prefixes/${id}`);

export const getSubnetTree = (rootPrefixId: number) => 
  apiClient.get<SubnetNode[]>(`/root-prefixes/${rootPrefixId}/tree`);

export const splitSubnet = (data: { target_type: 'root' | 'subnet', target_id: number, target_bits: number }) => 
  apiClient.post('/split', data);

export const mergeSubnets = (data: { subnet_ids: number[] }) => 
  apiClient.post('/merge', data);
