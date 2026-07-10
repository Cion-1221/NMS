import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tooltip, message } from 'antd';
import { DeleteOutlined, LineChartOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getLatestProbeResults, getAgents, deleteProbeResultPair, lookupASN } from '../../../api/agent';
import type { Agent, MtrHop, ProbeResult, TaskType } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_ADMIN, useCan } from '../../../utils/perms';
import { useDebounced } from '../../../utils/useDebounced';
import StatusTag from '../../../components/StatusTag';
import RelativeTime from '../../../components/RelativeTime';
import LatencySpark from '../../../components/LatencySpark';
import { FONT_MONO } from '../../../theme/theme';

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

// 延迟趋势弹窗内含 @ant-design/charts（G2，体积大）——懒加载，首次打开才拉取 chunk
const LatencyTrendModal = React.lazy(() => import('./LatencyTrendModal'));

// 路径类结果无标量延迟趋势价值（且不参与归档），不提供趋势图入口
const PATH_TYPES: string[] = ['mtr', 'meshmtr', 'traceroute'];

interface Props {
  type: TaskType;
}

const TabGenericResults: React.FC<Props> = ({ type }) => {
  const t = useT();
  const isAdminUser = useCan(PERM_ADMIN);
  const [trend, setTrend] = useState<{ agentId: string; target: string; probeType: string; label: string } | null>(null);
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
  const [asnMap, setAsnMap]         = useState<Record<string, { asn: number; name: string } | null>>({});
  const [asnLoading, setAsnLoading] = useState(false);

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
      if (seq === reqSeq.current) message.error(apiErrMsg(err));
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
      message.error(apiErrMsg(err));
    }
  };

  const openMtrDetail = useCallback(async (hops: MtrHop[]) => {
    setMtrHops(hops);
    setAsnMap({});
    const ips = [...new Set(hops.map(h => h.host).filter(h => h && h !== '???'))];
    if (ips.length === 0) return;
    setAsnLoading(true);
    try {
      const r = await lookupASN(ips);
      setAsnMap(r.data);
    } catch {
      // ASN lookup failure is non-critical; MTR hop table still displays without it.
    } finally {
      setAsnLoading(false);
    }
  }, []);

  const columns: ColumnsType<ProbeResult> = [
    {
      title: t('agent.list.hostname'), key: 'hostname',
      render: (_: unknown, r: ProbeResult) => (
        <Tooltip title={r.agent_id}>
          <span style={{ cursor: 'default' }}>{agentMap.get(r.agent_id) ?? r.agent_id}</span>
        </Tooltip>
      ),
    },
    { title: t('proberesults.target'), dataIndex: 'target', key: 'target', render: (v: string) => mono(v) },
    {
      title: t('common.status'), dataIndex: 'success', key: 'success',
      render: (v: boolean) => <StatusTag status={v ? 'success' : 'failed'} label={v ? t('proberesults.success') : t('proberesults.failed')} />,
    },
    {
      title: t('proberesults.latency'), dataIndex: 'latency_ms', key: 'latency_ms',
      render: (v: number | null) => (v == null ? '—' : mono(`${v.toFixed(1)} ms`)),
    },
    {
      title: t('proberesults.detail'), dataIndex: 'detail', key: 'detail',
      render: (v: string) => {
        if (type === 'mtr' && v) {
          try {
            const hops: MtrHop[] = JSON.parse(v);
            const maxLoss = Math.max(...hops.map(h => h.loss_rate));
            return (
              <Button type="link" size="small" style={{ padding: 0 }} onClick={() => { void openMtrDetail(hops); }}>
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
      title: t('proberesults.reportedAt'), dataIndex: 'reported_at', key: 'reported_at',
      render: (v: string) => <RelativeTime value={v} />,
    },
    {
      // 延迟趋势对所有登录用户开放（只读）；删除仅管理员（后端 AdminRequired 双重保障）
      title: t('common.actions'), key: 'action', fixed: 'right' as const,
      render: (_: unknown, r: ProbeResult) => (
        <Space size={0}>
          {!PATH_TYPES.includes(r.type) && (
            <Tooltip title={
              <LatencySpark agentId={r.agent_id} target={r.target} type={r.type} reportedAt={r.reported_at} />
            }>
              <Button
                type="text" size="small" icon={<LineChartOutlined />}
                onClick={() => setTrend({
                  agentId: r.agent_id, target: r.target, probeType: r.type,
                  label: `${agentMap.get(r.agent_id) ?? r.agent_id} → ${r.target}`,
                })}
              />
            </Tooltip>
          )}
          {isAdminUser && (
            <Popconfirm
              title={t('proberesults.delConfirm')}
              onConfirm={() => handleDelete(r)}
              okText={t('common.delete')}
              okButtonProps={{ danger: true }}
              cancelText={t('common.cancel')}
            >
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
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
      />
      <Modal
        title={t('mtr.hopDetails')}
        open={mtrHops !== null}
        onCancel={() => { setMtrHops(null); setAsnMap({}); }}
        footer={null}
        width={900}
        destroyOnClose
      >
        <Table
          size="small"
          dataSource={mtrHops ?? []}
          rowKey="ttl"
          pagination={false}
          columns={[
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
          ]}
        />
      </Modal>

      {/* 延迟趋势 Modal（懒加载：首次打开才拉取图表 chunk） */}
      {trend && (
        <Suspense fallback={null}>
          <LatencyTrendModal
            open
            onClose={() => setTrend(null)}
            agentId={trend.agentId}
            target={trend.target}
            probeType={trend.probeType}
            label={trend.label}
          />
        </Suspense>
      )}
    </div>
  );
};

export default TabGenericResults;
