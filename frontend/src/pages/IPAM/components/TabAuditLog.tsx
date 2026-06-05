import React, { useEffect, useState } from 'react';
import { Button, InputNumber, Modal, Space, Table, Tag, Tooltip, message } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getAuditLogs, purgeAuditLogs } from '../../../api/ipam';
import type { IPAMAuditLog } from '../../../types/ipam';
import { useT } from '../../../i18n';

const ACTION_COLORS: Record<string, string> = {
  create_root:   'green',
  update_root:   'blue',
  delete_root:   'red',
  split:         'cyan',
  merge:         'purple',
  update_subnet: 'blue',
  create_group:  'green',
  update_group:  'blue',
  delete_group:  'red',
  create_type:   'green',
  update_type:   'blue',
  delete_type:   'red',
  create_vrf:    'green',
  update_vrf:    'blue',
  delete_vrf:    'red',
  purge_audit:   'orange',
};

const TabAuditLog: React.FC = () => {
  const t = useT();
  const [data, setData]         = useState<IPAMAuditLog[]>([]);
  const [total, setTotal]       = useState(0);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading]   = useState(false);
  const [retainDays, setRetainDays] = useState<number>(90);

  const loadLogs = async (p = page, ps = pageSize) => {
    setLoading(true);
    try {
      const r = await getAuditLogs(p, ps);
      setData(r.data.items ?? []);
      setTotal(r.data.total);
    } catch {
      message.error('Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLogs(); }, []);

  const handleTableChange = (p: number, ps: number) => {
    setPage(p); setPageSize(ps); loadLogs(p, ps);
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
          loadLogs(1, pageSize);
          setPage(1);
        } catch {
          message.error('Purge failed');
        }
      },
    });
  };

  const columns: ColumnsType<IPAMAuditLog> = [
    {
      title:     t('ipam.audit.time'),
      dataIndex: 'created_at',
      key:       'created_at',
      width:     170,
      render:    (v: string) => new Date(v).toLocaleString(),
    },
    {
      title:     t('ipam.audit.operator'),
      dataIndex: 'username',
      key:       'username',
      width:     120,
      render:    (v: string) => <strong>{v}</strong>,
    },
    {
      title:     t('ipam.audit.action'),
      dataIndex: 'action',
      key:       'action',
      width:     140,
      render:    (v: string) => (
        <Tag color={ACTION_COLORS[v] ?? 'default'}>{v}</Tag>
      ),
    },
    {
      title:     t('ipam.audit.resource'),
      dataIndex: 'resource_type',
      key:       'resource_type',
      width:     130,
    },
    {
      title:     t('ipam.audit.resourceId'),
      dataIndex: 'resource_id',
      key:       'resource_id',
      width:     80,
      render:    (v) => v ?? '—',
    },
    {
      title:     t('ipam.audit.detail'),
      dataIndex: 'detail',
      key:       'detail',
      render:    (v: string) => (
        <Tooltip title={v} placement="topLeft">
          <span style={{ maxWidth: 400, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {v}
          </span>
        </Tooltip>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <span style={{ fontWeight: 500 }}>{t('ipam.audit.retain')}</span>
        <InputNumber
          min={1} max={3650}
          value={retainDays}
          onChange={(v) => setRetainDays(v ?? 90)}
          addonAfter={t('ipam.audit.days')}
          style={{ width: 180 }}
        />
        <Button danger icon={<DeleteOutlined />} onClick={handlePurge}>
          {t('ipam.audit.purge')}
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
          showTotal:       (total2, range) => `${range[0]}-${range[1]} / ${total2}`,
          onChange:        handleTableChange,
        }}
        scroll={{ x: 900 }}
      />
    </div>
  );
};

export default TabAuditLog;
