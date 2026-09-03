/**
 * 自定义 OID 指标趋势 Modal（counter 序列已是每秒速率）。
 * entry 非空即打开；切换时间范围重新拉取序列。
 *
 * 坐标轴与 ProbeResults 的延迟趋势图同一套 Cacti 风格（见 utils/chartTicks）：
 * x 轴时间标签水平显示、按密度抽样；y 轴从 0 起、整数刻度。指标最大值小于 2
 * 时保留 G2 从 0 起的自动刻度（允许小数），否则 0–1 的比率、低负载这类小量级
 * 读数会被 0 / 1 两档刻度压成一条贴底的线。只影响坐标轴，数值本身不取整。
 *
 * 与 LatencyTrendModal 一样保持静态 import（多个懒加载边界共享 @antv/g2 会触发
 * chunk 加载顺序崩溃，见该文件头部注释）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Segmented, Skeleton, message } from 'antd';
import { Line } from '@ant-design/charts';
import { getDeviceOIDSeries } from '../../../api/device';
import type { DeviceSNMPOIDEntry, MetricSeriesResp } from '../../../types/device';
import { apiErrMsg, useT } from '../../../i18n';
import { useAppContext } from '../../../contexts/AppContext';
import { FONT_MONO } from '../../../theme/theme';
import { integerTicks, pickXLabels } from '../../../utils/chartTicks';
import { mono } from './deviceDisplay';

interface Props {
  deviceId: number | null;
  /** 趋势目标；null = 关闭 */
  entry: DeviceSNMPOIDEntry | null;
  onClose: () => void;
}

// x 轴最多展示的标签个数：水平显示的 "M/D HH:mm" 约 60px，8 个在 720px 弹窗内不重叠
const MAX_X_LABELS = 8;

// 趋势图 x 轴标签。标签必须逐桶唯一（分类轴会合并重复标签，导致末点被画回
// 最左端拉出横穿全图的假直线）：24h 窗口经落桶对齐后首尾桶的 HH:mm 相同，
// 因此 24h 及以上一律带月日；只有严格小于 24h 的 1h/6h 用纯时分。
const trendLabel = (ts: string, range: string): string => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (range === '90d') return `${d.getMonth() + 1}/${d.getDate()}`;
  if (range === '1h' || range === '6h') return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
};

const DeviceMetricTrendModal: React.FC<Props> = ({ deviceId, entry, onClose }) => {
  const t = useT();
  const { resolvedTheme } = useAppContext();
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

  // counter 序列的值是每秒速率，单位展示自动追加 /s
  const trendUnit = data
    ? (data.kind === 'counter' ? `${data.unit || ''}/s` : data.unit)
    : '';

  // ── 图表数据与坐标轴 ──
  const chartData = useMemo(
    () => (data?.points ?? []).map(p => ({ ts: trendLabel(p.ts, range), v: p.avg })),
    [data, range],
  );
  const xDomain = useMemo(() => chartData.map(d => d.ts), [chartData]);
  const xKeep   = useMemo(() => pickXLabels(xDomain, MAX_X_LABELS), [xDomain]);
  const yMax    = useMemo(
    () => chartData.reduce((m, d) => (d.v != null && d.v > m ? d.v : m), 0),
    [chartData],
  );
  // 量级 ≥ 2 用整数刻度并把 domain 钉在最后一个刻度上；更小的量级交给 G2 从 0 起自动推刻度
  const yScale = useMemo(() => {
    if (yMax < 2) return { domainMin: 0, nice: true };
    const ticks = integerTicks(yMax, 5);
    return { domain: [0, ticks[ticks.length - 1]], nice: false, tickMethod: () => ticks };
  }, [yMax]);

  const chartConfig = {
    data: chartData,
    xField: 'ts',
    yField: 'v',
    height: 280,
    smooth: true,
    animate: false,
    theme: resolvedTheme === 'dark' ? 'classicDark' : 'classic',
    scale: { x: { domain: xDomain }, y: yScale },
    axis: {
      x: {
        labelFontFamily: FONT_MONO, labelFontSize: 10.5,
        // 时间标签水平显示（Cacti 效果）：关掉 G2 的自动旋转/隐藏/省略，密度由抽样控制
        labelAutoRotate: false, labelAutoHide: false, labelAutoEllipsis: false,
        tickFilter: (v: unknown) => xKeep.has(String(v)),
        labelFormatter: (v: unknown) => (xKeep.has(String(v)) ? String(v) : ''),
      },
      y: {
        labelFontFamily: FONT_MONO, labelFontSize: 10.5, gridLineDash: [3, 4],
        title: trendUnit || undefined,
      },
    },
  } as any;

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
        <Line {...chartConfig} />
      ) : (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--ant-color-text-tertiary)' }}>
          {t('device.oid.trendEmpty')}
        </div>
      )}
    </Modal>
  );
};

export default DeviceMetricTrendModal;
