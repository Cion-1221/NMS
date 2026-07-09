/**
 * LatencyTrendModal — 单条探测序列（源 Agent → 目标）的历史延迟趋势图。
 * ★ Direction A "Clarity" 重设计版：标题胶囊 + 统计条 + 三线趋势图 + 丢包子图。
 *
 * 数据来自 GET /probe-results/latency-series：服务端按所选时间范围自动在
 * 原始点/归档层之间选源（Cacti/RRD 语义），并聚合到 ≤500 个显示点。
 *
 * 主图曾尝试"Area(min-max 区间带) + Line(avg) 两个独立图表实例绝对定位叠加"的
 * 视觉方案，上线后实测两个独立图表实例各自的坐标系无法保证像素对齐（AntV 官方
 * 也未文档化这种叠加用法），导致线条错位出现假性尖峰，且区间带填色对比度过低
 * 近乎不可见。现改回单一 Line 图表 + colorField 三序列（avg/min/max 共享同一
 * 坐标系，与本功能最早上线时的实现一致，已验证稳定），仅通过分类色阶做视觉区分
 * （avg 主色加粗，min/max 同色变淡），避免复现错位问题。
 *
 * 本文件 import 了 @ant-design/charts（G2，体积大）——调用方必须通过
 * React.lazy 引入本组件，首次打开弹窗才加载图表 chunk（与 Dashboard 同款策略）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, DatePicker, Modal, Segmented, Space, Spin, theme } from 'antd';
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

// x 轴最多展示的标签个数（G2 5 的 point/band 分类轴不支持 tickCount，需要
// 自行按数据密度抽样，否则几百个桶会把时间标签挤成一团无法辨认）
const MAX_X_LABELS = 10;

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

  const AVG_LABEL = t('trend.avg');
  const MIN_LABEL = t('trend.min');
  const MAX_LABEL = t('trend.max');

  // 主图数据：avg/min/max 三条同色阶序列，长表结构（一行一个 metric），
  // 共享同一张图表实例、同一套坐标系——避免"多图叠加对齐"的脆弱方案。
  const chartData = useMemo(() => {
    if (!data) return [];
    const rows: { time: string; ms: number; metric: string }[] = [];
    for (const p of data.points) {
      const time = dayjs(p.ts * 1000).format(timeFmt);
      if (p.min_ms != null) rows.push({ time, ms: Number(p.min_ms.toFixed(2)), metric: MIN_LABEL });
      if (p.max_ms != null) rows.push({ time, ms: Number(p.max_ms.toFixed(2)), metric: MAX_LABEL });
      if (p.avg_ms != null) rows.push({ time, ms: Number(p.avg_ms.toFixed(2)), metric: AVG_LABEL });
    }
    return rows;
  }, [data, timeFmt, AVG_LABEL, MIN_LABEL, MAX_LABEL]);

  // 丢包率序列（逐桶 failed/runs），与主图共用时间轴格式
  const lossData = useMemo(() => {
    if (!data) return [];
    return data.points.map((p) => ({
      time: dayjs(p.ts * 1000).format(timeFmt),
      loss: p.runs > 0 ? Number(((p.failed / p.runs) * 100).toFixed(2)) : 0,
    }));
  }, [data, timeFmt]);

  // x 轴标签抽样：按桶数量等间隔挑选 ≤MAX_X_LABELS 个标签展示，其余位置的
  // 刻度仍然存在（保持每个点的横坐标准确），只是 label 留空——用固定的
  // labelFormatter 抽样代替 G2 的自动防重叠（该功能在 point/band 分类轴上
  // 不生效，且已知版本存在 labelAutoRotate/Ellipsis 相关 bug，故不依赖它）。
  const xKeepLabels = useMemo(() => {
    const keep = new Set<string>();
    if (!data || data.points.length === 0) return keep;
    const labels = data.points.map((p) => dayjs(p.ts * 1000).format(timeFmt));
    const step = Math.max(1, Math.ceil(labels.length / MAX_X_LABELS));
    for (let i = 0; i < labels.length; i += step) keep.add(labels[i]);
    keep.add(labels[labels.length - 1]);
    return keep;
  }, [data, timeFmt]);

  const xLabelFormatter = useCallback((v: unknown) => {
    const s = typeof v === 'string' ? v : String(v);
    return xKeepLabels.has(s) ? s : '';
  }, [xKeepLabels]);

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

  // ---- 主图：avg/min/max 三序列，同一坐标系，仅用分类色阶区分主次 ----
  const chartConfig = {
    data: chartData,
    xField: 'time',
    yField: 'ms',
    colorField: 'metric',
    seriesField: 'metric',
    height: 300,
    animate: false,
    theme: g2Theme,
    scale: {
      color: {
        domain: [MIN_LABEL, MAX_LABEL, AVG_LABEL],
        range: [token.colorBorderSecondary, token.colorBorderSecondary, token.colorPrimary],
      },
      y: { nice: true },
    },
    axis: {
      x: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, labelFill: token.colorTextTertiary, labelFormatter: xLabelFormatter },
      y: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, labelFill: token.colorTextTertiary, gridLineDash: [3, 4], gridStroke: token.colorBorderSecondary, title: false },
    },
    // 不覆盖 tooltip：多序列（colorField）折线图的默认 tooltip 已按 metric 分组
    // 逐行展示，与本功能最早上线时的实现一致、已验证稳定，自定义 items 反而
    // 有破坏分组行为的风险。
  } as any;

  // ---- 丢包率条形图 ----
  const lossConfig = {
    data: lossData,
    xField: 'time',
    yField: 'loss',
    height: 88,
    animate: false,
    theme: g2Theme,
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
                <span style={{ width: 14, height: 2, borderRadius: 2, background: token.colorBorderSecondary }} />
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{t('trend.min')} / {t('trend.max')}</span>
              </span>
            </div>

            <Line {...chartConfig} />

            {/* 丢包率 */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              margin: '14px 0 4px',
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
