import { useAuth } from '../contexts/AuthContext';

/**
 * 权限工具：与后端 models.KnownPermissions 对应。
 * admin 为超级管理员（隐含全部权限）；其余为模块级写权限——
 * 所有登录用户可读 IPAM/Devices/ProbeResults，写操作需要对应权限。
 */
export const PERM_ADMIN = 'admin';
export const PERM_IPAM_WRITE = 'ipam:write';
export const PERM_DEVICES_WRITE = 'devices:write';

/** 解析用户组的 permissions JSON 字符串；坏值一律视为无权限 */
export function parsePerms(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** 判断用户组（原始 permissions 字符串）是否为管理员组 —— 全站统一入口 */
export function groupIsAdmin(g?: { permissions: string } | null): boolean {
  return parsePerms(g?.permissions).includes(PERM_ADMIN);
}

/** Hook：当前登录用户是否拥有指定权限（admin 直通），用于隐藏无权限的写操作入口 */
export function useCan(perm: string): boolean {
  const { user } = useAuth();
  if (!user) return false;
  return user.is_admin || (user.permissions ?? []).includes(perm);
}

/**
 * 生成强随机密码（大小写字母 + 数字 + 符号各至少一个，crypto 随机源），
 * 供管理员创建用户 / 重置密码时一键填充。
 */
export function genPassword(length = 16): string {
  const sets = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnpqrstuvwxyz',
    '23456789',
    '!@#$%^&*_-+=',
  ];
  const all = sets.join('');
  const rand = new Uint32Array(length);
  crypto.getRandomValues(rand);
  const chars = Array.from(rand, (r, i) =>
    i < sets.length ? sets[i][r % sets[i].length] : all[r % all.length],
  );
  // Fisher–Yates 打乱，避免前四位固定为"大写/小写/数字/符号"的模式
  const shuffle = new Uint32Array(length);
  crypto.getRandomValues(shuffle);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffle[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
