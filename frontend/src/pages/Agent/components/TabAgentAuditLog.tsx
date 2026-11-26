import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getAgentAuditLogs, purgeAgentAuditLogs } from '../../../api/agent';
import type { AgentAuditLog } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_ADMIN, useCan } from '../../../utils/perms';
import { useDebounced } from '../../../utils/useDebounced';
import { FONT_MONO } from '../../../theme/theme';

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

const pad = (n: number) => String(n).padStart(2, '0');
const timeCell = (v: string) => {
  const d = new Date(v);
  return (
    <div style={{ fontFamily: FONT_MONO, lineHeight: 1.35, whiteSpace: 'nowrap' }}>
      <div>{pad(d.getHours())}:{pad(d.getMinutes())}:{pad(d.getSeconds())}</div>
      <div style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }}>
        {d.getFullYear()}-{pad(d.getMonth() + 1)}-{pad(d.getDate())}
      </div>
    </div>
  );
};

const ACTION_COLOR: Record<string, string> = {
  update_agent:        'blue',    delete_agent:       'red',     revoke_agent:        'volcano',
  create_group:        'green',   update_group:       'blue',    delete_group:        'red',
  create_task:         'green',   update_task:        'blue',    delete_task:         'red',
  create_token:        'green',   revoke_token:       'volcano',
  rotate_ca:           'purple',  finalize_ca:        'purple',
  create_release:      'green',   delete_release:     'red',     set_release_active:  'cyan',
  delete_probe_pair:   'red',     delete_probe_pairs: 'red',     purge_probe_results: 'orange',
  purge_audit:         'orange',
};

const ACTION_OPTIONS = Object.keys(ACTION_COLOR).map(a => ({ value: a, label: a }));

const RESOURCE_OPTIONS = [
  'agent', 'agent_group', 'agent_task', 'agent_token',
  'ca', 'agent_releases', 'probe_results', 'audit_log',
].map(r => ({ value: r, label: r }));

const TabAgentAuditLog: React.FC = () => {
  const t = useT();
  const isAdminUser = useCan(PERM_ADMIN);

  const [data, setData]         = useState<AgentAuditLog[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading]   = useState(false);
  const [retainDays, setRetainDays] = useState<number>(90);

  const [filterUser,     setFilterUser]     = useState('');
  const [filterAction,   setFilterAction]   = useState<string | undefined>();
  const [filterResource, setFilterResource] = useState<string | undefined>();

  const [purgeOpen, setPurgeOpen] = useState(false);

  const debUser = useDebounced(filterUser);
  const reqSeq = useRef(0);

  const loadLogs = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await getAgentAuditLogs(page, pageSize, {
        username:      debUser        || undefined,
        action:        filterAction   || undefined,
        resource_type: filterResource || undefined,
      });
      if (seq !== reqSeq.current) return;
      setData(r.data.items ?? []);
      setTotal(r.data.total);
    } catch (err: unknown) {
      if (seq === reqSeq.current) message.error(apiErrMsg(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debUser, filterAction, filterResource]);

  const filterKey = JSON.stringify([debUser, filterAction, filterResource]);
  const prevFilterKey = useRef(filterKey);
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      if (page !== 1) {
        setPage(1);
        return;
      }
      prevFilterKey.current = filterKey;
    }
    void loadLogs();
  }, [loadLogs, filterKey, page]);

  const handleTableChange = (p: number, ps: number) => {
    if (ps !== pageSize) { setPageSize(ps); setPage(1); } else { setPage(p); }
  };

  const handlePurge = async () => {
    try {
      const r = await purgeAgentAuditLogs(retainDays);
      message.success(t('agent.audit.purgeOk', { n: Number(r.data.deleted) }));
      setPurgeOpen(false);
      setPage(1);
      void loadLogs();
    } catch (err: unknown) { message.error(apiErrMsg(err)); }
  };

  const columns: ColumnsType<AgentAuditLog> = [
    {
      title: t('agent.audit.time'), dataIndex: 'created_at', key: 'created_at', width: 130,
      render: (v: string) => timeCell(v),
    },
    {
      title: t('agent.audit.operator'), dataIndex: 'username', key: 'username', width: 120,
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: t('agent.audit.action'), dataIndex: 'action', key: 'action', width: 180,
      render: (v: string) => <Tag color={ACTION_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: t('agent.audit.resource'), dataIndex: 'resource_type', key: 'resource_type', width: 130,
    },
    {
      title: t('agent.audit.resourceId'), dataIndex: 'resource_id', key: 'resource_id', width: 120,
      render: (v: string) => (v ? mono(v) : '—'),
    },
    {
      title: t('agent.audit.detail'), dataIndex: 'detail', key: 'detail', ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip>
      ),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('agent.audit.operator')}
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          allowClear style={{ width: 160 }}
        />
        <Select
          placeholder={t('agent.audit.action')}
          value={filterAction}
          onChange={setFilterAction}
          allowClear style={{ width: 200 }}
          options={ACTION_OPTIONS}
        />
        <Select
          placeholder={t('agent.audit.resource')}
          value={filterResource}
          onChange={setFilterResource}
          allowClear style={{ width: 160 }}
          options={RESOURCE_OPTIONS}
        />
        <Button icon={<ReloadOutlined />} onClick={() => { void loadLogs(); }} loading={loading}>
          {t('common.refresh')}
        </Button>
        {isAdminUser && (
          <Button danger icon={<DeleteOutlined />} onClick={() => setPurgeOpen(true)}>
            {t('agent.audit.purge')}
          </Button>
        )}
      </Space>

      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{
          current:         page,
          pageSize:        pageSize,
          total:           total,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal:       (n, range) => `${range[0]}-${range[1]} / ${n}`,
          onChange:        handleTableChange,
        }}
        scroll={{ x: 960 }}
      />

      <Modal
        title={t('agent.audit.purgeTitle')}
        open={purgeOpen}
        onOk={handlePurge}
        onCancel={() => setPurgeOpen(false)}
        okText={t('common.confirm')}
        okType="danger"
        cancelText={t('common.cancel')}
        width={420}
      >
        <p style={{ marginTop: 12 }}>{t('agent.audit.purgeBody')}</p>
        <InputNumber min={1} max={3650} value={retainDays}
          onChange={(v) => setRetainDays(v ?? 90)} style={{ width: 160 }}
          addonAfter={t('agent.audit.days')} />
      </Modal>
    </div>
  );
};

export default TabAgentAuditLog;
