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

export interface UpdateGroupReq {
  name?: string;
  permissions?: string;
}
