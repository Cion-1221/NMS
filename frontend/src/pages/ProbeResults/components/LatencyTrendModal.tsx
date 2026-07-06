/**
 * LatencyTrendModal — 单条探测序列（源 Agent → 目标）的历史延迟趋势图。
 *
 * 数据来自 GET /probe-results/latency-series：服务端按所选时间范围自动在
 * 原始点/归档层之间选源（Cacti/RRD 语义），并聚合到 ≤500 个显示点。
 *
 * 本文件 import 了 @ant-design/charts（G2，体积大）——调用方必须通过
 * React.lazy 引入本组件，首次打开弹窗才加载图表 chunk（与 Dashboard 同款策略）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Modal, Segmented, Space, Spin } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Column, Line } from '@ant-design/charts';
import dayjs, { Dayjs } from 'dayjs';
import { getLatencySeries } from '../../../api/agent';
import type { LatencySeriesResp } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';
import { useAppContext } from '../../../contexts/AppContext';
import { FONT_MONO } from '../../../theme/theme';

const { RangePicker } = DatePicker;

interface Props {
  open: boolean;
  onClose: () => void;
  agentId: string;
  target: string;
  probeType: string;
  /** 弹窗标题描述，如 "HKG-01 → SIN-02 (V4)" 或 "HKG-01 → 8.8.8.8" */
  label: string;
}

// 预设时间范围（值 = 秒），custom 走 RangePicker
const PRESETS: { key: string; seconds: number }[] = [
  { key: '1h',  seconds: 3600 },
  { key: '12h', seconds: 12 * 3600 },
  { key: '1d',  seconds: 24 * 3600 },
  { key: '7d',  seconds: 7 * 24 * 3600 },
  { key: '30d', seconds: 30 * 24 * 3600 },
  { key: '1y',  seconds: 366 * 24 * 3600 },
];

// 粒度的紧凑展示（30s / 5m / 2h / 1d），中英通用
const fmtBucket = (sec: number): string => {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
};

const fmtMs = (v: number | null | undefined): string =>
  v == null ? '—' : `${v.toFixed(1)} ms`;

const LatencyTrendModal: React.FC<Props> = ({ open, onClose, agentId, target, probeType, label }) => {
  const t = useT();
  const { resolvedTheme } = useAppContext();

  const [preset, setPreset] = useState('1d');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [data, setData] = useState<LatencySeriesResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState('');

  // 当前生效的 [start, end]
  const range = useMemo((): [Dayjs, Dayjs] => {
    if (preset === 'custom' && customRange) return customRange;
    const p = PRESETS.find((x) => x.key === preset) ?? PRESETS[2];
    const now = dayjs();
    return [now.subtract(p.seconds, 'second'), now];
  }, [preset, customRange]);

  const load = useCallback(async () => {
    setLoading(true);
    setErrMsg('');
    try {
      const r = await getLatencySeries({
        agent_id: agentId, target, type: probeType,
        start: range[0].toISOString(), end: range[1].toISOString(),
      });
      setData(r.data);
    } catch (err) {
      setErrMsg(apiErrMsg(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [agentId, target, probeType, range]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 图表数据：avg/min/max 三条线；时间标签按窗口长度选格式
  const windowSec = range[1].diff(range[0], 'second');
  const timeFmt = windowSec <= 86400 ? 'HH:mm' : windowSec <= 8 * 86400 ? 'MM-DD HH:mm' : 'YYYY-MM-DD';
  const chartData = useMemo(() => {
    if (!data) return [];
    const rows: { time: string; ms: number; metric: string }[] = [];
    for (const p of data.points) {
      const time = dayjs(p.ts * 1000).format(timeFmt);
      if (p.avg_ms != null) rows.push({ time, ms: Number(p.avg_ms.toFixed(2)), metric: t('trend.avg') });
      if (p.min_ms != null) rows.push({ time, ms: Number(p.min_ms.toFixed(2)), metric: t('trend.min') });
      if (p.max_ms != null) rows.push({ time, ms: Number(p.max_ms.toFixed(2)), metric: t('trend.max') });
    }
    return rows;
  }, [data, timeFmt, t]);

  // 丢包率序列（逐桶 failed/runs），与主图共用时间轴格式
  const lossData = useMemo(() => {
    if (!data) return [];
    return data.points.map((p) => ({
      time: dayjs(p.ts * 1000).format(timeFmt),
      loss: p.runs > 0 ? Number(((p.failed / p.runs) * 100).toFixed(2)) : 0,
    }));
  }, [data, timeFmt]);

  // 导出当前显示的聚合序列为 CSV（BOM 头保证 Excel 正确识别 UTF-8）
  const exportCsv = () => {
    if (!data || data.points.length === 0) return;
    const header = 'time,avg_ms,min_ms,max_ms,runs,failed\n';
    const lines = data.points.map((p) => [
      dayjs(p.ts * 1000).format('YYYY-MM-DD HH:mm:ss'),
      p.avg_ms ?? '', p.min_ms ?? '', p.max_ms ?? '', p.runs, p.failed,
    ].join(','));
    const blob = new Blob(['﻿' + header + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `latency_${agentId}_${target}_${range[0].format('YYYYMMDDHHmm')}-${range[1].format('YYYYMMDDHHmm')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // @ant-design/charts v2 (G2 5) 配置：与 Dashboard 相同，cast any 以兼容版本差异
  const chartConfig = {
    data: chartData,
    xField: 'time',
    yField: 'ms',
    colorField: 'metric',
    seriesField: 'metric',
    height: 320,
    animate: false,
    theme: resolvedTheme === 'dark' ? 'classicDark' : 'classic',
    axis: { y: { title: 'ms' } },
  } as any;

  const s = data?.summary;
  const statStyle: React.CSSProperties = { fontFamily: FONT_MONO, fontWeight: 700 };

  return (
    <Modal
      title={`${t('trend.title')}: ${label}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={880}
      destroyOnClose
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented
          value={preset}
          onChange={(v) => setPreset(String(v))}
          options={[
            ...PRESETS.map((p) => ({ value: p.key, label: t(`trend.p${p.key}` as never) })),
            { value: 'custom', label: t('trend.custom') },
          ]}
        />
        {preset === 'custom' && (
          <RangePicker
            showTime
            value={customRange}
            onChange={(v) => {
              if (v && v[0] && v[1]) setCustomRange([v[0], v[1]]);
            }}
          />
        )}
        <Button
          icon={<DownloadOutlined />}
          disabled={!data || data.points.length === 0}
          onClick={exportCsv}
        >
          {t('common.export')}
        </Button>
      </Space>

      {errMsg && <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 12 }} />}

      <Spin spinning={loading}>
        {data && data.points.length === 0 && !loading ? (
          <Alert type="info" showIcon message={t('trend.noData')} style={{ marginBottom: 12 }} />
        ) : (
          <>
            <Line {...chartConfig} />
            {/* 丢包率（逐桶 failed/runs，与主图同轴同粒度） */}
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
              {t('trend.loss')} (%)
            </div>
            <Column {...({
              data: lossData,
              xField: 'time',
              yField: 'loss',
              height: 90,
              animate: false,
              theme: resolvedTheme === 'dark' ? 'classicDark' : 'classic',
              color: '#dc2626',
              style: { fill: '#dc2626' },
            } as any)} />
          </>
        )}
      </Spin>

      {/* 窗口汇总 + 数据粒度标注 */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 12,
        fontSize: 12.5, color: 'var(--ant-color-text-secondary)',
      }}>
        <span>{t('trend.avg')}: <span style={statStyle}>{fmtMs(s?.avg_ms)}</span></span>
        <span>{t('trend.min')}: <span style={statStyle}>{fmtMs(s?.min_ms)}</span></span>
        <span>{t('trend.max')}: <span style={statStyle}>{fmtMs(s?.max_ms)}</span></span>
        <span>{t('trend.loss')}: <span style={statStyle}>{s ? `${s.loss_pct.toFixed(2)}%` : '—'}</span></span>
        <span>{t('trend.probes')}: <span style={statStyle}>{s?.runs ?? '—'}</span></span>
        {data && (
          <span>
            {t('trend.granularity')}: <span style={statStyle}>{fmtBucket(data.source_bucket_seconds)}</span>
            {' '}({data.source === 'raw' ? t('trend.sourceRaw') : t('trend.sourceRollup')})
          </span>
        )}
      </div>
    </Modal>
  );
};

export default LatencyTrendModal;
