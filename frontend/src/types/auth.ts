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
  /** 是否已开启两步验证（TOTP） */
  totp_enabled: boolean;
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

/** 登录第一步：密码正确但账号开启了两步验证——服务端不发 Token，只返回一次性挑战 */
export interface LoginTOTPChallenge {
  totp_required: true;
  /** 5 分钟内有效，绑定来源 IP，随 POST /auth/login/totp 一并提交 */
  mfa_token: string;
}
export type LoginStepResp = TokenBundle | LoginTOTPChallenge;

export const isTOTPChallenge = (r: LoginStepResp): r is LoginTOTPChallenge =>
  (r as LoginTOTPChallenge).totp_required === true;

/** POST /auth/totp/setup */
export interface TOTPSetupResp {
  secret: string;
  otpauth_uri: string;
}

/** POST /auth/totp/enable · /auth/totp/recovery-codes —— 恢复码明文仅此一次 */
export interface TOTPRecoveryCodesResp {
  recovery_codes: string[];
}
