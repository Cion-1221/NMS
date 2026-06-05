import client from './client';
import { AuthUser, LoginResp, RefreshResp, ChangePasswordResp } from '../types/auth';

export const login = (username: string, password: string) =>
  client.post<LoginResp>('/auth/login', { username, password });

export const getMe = () =>
  client.get<AuthUser>('/auth/me');

export const changePassword = (oldPassword: string, newPassword: string) =>
  client.post<ChangePasswordResp>('/auth/change-password', {
    old_password: oldPassword,
    new_password: newPassword,
  });

/** 用 Refresh Token 换取新的 Access Token（不走 JWT 中间件）*/
export const refreshToken = (token: string) =>
  client.post<RefreshResp>('/auth/refresh', { refresh_token: token });

/** 更新当前用户的会话令牌有效期（1-720 小时）*/
export const updateTokenSettings = (tokenLifetimeHours: number) =>
  client.put<{ message: string; token_lifetime_hours: number }>(
    '/auth/settings',
    { token_lifetime_hours: tokenLifetimeHours },
  );
