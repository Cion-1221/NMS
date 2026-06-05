export interface AuthUser {
  id: number;
  username: string;
  group_id: number;
  group_name: string;
  is_admin: boolean;
  must_change_password: boolean;
  /** 用户自定义的会话令牌有效期（小时），1-720 */
  token_lifetime_hours: number;
}

/** Login / Refresh / ChangePassword 均返回此结构 */
export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  /** ISO 8601 UTC 时间戳，例如 "2026-06-07T12:00:00Z" */
  access_token_expires_at: string;
  user: AuthUser;
}

export interface LoginResp extends TokenBundle {}

export interface RefreshResp extends TokenBundle {}

export interface ChangePasswordResp extends TokenBundle {
  message: string;
}
