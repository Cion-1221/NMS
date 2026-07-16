/**
 * Devices 模块共享展示工具：纯格式化函数 + 运行状态标签。
 * 设备列表（TabDeviceList）与 SNMP 详情 Drawer（DeviceSNMPDrawer）共用。
 */
import React from 'react';
import { Tooltip } from 'antd';
import StatusTag from '../../../components/StatusTag';
import { useT } from '../../../i18n';
import type { TranslationKey } from '../../../i18n/translations';
import { FONT_MONO } from '../../../theme/theme';

// IPs / IDs render in the mono stack against a dimmed colour (Direction A).
export const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

/** bit/s → "1.24 Gbps" / "820 Mbps" / "3.2 Kbps"（接口速率展示） */
export function formatBps(bps?: number | null): string | null {
  if (bps == null) return null;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(bps)} bps`;
}

// RFC 2863 ifOperStatus → StatusTag tone（1 up；2 down；6 notPresent 视为中性）
export const IF_OPER_TONES: Record<number, 'success' | 'danger' | 'warning' | 'neutral'> = {
  1: 'success', 2: 'danger', 3: 'warning', 4: 'neutral', 5: 'warning', 6: 'neutral', 7: 'warning',
};

/** sysUpTime TimeTicks（1/100 秒）→ "37d 4h" / "3h 12m" / "45m" */
export function formatUptime(ticks?: number | null): string | null {
  if (ticks == null) return null;
  const s = Math.floor(ticks / 100);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// oper_reason → i18n 词条存在的已知值；未知值原样展示（向前兼容后端新增原因）
const KNOWN_OPER_REASONS = new Set([
  'snmp_timeout', 'snmp_error', 'unreachable', 'no_target',
  'agent_down', 'agent_revoked', 'poller_stale', 'auth_fail',
]);

/**
 * 运行状态标签。polling_mode=none 显示 "—"（没有采集就没有可信结论）；
 * unknown + agent_down/agent_revoked 特殊展示为 "Proxy Down"（探针失联，设备
 * 本身状态未知）。tooltip 给出 oper_reason 详情。
 */
export const OperStatusTag: React.FC<{
  pollingMode: string;
  operStatus: string;
  operReason?: string;
}> = ({ pollingMode, operStatus, operReason }) => {
  const t = useT();
  if (pollingMode === 'none') {
    return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>;
  }
  let tone: 'success' | 'danger' | 'warning' | 'neutral' = 'neutral';
  let label = t(`device.operStatus.${operStatus}` as TranslationKey);
  if (operStatus === 'up') tone = 'success';
  else if (operStatus === 'down') tone = 'danger';
  else if (operStatus === 'unknown' && (operReason === 'agent_down' || operReason === 'agent_revoked')) {
    tone = 'warning';
    label = t('device.operStatus.proxyDown');
  }
  const tag = <StatusTag status={operStatus} label={label} tone={tone} />;
  if (!operReason) return tag;
  const reasonText = KNOWN_OPER_REASONS.has(operReason)
    ? t(`device.operReason.${operReason}` as TranslationKey)
    : operReason;
  return <Tooltip title={reasonText}>{tag}</Tooltip>;
};
