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
 * ★ 重要：本组件曾通过 React.lazy 懒加载（首次打开弹窗才拉取 @ant-design/charts
 * chunk），但和 App.tsx 里 Dashboard 路由自身的 React.lazy、以及设备页 OID 趋势图
 * （现位于 Devices/components/DeviceMetricTrendModal.tsx）的 React.lazy 三处懒加载
 * 边界都共享同一个重量级依赖（@ant-design/charts/@antv/g2），Rollup 默认的自动分包
 * 会把这份共享依赖拆到一个由多个懒加载入口共同引用的 chunk 里，实测触发 "Cannot
 * read properties of undefined (reading 'forwardRef')" 的 chunk 加载顺序崩溃（整个
 * 页面白屏）——这不是某一次具体改动引入的逻辑 bug，是三处独立懒加载边界互相打架
 * 导致的构建层问题。现已改回本文件的静态 import（TabGenericResults /
 * TabMeshPingMatrix 直接 `import LatencyTrendModal from './LatencyTrendModal'`，
 * 不再 lazy），OID 趋势图（DeviceMetricTrendModal）同样保持静态 import，减少懒加载
 * 边界数量、避免复现这个 chunk 顺序问题。DOM 层配色一律走 `var(--ant-color-*)` CSS
 * 变量，图表内部 style（Canvas 渲染，CSS 变量在此不生效）用固定十六进制色值。
 *
 * 本文件 import 了 @ant-design/charts（G2，体积大）——不再懒加载，作为
 * ProbeResults 主 bundle 的一部分随页面一起加载。
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

// 主图与丢包图共用的左右内边距。两张图的 y 轴标签宽度天然不同（延迟是 2–4 位
// 数的 ms，丢包固定是 0/50/100），若都交给 G2 auto 计算，两个绘图区的左右边缘
// 会差出几个像素——即使 x 轴 domain 完全一致，同一个桶在上下两图里的像素位置
// 仍然对不齐。显式钉死同一组 padding 消除这个固定偏移（G2 会把这块空间留给轴
// 组件，不会裁剪标签）；两图必须同时设置，只设一边另一边仍是 auto。
const PAD_L = 48;
const PAD_R = 16;

// 图表内部（Canvas 渲染）用的固定色值——G2 把颜色直接交给 Canvas 的
// fillStyle/strokeStyle，`var(--ant-color-*)` 这类 CSS 变量在这里不会被解析，
// 必须给字面色值。DOM 层（标题/统计条/图例文字）仍一律用 CSS 变量。
// 蓝色与 MainLayout 品牌色一致（#2563eb），丢包红与本功能重设计前的旧实现一致。
const CHART_COLORS = {
  light: { primary: '#2563eb', muted: '#cbd5e1', loss: '#dc2626' },
  dark:  { primary: '#3b82f6', muted: '#475569', loss: '#f87171' },
};

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
  const c = resolvedTheme === 'dark' ? CHART_COLORS.dark : CHART_COLORS.light;

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
  //
  // ★ 全部失败的桶（avg/min/max 皆为 null）必须保留整行、值填 null，不能整行跳过：
  // G2 的 line mark 底层用 d3-shape 的 .defined() 判定，null/undefined/NaN 会让它
  // 另起一段子路径 → 渲染成断线，正确表达"这段时间没有数据"；而整行跳过时 G2 只
  // 看得到缺口前后两个有效点，会直接连成一条横跨故障区的假直线（看起来像那段时间
  // 延迟稳定）。断线是默认行为（对应 style.connect 默认 false），无需额外配置——
  // 注意 G2 v5 并没有 connectNulls 这个配置键，不要去设它。多序列下按 series 分组
  // 各自断开，Min/Max/Avg 三条线互不影响。
  const chartData = useMemo(() => {
    if (!data) return [];
    const round2 = (n: number | null) => (n == null ? null : Number(n.toFixed(2)));
    const rows: { time: string; ms: number | null; metric: string }[] = [];
    for (const p of data.points) {
      const time = dayjs(p.ts * 1000).format(timeFmt);
      rows.push({ time, ms: round2(p.min_ms), metric: MIN_LABEL });
      rows.push({ time, ms: round2(p.max_ms), metric: MAX_LABEL });
      rows.push({ time, ms: round2(p.avg_ms), metric: AVG_LABEL });
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

  // 全部桶的时间标签——主图与丢包图显式共用这一份分类轴 domain。
  // 曾经的 bug：延迟序列跳过"全部失败"的桶、丢包序列逐桶都有，两张独立图表各自
  // 按自身数据推断分类轴 → 分类数不同 → 同一 x 像素对应不同时刻，表现为"100%
  // 丢包处上方却仍有延迟曲线"（实为延迟线末端被拉伸到了最右侧）。现在 chartData
  // 保留了 null 行、两边分类数天然一致，这里仍显式钉死 domain 作为不变量保险：
  // 日后若有人改回过滤式构造，对齐关系不会再次悄悄失效。
  const xDomain = useMemo(() => {
    if (!data) return [];
    return data.points.map((p) => dayjs(p.ts * 1000).format(timeFmt));
  }, [data, timeFmt]);

  // x 轴标签抽样：按桶数量等间隔挑选 ≤MAX_X_LABELS 个标签展示，其余位置的
  // 刻度仍然存在（保持每个点的横坐标准确），只是 label 留空——用固定的
  // labelFormatter 抽样代替 G2 的自动防重叠（该功能在 point/band 分类轴上
  // 不生效，且已知版本存在 labelAutoRotate/Ellipsis 相关 bug，故不依赖它）。
  const xKeepLabels = useMemo(() => {
    const keep = new Set<string>();
    if (xDomain.length === 0) return keep;
    const step = Math.max(1, Math.ceil(xDomain.length / MAX_X_LABELS));
    for (let i = 0; i < xDomain.length; i += step) keep.add(xDomain[i]);
    keep.add(xDomain[xDomain.length - 1]);
    return keep;
  }, [xDomain]);

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
    // 关掉 G2 内置图例：colorField 会让它自动渲染一份，与弹窗右上角那份手写的
    // 设计稿图例重复（页面上会出现两组 Avg / Min / Max）。
    legend: false,
    paddingLeft: PAD_L,
    paddingRight: PAD_R,
    scale: {
      // x domain 与丢包图共用，保证两图逐桶对齐（见 xDomain 注释）
      x: { domain: xDomain },
      color: {
        domain: [MIN_LABEL, MAX_LABEL, AVG_LABEL],
        range: [c.muted, c.muted, c.primary],
      },
      y: { nice: true },
    },
    axis: {
      x: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, labelFormatter: xLabelFormatter },
      y: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, gridLineDash: [3, 4], title: false },
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
    paddingLeft: PAD_L,
    paddingRight: PAD_R,
    // 与主图共用同一份 x domain，保证两图逐桶对齐（见 xDomain 注释）
    scale: { x: { domain: xDomain } },
    style: { fill: c.loss, radiusTopLeft: 1.5, radiusTopRight: 1.5 },
    axis: {
      x: false,
      y: { labelFontFamily: FONT_MONO, labelFontSize: 10.5, title: false, tickCount: 2 },
    },
    tooltip: {
      title: 'time',
      items: [{ channel: 'y', name: t('trend.loss'), valueFormatter: (v: number) => `${v.toFixed(2)}%` }],
    },
  } as any;

  const s = data?.summary;
  const lossColor =
    s == null ? 'var(--ant-color-text)'
    : s.loss_pct < 0.5 ? 'var(--ant-color-success)'
    : s.loss_pct < 2 ? 'var(--ant-color-warning)'
    : 'var(--ant-color-error)';

  // 顶部统计条（6 格，等宽网格 + 分隔线）
  const stats: { label: string; value: string; color?: string }[] = [
    { label: t('trend.avg'), value: fmtMs(s?.avg_ms), color: 'var(--ant-color-primary)' },
    { label: t('trend.min'), value: fmtMs(s?.min_ms) },
    { label: t('trend.max'), value: fmtMs(s?.max_ms) },
    { label: t('trend.loss'), value: s ? `${s.loss_pct.toFixed(2)}%` : '—', color: lossColor },
    { label: t('trend.probes'), value: s?.runs != null ? s.runs.toLocaleString('en-US') : '—' },
    {
      label: t('trend.granularity'),
      value: data ? `${fmtBucket(data.source_bucket_seconds)} · ${data.source === 'raw' ? t('trend.sourceRaw') : t('trend.sourceRollup')}` : '—',
      color: 'var(--ant-color-text-secondary)',
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
              color: 'var(--ant-color-primary)', background: 'var(--ant-color-primary-bg)',
            }}>
              {probeType.toUpperCase()}
            </span>
          </Space>
          <div style={{
            fontSize: 12.5, fontWeight: 400, color: 'var(--ant-color-text-secondary)',
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
        background: 'var(--ant-color-fill-quaternary)', border: '1px solid var(--ant-color-border)',
        borderRadius: 8, padding: '13px 0',
      }}>
        {stats.map((st, i) => (
          <div key={st.label} style={{ padding: '0 18px', minWidth: 0, borderLeft: i ? '1px solid var(--ant-color-border)' : 'none' }}>
            <div style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', fontWeight: 600, marginBottom: 4, whiteSpace: 'nowrap' }}>
              {st.label}
            </div>
            <div style={{
              fontSize: 15.5, fontWeight: 700, fontFamily: FONT_MONO, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', color: st.color ?? 'var(--ant-color-text)',
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
            {/* 图例（右缘与绘图区右缘对齐，故用与图表相同的 PAD_R） */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 18, alignItems: 'center', padding: `14px ${PAD_R}px 8px 0` }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 14, height: 2.5, borderRadius: 2, background: c.primary }} />
                <span style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{t('trend.avg')}</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 14, height: 2, borderRadius: 2, background: c.muted }} />
                <span style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>{t('trend.min')} / {t('trend.max')}</span>
              </span>
            </div>

            <Line {...chartConfig} />

            {/* 丢包率 */}
            {/* 标题行左右缘与两张图的绘图区对齐（同一组 PAD_L / PAD_R） */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              margin: `14px ${PAD_R}px 4px ${PAD_L}px`,
            }}>
              <span style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)', fontWeight: 600 }}>{t('trend.packetLoss')}</span>
              <span style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', fontFamily: FONT_MONO }}>
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
