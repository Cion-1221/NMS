import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getMeshPingMatrix, getAgentGroups } from '../../../api/agent';
import type { MeshPingMatrixResp, MeshPingProto, AgentGroup } from '../../../types/agent';
import { useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';

type AgentRow = MeshPingMatrixResp['agents'][number];

interface ActiveCell { rowId: string; colId: string }

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

  const renderProto = (p: MeshPingProto, label?: string) => (
    <Tooltip title={new Date(p.reported_at).toLocaleString()}>
      <Tag color={p.success ? 'green' : 'red'}>
        {label && <span style={{ opacity: 0.7, marginRight: 3 }}>{label}</span>}
        {p.success ? `${p.latency_ms?.toFixed(1) ?? '?'} ms` : t('proberesults.failed')}
      </Tag>
    </Tooltip>
  );

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
      width: 130,
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
        return (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            {cell.v4 && renderProto(cell.v4, hasBoth ? 'v4' : undefined)}
            {cell.v6 && renderProto(cell.v6, hasBoth ? 'v6' : undefined)}
          </div>
        );
      },
    })),
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
    </div>
  );
};

export default TabMeshPingMatrix;
