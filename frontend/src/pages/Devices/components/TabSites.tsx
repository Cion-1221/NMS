import React, { useEffect, useMemo, useState } from 'react';
import {
  Button, Divider, Drawer, Form, Input, Modal, Space, Table, Tag, message,
} from 'antd';
import {
  ExclamationCircleFilled, PlusOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getDeviceSites, createDeviceSite, updateDeviceSite, deleteDeviceSite,
  getDevicePoPs, createDevicePoP, updateDevicePoP, deleteDevicePoP,
} from '../../../api/device';
import type { DeviceSite, DevicePoP } from '../../../types/device';
import { useT } from '../../../i18n';

const { confirm } = Modal;

// ─────────────────────────────────────────────────────────────────────────────
// Sites table + per-site PoP management in a side Drawer.
// PoP names are unique within a site (composite DB index), so editing PoPs
// inside the site context eliminates cross-site naming confusion.
// ─────────────────────────────────────────────────────────────────────────────

const TabSites: React.FC = () => {
  const t = useT();

  // ── Sites table ───────────────────────────────────────────────────────────────
  const [data, setData]       = useState<DeviceSite[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');

  // ── Create Site modal ─────────────────────────────────────────────────────────
  const [createOpen,   setCreateOpen]   = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createForm]  = Form.useForm();

  // ── Edit Site Drawer ──────────────────────────────────────────────────────────
  const [drawerOpen,   setDrawerOpen]   = useState(false);
  const [selectedSite, setSelectedSite] = useState<DeviceSite | null>(null);
  const [siteForm]    = Form.useForm();
  const [siteSaving,   setSiteSaving]   = useState(false);

  // ── PoP management (inside Drawer) ───────────────────────────────────────────
  const [pops,         setPops]         = useState<DevicePoP[]>([]);
  const [popLoading,   setPopLoading]   = useState(false);
  const [popModalOpen, setPopModalOpen] = useState(false);
  const [popMode,      setPopMode]      = useState<'create' | 'edit'>('create');
  const [editingPop,   setEditingPop]   = useState<DevicePoP | null>(null);
  const [popSaving,    setPopSaving]    = useState(false);
  const [popForm]     = Form.useForm();

  // ── Site loaders ──────────────────────────────────────────────────────────────
  const loadData = async () => {
    setLoading(true);
    try {
      const r = await getDeviceSites();
      setData(r.data);
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Failed to load sites');
    } finally {
      setLoading(false);
    }
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

  // ── PoP loader ────────────────────────────────────────────────────────────────
  const loadPops = async (siteId: number) => {
    setPopLoading(true);
    try {
      const r = await getDevicePoPs(siteId);
      setPops(r.data);
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Failed to load PoPs');
    } finally {
      setPopLoading(false);
    }
  };

  // ── Create Site ───────────────────────────────────────────────────────────────
  const openCreate = () => {
    createForm.resetFields();
    setCreateOpen(true);
  };

  const handleCreateSite = async () => {
    const values = await createForm.validateFields();
    setCreateSaving(true);
    try {
      await createDeviceSite(
        values as { name: string; region?: string; address?: string; description?: string },
      );
      message.success(t('device.site.createOk'));
      setCreateOpen(false);
      loadData();
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setCreateSaving(false);
    }
  };

  // ── Edit Site Drawer ──────────────────────────────────────────────────────────
  const openDrawer = (site: DeviceSite) => {
    setSelectedSite(site);
    siteForm.setFieldsValue({
      name:        site.name,
      region:      site.region,
      address:     site.address,
      description: site.description,
    });
    setPops([]);          // clear stale PoPs before fresh load
    setDrawerOpen(true);
    loadPops(site.id);
  };

  const handleSaveSite = async () => {
    if (!selectedSite) return;
    const values = await siteForm.validateFields();
    setSiteSaving(true);
    try {
      const res = await updateDeviceSite(
        selectedSite.id,
        values as { name: string; region?: string; address?: string; description?: string },
      );
      setSelectedSite(res.data); // update drawer title if name changed
      message.success(t('device.site.saveOk'));
      loadData();
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSiteSaving(false);
    }
  };

  // ── Delete Site ───────────────────────────────────────────────────────────────
  const handleDeleteSite = (site: DeviceSite) => {
    confirm({
      title:      t('device.site.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('device.site.delBody'),
      okText:     t('device.site.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteDeviceSite(site.id);
          message.success(t('device.site.delDone'));
          if (selectedSite?.id === site.id) setDrawerOpen(false);
          loadData();
        } catch (err: unknown) {
          message.error(err instanceof Error ? err.message : 'Delete failed');
        }
      },
    });
  };

  // ── PoP handlers ──────────────────────────────────────────────────────────────
  const openPopCreate = () => {
    setPopMode('create');
    setEditingPop(null);
    popForm.resetFields();
    setPopModalOpen(true);
  };

  const openPopEdit = (pop: DevicePoP) => {
    setPopMode('edit');
    setEditingPop(pop);
    popForm.setFieldsValue({ name: pop.name, description: pop.description });
    setPopModalOpen(true);
  };

  const handlePopSubmit = async () => {
    if (!selectedSite) return;
    const values = await popForm.validateFields();
    setPopSaving(true);
    try {
      if (popMode === 'create') {
        await createDevicePoP({
          name:        values.name        as string,
          site_id:     selectedSite.id,
          description: values.description as string | undefined,
        });
        message.success(t('device.pop.createOk'));
      } else {
        await updateDevicePoP(editingPop!.id, {
          name:        values.name        as string,
          site_id:     selectedSite.id,  // site is always the current site
          description: values.description as string | undefined,
        });
        message.success(t('device.pop.saveOk'));
      }
      setPopModalOpen(false);
      loadPops(selectedSite.id);
      // Refresh Sites table so pop_count Tag stays in sync without requiring
      // the user to manually close the Drawer and click Refresh.
      void loadData();
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setPopSaving(false);
    }
  };

  const handlePopDelete = (pop: DevicePoP) => {
    confirm({
      title:      t('device.pop.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('device.pop.delBody'),
      okText:     t('device.pop.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteDevicePoP(pop.id);
          message.success(t('device.pop.delDone'));
          if (selectedSite) loadPops(selectedSite.id);
          // Refresh Sites table so pop_count Tag stays in sync.
          void loadData();
        } catch (err: unknown) {
          message.error(err instanceof Error ? err.message : 'Delete failed');
        }
      },
    });
  };

  // ── Site table columns ────────────────────────────────────────────────────────
  const siteColumns: ColumnsType<DeviceSite> = [
    { title: t('common.id'),           dataIndex: 'id',          key: 'id',     width: 70 },
    { title: t('device.site.name'),    dataIndex: 'name',        key: 'name' },
    { title: t('device.site.region'),  dataIndex: 'region',      key: 'region', render: v => v || '—' },
    { title: t('device.site.address'), dataIndex: 'address',     key: 'address',render: v => v || '—' },
    {
      title: t('device.site.desc'), dataIndex: 'description', key: 'description',
      ellipsis: true, render: v => v || '—',
    },
    {
      // pop_count is returned by the list API (LEFT JOIN COUNT) — allows instant
      // visibility into whether a site has PoPs before attempting deletion.
      title: t('device.tab.pops'),
      dataIndex: 'pop_count',
      key: 'pop_count',
      width: 90,
      align: 'center' as const,
      render: (count: number) => (
        <Tag color={count > 0 ? 'blue' : 'default'} style={{ minWidth: 32, textAlign: 'center' }}>
          {count ?? 0}
        </Tag>
      ),
    },
    {
      title: t('common.actions'), key: 'action', width: 140, fixed: 'right' as const,
      render: (_: unknown, r: DeviceSite) => (
        <Space size={4}>
          <Button type="link"  size="small" onClick={() => openDrawer(r)}>{t('common.edit')}</Button>
          <Button type="text"  size="small" danger onClick={() => handleDeleteSite(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  // ── PoP table columns (inside Drawer) ────────────────────────────────────────
  const popColumns: ColumnsType<DevicePoP> = [
    { title: t('common.id'),       dataIndex: 'id',          key: 'id',   width: 60 },
    { title: t('device.pop.name'), dataIndex: 'name',        key: 'name' },
    {
      title: t('device.pop.desc'), dataIndex: 'description', key: 'description',
      ellipsis: true, render: v => v || '—',
    },
    {
      title: t('common.actions'), key: 'action', width: 130,
      render: (_: unknown, r: DevicePoP) => (
        <Space size={4}>
          <Button type="link"  size="small" onClick={() => openPopEdit(r)}>{t('common.edit')}</Button>
          <Button type="text"  size="small" danger onClick={() => handlePopDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Filter + actions ── */}
      <Space style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={`${t('device.site.name')} / ${t('device.site.region')} / ${t('device.site.address')}`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          allowClear
          style={{ width: 340 }}
        />
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
          {t('common.refresh')}
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('device.site.add')}
        </Button>
      </Space>

      {/* ── Sites table ── */}
      <Table
        columns={siteColumns}
        dataSource={filtered}
        rowKey="id"
        loading={loading}
        pagination={{
          defaultPageSize: 20,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
        }}
        scroll={{ x: 'max-content' }}
      />

      {/* ── Create Site modal ── */}
      <Modal
        title={t('device.site.add')}
        open={createOpen}
        onOk={handleCreateSite}
        onCancel={() => setCreateOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={createSaving}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 8 }}>
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

      {/* ── Edit Site Drawer (site form + embedded PoP management) ── */}
      <Drawer
        title={selectedSite ? `${t('device.site.edit')} — ${selectedSite.name}` : ''}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={680}
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button onClick={() => setDrawerOpen(false)}>{t('common.cancel')}</Button>
          </div>
        }
      >
        {/* Section 1: site details */}
        <Divider orientation="start" style={{ marginTop: 0 }}>
          {t('device.site.infoSection')}
        </Divider>
        <Form form={siteForm} layout="vertical">
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
        <div style={{ textAlign: 'right', marginBottom: 24 }}>
          <Button type="primary" loading={siteSaving} onClick={handleSaveSite}>
            {t('device.site.saveSite')}
          </Button>
        </div>

        {/* Section 2: PoP management */}
        <Divider orientation="start">{t('device.tab.pops')}</Divider>
        <div style={{ marginBottom: 12 }}>
          <Space>
            <Button type="primary" icon={<PlusOutlined />} size="small" onClick={openPopCreate}>
              {t('device.pop.add')}
            </Button>
            <Button
              icon={<ReloadOutlined />}
              size="small"
              loading={popLoading}
              onClick={() => selectedSite && loadPops(selectedSite.id)}
            >
              {t('common.refresh')}
            </Button>
          </Space>
        </div>
        <Table
          columns={popColumns}
          dataSource={pops}
          rowKey="id"
          loading={popLoading}
          size="small"
          pagination={{
            defaultPageSize: 10,
            pageSizeOptions: ['10', '20', '50'],
            showSizeChanger: true,
            showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
          }}
        />
      </Drawer>

      {/* ── PoP create/edit modal (at root to avoid z-index conflicts with Drawer) ── */}
      <Modal
        title={popMode === 'create' ? t('device.pop.add') : t('device.pop.edit')}
        open={popModalOpen}
        onOk={handlePopSubmit}
        onCancel={() => setPopModalOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={popSaving}
        destroyOnClose
      >
        <Form form={popForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('device.pop.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('device.pop.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabSites;
