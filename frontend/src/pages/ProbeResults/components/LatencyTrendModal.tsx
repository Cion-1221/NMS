/**
 * LatencyTrendModal — 单条探测序列（源 Agent → 目标）的历史延迟趋势图。
 * ★ Direction A "Clarity" 重设计版：标题胶囊 + 统计条 + min–max 区间带 + 丢包子图。
 *
 * 数据来自 GET /probe-results/latency-series：服务端按所选时间范围自动在
 * 原始点/归档层之间选源（Cacti/RRD 语义），并聚合到 ≤500 个显示点。
 *
 * 本文件 import 了 @ant-design/charts（G2，体积大）——调用方必须通过
 * React.lazy 引入本组件，首次打开弹窗才加载图表 chunk（与 Dashboard 同款策略）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Modal, Segmented, Space, Spin, theme } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Area, Column, Line } from '@ant-design/charts';
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
  /** 弹窗路径描述，如 "HKG-01 → SIN-02 (V4)" 或 "HKG-01 → 8.8.8.8"（应传 hostname 而非 agent_id） */
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

/** 区间带图与丢包图共用的左右内边距，保证两图纵向对齐 */
const PAD_L = 46;
const PAD_R = 12;

const LatencyTrendModal: React.FC<Props> = ({ open, onClose, agentId, target, probeType, label }) => {
  const t = useT();
  const { resolvedTheme } = useAppContext();
  const { token } = theme.useToken();

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

  // 时间标签按窗口长度选格式。标签必须逐桶唯一（x 轴是分类轴，G2 会把重复
  // 标签合并到同一位置）：恰好 24h 的窗口经落桶对齐后首尾两个桶的 HH:mm 相同
  // （昨天 16:50 与今天 16:50），若仍用纯 HH:mm，最后一个点会被画回最左端、
  // 折线拉出一条横穿全图的假直线——因此 24h 及以上一律带日期，严格小于 24h
  // 的窗口内 HH:mm 天然不重复。
  const windowSec = range[1].diff(range[0], 'second');
  const timeFmt = windowSec < 86400 ? 'HH:mm' : windowSec <= 8 * 86400 ? 'MM-DD HH:mm' : 'YYYY-MM-DD';

  // 区间带（min–max）与主线（avg）数据
  const bandData = useMemo(() => {
    if (!data) return [];
    return data.points
      .filter((p) => p.min_ms != null && p.max_ms != null)
      .map((p) => ({
        time: dayjs(p.ts * 1000).format(timeFmt),
        min: Number(p.min_ms!.toFixed(2)),
        max: Number(p.max_ms!.toFixed(2)),
      }));
  }, [data, timeFmt]);

  const avgData = useMemo(() => {
    if (!data) return [];
    return data.points
      .filter((p) => p.avg_ms != null)
      .map((p) => ({
        time: dayjs(p.ts * 1000).format(timeFmt),
        avg: Number(p.avg_ms!.toFixed(2)),
      }));
  }, [data, timeFmt]);

  // 丢包率序列（逐桶 failed/runs），与主图共用时间轴格式
  const lossData = useMemo(() => {
    if (!data) return [];
    return data.points.map((p) => ({
      time: dayjs(p.ts * 1000).format(timeFmt),
      loss: p.runs > 0 ? Number(((p.failed / p.runs) * 100).toFixed(2)) : 0,
    }));
  }, [data, timeFmt]);

  // 区间带与主线共用同一 Y 轴上限，保证两图坐标系一致（G2 各图独立 scale，需显式钉住）
  const yMax = useMemo(() => {
    const vals = bandData.map((d) => d.max);
    if (!vals.length) return undefined;
    return Math.ceil((Math.max(...vals) * 1.06) / 10) * 10;
  }, [bandData]);

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

  const g2Theme = resolvedTheme === 'dark' ? 'classicDark' : 'classic';

  // ---- 主图：min–max 区间带（底层，带坐标轴）----
  // @ant-design/charts v2 (G2 5)：yField 传 [low, high] 即区间面积图。
  const bandConfig = {
    data: bandData,
    xField: 'time',
    yField: ['min', 'max'],
    height: 300,
    animate: false,
    theme: g2Theme,
    paddingLeft: PAD_L,
    paddingRight: PAD_R,
    style: { fill: token.colorPrimaryBg, fillOpacity: 1 },
    scale: { y: { domainMax: yMax, nice: true } },
    axis: {
      x: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, labelFill: token.colorTextTertiary, line: false, tick: false },
      y: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, labelFill: token.colorTextTertiary, gridLineDash: [3, 4], gridStroke: token.colorBorderSecondary, title: false },
    },
    tooltip: false,
  } as any;

  // ---- 主图：avg 主线（顶层，绝对定位叠加，无轴，负责 tooltip）----
  const lineConfig = {
    data: avgData,
    xField: 'time',
    yField: 'avg',
    height: 300,
    animate: false,
    theme: g2Theme,
    paddingLeft: PAD_L,
    paddingRight: PAD_R,
    style: { stroke: token.colorPrimary, lineWidth: 2.4 },
    scale: { y: { domainMax: yMax, nice: true } },
    axis: false,
    tooltip: {
      title: 'time',
      items: [{ channel: 'y', name: t('trend.avg'), valueFormatter: (v: number) => `${v.toFixed(1)} ms` }],
    },
  } as any;

  // ---- 丢包率条形图（与主图同 padding 对齐）----
  const lossConfig = {
    data: lossData,
    xField: 'time',
    yField: 'loss',
    height: 88,
    animate: false,
    theme: g2Theme,
    paddingLeft: PAD_L,
    paddingRight: PAD_R,
    style: { fill: token.colorError, radiusTopLeft: 1.5, radiusTopRight: 1.5 },
    axis: {
      x: false,
      y: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, labelFill: token.colorTextTertiary, title: false, tickCount: 2 },
    },
    tooltip: {
      title: 'time',
      items: [{ channel: 'y', name: t('trend.loss'), valueFormatter: (v: number) => `${v.toFixed(2)}%` }],
    },
  } as any;

  const s = data?.summary;
  const lossColor =
    s == null ? token.colorText
    : s.loss_pct < 0.5 ? token.colorSuccess
    : s.loss_pct < 2 ? token.colorWarning
    : token.colorError;

  // 顶部统计条（6 格，等宽网格 + 分隔线）
  const stats: { label: string; value: string; color?: string }[] = [
    { label: t('trend.avg'), value: fmtMs(s?.avg_ms), color: token.colorPrimary },
    { label: t('trend.min'), value: fmtMs(s?.min_ms) },
    { label: t('trend.max'), value: fmtMs(s?.max_ms) },
    { label: t('trend.loss'), value: s ? `${s.loss_pct.toFixed(2)}%` : '—', color: lossColor },
    { label: t('trend.probes'), value: s?.runs != null ? s.runs.toLocaleString('en-US') : '—' },
    {
      label: t('trend.granularity'),
      value: data ? `${fmtBucket(data.source_bucket_seconds)} · ${data.source === 'raw' ? t('trend.sourceRaw') : t('trend.sourceRollup')}` : '—',
      color: token.colorTextSecondary,
    },
  ];

  return (
    <Modal
      title={
        <div>
          <Space size={10}>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-.01em' }}>{t('trend.title')}</span>
            <span style={{
              padding: '3px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
              color: token.colorPrimary, background: token.colorPrimaryBg,
            }}>
              {probeType.toUpperCase()}
            </span>
          </Space>
          <div style={{
            fontSize: 12.5, fontWeight: 400, color: token.colorTextSecondary,
            fontFamily: FONT_MONO, marginTop: 5,
          }}>
            {label}
          </div>
        </div>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={940}
      destroyOnClose
    >
      {/* 控制行：时间预设 + 自定义范围 + 导出 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
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
        <div style={{ flex: 1 }} />
        <Button
          icon={<DownloadOutlined />}
          disabled={!data || data.points.length === 0}
          onClick={exportCsv}
        >
          {t('common.export')}
        </Button>
      </div>

      {/* 统计条 */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', marginTop: 18,
        background: token.colorFillQuaternary, border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadius, padding: '13px 0',
      }}>
        {stats.map((st, i) => (
          <div key={st.label} style={{ padding: '0 18px', minWidth: 0, borderLeft: i ? `1px solid ${token.colorBorder}` : 'none' }}>
            <div style={{ fontSize: 11, color: token.colorTextTertiary, fontWeight: 600, marginBottom: 4, whiteSpace: 'nowrap' }}>
              {st.label}
            </div>
            <div style={{
              fontSize: 15.5, fontWeight: 700, fontFamily: FONT_MONO, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', color: st.color ?? token.colorText,
            }}>
              {st.value}
            </div>
          </div>
        ))}
      </div>

      {errMsg && <Alert type="error" showIcon message={errMsg} style={{ marginTop: 14 }} />}

      <Spin spinning={loading}>
        {data && data.points.length === 0 && !loading ? (
          <Alert type="info" showIcon message={t('trend.noData')} style={{ marginTop: 14 }} />
        ) : (
          <>
            {/* 图例 */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 18, alignItems: 'center', padding: '14px 0 8px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 14, height: 2.5, borderRadius: 2, background: token.colorPrimary }} />
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{t('trend.avg')}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 14, height: 9, borderRadius: 2.5, background: token.colorPrimaryBg, border: `1px solid ${token.colorPrimaryBorder}` }} />
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{t('trend.min')}–{t('trend.max')}</span>
              </span>
            </div>

            {/* 主图：区间带打底，avg 线绝对定位叠加（padding 一致故坐标对齐） */}
            <div style={{ position: 'relative', height: 300 }}>
              <Area {...bandConfig} />
              <div style={{ position: 'absolute', inset: 0 }}>
                <Line {...lineConfig} />
              </div>
            </div>

            {/* 丢包率 */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              margin: `14px ${PAD_R}px 4px ${PAD_L}px`,
            }}>
              <span style={{ fontSize: 12, color: token.colorTextSecondary, fontWeight: 600 }}>{t('trend.loss')}</span>
              <span style={{ fontSize: 11, color: token.colorTextTertiary, fontFamily: FONT_MONO }}>
                max {lossData.length ? Math.max(...lossData.map((d) => d.loss)).toFixed(1) : '0.0'}%
              </span>
            </div>
            <Column {...lossConfig} />
          </>
        )}
      </Spin>
    </Modal>
  );
};

export default LatencyTrendModal;
