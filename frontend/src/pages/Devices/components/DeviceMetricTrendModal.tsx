/**
 * 自定义 OID 指标趋势 Modal（懒加载图表；counter 序列已是每秒速率）。
 * entry 非空即打开；切换时间范围重新拉取序列。
 */
import React, { useEffect, useState } from 'react';
import { Modal, Segmented, Skeleton, message } from 'antd';
import { Line } from '@ant-design/charts';
import { getDeviceOIDSeries } from '../../../api/device';
import type { DeviceSNMPOIDEntry, MetricSeriesResp } from '../../../types/device';
import { apiErrMsg, useT } from '../../../i18n';
import { mono } from './deviceDisplay';

interface Props {
  deviceId: number | null;
  /** 趋势目标；null = 关闭 */
  entry: DeviceSNMPOIDEntry | null;
  onClose: () => void;
}

const DeviceMetricTrendModal: React.FC<Props> = ({ deviceId, entry, onClose }) => {
  const t = useT();
  const [range,   setRange]   = useState<string>('24h');
  const [data,    setData]    = useState<MetricSeriesResp | null>(null);
  const [loading, setLoading] = useState(false);

  const loadTrend = async (e: DeviceSNMPOIDEntry, r: string) => {
    if (deviceId == null) return;
    setLoading(true);
    try {
      const resp = await getDeviceOIDSeries(deviceId, e.id, r);
      setData(resp.data);
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setLoading(false);
    }
  };

  // 打开（entry 变化）时重置范围并拉取
  useEffect(() => {
    if (!entry) return;
    setData(null);
    setRange('24h');
    void loadTrend(entry, '24h');
  }, [entry]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRange = (r: string) => {
    setRange(r);
    if (entry) void loadTrend(entry, r);
  };

  // 趋势图 x 轴标签。标签必须逐桶唯一（分类轴会合并重复标签，导致末点被画回
  // 最左端拉出横穿全图的假直线）：24h 窗口经落桶对齐后首尾桶的 HH:mm 相同，
  // 因此 24h 及以上一律带月日；只有严格小于 24h 的 1h/6h 用纯时分。
  const trendLabel = (ts: string) => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (range === '90d') return `${d.getMonth() + 1}/${d.getDate()}`;
    if (range === '1h' || range === '6h') return `${hh}:${mm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  };

  // counter 序列的值是每秒速率，单位展示自动追加 /s
  const trendUnit = data
    ? (data.kind === 'counter' ? `${data.unit || ''}/s` : data.unit)
    : '';

  return (
    <Modal
      title={entry
        ? `${entry.name || entry.oid} — ${t('device.oid.trend')}${trendUnit ? `（${trendUnit}）` : ''}`
        : t('device.oid.trend')}
      open={!!entry}
      footer={null}
      onCancel={onClose}
      width={720}
      destroyOnClose
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Segmented
          value={range}
          onChange={(v) => handleRange(String(v))}
          options={['1h', '6h', '24h', '7d', '30d', '90d']}
        />
        {entry && mono(entry.oid)}
      </div>
      {loading && !data ? (
        <Skeleton active paragraph={{ rows: 5 }} />
      ) : data && data.points.length > 0 ? (
        <Line {...({
          data: data.points.map(p => ({ ts: trendLabel(p.ts), v: p.avg })),
          xField: 'ts',
          yField: 'v',
          height: 280,
          smooth: true,
          axis: { y: { title: trendUnit || undefined } },
        } as any)} />
      ) : (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--ant-color-text-tertiary)' }}>
          {t('device.oid.trendEmpty')}
        </div>
      )}
    </Modal>
  );
};

export default DeviceMetricTrendModal;
