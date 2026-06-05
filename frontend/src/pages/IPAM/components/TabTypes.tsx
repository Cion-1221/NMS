import React, { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getIPAMTypes, createIPAMType, updateIPAMType, deleteIPAMType } from '../../../api/ipam';
import type { IPAMType } from '../../../types/ipam';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabTypes: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<IPAMType[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<IPAMType | null>(null);
  const [form] = Form.useForm();

  const fetch = async () => {
    setLoading(true);
    try { const r = await getIPAMTypes(); setData(r.data); }
    catch { message.error('Failed to load types'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetch(); }, []);

  const openCreate = () => {
    setMode('create'); form.resetFields(); setOpen(true);
  };

  const openEdit = (r: IPAMType) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: IPAMType) => {
    confirm({
      title:      t('ipam.type.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('ipam.type.delBody'),
      okText:     t('ipam.type.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteIPAMType(r.id); message.success(t('ipam.type.delDone')); fetch(); }
        catch { message.error('Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') {
        await createIPAMType(values); message.success(t('ipam.type.createOk'));
      } else {
        await updateIPAMType(editing!.id, values); message.success(t('ipam.type.saveOk'));
      }
      setOpen(false); fetch();
    } catch { message.error('Request failed'); }
  };

  const columns: ColumnsType<IPAMType> = [
    { title: t('common.id'),       dataIndex: 'id',          key: 'id', width: 70 },
    { title: t('ipam.type.name'),  dataIndex: 'name',        key: 'name' },
    { title: t('ipam.type.desc'),  dataIndex: 'description', key: 'description', render: (v) => v || '—' },
    {
      title:  t('common.actions'),
      key:    'action',
      width:  150,
      render: (_, r) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('ipam.type.add')}</Button>
      </div>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n) => `${n} items` }} />
      <Modal
        title={mode === 'create' ? t('ipam.type.add') : t('ipam.type.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
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
