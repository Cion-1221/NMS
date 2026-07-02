import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Modal, Space, Table, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getAgentGroups, createAgentGroup, updateAgentGroup, deleteAgentGroup } from '../../../api/agent';
import type { AgentGroup } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';

const { confirm } = Modal;

// ─────────────────────────────────────────────────────────────────────────────
// Group Tab：维护 Agent 分组（如 HKG / SIN / LAX）。简单 CRUD，与 TabVendors
// （Devices 模块）同款模式。
// ─────────────────────────────────────────────────────────────────────────────

const TabGroups: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<AgentGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch]   = useState('');
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<AgentGroup | null>(null);
  const [form] = Form.useForm();

  const loadData = async () => {
    setLoading(true);
    try { const r = await getAgentGroups(); setData(r.data); }
    catch (err: unknown) { message.error(apiErrMsg(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadData(); }, []);

  const filtered = useMemo(() => {
    if (!search) return data;
    const q = search.toLowerCase();
    return data.filter(g => g.name.toLowerCase().includes(q) || g.description?.toLowerCase().includes(q));
  }, [data, search]);

  const openCreate = () => { setMode('create'); form.resetFields(); setOpen(true); };
  const openEdit = (r: AgentGroup) => {
    setMode('edit'); setEditing(r);
    form.setFieldsValue({ name: r.name, description: r.description });
    setOpen(true);
  };

  const handleDelete = (r: AgentGroup) => {
    confirm({
      title: t('agent.group.delTitle'),
      icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('agent.group.delBody'),
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteAgentGroup(r.id); message.success(t('common.success')); loadData(); }
        catch (err: unknown) { message.error(apiErrMsg(err)); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') {
        await createAgentGroup(values as { name: string; description?: string });
      } else {
        await updateAgentGroup(editing!.id, values as { name: string; description?: string });
      }
      message.success(t('common.success'));
      setOpen(false); loadData();
    } catch (err: unknown) { message.error(apiErrMsg(err)); }
  };

  const columns: ColumnsType<AgentGroup> = [
    { title: t('common.id'), dataIndex: 'id', key: 'id', width: 70 },
    { title: t('common.name'), dataIndex: 'name', key: 'name' },
    { title: t('agent.group.desc'), dataIndex: 'description', key: 'description', ellipsis: true, render: (v: string) => v || '—' },
    {
      title: t('common.actions'), key: 'action', width: 140, fixed: 'right' as const,
      render: (_: unknown, r: AgentGroup) => (
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
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('common.search')}
          value={search} onChange={e => setSearch(e.target.value)} allowClear style={{ width: 260 }}
        />
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>{t('common.refresh')}</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('agent.group.add')}</Button>
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
        title={mode === 'create' ? t('agent.group.add') : t('agent.group.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('common.name')} name="name" rules={[{ required: true }]}>
            <Input placeholder="HKG / SIN / LAX" />
          </Form.Item>
          <Form.Item label={t('agent.group.desc')} name="description">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabGroups;
