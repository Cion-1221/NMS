import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getDeviceRoles, createDeviceRole, updateDeviceRole, deleteDeviceRole } from '../../../api/device';
import type { DeviceRole } from '../../../types/device';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabRoles: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<DeviceRole[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<DeviceRole | null>(null);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try { const r = await getDeviceRoles(); setData(r.data); }
    catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Failed to load roles'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter(r =>
      r.name.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const openCreate = () => { setMode('create'); form.resetFields(); setOpen(true); };
  const openEdit = (r: DeviceRole) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: DeviceRole) => {
    confirm({
      title:   t('device.role.delTitle'),
      icon:    <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('device.role.delBody'),
      okText:  t('device.role.delOk'),
      okType:  'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteDeviceRole(r.id); message.success(t('device.role.delDone')); loadData(); }
        catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') {
        await createDeviceRole(values as { name: string; description?: string });
        message.success(t('device.role.createOk'));
      } else {
        await updateDeviceRole(editing!.id, values as { name: string; description?: string });
        message.success(t('device.role.saveOk'));
      }
      setOpen(false); loadData();
    } catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Request failed'); }
  };

  const columns: ColumnsType<DeviceRole> = [
    { title: t('common.id'),        dataIndex: 'id',          key: 'id',   width: 70 },
    { title: t('device.role.name'), dataIndex: 'name',        key: 'name' },
    { title: t('device.role.desc'), dataIndex: 'description', key: 'description', ellipsis: true,
      render: v => v || '—' },
    {
      title: t('common.actions'), key: 'action', width: 140, fixed: 'right' as const,
      render: (_: unknown, r: DeviceRole) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={`${t('device.role.name')} / ${t('device.role.desc')}`}
          value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 260 }}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('device.role.add')}</Button>
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
        title={mode === 'create' ? t('device.role.add') : t('device.role.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('device.role.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('device.role.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabRoles;
