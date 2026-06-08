import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getDeviceSites, createDeviceSite, updateDeviceSite, deleteDeviceSite } from '../../../api/device';
import type { DeviceSite } from '../../../types/device';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabSites: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<DeviceSite[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<DeviceSite | null>(null);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try { const r = await getDeviceSites(); setData(r.data); }
    catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Failed to load sites'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.region?.toLowerCase().includes(q) ||
      s.address?.toLowerCase().includes(q) ||
      s.description?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const openCreate = () => { setMode('create'); form.resetFields(); setOpen(true); };
  const openEdit = (r: DeviceSite) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, region: r.region, address: r.address, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: DeviceSite) => {
    confirm({
      title:   t('device.site.delTitle'),
      icon:    <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('device.site.delBody'),
      okText:  t('device.site.delOk'),
      okType:  'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteDeviceSite(r.id); message.success(t('device.site.delDone')); loadData(); }
        catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Delete failed';
          message.error(msg);
        }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') {
        await createDeviceSite(values as { name: string; region?: string; address?: string; description?: string });
        message.success(t('device.site.createOk'));
      } else {
        await updateDeviceSite(editing!.id, values as { name: string; region?: string; address?: string; description?: string });
        message.success(t('device.site.saveOk'));
      }
      setOpen(false);
      loadData();
    } catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Request failed'); }
  };

  const columns: ColumnsType<DeviceSite> = [
    { title: t('common.id'),         dataIndex: 'id',          key: 'id',     width: 70 },
    { title: t('device.site.name'),  dataIndex: 'name',        key: 'name' },
    { title: t('device.site.region'),dataIndex: 'region',      key: 'region', render: v => v || '—' },
    { title: t('device.site.address'),dataIndex:'address',     key: 'address',render: v => v || '—' },
    { title: t('device.site.desc'),  dataIndex: 'description', key: 'description', ellipsis: true,
      render: v => v || '—' },
    {
      title: t('common.actions'), key: 'action', width: 140, fixed: 'right' as const,
      render: (_: unknown, r: DeviceSite) => (
        <Space size={4}>
          <Button type="link"  size="small" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
          <Button type="text"  size="small" danger onClick={() => handleDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={`${t('device.site.name')} / ${t('device.site.region')} / ${t('device.site.address')}`}
          value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 320 }}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('device.site.add')}</Button>
      </Space>

      <Table columns={columns} dataSource={filtered} rowKey="id" loading={loading}
        pagination={{
          defaultPageSize: 20, pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true, showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
        }}
        scroll={{ x: 'max-content' }}
      />

      <Modal
        title={mode === 'create' ? t('device.site.add') : t('device.site.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('device.site.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('device.site.region')} name="region">
            <Input />
          </Form.Item>
          <Form.Item label={t('device.site.address')} name="address">
            <Input />
          </Form.Item>
          <Form.Item label={t('device.site.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabSites;
