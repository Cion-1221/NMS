/** StatTile — compact metric tile (the row above Devices / Agents / IPAM tables). */
import React from 'react';
import { Card, theme } from 'antd';
import { FONT_MONO } from '../theme/theme';

export const StatTile: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
  valueColor?: string;
  live?: boolean;
}> = ({ label, value, valueColor, live }) => {
  const { token } = theme.useToken();
  return (
    <Card size="small" styles={{ body: { padding: '18px 22px' } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {live && (
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: token.colorSuccess,
            animation: 'cionPulse 2s infinite',
          }} />
        )}
        <span style={{ fontSize: 12.5, color: token.colorTextSecondary, fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{
        fontSize: 26, fontWeight: 700, fontFamily: FONT_MONO, marginTop: 6,
        color: valueColor ?? token.colorText, lineHeight: 1,
      }}>
        {value}
      </div>
    </Card>
  );
};

export default StatTile;
