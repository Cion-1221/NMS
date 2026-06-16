import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, DatePicker, Input, Select, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { getProbeResults, getLatestProbeResults, getAgents } from '../../../api/agent';
import type { Agent, ProbeResult, TaskType } from '../../../types/agent';
import { useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';

const { RangePicker } = DatePicker;

interface Props {
  type: TaskType;
}

// ─────────────────────────────────────────────────────────────────────────────
// 通用结果 Tab：参数化 type，复用于 ping / tcpping / httpcheck / mtr 四个 Tab。
// 服务端分页 + 搜索防抖 + 请求序号守卫，与 TabLockouts 同款交互模式。
// "仅看最新" 打开后切换到 /probe-results/latest（每个 Agent+Target 只保留最新一条，
// 即"当前状态"快照），关闭则是完整历史日志（按时间倒序）。
// ─────────────────────────────────────────────────────────────────────────────

const TabGenericResults: React.FC<Props> = ({ type }) => {
  const t = useT();
  const [data, setData]         = useState<ProbeResult[]>([]);
  const [agents, setAgents]     = useState<Agent[]>([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');
  const [successFilter, setSuccessFilter] = useState<string | undefined>(undefined);
  const [agentFilter, setAgentFilter]     = useState<string | undefined>(undefined);
  const [dateRange, setDateRange]         = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [latestOnly, setLatestOnly]       = useState(false);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal]       = useState(0);

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
        start: dateRange?.[0] ? dateRange[0].toISOString() : undefined,
        end: dateRange?.[1] ? dateRange[1].toISOString() : undefined,
      };
      const r = latestOnly ? await getLatestProbeResults(params) : await getProbeResults(params);
      if (seq !== reqSeq.current) return;
      setData(r.data.items);
      setTotal(r.data.total);
    } catch (err: any) {
      if (seq === reqSeq.current) message.error(err?.response?.data?.error ?? 'Failed to load results');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debSearch, successFilter, agentFilter, dateRange, latestOnly, type]);

  useEffect(() => { setPage(1); }, [debSearch, successFilter, agentFilter, dateRange, latestOnly]);
  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { getAgents({ page: 1, page_size: 200 }).then(r => setAgents(r.data.items)).catch(() => {}); }, []);

  const columns: ColumnsType<ProbeResult> = [
    { title: t('agent.list.agentId'), dataIndex: 'agent_id', key: 'agent_id', width: 150 },
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
      title: t('proberesults.detail'), dataIndex: 'detail', key: 'detail', ellipsis: true,
      render: (v: string) => v || '—',
    },
    {
      title: t('proberesults.reportedAt'), dataIndex: 'reported_at', key: 'reported_at', width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
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
          allowClear showSearch placeholder={t('agent.list.agentId')} style={{ width: 200 }}
          value={agentFilter} onChange={setAgentFilter}
          optionFilterProp="label"
          options={agents.map(a => ({ value: a.agent_id, label: `${a.agent_id} (${a.hostname})` }))}
        />
        <Select
          allowClear placeholder={t('common.status')} style={{ width: 130 }}
          value={successFilter} onChange={setSuccessFilter}
          options={[
            { value: 'true', label: t('proberesults.success') },
            { value: 'false', label: t('proberesults.failed') },
          ]}
        />
        <RangePicker
          showTime value={dateRange} onChange={(v) => setDateRange(v as [Dayjs | null, Dayjs | null] | null)}
        />
        <Tooltip title={t('proberesults.latestOnlyHint')}>
          <Space>
            <Switch checked={latestOnly} onChange={setLatestOnly} />
            <span>{t('proberesults.latestOnly')}</span>
          </Space>
        </Tooltip>
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
    </div>
  );
};

export default TabGenericResults;
