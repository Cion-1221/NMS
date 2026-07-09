import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listSysAuditLogs, purgeSysAuditLogs } from '../../../../api/system';
import type { SysAuditLog } from '../../../../types/system';
import { apiErrMsg, useT } from '../../../../i18n';
import { FONT_MONO } from '../../../../theme/theme';

// ─────────────────────────────────────────────────────────────────────────────
// System 审计日志 Tab：用户/用户组/安全设置/会话管理的敏感操作留痕。
// 内容格式（列布局/操作类型配色/筛选栏）与 IPAM/Devices 审计 Tab 保持一致；
// 清理（Purge）交互是三处审计日志的共同标准——按钮打开弹窗输入保留天数，
// 而非页面内常驻输入框 + 原生 confirm。
// ─────────────────────────────────────────────────────────────────────────────

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
  create_user: 'green', update_user: 'blue', delete_user: 'red', force_logout: 'volcano',
  change_password: 'blue',
  create_group: 'green', update_group: 'blue', delete_group: 'red',
  update_security_settings: 'blue', update_session_policy: 'blue',
  unlock_lockouts: 'cyan',
  purge_audit: 'orange',
};

// ACTION_OPTIONS is the single source of truth: add a new entry to ACTION_COLOR
// above and it automatically appears in both the color renderer and the filter.
const ACTION_OPTIONS = Object.keys(ACTION_COLOR).map(a => ({ value: a, label: a }));

const RESOURCE_OPTIONS = ['user', 'group', 'settings', 'lockout', 'audit_log']
  .map(r => ({ value: r, label: r }));

const TabSysAuditLog: React.FC = () => {
  const t = useT();

  const [data, setData]         = useState<SysAuditLog[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading]   = useState(false);

  const [filterUser,     setFilterUser]     = useState('');
  const [filterAction,   setFilterAction]   = useState<string | undefined>();
  const [filterResource, setFilterResource] = useState<string | undefined>();

  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeDays, setPurgeDays] = useState<number>(180);

  const reqSeq = useRef(0);

  const loadLogs = useCallback(async (
    p = page, ps = pageSize,
    u = filterUser, a = filterAction, rt = filterResource,
  ) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await listSysAuditLogs({
        page: p, page_size: ps,
        username:      u  || undefined,
        action:        a  || undefined,
        resource_type: rt || undefined,
      });
      if (seq !== reqSeq.current) return;
      setData(r.data.items ?? []);
      setTotal(r.data.total);
    } catch (err: unknown) {
      if (seq === reqSeq.current) message.error(apiErrMsg(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void loadLogs(1, pageSize); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearch = () => { setPage(1); void loadLogs(1, pageSize, filterUser, filterAction, filterResource); };

  const handleTableChange = (p: number, ps: number) => {
    setPage(p); setPageSize(ps);
    void loadLogs(p, ps, filterUser, filterAction, filterResource);
  };

  const handlePurge = async () => {
    try {
      const r = await purgeSysAuditLogs(purgeDays);
      message.success(t('sysaudit.purgeOk', { n: Number(r.data.deleted) }));
      setPurgeOpen(false);
      void loadLogs(1, pageSize, filterUser, filterAction, filterResource);
      setPage(1);
    } catch (err: unknown) { message.error(apiErrMsg(err)); }
  };

  const columns: ColumnsType<SysAuditLog> = [
    {
      title: t('sysaudit.time'), dataIndex: 'created_at', key: 'created_at', width: 130,
      render: (v: string) => timeCell(v),
    },
    {
      title: t('sys.user.username'), dataIndex: 'username', key: 'username', width: 120,
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: t('sysaudit.action'), dataIndex: 'action', key: 'action', width: 210,
      render: (v: string) => <Tag color={ACTION_COLOR[v] ?? 'default'}>{v}</Tag>,
    },
    {
      title: t('sysaudit.resource'), dataIndex: 'resource_type', key: 'resource_type', width: 110,
    },
    {
      title: t('sysaudit.resourceId'), dataIndex: 'resource_id', key: 'resource_id', width: 140,
      render: (v: string) => (v ? mono(v) : '—'),
    },
    {
      title: t('sysaudit.detail'), dataIndex: 'detail', key: 'detail', ellipsis: true,
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
          placeholder={t('sysaudit.search')}
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          onPressEnter={handleSearch}
          allowClear style={{ width: 160 }}
        />
        <Select
          placeholder={t('sysaudit.action')}
          value={filterAction}
          onChange={setFilterAction}
          allowClear style={{ width: 200 }}
          options={ACTION_OPTIONS}
        />
        <Select
          placeholder={t('sysaudit.resource')}
          value={filterResource}
          onChange={setFilterResource}
          allowClear style={{ width: 140 }}
          options={RESOURCE_OPTIONS}
        />
        <Button type="primary" onClick={handleSearch}>{t('common.search')}</Button>
        <Button icon={<ReloadOutlined />} onClick={() => { void loadLogs(); }} loading={loading}>
          {t('common.refresh')}
        </Button>
        <Button danger icon={<DeleteOutlined />} onClick={() => setPurgeOpen(true)}>
          {t('sysaudit.purge')}
        </Button>
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
        scroll={{ x: 1000 }}
      />

      <Modal
        title={t('sysaudit.purgeTitle')}
        open={purgeOpen}
        onOk={handlePurge}
        onCancel={() => setPurgeOpen(false)}
        okText={t('common.confirm')}
        okType="danger"
        cancelText={t('common.cancel')}
        width={420}
      >
        <p style={{ marginTop: 12 }}>{t('sysaudit.purgeBody')}</p>
        <InputNumber min={1} max={3650} value={purgeDays}
          onChange={(v) => setPurgeDays(v ?? 180)} style={{ width: 160 }}
          addonAfter={t('sysaudit.days')} />
      </Modal>
    </div>
  );
};

export default TabSysAuditLog;
