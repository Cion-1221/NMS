/**
 * StatusTag — the pill used everywhere for device/agent status & alert severity.
 * Replaces the ad-hoc <Tag color="green"> calls. Colors come from the theme tokens
 * so it tracks light/dark automatically.
 */
import React from 'react';
import { theme } from 'antd';

type Tone = 'success' | 'danger' | 'warning' | 'accent' | 'teal' | 'neutral';

/** Map any backend status string to a tone. Extend as needed. */
const TONE: Record<string, Tone> = {
  active: 'success', online: 'success', ok: 'success', enabled: 'success', success: 'success',
  offline: 'danger', revoked: 'danger', error: 'danger', fail: 'danger', failed: 'danger', crit: 'danger', critical: 'danger',
  maintenance: 'warning', warn: 'warning', warning: 'warning', degraded: 'warning', planned_warn: 'warning',
  planned: 'accent', info: 'accent',
  used: 'teal', service: 'teal',
  unused: 'neutral', disabled: 'neutral', unknown: 'neutral', expired: 'neutral',
};

export const StatusTag: React.FC<{ status: string; label?: string; tone?: Tone }> = ({
  status, label, tone,
}) => {
  const { token } = theme.useToken();
  const t: Tone = tone ?? TONE[status?.toLowerCase()] ?? 'neutral';

  const fg: Record<Tone, string> = {
    success: token.colorSuccess, danger: token.colorError, warning: token.colorWarning,
    accent: token.colorPrimary, teal: '#0d9488', neutral: token.colorTextTertiary,
  };
  const bg: Record<Tone, string> = {
    success: token.colorSuccessBg, danger: token.colorErrorBg, warning: token.colorWarningBg,
    accent: token.colorPrimaryBg, teal: 'rgba(13,148,136,.12)', neutral: token.colorFillTertiary,
  };

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, lineHeight: 1.5,
      color: fg[t], background: bg[t], whiteSpace: 'nowrap',
    }}>
      {label ?? status}
    </span>
  );
};

export default StatusTag;
