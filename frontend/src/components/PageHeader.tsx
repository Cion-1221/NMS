/** PageHeader — the title + subtitle + actions block at the top of every screen. */
import React from 'react';
import { theme } from 'antd';

export const PageHeader: React.FC<{
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ title, subtitle, actions }) => {
  const { token } = theme.useToken();
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
      gap: 16, marginBottom: 20, flexWrap: 'wrap',
    }}>
      <div>
        <h1 style={{ fontSize: 23, fontWeight: 700, color: token.colorText, margin: '0 0 5px', letterSpacing: '-.015em' }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ fontSize: 13.5, color: token.colorTextSecondary, margin: 0 }}>{subtitle}</p>
        )}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
};

export default PageHeader;
