import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getDevicePoPs, createDevicePoP, updateDevicePoP, deleteDevicePoP,
  getDeviceSites,
} from '../../../api/device';
import type { DevicePoP, DeviceSite } from '../../../types/device';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabPoPs: React.FC = () => {
  const t = useT();
  const [data, setData]         = useState<DevicePoP[]>([]);
  const [loading, setLoading]   = useState(false);
  const [sites, setSites]       = useState<DeviceSite[]>([]);
  const [search, setSearch]     = useState('');
  const [filterSiteId, setFilterSiteId] = useState<number | undefined>();
  const [open, setOpen]         = useState(false);
  const [mode, setMode]         = useState<'create' | 'edit'>('create');
  const [editing, setEditing]   = useState<DevicePoP | null>(null);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try { const r = await getDevicePoPs(); setData(r.data); }
    catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Failed to load PoPs'); }
    finally { setLoading(false); }
  };

  const loadSites = async () => {
    try { const r = await getDeviceSites(); setSites(r.data); }
    catch { /* silently ignore */ }
  };

  useEffect(() => { loadData(); loadSites(); }, []);

  // Re-fetch sites when modal opens
  useEffect(() => { if (open) loadSites(); }, [open]);

  const filtered = useMemo(() => {
    return data.filter(p => {
      if (filterSiteId != null && p.site_id !== filterSiteId) return false;
      if (search) {
        const q = search.toLowerCase();
        return p.name.toLowerCase().includes(q) || (p.description?.toLowerCase().includes(q) ?? false);
      }
      return true;
    });
  }, [data, filterSiteId, search]);

  const openCreate = () => { setMode('create'); form.resetFields(); setOpen(true); };
  const openEdit = (r: DevicePoP) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, site_id: r.site_id, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: DevicePoP) => {
    confirm({
      title:   t('device.pop.delTitle'),
      icon:    <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('device.pop.delBody'),
      okText:  t('device.pop.delOk'),
      okType:  'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteDevicePoP(r.id); message.success(t('device.pop.delDone')); loadData(); }
        catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      const payload = { name: values.name as string, site_id: values.site_id as number, description: values.description as string | undefined };
      if (mode === 'create') {
        await createDevicePoP(payload);
        message.success(t('device.pop.createOk'));
      } else {
        await updateDevicePoP(editing!.id, payload);
        message.success(t('device.pop.saveOk'));
      }
      setOpen(false); loadData();
    } catch (err: unknown) { message.error(err instanceof Error ? err.message : 'Request failed'); }
  };

  const columns: ColumnsType<DevicePoP> = [
    { title: t('common.id'),       dataIndex: 'id',   key: 'id',   width: 70 },
    { title: t('device.pop.name'), dataIndex: 'name', key: 'name' },
    { title: t('device.pop.site'), key: 'site', render: (_, r) => r.site?.name ?? '—' },
    { title: t('device.pop.desc'), dataIndex: 'description', key: 'description', ellipsis: true,
      render: v => v || '—' },
    {
      title: t('common.actions'), key: 'action', width: 140, fixed: 'right' as const,
      render: (_: unknown, r: DevicePoP) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={`${t('device.pop.name')} / ${t('device.pop.desc')}`}
          value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 240 }}
        />
        <Select
          placeholder={t('device.pop.siteFilter')}
          value={filterSiteId}
          onChange={setFilterSiteId}
          allowClear style={{ width: 180 }}
          options={sites.map(s => ({ value: s.id, label: s.name }))}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('device.pop.add')}</Button>
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
        title={mode === 'create' ? t('device.pop.add') : t('device.pop.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('device.pop.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('device.pop.site')} name="site_id" rules={[{ required: true }]}>
            <Select options={sites.map(s => ({ value: s.id, label: s.name }))} />
          </Form.Item>
          <Form.Item label={t('device.pop.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabPoPs;
