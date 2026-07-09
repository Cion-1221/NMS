import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getDeviceAuditLogs, purgeDeviceAuditLogs } from '../../../api/device';
import type { DeviceAuditLog } from '../../../types/device';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_ADMIN, useCan } from '../../../utils/perms';
import { useDebounced } from '../../../utils/useDebounced';
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
  create_device: 'green',  update_device: 'blue',   delete_device: 'red',
  create_site:   'green',  update_site:   'blue',   delete_site:   'red',
  create_pop:    'green',  update_pop:    'blue',   delete_pop:    'red',
  create_role:   'green',  update_role:   'blue',   delete_role:   'red',
  create_vendor: 'green',  update_vendor: 'blue',   delete_vendor: 'red',
  purge_audit:   'orange',
};

// ACTION_OPTIONS is the single source of truth: add a new entry to ACTION_COLOR above
// and it automatically appears in both the color renderer and the filter dropdown.
const ACTION_OPTIONS = Object.keys(ACTION_COLOR).map(a => ({ value: a, label: a }));

// RESOURCE_OPTIONS is auto-derived from ACTION_COLOR keys so it stays in sync without
// a separate maintenance step.
// Derivation rule: "create_device" → "device", "purge_audit" → "audit_log"
// (purge_* actions have a special mapping because the resource type logged is "audit_log").
const RESOURCE_OPTIONS = [
  ...new Set(
    Object.keys(ACTION_COLOR).map(action => {
      if (action.startsWith('purge_')) return 'audit_log';
      const sep = action.indexOf('_');
      return sep >= 0 ? action.slice(sep + 1) : action;
    }),
  ),
].map(r => ({ value: r, label: r }));

const TabDeviceAuditLog: React.FC = () => {
  const t = useT();
  const isAdminUser = useCan(PERM_ADMIN);

  const [data, setData]         = useState<DeviceAuditLog[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading]   = useState(false);
  const [retainDays, setRetainDays] = useState<number>(90);

  const [filterUser,     setFilterUser]     = useState('');
  const [filterAction,   setFilterAction]   = useState<string | undefined>();
  const [filterResource, setFilterResource] = useState<string | undefined>();

  const [purgeOpen, setPurgeOpen] = useState(false);

  // 用户名文本框防抖实时搜索；Action/Resource 下拉选中即时生效（与 Device List
  // 主列表同款交互，不再需要单独的 Search 按钮）
  const debUser = useDebounced(filterUser);
  const reqSeq = useRef(0);

  const loadLogs = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await getDeviceAuditLogs(page, pageSize, {
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

  // 筛选条件变化时回到第一页（loadLogs 依赖变化会自动触发重新查询）
  useEffect(() => { setPage(1); }, [debUser, filterAction, filterResource]);
  useEffect(() => { void loadLogs(); }, [loadLogs]);

  const handleTableChange = (p: number, ps: number) => {
    // 切换每页条数时回到第一页，避免落在超出范围的页码上
    if (ps !== pageSize) { setPageSize(ps); setPage(1); } else { setPage(p); }
  };

  const handlePurge = async () => {
    try {
      const r = await purgeDeviceAuditLogs(retainDays);
      message.success(t('device.audit.purgeOk', { n: Number(r.data.deleted) }));
      setPurgeOpen(false);
      setPage(1);
      void loadLogs();
    } catch (err: unknown) { message.error(apiErrMsg(err)); }
  };

  const columns: ColumnsType<DeviceAuditLog> = [
    {
      title: t('device.audit.time'), dataIndex: 'created_at', key: 'created_at', width: 130,
      render: (v: string) => timeCell(v),
    },
    {
      title: t('device.audit.operator'), dataIndex: 'username', key: 'username', width: 120,
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: t('device.audit.action'), dataIndex: 'action', key: 'action', width: 160,
      render: (v: string) => <Tag color={ACTION_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: t('device.audit.resource'), dataIndex: 'resource_type', key: 'resource_type', width: 100,
    },
    {
      title: t('device.audit.resourceId'), dataIndex: 'resource_id', key: 'resource_id', width: 70,
      render: (v) => (v != null ? mono(v) : '—'),
    },
    {
      title: t('device.audit.detail'), dataIndex: 'detail', key: 'detail', ellipsis: true,
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
          placeholder={t('device.audit.operator')}
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          allowClear style={{ width: 160 }}
        />
        <Select
          placeholder={t('device.audit.action')}
          value={filterAction}
          onChange={setFilterAction}
          allowClear style={{ width: 180 }}
          options={ACTION_OPTIONS}
        />
        <Select
          placeholder={t('device.audit.resource')}
          value={filterResource}
          onChange={setFilterResource}
          allowClear style={{ width: 140 }}
          options={RESOURCE_OPTIONS}
        />
        <Button icon={<ReloadOutlined />} onClick={() => { void loadLogs(); }} loading={loading}>
          {t('common.refresh')}
        </Button>
        {/* 清理为破坏性操作，仅管理员可见；后端 AdminRequired 双重保障 */}
        {isAdminUser && (
          <Button danger icon={<DeleteOutlined />} onClick={() => setPurgeOpen(true)}>
            {t('device.audit.purge')}
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
        scroll={{ x: 900 }}
      />

      <Modal
        title={t('device.audit.purgeTitle')}
        open={purgeOpen}
        onOk={handlePurge}
        onCancel={() => setPurgeOpen(false)}
        okText={t('common.confirm')}
        okType="danger"
        cancelText={t('common.cancel')}
        width={420}
      >
        <p style={{ marginTop: 12 }}>{t('device.audit.purgeBody')}</p>
        <InputNumber min={1} max={3650} value={retainDays}
          onChange={(v) => setRetainDays(v ?? 90)} style={{ width: 160 }}
          addonAfter={t('device.audit.days')} />
      </Modal>
    </div>
  );
};

export default TabDeviceAuditLog;
