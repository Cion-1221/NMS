import client from './client';
import {
  SysUser, SysGroup,
  CreateUserReq, UpdateUserReq,
  CreateGroupReq, UpdateGroupReq,
  SecuritySettings, LockoutListResp,
  SessionPolicy, SysAuditLogListResp,
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

// 吊销用户全部 Refresh Token（会话在当前 Access Token 到期后无法续期）
export const forceLogoutUser = (id: number) =>
  client.post<{ revoked: number }>(`/system/users/${id}/force-logout`);

// ── 用户组管理 ─────────────────────────────────────────────────────────────────
export const listGroups = () =>
  client.get<SysGroup[]>('/system/groups');

export const createGroup = (data: CreateGroupReq) =>
  client.post<SysGroup>('/system/groups', data);

export const updateGroup = (id: number, data: UpdateGroupReq) =>
  client.put<SysGroup>(`/system/groups/${id}`, data);

export const deleteGroup = (id: number) =>
  client.delete(`/system/groups/${id}`);

// ── 安全设置（登录防爆破）──────────────────────────────────────────────────────
export const getSecuritySettings = () =>
  client.get<SecuritySettings>('/system/settings/security');

export const updateSecuritySettings = (data: SecuritySettings) =>
  client.put<SecuritySettings>('/system/settings/security', data);

// ── 锁定列表（防爆破触发的临时锁定，支持手动解除）──────────────────────────────
// 服务端分页：q 同时模糊匹配用户名和 IP；undefined 参数自动从 query string 剔除
export const listLockouts = (params: { page: number; page_size: number; q?: string }) =>
  client.get<LockoutListResp>('/system/security/lockouts', { params });

export const unlockLockouts = (keys: string[]) =>
  client.post<{ unlocked: number }>('/system/security/lockouts/unlock', { keys });

// ── 会话策略（全局最大会话时长）───────────────────────────────────────────────
export const getSessionPolicy = () =>
  client.get<SessionPolicy>('/system/settings/session');

export const updateSessionPolicy = (data: SessionPolicy) =>
  client.put<SessionPolicy>('/system/settings/session', data);

// ── System 审计日志 ───────────────────────────────────────────────────────────
export const listSysAuditLogs = (params: { page: number; page_size: number; username?: string; action?: string; resource_type?: string }) =>
  client.get<SysAuditLogListResp>('/system/audit-logs', { params });

export const purgeSysAuditLogs = (days: number) =>
  client.delete<{ deleted: number }>('/system/audit-logs', { params: { days } });
