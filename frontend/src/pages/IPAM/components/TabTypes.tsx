import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getIPAMTypes, createIPAMType, updateIPAMType, deleteIPAMType } from '../../../api/ipam';
import type { IPAMType } from '../../../types/ipam';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabTypes: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<IPAMType[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<IPAMType | null>(null);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try { const r = await getIPAMTypes(); setData(r.data); }
    catch { message.error('Failed to load types'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter((tp) =>
      tp.name.toLowerCase().includes(q) || tp.description?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const openCreate = () => { setMode('create'); form.resetFields(); setOpen(true); };
  const openEdit   = (r: IPAMType) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: IPAMType) => {
    confirm({
      title: t('ipam.type.delTitle'), icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('ipam.type.delBody'), okText: t('ipam.type.delOk'), okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteIPAMType(r.id); message.success(t('ipam.type.delDone')); loadData(); }
        catch { message.error('Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') { await createIPAMType(values); message.success(t('ipam.type.createOk')); }
      else { await updateIPAMType(editing!.id, values); message.success(t('ipam.type.saveOk')); }
      setOpen(false); loadData();
    } catch { message.error('Request failed'); }
  };

  const columns: ColumnsType<IPAMType> = [
    { title: t('common.id'),      dataIndex: 'id',          key: 'id',   width: 70 },
    { title: t('ipam.type.name'), dataIndex: 'name',        key: 'name', width: 200 },
    { title: t('ipam.type.desc'), dataIndex: 'description', key: 'description', ellipsis: true,
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
        <Input prefix={<SearchOutlined />} placeholder={`${t('ipam.type.name')} / ${t('ipam.type.desc')}`}
          value={search} onChange={(e) => setSearch(e.target.value)} allowClear style={{ width: 260 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('ipam.type.add')}</Button>
      </Space>
      <Table columns={columns} dataSource={filtered} rowKey="id" loading={loading}
        pagination={{
          defaultPageSize: 20, pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true, showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
        }}
        scroll={{ x: 600 }}
      />
      <Modal title={mode === 'create' ? t('ipam.type.add') : t('ipam.type.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item label={t('ipam.type.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('ipam.type.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabTypes;
