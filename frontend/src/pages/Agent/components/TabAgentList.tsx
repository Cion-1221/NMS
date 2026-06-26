import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Checkbox, Col, Form, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Tooltip, message } from 'antd';
import { ExclamationCircleFilled, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getAgents, getAgentSummary, updateAgent, deleteAgent, revokeAgent, getAgentGroups } from '../../../api/agent';
import type { Agent, AgentGroup, AgentSummary } from '../../../types/agent';
import { useT } from '../../../i18n';
import type { TranslationKey } from '../../../i18n/translations';
import { useDebounced } from '../../../utils/useDebounced';

const { confirm } = Modal;

function splitSourceIP(raw: string | null | undefined): { ipv4: string; ipv6: string } {
  const parts = (raw ?? '').split('/').map(s => s.trim()).filter(Boolean);
  return {
    ipv4: parts.find(p => !p.includes(':')) ?? '',
    ipv6: parts.find(p =>  p.includes(':')) ?? '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent List Tab：顶部健康汇总卡片 + 服务端分页列表，支持搜索、修改 Source IP/
// Group、单条/批量删除与作废证书。交互模式与 TabLockouts（搜索防抖+请求序号守卫+
// 批量操作）一致。
// ─────────────────────────────────────────────────────────────────────────────

const TabAgentList: React.FC = () => {
  const t = useT();
  const [agents, setAgents]         = useState<Agent[]>([]);
  const [groups, setGroups]         = useState<AgentGroup[]>([]);
  const [summary, setSummary]       = useState<AgentSummary | null>(null);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  const [page, setPage]             = useState(1);
  const [pageSize, setPageSize]     = useState(20);
  const [total, setTotal]           = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [editOpen, setEditOpen]     = useState(false);
  const [editing, setEditing]       = useState<Agent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ ids: string[]; label: string } | null>(null);
  const [purgeOnDelete, setPurgeOnDelete] = useState(false);
  const [form] = Form.useForm();

  const debSearch = useDebounced(search);
  const reqSeq = useRef(0);

  const loadSummary = useCallback(async () => {
    try { const r = await getAgentSummary(); setSummary(r.data); }
    catch { /* 汇总卡片非关键路径，静默失败即可，主列表仍可用 */ }
  }, []);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await getAgents({ page, page_size: pageSize, q: debSearch || undefined });
      if (seq !== reqSeq.current) return;
      setAgents(r.data.items);
      setTotal(r.data.total);
      setSelectedKeys([]);
    } catch (err: any) {
      if (seq === reqSeq.current) message.error(err?.response?.data?.error ?? 'Failed to load agents');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debSearch]);

  useEffect(() => { setPage(1); }, [debSearch]);
  useEffect(() => { void loadData(); void loadSummary(); }, [loadData, loadSummary]);
  useEffect(() => { getAgentGroups().then(r => setGroups(r.data)).catch(() => {}); }, []);

  const openEdit = (r: Agent) => {
    setEditing(r);
    const { ipv4, ipv6 } = splitSourceIP(r.source_ip_override);
    form.setFieldsValue({ hostname: r.hostname, source_ipv4: ipv4, source_ipv6: ipv6, group_id: r.group_id ?? undefined });
    setEditOpen(true);
  };

  const handleSubmitEdit = async () => {
    const values = await form.validateFields();
    const v4 = (values.source_ipv4 ?? '').trim();
    const v6 = (values.source_ipv6 ?? '').trim();
    const sourceIPOverride = v4 && v6 ? `${v4} / ${v6}` : v4 || v6;
    try {
      await updateAgent(editing!.agent_id, {
        hostname: values.hostname,
        source_ip_override: sourceIPOverride,
        group_id: values.group_id ?? null,
      });
      message.success(t('common.success'));
      setEditOpen(false);
      void loadData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Update failed');
    }
  };

  const handleDelete = (r: Agent) => {
    setPurgeOnDelete(false);
    setDeleteTarget({ ids: [r.agent_id], label: r.hostname });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const results = await Promise.allSettled(
      deleteTarget.ids.map(id => deleteAgent(id, purgeOnDelete))
    );
    const ok   = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    if (ok   > 0) message.success(deleteTarget.ids.length === 1 ? t('common.success') : t('agent.list.bulkDelOk').replace('{n}', String(ok)));
    if (fail > 0) message.error(`${fail} 条操作失败`);
    setDeleteTarget(null);
    void loadData();
    void loadSummary();
  };

  const handleRevoke = (r: Agent) => {
    confirm({
      title: t('agent.list.revokeTitle'),
      icon: <ExclamationCircleFilled style={{ color: '#faad14' }} />,
      content: t('agent.list.revokeBody').replace('{id}', r.agent_id),
      okText: t('agent.list.revoke'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await revokeAgent(r.agent_id); message.success(t('common.success')); void loadData(); void loadSummary(); }
        catch (err: any) { message.error(err?.response?.data?.error ?? 'Revoke failed'); }
      },
    });
  };

  // 批量操作复用现有的单条接口，并发调用 + allSettled 汇总结果——Agent 数量级在几十到
  // 几百，没有必要为此新增专门的批量后端接口。
  const runBulk = async (
    keys: React.Key[],
    action: (agentId: string) => Promise<unknown>,
    successMsgKey: TranslationKey,
  ) => {
    const ids = keys as string[];
    const results = await Promise.allSettled(ids.map(action));
    const okCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.length - okCount;
    if (okCount > 0) message.success(t(successMsgKey).replace('{n}', String(okCount)));
    if (failCount > 0) message.error(`${failCount} 条操作失败`);
    void loadData();
    void loadSummary();
  };

  const handleBulkDelete = () => {
    setPurgeOnDelete(false);
    setDeleteTarget({ ids: selectedKeys as string[], label: String(selectedKeys.length) });
  };

  const handleBulkRevoke = () => {
    confirm({
      title: t('agent.list.bulkRevokeTitle').replace('{n}', String(selectedKeys.length)),
      icon: <ExclamationCircleFilled style={{ color: '#faad14' }} />,
      content: t('agent.list.revokeBody').replace('{id}', ''),
      okText: t('agent.list.revoke'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: () => runBulk(selectedKeys, (id) => revokeAgent(id), 'agent.list.bulkRevokeOk'),
    });
  };

  const columns: ColumnsType<Agent> = [
    {
      title: t('agent.list.hostname'), key: 'hostname',
      render: (_: unknown, r: Agent) => (
        <Tooltip title={r.agent_id}>
          <span style={{ cursor: 'default' }}>{r.hostname}</span>
        </Tooltip>
      ),
    },
    { title: t('agent.list.group'), key: 'group', width: 120, render: (_: unknown, r: Agent) => r.group?.name ?? '—' },
    {
      title: t('agent.list.connectionIp'), key: 'connection_ip', width: 200,
      render: (_: unknown, r: Agent) => {
        const v4 = r.connection_ipv4 || (r.connection_ip && !r.connection_ip.includes(':') ? r.connection_ip : '');
        const v6 = r.connection_ipv6 || (r.connection_ip && r.connection_ip.includes(':') ? r.connection_ip : '');
        if (v4 && v6) return <span>{v4}<br /><span style={{ color: '#888', fontSize: 12 }}>{v6}</span></span>;
        return <span>{v4 || v6 || '—'}</span>;
      },
    },
    {
      title: t('agent.list.sourceIp'), key: 'source_ip_override', width: 170,
      render: (_: unknown, r: Agent) => {
        const { ipv4, ipv6 } = splitSourceIP(r.source_ip_override);
        if (ipv4 && ipv6) return <span>{ipv4}<br /><span style={{ color: '#888', fontSize: 12 }}>{ipv6}</span></span>;
        return <span>{ipv4 || ipv6 || '—'}</span>;
      },
    },
    { title: t('agent.list.version'), dataIndex: 'version', key: 'version', width: 110, render: (v: string | undefined) => v || '—' },
    { title: t('agent.list.os'), dataIndex: 'os', key: 'os', width: 100, render: (v: string | undefined) => v || '—' },
    { title: t('agent.list.arch'), dataIndex: 'arch', key: 'arch', width: 90, render: (v: string | undefined) => v || '—' },
    {
      title: t('common.status'), dataIndex: 'status', key: 'status', width: 110,
      render: (v: string, r: Agent) => r.revoked
        ? <Tag color="red">{t('agent.list.revoked')}</Tag>
        : <Tag color={v === 'online' ? 'green' : 'default'}>{v}</Tag>,
    },
    {
      title: t('agent.list.certExpiry'), dataIndex: 'cert_expiry', key: 'cert_expiry', width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: t('agent.list.lastSeen'), dataIndex: 'last_seen_at', key: 'last_seen_at', width: 180,
      render: (v: string | null) => (v ? new Date(v).toLocaleString() : '—'),
    },
    {
      title: t('common.actions'), key: 'action', width: 220, fixed: 'right' as const,
      render: (_: unknown, r: Agent) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
          <Button type="link" size="small" danger disabled={r.revoked} icon={<StopOutlined />} onClick={() => handleRevoke(r)}>
            {t('agent.list.revoke')}
          </Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {summary && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={4}><Card size="small"><Statistic title={t('agent.summary.total')} value={summary.total_agents} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title={t('agent.summary.online')} value={summary.online_agents} valueStyle={{ color: '#3f8600' }} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title={t('agent.summary.offline')} value={summary.offline_agents} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title={t('agent.summary.revoked')} value={summary.revoked_agents} valueStyle={{ color: '#cf1322' }} /></Card></Col>
          <Col span={4}><Card size="small"><Statistic title={t('agent.summary.probes1h')} value={summary.recent_probes_1h} /></Card></Col>
          <Col span={4}>
            <Card size="small">
              <Statistic
                title={t('agent.summary.failureRate1h')}
                value={summary.recent_failure_rate_pct}
                precision={1}
                suffix="%"
                valueStyle={{ color: summary.recent_failure_rate_pct > 10 ? '#cf1322' : undefined }}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('agent.list.search')}
          value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 260 }}
        />
        <Button icon={<ReloadOutlined />} onClick={() => { void loadData(); void loadSummary(); }} loading={loading}>{t('common.refresh')}</Button>
        <Button danger disabled={selectedKeys.length === 0} onClick={handleBulkDelete}>
          {t('agent.list.bulkDelete')}{selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ''}
        </Button>
        <Button danger disabled={selectedKeys.length === 0} icon={<StopOutlined />} onClick={handleBulkRevoke}>
          {t('agent.list.bulkRevoke')}{selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ''}
        </Button>
      </Space>
      <Table
        columns={columns}
        dataSource={agents}
        rowKey="agent_id"
        loading={loading}
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
        pagination={{
          current: page,
          pageSize,
          total,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
          onChange: (p, ps) => {
            if (ps !== pageSize) { setPageSize(ps); setPage(1); } else { setPage(p); }
          },
        }}
        scroll={{ x: 'max-content' }}
      />

      <Modal
        title={t('agent.list.editTitle')}
        open={editOpen} onOk={handleSubmitEdit} onCancel={() => setEditOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('agent.list.hostname')} name="hostname" rules={[{ required: true, whitespace: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('agent.list.sourceIpv4')} name="source_ipv4" tooltip={t('agent.list.sourceIpHint')}>
            <Input placeholder="10.0.0.5" />
          </Form.Item>
          <Form.Item label={t('agent.list.sourceIpv6')} name="source_ipv6">
            <Input placeholder="2001:db8::1" />
          </Form.Item>
          <Form.Item label={t('agent.list.group')} name="group_id">
            <Select allowClear options={groups.map(g => ({ value: g.id, label: g.name }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={
          deleteTarget?.ids.length === 1
            ? t('agent.list.delTitle').replace('{id}', deleteTarget.label)
            : t('agent.list.bulkDelTitle').replace('{n}', deleteTarget?.label ?? '')
        }
        open={!!deleteTarget}
        onOk={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        okText={t('common.delete')}
        okButtonProps={{ danger: true }}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <p style={{ marginBottom: 12 }}>{t('agent.list.delBody')}</p>
        <Checkbox checked={purgeOnDelete} onChange={e => setPurgeOnDelete(e.target.checked)}>
          {t('agent.list.purgeResults')}
        </Checkbox>
      </Modal>
    </div>
  );
};

export default TabAgentList;
