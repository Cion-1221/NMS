import React, { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getGroups, createGroup, updateGroup, deleteGroup } from '../../../api/ipam';
import type { IPAMGroup } from '../../../types/ipam';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabGroups: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<IPAMGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<IPAMGroup | null>(null);
  const [form] = Form.useForm();

  const fetch = async () => {
    setLoading(true);
    try { const r = await getGroups(); setData(r.data); }
    catch { message.error('Failed to load groups'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetch(); }, []);

  const openCreate = () => {
    setMode('create'); form.resetFields(); setOpen(true);
  };

  const openEdit = (r: IPAMGroup) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: IPAMGroup) => {
    confirm({
      title:      t('ipam.group.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('ipam.group.delBody'),
      okText:     t('ipam.group.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteGroup(r.id); message.success(t('ipam.group.delDone')); fetch(); }
        catch { message.error('Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') {
        await createGroup(values); message.success(t('ipam.group.createOk'));
      } else {
        await updateGroup(editing!.id, values); message.success(t('ipam.group.saveOk'));
      }
      setOpen(false); fetch();
    } catch { message.error('Request failed'); }
  };

  const columns: ColumnsType<IPAMGroup> = [
    { title: t('common.id'),        dataIndex: 'id',          key: 'id', width: 70 },
    { title: t('ipam.group.name'),  dataIndex: 'name',        key: 'name' },
    { title: t('ipam.group.desc'),  dataIndex: 'description', key: 'description', render: (v) => v || '—' },
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
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('ipam.group.add')}</Button>
      </div>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n) => `${n} items` }} />
      <Modal
        title={mode === 'create' ? t('ipam.group.add') : t('ipam.group.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
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
