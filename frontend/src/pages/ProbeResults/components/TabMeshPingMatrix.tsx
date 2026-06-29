import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Input, Modal, Select, Space, Spin, Table, Tag, Tooltip, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getMeshPingMatrix, getAgentGroups, getLatestProbeResults, lookupASN } from '../../../api/agent';
import type { MeshPingMatrixResp, MeshPingProto, AgentGroup, MtrHop } from '../../../types/agent';
import { useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';

type AgentRow = MeshPingMatrixResp['agents'][number];

interface ActiveCell { rowId: string; colId: string }

interface MtrModalState {
  open: boolean;
  title: string;
  hops: MtrHop[] | null; // null = 加载中
}

const HL_ROW_COL = '#dbeeff';
const HL_CROSS   = '#bbd6f7';

const TabMeshPingMatrix: React.FC = () => {
  const t = useT();
  const [matrixData, setMatrixData] = useState<MeshPingMatrixResp>({ agents: [], matrix: {} });
  const [groups, setGroups]           = useState<AgentGroup[]>([]);
  const [groupId, setGroupId]         = useState<number | undefined>(undefined);
  const [loading, setLoading]         = useState(false);
  const [search, setSearch]           = useState('');
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [activeCell, setActiveCell]   = useState<ActiveCell | null>(null);

  const [mtrModal, setMtrModal] = useState<MtrModalState>({ open: false, title: '', hops: null });
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
      if (seq === reqSeq.current) message.error(err?.response?.data?.error ?? 'Failed to load matrix');
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

  // 渲染单个协议标签，有 target_ip 时包裹 Dropdown 提供 MTR 跳转入口
  const renderProto = (
    p: MeshPingProto,
    label: string | undefined,
    onMtr?: () => void,
  ) => {
    const inner = (
      <Tooltip title={new Date(p.reported_at).toLocaleString()}>
        <Tag
          color={p.success ? 'green' : 'red'}
          style={{ cursor: onMtr ? 'pointer' : 'default', userSelect: 'none' }}
        >
          {label && <span style={{ opacity: 0.7, marginRight: 3 }}>{label}</span>}
          {p.success ? `${p.latency_ms?.toFixed(1) ?? '?'} ms` : t('proberesults.failed')}
        </Tag>
      </Tooltip>
    );
    if (!onMtr) return inner;
    return (
      <Dropdown
        trigger={['click']}
        menu={{
          items: [{ key: 'mtr', label: 'MTR' }],
          onClick: ({ key, domEvent }) => {
            domEvent.stopPropagation();
            if (key === 'mtr') onMtr();
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
      fixed: 'left' as const, width: 160,
      render: (v: string, r: AgentRow) => <Tooltip title={r.agent_id}><b>{v || r.agent_id}</b></Tooltip>,
      onCell: (row: AgentRow) => ({
        style: { background: activeCell?.rowId === row.agent_id ? HL_ROW_COL : undefined },
      }),
    },
    ...colAgents.map(col => ({
      title: (
        <span style={{ background: activeCell?.colId === col.agent_id ? HL_ROW_COL : undefined, borderRadius: 4, padding: '0 4px' }}>
          <Tooltip title={col.agent_id}>{col.hostname || col.agent_id}</Tooltip>
        </span>
      ),
      key: col.agent_id,
      width: 145,
      align: 'center' as const,
      onCell: (row: AgentRow) => ({
        style: { background: cellBg(row.agent_id, col.agent_id), cursor: 'pointer' },
        onClick: () => handleCellClick(row.agent_id, col.agent_id),
      }),
      render: (_: unknown, row: AgentRow) => {
        if (row.agent_id === col.agent_id) return <span style={{ color: '#ccc' }}>—</span>;
        const cell = matrix[row.agent_id]?.[col.agent_id];
        if (!cell?.v4 && !cell?.v6) return <span style={{ color: '#ccc' }}>{t('proberesults.noData')}</span>;
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
            )}
            {cell.v6 && renderProto(
              cell.v6,
              hasBoth ? 'v6' : undefined,
              cell.v6.target_ip
                ? () => { void handleOpenMtr(row.agent_id, cell.v6!.target_ip!, 'v6', srcName, dstName); }
                : undefined,
            )}
          </div>
        );
      },
    })),
  ];

  // MTR hop 列定义（与 TabGenericResults modal 保持一致）
  const mtrColumns = [
    { title: 'Hop', dataIndex: 'ttl', key: 'ttl', width: 55 },
    { title: 'Host', dataIndex: 'host', key: 'host' },
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
      title: 'Loss%', dataIndex: 'loss_rate', key: 'loss_rate', width: 70, align: 'right' as const,
      render: (v: number) => <span style={{ color: v > 0 ? '#ff4d4f' : undefined }}>{v}%</span>,
    },
    {
      title: 'Avg', dataIndex: 'avg_rtt_ms', key: 'avg_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number, r: MtrHop) => r.loss_rate >= 100 ? '—' : `${v.toFixed(1)} ms`,
    },
    {
      title: 'Best', dataIndex: 'best_rtt_ms', key: 'best_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number, r: MtrHop) => r.loss_rate >= 100 ? '—' : `${v.toFixed(1)} ms`,
    },
    {
      title: 'Worst', dataIndex: 'worst_rtt_ms', key: 'worst_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number, r: MtrHop) => r.loss_rate >= 100 ? '—' : `${v.toFixed(1)} ms`,
    },
    {
      title: 'Std Dev', dataIndex: 'stddev_rtt_ms', key: 'stddev_rtt_ms', width: 80, align: 'right' as const,
      render: (v: number | undefined, r: MtrHop) =>
        r.loss_rate >= 100 || v == null ? '—' : `${v.toFixed(1)} ms`,
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
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
      <Table
        columns={columns}
        dataSource={agents}
        rowKey="agent_id"
        loading={loading}
        pagination={false}
        scroll={{ x: 'max-content' }}
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
    </div>
  );
};

export default TabMeshPingMatrix;
