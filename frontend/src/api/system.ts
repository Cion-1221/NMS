import client from './client';
import {
  SysUser, SysGroup,
  CreateUserReq, UpdateUserReq,
  CreateGroupReq, UpdateGroupReq,
} from '../types/system';

// ── 用户管理 ──────────────────────────────────────────────────────────────────
export const listUsers = () =>
  client.get<SysUser[]>('/system/users');

export const createUser = (data: CreateUserReq) =>
  client.post<SysUser>('/system/users', data);

export const updateUser = (id: number, data: UpdateUserReq) =>
  client.put<SysUser>(`/system/users/${id}`, data);

export const deleteUser = (id: number) =>
  client.delete(`/system/users/${id}`);

// ── 用户组管理 ─────────────────────────────────────────────────────────────────
export const listGroups = () =>
  client.get<SysGroup[]>('/system/groups');

export const createGroup = (data: CreateGroupReq) =>
  client.post<SysGroup>('/system/groups', data);

export const updateGroup = (id: number, data: UpdateGroupReq) =>
  client.put<SysGroup>(`/system/groups/${id}`, data);

export const deleteGroup = (id: number) =>
  client.delete(`/system/groups/${id}`);
