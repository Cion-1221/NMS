import React, { useEffect, useState } from 'react';
import {
  Button, Form, Input, Modal, Radio, Select, Space, Table, Tag, Tooltip, message,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { AxiosError } from 'axios';
import type { ColumnsType } from 'antd/es/table';
import {
  getRootPrefixes, createRootPrefix, updateRootPrefix, deleteRootPrefix,
  getGroups, getIPAMTypes, getVRFs,
} from '../../../api/ipam';
import type { RootPrefix, IPAMGroup, IPAMType, IPAMVRF } from '../../../types/ipam';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabRootPrefix: React.FC = () => {
  const t = useT();
  const [data, setData]           = useState<RootPrefix[]>([]);
  const [loading, setLoading]     = useState(false);
  const [searchText, setSearch]   = useState('');
  const [filterIPv, setFilterIPv] = useState<number | undefined>();

  const [groups, setGroups] = useState<IPAMGroup[]>([]);
  const [types,  setTypes]  = useState<IPAMType[]>([]);
  const [vrfs,   setVRFs]   = useState<IPAMVRF[]>([]);

  const [isModalOpen, setIsModalOpen]     = useState(false);
  const [modalMode, setModalMode]         = useState<'create' | 'edit'>('create');
  const [editingRecord, setEditingRecord] = useState<RootPrefix | null>(null);
  const [form] = Form.useForm();

  const fetchList = async () => {
    setLoading(true);
    try { const res = await getRootPrefixes(); setData(res.data); }
    catch { message.error('Failed to load root prefixes'); }
    finally { setLoading(false); }
  };

  const fetchLookups = async () => {
    try {
      const [g, tp, v] = await Promise.all([getGroups(), getIPAMTypes(), getVRFs()]);
      setGroups(g.data); setTypes(tp.data); setVRFs(v.data);
    } catch { /* non-critical */ }
  };

  useEffect(() => { fetchList(); fetchLookups(); }, []);

  // Unified full-text filter across all text fields
  const filtered = data.filter((r) => {
    if (filterIPv && r.ip_version !== filterIPv) return false;
    if (searchText) {
      const q = searchText.toLowerCase();
      const haystack = [
        r.cidr,
        r.group?.name,
        r.type?.name,
        r.vrf?.name,
        r.vrf?.rd,
        r.remark,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const openCreate = () => {
    setModalMode('create'); form.resetFields();
    form.setFieldsValue({ ip_version: 4 });
    setIsModalOpen(true);
  };

  const openEdit = (r: RootPrefix) => {
    setModalMode('edit'); setEditingRecord(r);
    form.setFieldsValue({
      ip_version: r.ip_version,
      cidr:       r.cidr,
      group_id:   r.group_id  ?? undefined,
      type_id:    r.type_id   ?? undefined,
      vrf_id:     r.vrf_id    ?? undefined,
      remark:     r.remark    ?? '',
    });
    setIsModalOpen(true);
  };

  const handleDelete = (id: number, _cidr: string) => {
    confirm({
      title:      t('ipam.root.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('ipam.root.delBody'),
      okText:     t('ipam.root.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteRootPrefix(id); message.success(t('ipam.root.delDone')); fetchList(); }
        catch { message.error('Delete failed'); }
      },
    });
  };

  const handleSubmit = async () => {
    try {
      const v = await form.validateFields();
      if (modalMode === 'create') {
        await createRootPrefix({
          ip_version: v.ip_version,
          cidr:       v.cidr,
          group_id:   v.group_id  ?? null,
          type_id:    v.type_id   ?? null,
          vrf_id:     v.vrf_id    ?? null,
          remark:     v.remark    ?? '',
        });
        message.success(t('ipam.root.createOk'));
      } else {
        await updateRootPrefix(editingRecord!.id, {
          group_id: v.group_id ?? null,
          type_id:  v.type_id  ?? null,
          vrf_id:   v.vrf_id   ?? null,
          remark:   v.remark   ?? '',
        });
        message.success(t('ipam.root.saveOk'));
      }
      setIsModalOpen(false); fetchList();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      if (err instanceof AxiosError && err.response?.status === 400) {
        Modal.error({ title: 'Validation Error', content: err.response.data.error });
      } else {
        message.error('Request failed');
      }
    }
  };

  const groupOpts = groups.map((g)  => ({ value: g.id,  label: g.name }));
  const typeOpts  = types.map((tp)  => ({ value: tp.id, label: tp.name }));
  const vrfOpts   = vrfs.map((v)    => ({ value: v.id,  label: v.rd ? `${v.name} (${v.rd})` : v.name }));

  const columns: ColumnsType<RootPrefix> = [
    { title: t('common.id'), dataIndex: 'id', key: 'id', width: 60 },
    {
      title: t('ipam.root.ipver'), dataIndex: 'ip_version', key: 'ip_version', width: 90,
      render: (v: number) => <Tag color={v === 4 ? 'blue' : 'green'}>IPv{v}</Tag>,
    },
    {
      title: t('ipam.root.cidr'), dataIndex: 'cidr', key: 'cidr', width: 180,
      render: (v: string) => <strong>{v}</strong>,
    },
    { title: t('ipam.root.group'), key: 'group', width: 110, render: (_, r) => r.group?.name || '—' },
    { title: t('ipam.root.type'),  key: 'type',  width: 110, render: (_, r) => r.type?.name  || '—' },
    {
      title: t('ipam.root.vrf'), key: 'vrf', width: 130,
      render: (_, r) => r.vrf ? `${r.vrf.name}${r.vrf.rd ? ` (${r.vrf.rd})` : ''}` : '—',
    },
    {
      title: t('ipam.root.remark'), key: 'remark', ellipsis: true,
      render: (_, r) => r.remark
        ? <Tooltip title={r.remark}><span>{r.remark}</span></Tooltip>
        : '—',
    },
    {
      title: t('common.actions'), key: 'action', width: 160,
      render: (_, r: RootPrefix) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEdit(r)}>{t('ipam.root.editBtn')}</Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r.id, r.cidr)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="Search CIDR / Group / Type / VRF / Remark…"
          value={searchText}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{ width: 280 }}
        />
        <Select
          placeholder={t('ipam.root.ipver')}
          value={filterIPv}
          onChange={setFilterIPv}
          allowClear
          style={{ width: 120 }}
          options={[{ value: 4, label: 'IPv4' }, { value: 6, label: 'IPv6' }]}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('ipam.root.add')}
        </Button>
      </Space>

      <Table
        columns={columns}
        dataSource={filtered}
        rowKey="id"
        loading={loading}
        pagination={{
          defaultPageSize: 10,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
        }}
        scroll={{ x: 1000 }}
      />

      <Modal
        title={modalMode === 'create' ? t('ipam.root.newTitle') : t('ipam.root.editTitle')}
        open={isModalOpen}
        onOk={handleSubmit}
        onCancel={() => setIsModalOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label={t('ipam.root.ipver')} name="ip_version" rules={[{ required: true }]}>
            <Radio.Group disabled={modalMode === 'edit'}>
              <Radio value={4}>IPv4</Radio>
              <Radio value={6}>IPv6</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            label={t('ipam.root.cidr')} name="cidr"
            rules={[{ required: true, message: 'CIDR is required' }]}
            extra={modalMode === 'create' ? t('ipam.root.cidrHint') : ''}
          >
            <Input disabled={modalMode === 'edit'} placeholder="e.g. 10.0.0.0/8 or 2001:db8::/32" />
          </Form.Item>
          <Form.Item label={t('ipam.root.group')} name="group_id">
            <Select allowClear placeholder="—" options={groupOpts} />
          </Form.Item>
          <Form.Item label={t('ipam.root.type')} name="type_id">
            <Select allowClear placeholder="—" options={typeOpts} />
          </Form.Item>
          <Form.Item label={t('ipam.root.vrf')} name="vrf_id">
            <Select allowClear placeholder="—" options={vrfOpts} />
          </Form.Item>
          <Form.Item label={t('ipam.root.remark')} name="remark">
            <Input.TextArea rows={2} placeholder="Optional remark…" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabRootPrefix;
