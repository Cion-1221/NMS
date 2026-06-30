import React, { useEffect, useState } from 'react';
import {
  Button, Form, Input, message, Modal, Space, Switch, Table,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listGroups, createGroup, updateGroup, deleteGroup } from '../../../api/system';
import { SysGroup } from '../../../types/system';
import { useT } from '../../../i18n';
import PageHeader from '../../../components/PageHeader';
import StatusTag from '../../../components/StatusTag';
import { FONT_MONO } from '../../../theme/theme';

const { confirm } = Modal;

const isAdmin = (g: SysGroup) => {
  try { return (JSON.parse(g.permissions) as string[]).includes('admin'); }
  catch { return false; }
};

const SystemGroupPage: React.FC = () => {
  const t = useT();
  const [groups, setGroups] = useState<SysGroup[]>([]);
  const [loading, setLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SysGroup | null>(null);
  const [editForm] = Form.useForm();
  const [editing, setEditing] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try { const r = await listGroups(); setGroups(r.data); }
    catch { message.error('Failed to load groups'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async () => {
    let v: any;
    try { v = await createForm.validateFields(); } catch { return; }
    const perms = JSON.stringify(v.is_admin ? ['admin'] : []);
    setCreating(true);
    try {
      await createGroup({ name: v.name, permissions: perms });
      message.success(t('sys.group.createOk'));
      setCreateOpen(false);
      createForm.resetFields();
      fetchData();
    } catch (err: any) { message.error(err?.response?.data?.error ?? 'Create failed'); }
    finally { setCreating(false); }
  };

  const openEdit = (g: SysGroup) => {
    setEditTarget(g);
    editForm.setFieldsValue({ name: g.name, is_admin: isAdmin(g) });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    let v: any;
    try { v = await editForm.validateFields(); } catch { return; }
    if (!editTarget) return;
    const perms = JSON.stringify(v.is_admin ? ['admin'] : []);
    setEditing(true);
    try {
      await updateGroup(editTarget.id, { name: v.name, permissions: perms });
      message.success(t('sys.group.editOk'));
      setEditOpen(false);
      editForm.resetFields();
      fetchData();
    } catch (err: any) { message.error(err?.response?.data?.error ?? 'Update failed'); }
    finally { setEditing(false); }
  };

  const handleDelete = (g: SysGroup) => {
    confirm({
      title:   t('sys.group.delTitle', { name: g.name }),
      icon:    <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('sys.group.delBody'),
      okText:  t('common.delete'),
      okType:  'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteGroup(g.id); message.success(t('sys.group.delOk')); fetchData(); }
        catch (err: any) { message.error(err?.response?.data?.error ?? 'Delete failed'); }
      },
    });
  };

  const columns: ColumnsType<SysGroup> = [
    { title: t('common.id'),       dataIndex: 'id',   key: 'id',   width: 60, render: (v: number) => <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span> },
    { title: t('sys.group.name'),  dataIndex: 'name', key: 'name', render: (v) => <strong>{v}</strong> },
    {
      title:  t('sys.group.level'),
      key:    'level',
      render: (_, g) => isAdmin(g)
        ? <StatusTag status="planned" tone="accent" label={t('sys.group.admin')} />
        : <StatusTag status="unknown" tone="neutral" label={t('sys.group.regular')} />,
    },
    {
      title:  t('common.actions'),
      key:    'action',
      render: (_, g) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(g)}>{t('common.edit')}</Button>
          <Button size="small" type="text" danger onClick={() => handleDelete(g)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  const groupForm = (form: any, initial?: { is_admin?: boolean }) => (
    <Form form={form} layout="vertical" style={{ marginTop: 16 }} initialValues={{ is_admin: false, ...initial }}>
      <Form.Item label={t('sys.group.name')} name="name" rules={[{ required: true, min: 2, max: 100 }]}>
        <Input />
      </Form.Item>
      <Form.Item label={t('sys.group.isAdmin')} name="is_admin" valuePropName="checked"
        extra={t('sys.group.adminHint')}>
        <Switch checkedChildren={t('sys.group.admin')} unCheckedChildren={t('sys.group.regular')} />
      </Form.Item>
    </Form>
  );

  return (
    <div>
      <PageHeader
        title={t('sys.group.title')}
        subtitle={t('sys.group.subtitle')}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t('sys.group.create')}
          </Button>
        }
      />

      <Table columns={columns} dataSource={groups} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />

      <Modal title={t('sys.group.create')} open={createOpen}
        onOk={handleCreate} onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        okText={t('common.create')} cancelText={t('common.cancel')} confirmLoading={creating} width={440}>
        {groupForm(createForm)}
      </Modal>

      <Modal title={t('sys.group.editTitle', { name: editTarget?.name ?? '' })} open={editOpen}
        onOk={handleEdit} onCancel={() => { setEditOpen(false); editForm.resetFields(); }}
        okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={editing} width={440}>
        {groupForm(editForm, { is_admin: editTarget ? isAdmin(editTarget) : false })}
      </Modal>
    </div>
  );
};

export default SystemGroupPage;
