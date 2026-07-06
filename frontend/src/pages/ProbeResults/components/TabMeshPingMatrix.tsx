import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Input, Modal, Select, Space, Spin, Table, theme, Tooltip, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getMeshPingMatrix, getAgentGroups, getLatestProbeResults, getLatencySeries, lookupASN } from '../../../api/agent';
import type { MeshPingMatrixResp, MeshPingCell, MeshPingProto, AgentGroup, MtrHop, LatencySeriesPoint } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';
import { FONT_MONO } from '../../../theme/theme';

// 延迟趋势弹窗内含 @ant-design/charts（G2，体积大）——懒加载，首次打开才拉取 chunk
const LatencyTrendModal = React.lazy(() => import('./LatencyTrendModal'));

type AgentRow = MeshPingMatrixResp['agents'][number];

interface TrendTarget { agentId: string; target: string; label: string }

// ── 单元格悬停迷你趋势 ────────────────────────────────────────────────────────
// 悬停延迟 chip 时在 Tooltip 里展示近 24 小时 avg 延迟 sparkline（手绘 SVG，
// 不引入图表库）。Tooltip 首次展开才挂载本组件 → 才发请求；模块级缓存 60 秒，
// 同一序列反复悬停不重复请求。
const sparkCache = new Map<string, { at: number; pts: LatencySeriesPoint[] }>();

const CellSpark: React.FC<{ agentId: string; target: string; reportedAt: string }> = ({
  agentId, target, reportedAt,
}) => {
  const t = useT();
  const [pts, setPts] = useState<LatencySeriesPoint[] | null>(null);

  useEffect(() => {
    const key = `${agentId}|${target}`;
    const hit = sparkCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) { setPts(hit.pts); return; }
    let alive = true;
    getLatencySeries({
      agent_id: agentId, target, type: 'meshping',
      start: new Date(Date.now() - 24 * 3600_000).toISOString(),
      end: new Date().toISOString(),
    }).then((r) => {
      if (!alive) return;
      sparkCache.set(key, { at: Date.now(), pts: r.data.points });
      setPts(r.data.points);
    }).catch(() => { if (alive) setPts([]); });
    return () => { alive = false; };
  }, [agentId, target]);

  const ok = (pts ?? []).filter((p) => p.avg_ms != null);
  let body: React.ReactNode;
  if (pts === null) {
    body = <Spin size="small" />;
  } else if (ok.length >= 2) {
    const vals = ok.map((p) => p.avg_ms as number);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const W = 180;
    const H = 32;
    const coords = ok.map((p, i) =>
      `${((i / (ok.length - 1)) * W).toFixed(1)},${(H - 2 - (((p.avg_ms as number) - min) / span) * (H - 4)).toFixed(1)}`,
    ).join(' ');
    body = (
      <>
        <svg width={W} height={H} style={{ display: 'block' }}>
          <polyline points={coords} fill="none" stroke="#69b1ff" strokeWidth={1.5} />
        </svg>
        <div style={{ fontSize: 10, opacity: 0.65 }}>
          24h · min {min.toFixed(1)} / max {max.toFixed(1)} ms
        </div>
      </>
    );
  } else {
    body = <span style={{ fontSize: 11, opacity: 0.65 }}>{t('trend.noData')}</span>;
  }

  return (
    <div style={{ padding: '2px 0' }}>
      <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 4 }}>{new Date(reportedAt).toLocaleString()}</div>
      {body}
    </div>
  );
};

interface ActiveCell { rowId: string; colId: string }

interface MtrModalState {
  open: boolean;
  title: string;
  hops: MtrHop[] | null; // null = 加载中
}

// Cross-hair highlight tints track the theme (primary @ low alpha).
const HL_ROW_COL = 'var(--ant-color-primary-bg)';
const HL_CROSS   = 'var(--ant-color-primary-bg-hover)';

const TEAL = '#0d9488';
const TEAL_BG = 'rgba(13,148,136,.12)';

const TabMeshPingMatrix: React.FC = () => {
  const t = useT();
  const { token } = theme.useToken();

  // Latency → heatmap tone. ≤60 success · ≤120 teal · ≤180 warning · >180/fail danger.
  const toneFor = (ms: number, success: boolean) => {
    if (!success)  return { fg: token.colorError,   bg: token.colorErrorBg };
    if (ms <= 60)  return { fg: token.colorSuccess, bg: token.colorSuccessBg };
    if (ms <= 120) return { fg: TEAL,               bg: TEAL_BG };
    if (ms <= 180) return { fg: token.colorWarning, bg: token.colorWarningBg };
    return { fg: token.colorError, bg: token.colorErrorBg };
  };

  // Cell-level background = worst case across the v4/v6 protocols present.
  const cellHeatBg = (cell: MeshPingCell | undefined): string | undefined => {
    const protos = [cell?.v4, cell?.v6].filter(Boolean) as MeshPingProto[];
    if (!protos.length) return undefined;
    if (protos.some(p => !p.success)) return toneFor(0, false).bg;
    const maxMs = Math.max(...protos.map(p => p.latency_ms ?? 0));
    return toneFor(maxMs, true).bg;
  };
  const [matrixData, setMatrixData] = useState<MeshPingMatrixResp>({ agents: [], matrix: {} });
  const [groups, setGroups]           = useState<AgentGroup[]>([]);
  const [groupId, setGroupId]         = useState<number | undefined>(undefined);
  const [loading, setLoading]         = useState(false);
  const [search, setSearch]           = useState('');
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [activeCell, setActiveCell]   = useState<ActiveCell | null>(null);

  const [mtrModal, setMtrModal] = useState<MtrModalState>({ open: false, title: '', hops: null });
  const [trend, setTrend] = useState<TrendTarget | null>(null);
  const [asnMap, setAsnMap]         = useState<Record<string, { asn: number; name: string } | null>>({});
  const [asnLoading, setAsnLoading] = useState(false);

  const debSearch = useDebounced(search);
  const reqSeq = useRef(0);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await getMeshPingMatrix({ q: debSearch || undefined, group_id: groupId });
      if (seq !== reqSeq.current) return;
      setMatrixData(r.data);
      setActiveCell(null);
    } catch (err: any) {
      if (seq === reqSeq.current) message.error(apiErrMsg(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [debSearch, groupId]);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { getAgentGroups().then(r => setGroups(r.data)).catch(() => {}); }, []);

  const { agents, matrix } = matrixData;

  const colAgents = selectedTargets.length > 0
    ? agents.filter(a => selectedTargets.includes(a.agent_id))
    : agents;

  const handleCellClick = (rowId: string, colId: string) => {
    setActiveCell(prev =>
      prev?.rowId === rowId && prev?.colId === colId ? null : { rowId, colId }
    );
  };

  const cellBg = (rowId: string, colId: string): string | undefined => {
    if (!activeCell) return undefined;
    const isActiveRow = activeCell.rowId === rowId;
    const isActiveCol = activeCell.colId === colId;
    if (isActiveRow && isActiveCol) return HL_CROSS;
    if (isActiveRow || isActiveCol) return HL_ROW_COL;
    return undefined;
  };

  // 打开两点之间的 MTR modal，先显示 loading，再异步拉取 MTR 数据 + ASN
  const handleOpenMtr = useCallback(async (
    srcAgentId: string,
    targetIp: string,
    proto: string,
    srcName: string,
    dstName: string,
  ) => {
    setMtrModal({ open: true, title: `MTR: ${srcName} → ${dstName} (${proto.toUpperCase()})`, hops: null });
    setAsnMap({});

    try {
      const r = await getLatestProbeResults({
        page: 1, page_size: 1, type: 'meshmtr',
        agent_id: srcAgentId, target: targetIp,
      });
      const detail = r.data.items[0]?.detail;
      if (!detail) {
        setMtrModal(prev => ({ ...prev, hops: [] }));
        return;
      }
      const hops: MtrHop[] = JSON.parse(detail);
      setMtrModal(prev => ({ ...prev, hops }));

      const ips = [...new Set(hops.map(h => h.host).filter(h => h && h !== '???'))];
      if (ips.length === 0) return;
      setAsnLoading(true);
      try {
        const asnR = await lookupASN(ips);
        setAsnMap(asnR.data);
      } catch { /* ASN 查询失败不阻断 MTR 基本显示 */ } finally {
        setAsnLoading(false);
      }
    } catch {
      setMtrModal(prev => ({ ...prev, hops: [] }));
    }
  }, []);

  const closeMtrModal = () => {
    setMtrModal({ open: false, title: '', hops: null });
    setAsnMap({});
  };

  // 渲染单个协议数值（mono + 按时延着色），有 target_ip 时包裹 Dropdown 提供 MTR 跳转入口
  const renderProto = (
    p: MeshPingProto,
    label: string | undefined,
    onMtr?: () => void,
    onTrend?: () => void,
    sparkTip?: React.ReactNode,
  ) => {
    const tone = toneFor(p.latency_ms ?? 0, p.success);
    const clickable = !!(onMtr || onTrend);
    const inner = (
      <Tooltip title={sparkTip ?? new Date(p.reported_at).toLocaleString()}>
        <span
          style={{
            fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 600, color: tone.fg,
            cursor: clickable ? 'pointer' : 'default', userSelect: 'none',
            textDecoration: clickable ? 'underline dotted' : undefined, textUnderlineOffset: 3,
          }}
        >
          {label && <span style={{ opacity: 0.6, marginRight: 4 }}>{label}</span>}
          {p.success ? (p.latency_ms?.toFixed(0) ?? '?') : t('proberesults.failed')}
        </span>
      </Tooltip>
    );
    if (!clickable) return inner;
    return (
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            ...(onMtr ? [{ key: 'mtr', label: 'MTR' }] : []),
            ...(onTrend ? [{ key: 'trend', label: t('trend.action') }] : []),
          ],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'mtr') onMtr?.();
            if (key === 'trend') onTrend?.();
          },
        }}
      >
        {/* stopPropagation 防止触发外层格子的 activeCell 高亮切换 */}
        <span onClick={e => e.stopPropagation()}>{inner}</span>
      </Dropdown>
    );
  };

  const columns: ColumnsType<AgentRow> = [
    {
      title: t('agent.list.hostname'), dataIndex: 'hostname', key: '__row_header',
      width: 150,
      render: (v: string, r: AgentRow) => (
        <Tooltip title={r.agent_id}>
          <b style={{ fontFamily: FONT_MONO, fontSize: 12.5 }}>{v || r.agent_id}</b>
        </Tooltip>
      ),
      onCell: (row: AgentRow) => ({
        style: { background: activeCell?.rowId === row.agent_id ? HL_ROW_COL : undefined },
      }),
    },
    ...colAgents.map(col => ({
      title: (
        <span style={{ background: activeCell?.colId === col.agent_id ? HL_ROW_COL : undefined, borderRadius: 4, padding: '0 4px', fontFamily: FONT_MONO, fontSize: 12 }}>
          <Tooltip title={col.agent_id}>{col.hostname || col.agent_id}</Tooltip>
        </span>
      ),
      key: col.agent_id,
      align: 'center' as const,
      onCell: (row: AgentRow) => {
        const highlight = cellBg(row.agent_id, col.agent_id);
        const heat = row.agent_id === col.agent_id ? undefined : cellHeatBg(matrix[row.agent_id]?.[col.agent_id]);
        return {
          style: { background: highlight ?? heat, cursor: 'pointer' },
          onClick: () => handleCellClick(row.agent_id, col.agent_id),
        };
      },
      render: (_: unknown, row: AgentRow) => {
        if (row.agent_id === col.agent_id) return <span style={{ color: 'var(--ant-color-text-quaternary)' }}>—</span>;
        const cell = matrix[row.agent_id]?.[col.agent_id];
        if (!cell?.v4 && !cell?.v6) return <span style={{ color: 'var(--ant-color-text-quaternary)', fontSize: 12 }}>{t('proberesults.noData')}</span>;
        const hasBoth = !!(cell.v4 && cell.v6);
        const srcName = row.hostname || row.agent_id;
        const dstName = col.hostname || col.agent_id;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            {cell.v4 && renderProto(
              cell.v4,
              hasBoth ? 'v4' : undefined,
              cell.v4.target_ip
                ? () => { void handleOpenMtr(row.agent_id, cell.v4!.target_ip!, 'v4', srcName, dstName); }
                : undefined,
              cell.v4.target_ip
                ? () => setTrend({ agentId: row.agent_id, target: cell.v4!.target_ip!, label: `${srcName} → ${dstName} (V4)` })
                : undefined,
              cell.v4.target_ip
                ? <CellSpark agentId={row.agent_id} target={cell.v4.target_ip} reportedAt={cell.v4.reported_at} />
                : undefined,
            )}
            {cell.v6 && renderProto(
              cell.v6,
              hasBoth ? 'v6' : undefined,
              cell.v6.target_ip
                ? () => { void handleOpenMtr(row.agent_id, cell.v6!.target_ip!, 'v6', srcName, dstName); }
                : undefined,
              cell.v6.target_ip
                ? () => setTrend({ agentId: row.agent_id, target: cell.v6!.target_ip!, label: `${srcName} → ${dstName} (V6)` })
                : undefined,
              cell.v6.target_ip
                ? <CellSpark agentId={row.agent_id} target={cell.v6.target_ip} reportedAt={cell.v6.reported_at} />
                : undefined,
            )}
          </div>
        );
      },
    })),
  ];

  // MTR hop 列定义（与 TabGenericResults modal 保持一致）
  const mtrColumns = [
    { title: t('mtr.hop'), dataIndex: 'ttl', key: 'ttl', width: 55 },
    { title: t('mtr.host'), dataIndex: 'host', key: 'host' },
    {
      title: t('mtr.asn'),
      key: 'asn',
      width: 230,
      render: (_: unknown, r: MtrHop) => {
        if (r.host === '???') return <span style={{ color: '#aaa' }}>—</span>;
        if (asnLoading) return <Spin size="small" />;
        const info = asnMap[r.host];
        if (!info) return <span style={{ color: '#aaa' }}>—</span>;
        return (
          <span style={{ fontSize: 12 }}>
            <span style={{ color: '#888', marginRight: 6 }}>AS{info.asn}</span>
            {info.name}
          </span>
        );
      },
    },
    {
      title: t('mtr.loss'), dataIndex: 'loss_rate', key: 'loss_rate', width: 70, align: 'right' as const,
      render: (v: number) => <span style={{ color: v > 0 ? '#ff4d4f' : undefined }}>{v}%</span>,
    },
    {
      title: t('mtr.avg'), dataIndex: 'avg_rtt_ms', key: 'avg_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number, r: MtrHop) => r.loss_rate >= 100 ? '—' : `${v.toFixed(1)} ms`,
    },
    {
      title: t('mtr.best'), dataIndex: 'best_rtt_ms', key: 'best_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number, r: MtrHop) => r.loss_rate >= 100 ? '—' : `${v.toFixed(1)} ms`,
    },
    {
      title: t('mtr.worst'), dataIndex: 'worst_rtt_ms', key: 'worst_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number, r: MtrHop) => r.loss_rate >= 100 ? '—' : `${v.toFixed(1)} ms`,
    },
    {
      title: t('mtr.stddev'), dataIndex: 'stddev_rtt_ms', key: 'stddev_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number | undefined, r: MtrHop) =>
        r.loss_rate >= 100 || v == null ? '—' : `${v.toFixed(1)} ms`,
    },
  ];

  const legend: { label: string; fg: string; bg: string }[] = [
    { label: '< 60ms',       fg: token.colorSuccess, bg: token.colorSuccessBg },
    { label: '< 120ms',      fg: TEAL,               bg: TEAL_BG },
    { label: '< 180ms',      fg: token.colorWarning, bg: token.colorWarningBg },
    { label: '≥ 180 / fail', fg: token.colorError,   bg: token.colorErrorBg },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <Space wrap>
          <Select
            allowClear placeholder={t('agent.list.group')} style={{ width: 160 }}
            value={groupId} onChange={setGroupId}
            options={groups.map(g => ({ value: g.id, label: g.name }))}
          />
          <Input
            prefix={<SearchOutlined />}
            placeholder={t('proberesults.search')}
            value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 260 }}
          />
          <Select
            mode="multiple"
            allowClear
            placeholder={t('proberesults.filterTargets')}
            style={{ minWidth: 220 }}
            value={selectedTargets}
            onChange={setSelectedTargets}
            maxTagCount="responsive"
            options={agents.map(a => ({ value: a.agent_id, label: a.hostname || a.agent_id }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => { void loadData(); }} loading={loading}>{t('common.refresh')}</Button>
        </Space>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          {legend.map(l => (
            <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
              <span style={{ width: 11, height: 11, borderRadius: 3, background: l.bg, border: `1px solid ${l.fg}` }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
      <Table
        columns={columns}
        dataSource={agents}
        rowKey="agent_id"
        loading={loading}
        pagination={false}
        sticky
        bordered
      />

      {/* MTR 详情 Modal */}
      <Modal
        title={mtrModal.title}
        open={mtrModal.open}
        onCancel={closeMtrModal}
        footer={null}
        width={900}
        destroyOnClose
      >
        {mtrModal.hops === null ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}><Spin /></div>
        ) : mtrModal.hops.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#aaa' }}>{t('proberesults.noData')}</div>
        ) : (
          <Table
            size="small"
            dataSource={mtrModal.hops}
            rowKey="ttl"
            pagination={false}
            columns={mtrColumns}
          />
        )}
      </Modal>

      {/* 延迟趋势 Modal（懒加载：首次打开才拉取图表 chunk） */}
      {trend && (
        <Suspense fallback={null}>
          <LatencyTrendModal
            open
            onClose={() => setTrend(null)}
            agentId={trend.agentId}
            target={trend.target}
            probeType="meshping"
            label={trend.label}
          />
        </Suspense>
      )}
    </div>
  );
};

export default TabMeshPingMatrix;
