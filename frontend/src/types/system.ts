export interface SysGroup {
  id: number;
  name: string;
  permissions: string; // JSON 数组字符串，例如 '["admin"]' 或 '[]'
  created_at: string;
  updated_at: string;
}

export interface SysUser {
  id: number;
  username: string;
  group_id: number;
  group: SysGroup;
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateUserReq {
  username: string;
  password: string;
  group_id: number;
}

export interface UpdateUserReq {
  group_id?: number;
  password?: string;
}

export interface CreateGroupReq {
  name: string;
  permissions: string;
}

/** 登录安全（防爆破）配置 — 对应 GET/PUT /system/settings/security */
export interface SecuritySettings {
  enabled: boolean;
  max_attempts: number;
  window_minutes: number;
  lockout_minutes: number;
}

/** 当前处于锁定状态的「用户名 + IP」条目 — 对应 GET /system/security/lockouts */
export interface LockoutEntry {
  key: string;
  username: string;
  ip: string;
  locked_at: string;
  locked_until: string;
}

/** 锁定列表服务端分页响应 */
export interface LockoutListResp {
  total: number;
  items: LockoutEntry[];
  page: number;
  page_size: number;
}

export interface UpdateGroupReq {
  name?: string;
  permissions?: string;
}
