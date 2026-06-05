export interface AuthUser {
  id: number;
  username: string;
  group_id: number;
  group_name: string;
  is_admin: boolean;
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
