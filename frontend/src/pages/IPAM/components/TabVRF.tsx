import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getVRFs, createVRF, updateVRF, deleteVRF } from '../../../api/ipam';
import type { IPAMVRF } from '../../../types/ipam';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_IPAM_WRITE, useCan } from '../../../utils/perms';
import { FONT_MONO } from '../../../theme/theme';

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

const { confirm } = Modal;

const TabVRF: React.FC = () => {
  const t = useT();
  const canWrite = useCan(PERM_IPAM_WRITE);
  const [data, setData]       = useState<IPAMVRF[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<IPAMVRF | null>(null);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try { const r = await getVRFs(); setData(r.data); }
    catch (err) { message.error(apiErrMsg(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter((v) =>
      v.name.toLowerCase().includes(q) ||
      v.rd?.toLowerCase().includes(q) ||
      v.description?.toLowerCase().includes(q),
    );
  }, [data, search]);

  const openCreate = () => { setMode('create'); form.resetFields(); setOpen(true); };
  const openEdit   = (r: IPAMVRF) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, rd: r.rd, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: IPAMVRF) => {
    confirm({
      title: t('ipam.vrf.delTitle'), icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('ipam.vrf.delBody'), okText: t('ipam.vrf.delOk'), okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteVRF(r.id); message.success(t('ipam.vrf.delDone')); loadData(); }
        catch (err) { message.error(apiErrMsg(err)); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') { await createVRF(values); message.success(t('ipam.vrf.createOk')); }
      else { await updateVRF(editing!.id, values); message.success(t('ipam.vrf.saveOk')); }
      setOpen(false); loadData();
    } catch (err) { message.error(apiErrMsg(err)); }
  };

  const columns: ColumnsType<IPAMVRF> = [
    { title: t('common.id'),     dataIndex: 'id',          key: 'id',   width: 70, render: (v: number) => mono(v) },
    { title: t('ipam.vrf.name'), dataIndex: 'name',        key: 'name', width: 160, render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: t('ipam.vrf.rd'),   dataIndex: 'rd',          key: 'rd',   width: 160, render: (v) => (v ? mono(v) : '—') },
    { title: t('ipam.vrf.desc'), dataIndex: 'description', key: 'description', ellipsis: true,
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
        <Input prefix={<SearchOutlined />}
          placeholder={`${t('ipam.vrf.name')} / RD / ${t('ipam.vrf.desc')}`}
          value={search} onChange={(e) => setSearch(e.target.value)} allowClear style={{ width: 280 }} />
        {canWrite && <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('ipam.vrf.add')}</Button>}
      </Space>
      <Table columns={canWrite ? columns : columns.filter((c) => c.key !== 'action')} dataSource={filtered} rowKey="id" loading={loading}
        pagination={{
          defaultPageSize: 20, pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true, showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
        }}
        scroll={{ x: 700 }}
      />
      <Modal title={mode === 'create' ? t('ipam.vrf.add') : t('ipam.vrf.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item label={t('ipam.vrf.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('ipam.vrf.rd')} name="rd" extra="e.g. 65000:100">
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
