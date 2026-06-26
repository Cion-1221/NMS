import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getLatestProbeResults, getAgents, deleteProbeResultPair } from '../../../api/agent';
import type { Agent, MtrHop, ProbeResult, TaskType } from '../../../types/agent';
import { useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';

interface Props {
  type: TaskType;
}

const TabGenericResults: React.FC<Props> = ({ type }) => {
  const t = useT();
  const [data, setData]         = useState<ProbeResult[]>([]);
  const [agents, setAgents]     = useState<Agent[]>([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');
  const [successFilter, setSuccessFilter] = useState<string | undefined>(undefined);
  const [agentFilter, setAgentFilter]     = useState<string | undefined>(undefined);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal]       = useState(0);

  const [mtrHops, setMtrHops] = useState<MtrHop[] | null>(null);

  const agentMap = useMemo(
    () => new Map(agents.map(a => [a.agent_id, a.hostname])),
    [agents],
  );

  const debSearch = useDebounced(search);
  const reqSeq = useRef(0);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const params = {
        page, page_size: pageSize, type,
        q: debSearch || undefined,
        agent_id: agentFilter || undefined,
        success: successFilter === undefined ? undefined : successFilter === 'true',
      };
      const r = await getLatestProbeResults(params);
      if (seq !== reqSeq.current) return;
      setData(r.data.items);
      setTotal(r.data.total);
    } catch (err: any) {
      if (seq === reqSeq.current) message.error(err?.response?.data?.error ?? 'Failed to load results');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debSearch, successFilter, agentFilter, type]);

  useEffect(() => { setPage(1); }, [debSearch, successFilter, agentFilter]);
  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { getAgents({ page: 1, page_size: 200 }).then(r => setAgents(r.data.items)).catch(() => {}); }, []);

  const handleDelete = async (r: ProbeResult) => {
    try {
      await deleteProbeResultPair(r.agent_id, r.target, type);
      message.success(t('common.success'));
      void loadData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Delete failed');
    }
  };

  const columns: ColumnsType<ProbeResult> = [
    {
      title: t('agent.list.hostname'), key: 'hostname', width: 160,
      render: (_: unknown, r: ProbeResult) => (
        <Tooltip title={r.agent_id}>
          <span style={{ cursor: 'default' }}>{agentMap.get(r.agent_id) ?? r.agent_id}</span>
        </Tooltip>
      ),
    },
    { title: t('proberesults.target'), dataIndex: 'target', key: 'target' },
    {
      title: t('common.status'), dataIndex: 'success', key: 'success', width: 100,
      render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? t('proberesults.success') : t('proberesults.failed')}</Tag>,
    },
    {
      title: t('proberesults.latency'), dataIndex: 'latency_ms', key: 'latency_ms', width: 110,
      render: (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} ms`),
    },
    {
      title: t('proberesults.detail'), dataIndex: 'detail', key: 'detail',
      render: (v: string) => {
        if (type === 'mtr' && v) {
          try {
            const hops: MtrHop[] = JSON.parse(v);
            const maxLoss = Math.max(...hops.map(h => h.loss_rate));
            return (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setMtrHops(hops)}>
                {hops.length} hops{maxLoss > 0 ? `, max loss ${maxLoss}%` : ''}
              </Button>
            );
          } catch { /* fall through */ }
        }
        return v
          ? <Tooltip title={v}><span style={{ maxWidth: 300, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{v}</span></Tooltip>
          : '—';
      },
    },
    {
      title: t('proberesults.reportedAt'), dataIndex: 'reported_at', key: 'reported_at', width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t('common.actions'), key: 'action', width: 80, fixed: 'right' as const,
      render: (_: unknown, r: ProbeResult) => (
        <Popconfirm
          title={t('proberesults.delConfirm')}
          onConfirm={() => handleDelete(r)}
          okText={t('common.delete')}
          okButtonProps={{ danger: true }}
          cancelText={t('common.cancel')}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('proberesults.search')}
          value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 220 }}
        />
        <Select
          allowClear showSearch placeholder={t('agent.list.hostname')} style={{ width: 200 }}
          value={agentFilter} onChange={setAgentFilter}
          optionFilterProp="label"
          options={agents.map(a => ({ value: a.agent_id, label: agentMap.get(a.agent_id) ?? a.agent_id }))}
        />
        <Select
          allowClear placeholder={t('common.status')} style={{ width: 130 }}
          value={successFilter} onChange={setSuccessFilter}
          options={[
            { value: 'true', label: t('proberesults.success') },
            { value: 'false', label: t('proberesults.failed') },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={() => { void loadData(); }} loading={loading}>{t('common.refresh')}</Button>
      </Space>
      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page, pageSize, total,
          pageSizeOptions: ['10', '20', '50', '100'], showSizeChanger: true, showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
          onChange: (p, ps) => { if (ps !== pageSize) { setPageSize(ps); setPage(1); } else { setPage(p); } },
        }}
        scroll={{ x: 'max-content' }}
      />
      <Modal
        title="MTR Hop Details"
        open={mtrHops !== null}
        onCancel={() => setMtrHops(null)}
        footer={null}
        width={700}
        destroyOnClose
      >
        <Table
          size="small"
          dataSource={mtrHops ?? []}
          rowKey="ttl"
          pagination={false}
          columns={[
            { title: 'Hop', dataIndex: 'ttl', key: 'ttl', width: 55 },
            { title: 'Host', dataIndex: 'host', key: 'host' },
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
          ]}
        />
      </Modal>
    </div>
  );
};

export default TabGenericResults;
