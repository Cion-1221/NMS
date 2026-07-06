import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, InputNumber, Modal, Space, Table, message } from 'antd';
import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listSysAuditLogs, purgeSysAuditLogs } from '../../../../api/system';
import type { SysAuditLog } from '../../../../types/system';
import { apiErrMsg, useT } from '../../../../i18n';
import { useDebounced } from '../../../../utils/useDebounced';
import StatusTag from '../../../../components/StatusTag';
import RelativeTime from '../../../../components/RelativeTime';
import { FONT_MONO } from '../../../../theme/theme';

// ─────────────────────────────────────────────────────────────────────────────
// System 审计日志 Tab：用户/用户组/安全设置/会话管理的敏感操作留痕
// （与 IPAM/Devices 审计 Tab 同款交互：服务端分页 + 用户名搜索 + 按天数清理）。
// ─────────────────────────────────────────────────────────────────────────────

const TabSysAuditLog: React.FC = () => {
  const t = useT();

  const [logs, setLogs]         = useState<SysAuditLog[]>([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal]       = useState(0);

  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeDays, setPurgeDays] = useState<number>(180);

  const debSearch = useDebounced(search);
  const reqSeq = useRef(0);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await listSysAuditLogs({
        page, page_size: pageSize,
        username: debSearch || undefined,
      });
      if (seq !== reqSeq.current) return;
      setLogs(r.data.items ?? []);
      setTotal(r.data.total);
    } catch (err) {
      if (seq === reqSeq.current) message.error(apiErrMsg(err));
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debSearch]);

  useEffect(() => { setPage(1); }, [debSearch]);
  useEffect(() => { void loadData(); }, [loadData]);

  const handlePurge = async () => {
    try {
      const r = await purgeSysAuditLogs(purgeDays);
      message.success(t('sysaudit.purgeOk', { n: Number(r.data.deleted) }));
      setPurgeOpen(false);
      void loadData();
    } catch (err) { message.error(apiErrMsg(err)); }
  };

  const columns: ColumnsType<SysAuditLog> = [
    {
      title: t('sysaudit.time'), dataIndex: 'created_at', key: 'created_at', width: 140,
      render: (v: string) => <RelativeTime value={v} />,
    },
    {
      title: t('sys.user.username'), dataIndex: 'username', key: 'username', width: 140,
      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    {
      title: t('sysaudit.action'), dataIndex: 'action', key: 'action', width: 200,
      render: (v: string) => <StatusTag status="used" tone="teal" label={v} />,
    },
    {
      title: t('sysaudit.resource'), key: 'resource', width: 200,
      render: (_, r) => (
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
          {r.resource_type}{r.resource_id ? ` / ${r.resource_id}` : ''}
        </span>
      ),
    },
    { title: t('sysaudit.detail'), dataIndex: 'detail', key: 'detail', ellipsis: true },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('sysaudit.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{ width: 240 }}
        />
        <Button icon={<ReloadOutlined />} onClick={() => { void loadData(); }} loading={loading}>
          {t('common.refresh')}
        </Button>
        <Button danger icon={<DeleteOutlined />} onClick={() => setPurgeOpen(true)}>
          {t('sysaudit.purge')}
        </Button>
      </Space>

      <Table
        columns={columns}
        dataSource={logs}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page, pageSize, total,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
          onChange: (p, ps) => {
            if (ps !== pageSize) { setPageSize(ps); setPage(1); } else { setPage(p); }
          },
        }}
        scroll={{ x: 'max-content' }}
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
