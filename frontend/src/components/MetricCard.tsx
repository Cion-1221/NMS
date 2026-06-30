/**
 * MetricCard — the dashboard KPI card: icon + label, big mono number, sub-line,
 * and a sparkline drawn with @ant-design/charts (<Area>).
 *
 * The sparkline is optional: pass an empty `series` and it renders without one
 * (graceful degradation when the backend has no per-KPI time-series yet).
 */
import React from 'react';
import { Card, theme } from 'antd';
import { Area } from '@ant-design/charts';
import { FONT_MONO } from '../theme/theme';

export const MetricCard: React.FC<{
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  subColor?: string;
  series: number[];
  lineColor: string;
}> = ({ icon, iconBg, iconColor, label, value, sub, subColor, series, lineColor }) => {
  const { token } = theme.useToken();

  // Tiny sparkline. Props track @ant-design/charts v2 — adjust to your installed version.
  const sparkConfig = {
    data: series.map((y, x) => ({ x, y })),
    xField: 'x',
    yField: 'y',
    height: 34,
    width: 76,
    padding: 0,
    autoFit: false,
    axis: false as const,
    line: { style: { stroke: lineColor, lineWidth: 2.2 } },
    style: { fill: `l(90) 0:${lineColor}00 1:${lineColor}26` },
    tooltip: false as const,
  };

  return (
    <Card styles={{ body: { padding: 22 } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{
          width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center',
          justifyContent: 'center', background: iconBg, color: iconColor, flexShrink: 0,
        }}>
          {icon}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: token.colorTextSecondary }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 14 }}>
        <div>
          <div style={{ fontSize: 30, fontWeight: 700, fontFamily: FONT_MONO, color: token.colorText, letterSpacing: '-.02em', lineHeight: 1 }}>
            {value}
          </div>
          <div style={{ fontSize: 12, color: subColor ?? token.colorTextTertiary, marginTop: 6, fontWeight: subColor ? 600 : 400 }}>
            {sub}
          </div>
        </div>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        {series.length > 0 && <div style={{ width: 76, height: 34 }}><Area {...(sparkConfig as any)} /></div>}
      </div>
    </Card>
  );
};

export default MetricCard;
