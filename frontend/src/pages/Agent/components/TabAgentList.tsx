import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Col, Form, Input, Modal, Row, Select, Space, Table, theme, Tooltip, message } from 'antd';
import { ExclamationCircleFilled, ReloadOutlined, SearchOutlined, StopOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getAgents, getAgentSummary, getAgentFilterOptions, updateAgent, deleteAgent, revokeAgent, getAgentGroups,
} from '../../../api/agent';
import type { Agent, AgentFilterOptions, AgentGroup, AgentSummary } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';
import type { TranslationKey } from '../../../i18n/translations';
import { useDebounced } from '../../../utils/useDebounced';
import StatusTag from '../../../components/StatusTag';
import StatTile from '../../../components/StatTile';
import RelativeTime from '../../../components/RelativeTime';
import { FONT_MONO } from '../../../theme/theme';

const { confirm } = Modal;

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

// System Profile 的统一展示格式（表格列与筛选下拉共用）："Linux / amd64"
function profileLabel(os: string | undefined, arch: string | undefined): string {
  const osLabel = os ? os.charAt(0).toUpperCase() + os.slice(1) : '?';
  return `${osLabel} / ${arch || '?'}`;
}

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
  const { token } = theme.useToken();
  const [agents, setAgents]         = useState<Agent[]>([]);
  const [groups, setGroups]         = useState<AgentGroup[]>([]);
  const [summary, setSummary]       = useState<AgentSummary | null>(null);
  const [loading, setLoading]       = useState(false);
  const [search, setSearch]         = useState('');
  // ── 筛选栏下拉（与 IPAM 子网树的筛选方式一致：allowClear 的 Select，服务端过滤）──
  const [filterGroupId, setFilterGroupId] = useState<number | undefined>();
  const [filterVersion, setFilterVersion] = useState<string | undefined>();
  const [filterProfile, setFilterProfile] = useState<string | undefined>(); // 编码为 "os/arch"
  const [filterStatus,  setFilterStatus]  = useState<string | undefined>();
  const [filterOpts, setFilterOpts] = useState<AgentFilterOptions>({ versions: [], profiles: [] });
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

  // 下拉候选（Version / System Profile）：非关键路径，失败时保留上次的值
  const loadFilterOptions = useCallback(async () => {
    try {
      const r = await getAgentFilterOptions();
      setFilterOpts({ versions: r.data.versions ?? [], profiles: r.data.profiles ?? [] });
    } catch { /* 静默 */ }
  }, []);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      // System Profile 下拉的值是 "os/arch"，拆成两个独立的服务端过滤参数
      const [os, arch] = filterProfile ? filterProfile.split('/') : [undefined, undefined];
      const r = await getAgents({
        page,
        page_size: pageSize,
        q:        debSearch || undefined,
        group_id: filterGroupId,
        status:   filterStatus,
        version:  filterVersion,
        os:       os || undefined,
        arch:     arch || undefined,
      });
      if (seq !== reqSeq.current) return;
      setAgents(r.data.items ?? []);
      setTotal(r.data.total);
      setSelectedKeys([]);
    } catch (err: any) {
      if (seq === reqSeq.current) message.error(apiErrMsg(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debSearch, filterGroupId, filterStatus, filterVersion, filterProfile]);

  // 搜索词 / 任一筛选条件变化时回到第一页，避免在 page > 1 时先用旧页码发一次多余请求
  const filterKey = JSON.stringify([debSearch, filterGroupId, filterStatus, filterVersion, filterProfile]);
  const prevFilterKey = useRef(filterKey);
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      if (page !== 1) {
        setPage(1);
        return;
      }
      prevFilterKey.current = filterKey;
    }
    void loadData();
  }, [loadData, filterKey, page]);
  useEffect(() => { void loadSummary(); }, [loadSummary]);
  useEffect(() => { getAgentGroups().then(r => setGroups(r.data ?? [])).catch(() => {}); }, []);
  useEffect(() => { void loadFilterOptions(); }, [loadFilterOptions]);

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
      message.error(apiErrMsg(err));
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
        catch (err: any) { message.error(apiErrMsg(err)); }
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
        if (v4 && v6) return <span style={{ fontFamily: FONT_MONO }}>{v4}<br /><span style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 12 }}>{v6}</span></span>;
        return mono(v4 || v6 || '—');
      },
    },
    {
      title: t('agent.list.sourceIp'), key: 'source_ip_override', width: 170,
      render: (_: unknown, r: Agent) => {
        const { ipv4, ipv6 } = splitSourceIP(r.source_ip_override);
        if (ipv4 && ipv6) return <span style={{ fontFamily: FONT_MONO }}>{ipv4}<br /><span style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 12 }}>{ipv6}</span></span>;
        return mono(ipv4 || ipv6 || '—');
      },
    },
    { title: t('agent.list.version'), dataIndex: 'version', key: 'version', width: 110, render: (v: string | undefined) => (v ? mono(v) : '—') },
    {
      title: t('agent.list.systemProfile'), key: 'system_profile', width: 150,
      render: (_: unknown, r: Agent) => {
        if (!r.os && !r.arch) return '—';
        return <StatusTag status="info" tone="neutral" label={profileLabel(r.os, r.arch)} />;
      },
    },
    {
      title: t('common.status'), dataIndex: 'status', key: 'status', width: 110,
      render: (v: string, r: Agent) => r.revoked
        ? <StatusTag status="revoked" label={t('agent.list.revoked')} />
        : <StatusTag status={v} />,
    },
    {
      title: t('agent.list.certExpiry'), dataIndex: 'cert_expiry', key: 'cert_expiry', width: 140,
      render: (v: string) => <RelativeTime value={v} danger={(new Date(v).getTime() - Date.now()) / 86_400_000 <= 14} />,
    },
    {
      title: t('agent.list.lastSeen'), dataIndex: 'last_seen_at', key: 'last_seen_at', width: 140,
      render: (v: string | null) => <RelativeTime value={v} />,
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

  // ── 筛选栏下拉选项 ──────────────────────────────────────────────────────────
  const groupOptions   = groups.map(g => ({ value: g.id, label: g.name }));
  const versionOptions = filterOpts.versions.map(v => ({ value: v, label: v }));
  const profileOptions = filterOpts.profiles.map(p => ({
    value: `${p.os}/${p.arch}`,
    label: profileLabel(p.os, p.arch),
  }));
  // 状态口径与顶部汇总卡片一致：已作废单独一类，online/offline 只含未作废的 Agent
  const statusOptions = [
    { value: 'online',  label: t('agent.summary.online') },
    { value: 'offline', label: t('agent.summary.offline') },
    { value: 'revoked', label: t('agent.summary.revoked') },
  ];

  return (
    <div>
      {summary && (
        <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
          <Col xs={12} md={8} xl={4}><StatTile label={t('agent.summary.total')} value={summary.total_agents} /></Col>
          <Col xs={12} md={8} xl={4}><StatTile label={t('agent.summary.online')} value={summary.online_agents} valueColor={token.colorSuccess} live={summary.online_agents > 0} /></Col>
          <Col xs={12} md={8} xl={4}><StatTile label={t('agent.summary.offline')} value={summary.offline_agents} valueColor={summary.offline_agents > 0 ? token.colorError : undefined} /></Col>
          <Col xs={12} md={8} xl={4}><StatTile label={t('agent.summary.revoked')} value={summary.revoked_agents} /></Col>
          <Col xs={12} md={8} xl={4}><StatTile label={t('agent.summary.probes1h')} value={summary.recent_probes_1h.toLocaleString()} /></Col>
          <Col xs={12} md={8} xl={4}><StatTile label={t('agent.summary.failureRate1h')} value={`${summary.recent_failure_rate_pct.toFixed(1)}%`} valueColor={summary.recent_failure_rate_pct > 10 ? token.colorError : undefined} /></Col>
        </Row>
      )}

      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('agent.list.search')}
          value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 240 }}
        />
        <Select
          placeholder={t('agent.list.group')}
          value={filterGroupId}
          onChange={setFilterGroupId}
          allowClear style={{ width: 140 }}
          options={groupOptions}
        />
        <Select
          placeholder={t('agent.list.version')}
          value={filterVersion}
          onChange={setFilterVersion}
          allowClear style={{ width: 130 }}
          options={versionOptions}
        />
        <Select
          placeholder={t('agent.list.systemProfile')}
          value={filterProfile}
          onChange={setFilterProfile}
          allowClear style={{ width: 160 }}
          options={profileOptions}
        />
        <Select
          placeholder={t('common.status')}
          value={filterStatus}
          onChange={setFilterStatus}
          allowClear style={{ width: 120 }}
          options={statusOptions}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => { void loadData(); void loadSummary(); void loadFilterOptions(); }}
          loading={loading}
        >
          {t('common.refresh')}
        </Button>
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
