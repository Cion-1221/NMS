import client from './client';
import {
  AuthUser, ChangePasswordResp, LoginResp, LoginStepResp, RefreshResp,
  TOTPRecoveryCodesResp, TOTPSetupResp,
} from '../types/auth';

// 第一步：用户名 + 密码。账号开启两步验证时返回 {totp_required, mfa_token} 而非 Token
export const login = (username: string, password: string) =>
  client.post<LoginStepResp>('/auth/login', { username, password });

// 第二步：验证器 6 位码或恢复码，换取 Token 对
export const loginTOTP = (mfaToken: string, code: string) =>
  client.post<LoginResp>('/auth/login/totp', { mfa_token: mfaToken, code });

// 服务端登出：吊销本会话的 Refresh Token 家族（仅清本地存储的话，令牌在服务端仍有效）
export const logout = (refreshToken: string) =>
  client.post('/auth/logout', { refresh_token: refreshToken }, { timeout: 3000 });

export const getMe = () =>
  client.get<AuthUser>('/auth/me');

export const changePassword = (oldPassword: string, newPassword: string) =>
  client.post<ChangePasswordResp>('/auth/change-password', {
    old_password: oldPassword,
    new_password: newPassword,
  });

export const refreshToken = (token: string) =>
  client.post<RefreshResp>('/auth/refresh', { refresh_token: token });

export const updateTokenSettings = (tokenLifetimeHours: number) =>
  client.put<{ message: string; token_lifetime_hours: number }>(
    '/auth/settings',
    { token_lifetime_hours: tokenLifetimeHours },
  );

/** Update UI preferences: theme and/or language */
export const updateProfile = (data: { theme?: string; language?: string }) =>
  client.put<AuthUser>('/auth/profile', data);

// ── 两步验证（TOTP）自助管理 ───────────────────────────────────────────────────
// setup 生成待确认的密钥（不改变登录要求）→ enable 用验证器码确认后正式开启并返回
// 一次性恢复码 → disable 需要当前密码 + 验证码（或恢复码）
export const totpSetup = () =>
  client.post<TOTPSetupResp>('/auth/totp/setup');

export const totpEnable = (code: string) =>
  client.post<TOTPRecoveryCodesResp>('/auth/totp/enable', { code });

export const totpDisable = (password: string, code: string) =>
  client.post('/auth/totp/disable', { password, code });

export const totpRegenerateRecoveryCodes = (code: string) =>
  client.post<TOTPRecoveryCodesResp>('/auth/totp/recovery-codes', { code });
