import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getGroups, createGroup, updateGroup, deleteGroup } from '../../../api/ipam';
import type { IPAMGroup } from '../../../types/ipam';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabGroups: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<IPAMGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<IPAMGroup | null>(null);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try { const r = await getGroups(); setData(r.data); }
    catch { message.error('Failed to load groups'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter((g) =>
      g.name.toLowerCase().includes(q) || g.description?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const openCreate = () => { setMode('create'); form.resetFields(); setOpen(true); };
  const openEdit   = (r: IPAMGroup) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: IPAMGroup) => {
    confirm({
      title: t('ipam.group.delTitle'), icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('ipam.group.delBody'), okText: t('ipam.group.delOk'), okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteGroup(r.id); message.success(t('ipam.group.delDone')); loadData(); }
        catch { message.error('Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') { await createGroup(values); message.success(t('ipam.group.createOk')); }
      else { await updateGroup(editing!.id, values); message.success(t('ipam.group.saveOk')); }
      setOpen(false); loadData();
    } catch { message.error('Request failed'); }
  };

  const columns: ColumnsType<IPAMGroup> = [
    { title: t('common.id'),       dataIndex: 'id',          key: 'id',   width: 70 },
    { title: t('ipam.group.name'), dataIndex: 'name',        key: 'name', width: 200 },
    { title: t('ipam.group.desc'), dataIndex: 'description', key: 'description', ellipsis: true,
      render: (v) => v || '—' },
    {
      title: t('common.actions'), key: 'action', width: 140, fixed: 'right',
      render: (_, r) => (
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
        <Input prefix={<SearchOutlined />} placeholder={`${t('ipam.group.name')} / ${t('ipam.group.desc')}`}
          value={search} onChange={(e) => setSearch(e.target.value)} allowClear style={{ width: 260 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('ipam.group.add')}</Button>
      </Space>
      <Table columns={columns} dataSource={filtered} rowKey="id" loading={loading}
        pagination={{
          defaultPageSize: 20, pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true, showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
        }}
        scroll={{ x: 600 }}
      />
      <Modal title={mode === 'create' ? t('ipam.group.add') : t('ipam.group.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item label={t('ipam.group.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('ipam.group.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabGroups;
