import React, { useEffect, useState } from 'react';
import {
  Button, Form, Input, Modal, Radio, Select, Space, Table, Tooltip, message,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { AxiosError } from 'axios';
import type { ColumnsType } from 'antd/es/table';
import {
  getRootPrefixes, createRootPrefix, updateRootPrefix, deleteRootPrefix,
  getGroups, getIPAMTypes, getVRFs,
} from '../../../api/ipam';
import type { RootPrefix, IPAMGroup, IPAMType, IPAMVRF } from '../../../types/ipam';
import { apiErrMsg, useT } from '../../../i18n';
import { cidrMatchesSearch } from '../../../utils/cidr';
import StatusTag from '../../../components/StatusTag';
import { FONT_MONO } from '../../../theme/theme';

const { confirm } = Modal;

const TabRootPrefix: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<RootPrefix[]>([]);
  const [loading, setLoading] = useState(false);

  // Per-field filters
  const [filterCIDR,    setFilterCIDR]    = useState('');
  const [filterGroupId, setFilterGroupId] = useState<number | undefined>();
  const [filterTypeId,  setFilterTypeId]  = useState<number | undefined>();
  const [filterVrfId,   setFilterVrfId]   = useState<number | undefined>();
  const [filterIPv,     setFilterIPv]     = useState<number | undefined>();

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
    catch (err) { message.error(apiErrMsg(err)); }
    finally { setLoading(false); }
  };

  const fetchLookups = async () => {
    try {
      const [g, tp, v] = await Promise.all([getGroups(), getIPAMTypes(), getVRFs()]);
      setGroups(g.data); setTypes(tp.data); setVRFs(v.data);
    } catch { /* non-critical */ }
  };

  useEffect(() => { fetchList(); fetchLookups(); }, []);

  const filtered = data.filter((r) => {
    if (filterIPv     && r.ip_version !== filterIPv)              return false;
    if (filterGroupId !== undefined && r.group_id !== filterGroupId) return false;
    if (filterTypeId  !== undefined && r.type_id  !== filterTypeId)  return false;
    if (filterVrfId   !== undefined && r.vrf_id   !== filterVrfId)   return false;
    if (filterCIDR    && !cidrMatchesSearch(r.cidr, filterCIDR))  return false;
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
      ip_version: r.ip_version, cidr: r.cidr,
      group_id: r.group_id ?? undefined,
      type_id:  r.type_id  ?? undefined,
      vrf_id:   r.vrf_id   ?? undefined,
      remark:   r.remark   ?? '',
    });
    setIsModalOpen(true);
  };

  const handleDelete = (id: number) => {
    confirm({
      title: t('ipam.root.delTitle'),
      icon:  <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('ipam.root.delBody'),
      okText: t('ipam.root.delOk'), okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteRootPrefix(id); message.success(t('ipam.root.delDone')); fetchList(); }
        catch (err) { message.error(apiErrMsg(err)); }
      },
    });
  };

  const handleSubmit = async () => {
    try {
      const v = await form.validateFields();
      if (modalMode === 'create') {
        await createRootPrefix({
          ip_version: v.ip_version, cidr: v.cidr,
          group_id: v.group_id ?? null, type_id: v.type_id ?? null,
          vrf_id: v.vrf_id ?? null, remark: v.remark ?? '',
        });
        message.success(t('ipam.root.createOk'));
      } else {
        await updateRootPrefix(editingRecord!.id, {
          group_id: v.group_id ?? null, type_id: v.type_id ?? null,
          vrf_id: v.vrf_id ?? null, remark: v.remark ?? '',
        });
        message.success(t('ipam.root.saveOk'));
      }
      setIsModalOpen(false); fetchList();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      if (err instanceof AxiosError && err.response?.status === 400)
        Modal.error({ title: t('common.error'), content: apiErrMsg(err) });
      else message.error(apiErrMsg(err));
    }
  };

  const groupOpts = groups.map((g)  => ({ value: g.id,  label: g.name }));
  const typeOpts  = types.map((tp)  => ({ value: tp.id, label: tp.name }));
  const vrfOpts   = vrfs.map((v)    => ({
    value: v.id,
    label: v.rd ? `${v.name} (${v.rd})` : v.name,
  }));

  const columns: ColumnsType<RootPrefix> = [
    { title: t('common.id'),      dataIndex: 'id',         key: 'id', width: 64, render: (v: number) => <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span> },
    {
      title: t('ipam.root.ipver'), dataIndex: 'ip_version', key: 'ip_version', width: 100,
      render: (v: number) => <StatusTag status={v === 4 ? 'planned' : 'used'} tone={v === 4 ? 'accent' : 'teal'} label={`IPv${v}`} />,
    },
    {
      title: t('ipam.root.cidr'), dataIndex: 'cidr', key: 'cidr',
      render: (v: string) => <span style={{ fontFamily: FONT_MONO, fontWeight: 700, whiteSpace: 'nowrap' }}>{v}</span>,
    },
    { title: t('ipam.root.group'), key: 'group', render: (_, r) => r.group?.name || '—' },
    { title: t('ipam.root.type'),  key: 'type',  render: (_, r) => r.type?.name  || '—' },
    {
      title: t('ipam.root.vrf'), key: 'vrf',
      render: (_, r) => r.vrf ? `${r.vrf.name}${r.vrf.rd ? ` (${r.vrf.rd})` : ''}` : '—',
    },
    {
      title: t('ipam.root.remark'), key: 'remark', ellipsis: true, width: 200,
      render: (_, r) => r.remark
        ? <Tooltip title={r.remark}>{r.remark}</Tooltip>
        : '—',
    },
    {
      title: t('common.actions'), key: 'action', width: 120, fixed: 'right' as const,
      render: (_, r: RootPrefix) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(r)}>{t('ipam.root.editBtn')}</Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r.id)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* Per-field search bar */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('ipam.searchCidrPh')}
          value={filterCIDR}
          onChange={(e) => setFilterCIDR(e.target.value)}
          allowClear
          style={{ width: 200 }}
        />
        <Select
          placeholder={t('ipam.root.group')}
          value={filterGroupId}
          onChange={setFilterGroupId}
          allowClear style={{ width: 140 }}
          options={groupOpts}
        />
        <Select
          placeholder={t('ipam.root.type')}
          value={filterTypeId}
          onChange={setFilterTypeId}
          allowClear style={{ width: 130 }}
          options={typeOpts}
        />
        <Select
          placeholder="VRF"
          value={filterVrfId}
          onChange={setFilterVrfId}
          allowClear style={{ width: 150 }}
          options={vrfOpts}
        />
        <Select
          placeholder={t('ipam.root.ipver')}
          value={filterIPv}
          onChange={setFilterIPv}
          allowClear style={{ width: 110 }}
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
        scroll={{ x: 'max-content' }}
        pagination={{
          defaultPageSize: 10,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} / ${total}`,
        }}
      />

      <Modal
        title={modalMode === 'create' ? t('ipam.root.newTitle') : t('ipam.root.editTitle')}
        open={isModalOpen}
        onOk={handleSubmit}
        onCancel={() => setIsModalOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')}
        width={520} destroyOnClose
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
            rules={[{ required: true, message: t('ipam.root.cidrRequired') }]}
            extra={modalMode === 'create' ? t('ipam.root.cidrHint') : ''}
          >
            <Input disabled={modalMode === 'edit'} placeholder={t('ipam.root.cidrPh')} />
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
            <Input.TextArea rows={2} placeholder={t('common.remarkPh')} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabRootPrefix;
