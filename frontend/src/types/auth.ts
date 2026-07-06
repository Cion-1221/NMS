export interface AuthUser {
  id: number;
  username: string;
  group_id: number;
  group_name: string;
  is_admin: boolean;
  /** 所属用户组的模块级权限，如 ["ipam:write"]；admin 隐含全部权限 */
  permissions: string[];
  must_change_password: boolean;
  token_lifetime_hours: number;
  /** 'light' | 'dark' | 'system' */
  theme: string;
  /** 'en' | 'zh' */
  language: string;
}

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  access_token_expires_at: string;
  user: AuthUser;
}

export interface LoginResp extends TokenBundle {}
export interface RefreshResp extends TokenBundle {}
export interface ChangePasswordResp extends TokenBundle { message: string }
