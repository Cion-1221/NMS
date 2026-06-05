import React, { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getVRFs, createVRF, updateVRF, deleteVRF } from '../../../api/ipam';
import type { IPAMVRF } from '../../../types/ipam';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabVRF: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<IPAMVRF[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<IPAMVRF | null>(null);
  const [form] = Form.useForm();

  const fetch = async () => {
    setLoading(true);
    try { const r = await getVRFs(); setData(r.data); }
    catch { message.error('Failed to load VRFs'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetch(); }, []);

  const openCreate = () => {
    setMode('create'); form.resetFields(); setOpen(true);
  };

  const openEdit = (r: IPAMVRF) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, rd: r.rd, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: IPAMVRF) => {
    confirm({
      title:      t('ipam.vrf.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('ipam.vrf.delBody'),
      okText:     t('ipam.vrf.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteVRF(r.id); message.success(t('ipam.vrf.delDone')); fetch(); }
        catch { message.error('Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') {
        await createVRF(values); message.success(t('ipam.vrf.createOk'));
      } else {
        await updateVRF(editing!.id, values); message.success(t('ipam.vrf.saveOk'));
      }
      setOpen(false); fetch();
    } catch { message.error('Request failed'); }
  };

  const columns: ColumnsType<IPAMVRF> = [
    { title: t('common.id'),      dataIndex: 'id',          key: 'id',   width: 70 },
    { title: t('ipam.vrf.name'),  dataIndex: 'name',        key: 'name' },
    { title: t('ipam.vrf.rd'),    dataIndex: 'rd',          key: 'rd',   render: (v) => v || '—' },
    { title: t('ipam.vrf.desc'),  dataIndex: 'description', key: 'description', render: (v) => v || '—' },
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
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('ipam.vrf.add')}</Button>
      </div>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n) => `${n} items` }} />
      <Modal
        title={mode === 'create' ? t('ipam.vrf.add') : t('ipam.vrf.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label={t('ipam.vrf.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('ipam.vrf.rd')} name="rd"
            extra="e.g. 65000:100">
            <Input placeholder="65000:100" />
          </Form.Item>
          <Form.Item label={t('ipam.vrf.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabVRF;
