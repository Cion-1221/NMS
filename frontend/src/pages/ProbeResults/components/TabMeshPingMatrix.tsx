import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getMeshPingMatrix, getAgentGroups } from '../../../api/agent';
import type { MeshPingMatrixResp, AgentGroup } from '../../../types/agent';
import { useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';

type AgentRow = MeshPingMatrixResp['agents'][number];

// ─────────────────────────────────────────────────────────────────────────────
// MeshPing Tab：将互测结果渲染为 NxN 交叉延迟矩阵——行/列均为当前 Agent 集合，
// 单元格取双方最新一次探测结果。q 同时过滤参与矩阵的 Agent（按 agent_id/hostname）。
// ─────────────────────────────────────────────────────────────────────────────

const TabMeshPingMatrix: React.FC = () => {
  const t = useT();
  const [matrixData, setMatrixData] = useState<MeshPingMatrixResp>({ agents: [], matrix: {} });
  const [groups, setGroups]   = useState<AgentGroup[]>([]);
  const [groupId, setGroupId] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const debSearch = useDebounced(search);
  const reqSeq = useRef(0);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await getMeshPingMatrix({ q: debSearch || undefined, group_id: groupId });
      if (seq !== reqSeq.current) return;
      setMatrixData(r.data);
    } catch (err: any) {
      if (seq === reqSeq.current) message.error(err?.response?.data?.error ?? 'Failed to load matrix');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [debSearch, groupId]);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { getAgentGroups().then(r => setGroups(r.data)).catch(() => {}); }, []);

  const { agents, matrix } = matrixData;

  const columns: ColumnsType<AgentRow> = [
    {
      title: t('agent.list.hostname'), dataIndex: 'hostname', key: '__row_header',
      fixed: 'left' as const, width: 160,
      render: (v: string, r: AgentRow) => <Tooltip title={r.agent_id}><b>{v || r.agent_id}</b></Tooltip>,
    },
    ...agents.map(col => ({
      title: <Tooltip title={col.agent_id}>{col.hostname || col.agent_id}</Tooltip>,
      key: col.agent_id,
      width: 130,
      align: 'center' as const,
      render: (_: unknown, row: AgentRow) => {
        if (row.agent_id === col.agent_id) return <span style={{ color: '#ccc' }}>—</span>;
        const cell = matrix[row.agent_id]?.[col.agent_id];
        if (!cell) return <span style={{ color: '#ccc' }}>{t('proberesults.noData')}</span>;
        return (
          <Tooltip title={new Date(cell.reported_at).toLocaleString()}>
            <Tag color={cell.success ? 'green' : 'red'}>
              {cell.success ? `${cell.latency_ms?.toFixed(1) ?? '?'} ms` : t('proberesults.failed')}
            </Tag>
          </Tooltip>
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
