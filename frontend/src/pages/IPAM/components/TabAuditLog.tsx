import React, { useEffect, useState } from 'react';
import { Button, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getAuditLogs, purgeAuditLogs } from '../../../api/ipam';
import type { IPAMAuditLog } from '../../../types/ipam';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_ADMIN, useCan } from '../../../utils/perms';
import { FONT_MONO } from '../../../theme/theme';

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

// Audit time, stacked: HH:mm:ss over YYYY-MM-DD.
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
  create_root: 'green',  update_root: 'blue',   delete_root: 'red',
  split: 'cyan',         merge: 'purple',        update_subnet: 'blue',
  create_group: 'green', update_group: 'blue',   delete_group: 'red',
  create_type: 'green',  update_type: 'blue',    delete_type: 'red',
  create_vrf: 'green',   update_vrf: 'blue',     delete_vrf: 'red',
  purge_audit: 'orange',
};

const ACTION_OPTIONS = Object.keys(ACTION_COLOR).map((a) => ({ value: a, label: a }));
const RESOURCE_OPTIONS = [
  'root_prefix', 'subnet', 'group', 'type', 'vrf', 'audit_log',
].map((r) => ({ value: r, label: r }));

const TabAuditLog: React.FC = () => {
  const t = useT();
  const isAdminUser = useCan(PERM_ADMIN);

  const [data, setData]         = useState<IPAMAuditLog[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading]   = useState(false);
  const [retainDays, setRetainDays] = useState<number>(90);

  // Filters
  const [filterUser,     setFilterUser]     = useState('');
  const [filterAction,   setFilterAction]   = useState<string | undefined>();
  const [filterResource, setFilterResource] = useState<string | undefined>();

  const loadLogs = async (p = page, ps = pageSize, u = filterUser, a = filterAction, rt = filterResource) => {
    setLoading(true);
    try {
      const r = await getAuditLogs(p, ps, {
        username:      u      || undefined,
        action:        a      || undefined,
        resource_type: rt     || undefined,
      });
      setData(r.data.items ?? []);
      setTotal(r.data.total);
    } catch (err) {
      message.error(apiErrMsg(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLogs(); }, []);

  const handleSearch = () => { setPage(1); loadLogs(1, pageSize, filterUser, filterAction, filterResource); };

  const handleTableChange = (p: number, ps: number) => {
    setPage(p); setPageSize(ps);
    loadLogs(p, ps, filterUser, filterAction, filterResource);
  };

  const handlePurge = () => {
    Modal.confirm({
      title:      t('ipam.audit.purge'),
      content:    t('ipam.audit.purgeConfirm', { days: retainDays }),
      okType:     'danger',
      okText:     t('ipam.audit.purge'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          const r = await purgeAuditLogs(retainDays);
          message.success(`${t('ipam.audit.purgeOk')} (${r.data.deleted} rows)`);
          loadLogs(1, pageSize, filterUser, filterAction, filterResource);
          setPage(1);
        } catch (err) { message.error(apiErrMsg(err)); }
      },
    });
  };

  const columns: ColumnsType<IPAMAuditLog> = [
    {
      title: t('ipam.audit.time'), dataIndex: 'created_at', key: 'created_at', width: 130,
      render: (v: string) => timeCell(v),
    },
    {
      title: t('ipam.audit.operator'), dataIndex: 'username', key: 'username', width: 120,
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: t('ipam.audit.action'), dataIndex: 'action', key: 'action', width: 150,
      render: (v: string) => <Tag color={ACTION_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: t('ipam.audit.resource'), dataIndex: 'resource_type', key: 'resource_type', width: 120,
    },
    {
      title: t('ipam.audit.resourceId'), dataIndex: 'resource_id', key: 'resource_id', width: 80,
      render: (v) => (v != null ? mono(v) : '—'),
    },
    {
      title: t('ipam.audit.detail'), dataIndex: 'detail', key: 'detail', ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip>
      ),
    },
  ];

  return (
    <div>
      {/* Filter row */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('ipam.audit.operator')}
          value={filterUser}
          onChange={(e) => setFilterUser(e.target.value)}
          onPressEnter={handleSearch}
          allowClear style={{ width: 160 }}
        />
        <Select
          placeholder={t('ipam.audit.action')}
          value={filterAction}
          onChange={setFilterAction}
          allowClear style={{ width: 160 }}
          options={ACTION_OPTIONS}
        />
        <Select
          placeholder={t('ipam.audit.resource')}
          value={filterResource}
          onChange={setFilterResource}
          allowClear style={{ width: 140 }}
          options={RESOURCE_OPTIONS}
        />
        <Button type="primary" onClick={handleSearch}>{t('common.search') ?? 'Search'}</Button>
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
        scroll={{ x: 900 }}
      />

      {/* Purge control（清理为破坏性操作，仅管理员可见；后端 AdminRequired 双重保障） */}
      {isAdminUser && (
        <Space style={{ marginTop: 16 }} wrap>
          <span style={{ fontWeight: 500 }}>{t('ipam.audit.retain')}</span>
          <InputNumber
            min={1} max={3650} value={retainDays}
            onChange={(v) => setRetainDays(v ?? 90)}
            addonAfter={t('ipam.audit.days')} style={{ width: 180 }}
          />
          <Button danger icon={<DeleteOutlined />} onClick={handlePurge}>
            {t('ipam.audit.purge')}
          </Button>
        </Space>
      )}
    </div>
  );
};

export default TabAuditLog;
