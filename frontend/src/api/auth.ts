import client from './client';
import { AuthUser, ChangePasswordResp, LoginResp, RefreshResp } from '../types/auth';

export const login = (username: string, password: string) =>
  client.post<LoginResp>('/auth/login', { username, password });

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
