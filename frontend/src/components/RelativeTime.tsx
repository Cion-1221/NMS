/**
 * RelativeTime — renders a timestamp as relative ("3 minutes ago" / "in 2 days"),
 * locale-aware (follows AppContext.language), with the absolute time in a tooltip.
 * Used for every Reported At / Last Seen / Cert Expiry column.
 */
import React from 'react';
import { Tooltip } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { useAppContext } from '../contexts/AppContext';

dayjs.extend(relativeTime);

export const RelativeTime: React.FC<{
  value?: string | number | Date | null;
  /** Highlight in danger colour + bold (e.g. cert expiring soon). */
  danger?: boolean;
}> = ({ value, danger }) => {
  const { language } = useAppContext();
  if (!value) return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>;
  const d = dayjs(value);
  return (
    <Tooltip title={d.format('YYYY-MM-DD HH:mm:ss')}>
      <span style={{
        whiteSpace: 'nowrap',
        color: danger ? 'var(--ant-color-error)' : 'var(--ant-color-text-secondary)',
        fontWeight: danger ? 700 : 400,
      }}>
        {d.locale(language === 'zh' ? 'zh-cn' : 'en').fromNow()}
      </span>
    </Tooltip>
  );
};

export default RelativeTime;
