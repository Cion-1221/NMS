import React, { useEffect, useState } from 'react';
import {
  Button, Form, Input, Modal, Radio, Select, Space, Table, Tag, message,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { AxiosError } from 'axios';
import type { ColumnsType } from 'antd/es/table';
import { getRootPrefixes, createRootPrefix, updateRootPrefix, deleteRootPrefix } from '../../../api/ipam';
import { RootPrefix } from '../../../types/ipam';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabRootPrefix: React.FC = () => {
  const t = useT();
  const [data, setData]         = useState<RootPrefix[]>([]);
  const [loading, setLoading]   = useState(false);
  const [searchCIDR, setSearchCIDR]   = useState('');
  const [searchGroup, setSearchGroup] = useState('');
  const [filterIPv, setFilterIPv]     = useState<number | undefined>();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode]     = useState<'create' | 'edit'>('create');
  const [editingRecord, setEditingRecord] = useState<RootPrefix | null>(null);
  const [form] = Form.useForm();

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await getRootPrefixes();
      setData(res.data);
    } catch {
      message.error('Failed to load root prefixes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); }, []);

  // ── Client-side search / filter ────────────────────────────────────────────
  const filtered = data.filter((r) => {
    if (searchCIDR  && !r.cidr.includes(searchCIDR.trim()))   return false;
    if (searchGroup && !(r.group ?? '').toLowerCase().includes(searchGroup.toLowerCase())) return false;
    if (filterIPv   && r.ip_version !== filterIPv)             return false;
    return true;
  });

  // ── Modal helpers ──────────────────────────────────────────────────────────
  const openCreate = () => {
    setModalMode('create');
    form.resetFields();
    form.setFieldsValue({ ip_version: 4 });
    setIsModalOpen(true);
  };

  const openEdit = (r: RootPrefix) => {
    setModalMode('edit');
    setEditingRecord(r);
    form.setFieldsValue({ ip_version: r.ip_version, cidr: r.cidr, group: r.group, type: r.type });
    setIsModalOpen(true);
  };

  const handleDelete = (id: number, cidr: string) => {
    confirm({
      title:      t('ipam.root.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('ipam.root.delBody'),
      okText:     t('ipam.root.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteRootPrefix(id);
          message.success(t('ipam.root.delDone'));
          fetchList();
        } catch {
          message.error('Delete failed');
        }
      },
    });
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (modalMode === 'create') {
        await createRootPrefix(values);
        message.success(t('ipam.root.createOk'));
      } else {
        await updateRootPrefix(editingRecord!.id, { group: values.group, type: values.type });
        message.success(t('ipam.root.saveOk'));
      }
      setIsModalOpen(false);
      fetchList();
    } catch (err: any) {
      if (err?.errorFields) return;
      if (err instanceof AxiosError && err.response?.status === 400) {
        Modal.error({ title: 'Validation Error', content: err.response.data.error });
      } else {
        message.error('Request failed');
      }
    }
  };

  const columns: ColumnsType<RootPrefix> = [
    { title: t('common.id'), dataIndex: 'id', key: 'id', width: 70 },
    {
      title:     t('ipam.root.ipver'),
      dataIndex: 'ip_version',
      key:       'ip_version',
      width:     110,
      render:    (v: number) => <Tag color={v === 4 ? 'blue' : 'green'}>IPv{v}</Tag>,
    },
    {
      title:     t('ipam.root.cidr'),
      dataIndex: 'cidr',
      key:       'cidr',
      render:    (v: string) => <strong>{v}</strong>,
    },
    { title: t('ipam.root.group'), dataIndex: 'group', key: 'group' },
    { title: t('ipam.root.type'),  dataIndex: 'type',  key: 'type'  },
    {
      title:  t('common.actions'),
      key:    'action',
      width:  180,
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
      {/* Search bar */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('ipam.root.search.cidr')}
          value={searchCIDR}
          onChange={(e) => setSearchCIDR(e.target.value)}
          allowClear
          style={{ width: 200 }}
        />
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('ipam.root.search.group')}
          value={searchGroup}
          onChange={(e) => setSearchGroup(e.target.value)}
          allowClear
          style={{ width: 180 }}
        />
        <Select
          placeholder={t('ipam.root.ipver')}
          value={filterIPv}
          onChange={setFilterIPv}
          allowClear
          style={{ width: 130 }}
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
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => `${total} items` }}
      />

      <Modal
        title={modalMode === 'create' ? t('ipam.root.newTitle') : t('ipam.root.editTitle')}
        open={isModalOpen}
        onOk={handleSubmit}
        onCancel={() => setIsModalOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        width={500}
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
          <Form.Item label={t('ipam.root.group')} name="group">
            <Input placeholder="e.g. Production, Office" />
          </Form.Item>
          <Form.Item label={t('ipam.root.type')} name="type">
            <Input placeholder="e.g. Internal, DMZ" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabRootPrefix;
