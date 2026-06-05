import React, { useEffect, useState } from 'react';
import {
  Badge, Button, Form, Input, message, Modal, Select, Space, Table, Tag, Typography,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listUsers, createUser, updateUser, deleteUser, listGroups } from '../../../api/system';
import { SysUser, SysGroup } from '../../../types/system';
import { useAuth } from '../../../contexts/AuthContext';
import { useT } from '../../../i18n';

const { confirm } = Modal;
const { Text }    = Typography;

const SystemUserPage: React.FC = () => {
  const { user: me } = useAuth();
  const t = useT();
  const [users, setUsers]   = useState<SysUser[]>([]);
  const [groups, setGroups] = useState<SysGroup[]>([]);
  const [loading, setLoading] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SysUser | null>(null);
  const [editForm] = Form.useForm();
  const [editing, setEditing] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [ur, gr] = await Promise.all([listUsers(), listGroups()]);
      setUsers(ur.data);
      setGroups(gr.data);
    } catch { message.error('Failed to load data'); }
    finally  { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  const handleCreate = async () => {
    let v: any;
    try { v = await createForm.validateFields(); } catch { return; }
    setCreating(true);
    try {
      await createUser({ username: v.username, password: v.password, group_id: v.group_id });
      message.success(t('sys.user.createOk'));
      setCreateOpen(false);
      createForm.resetFields();
      fetchData();
    } catch (err: any) { message.error(err?.response?.data?.error ?? 'Create failed'); }
    finally { setCreating(false); }
  };

  const openEdit = (r: SysUser) => {
    setEditTarget(r);
    editForm.setFieldsValue({ group_id: r.group_id, password: '' });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    let v: any;
    try { v = await editForm.validateFields(); } catch { return; }
    if (!editTarget) return;
    setEditing(true);
    const payload: any = {};
    if (v.group_id !== editTarget.group_id) payload.group_id = v.group_id;
    if (v.password) payload.password = v.password;
    if (!Object.keys(payload).length) { message.info('Nothing changed'); setEditOpen(false); setEditing(false); return; }
    try {
      await updateUser(editTarget.id, payload);
      message.success(t('sys.user.editOk'));
      setEditOpen(false);
      editForm.resetFields();
      fetchData();
    } catch (err: any) { message.error(err?.response?.data?.error ?? 'Update failed'); }
    finally { setEditing(false); }
  };

  const handleDelete = (r: SysUser) => {
    confirm({
      title:   t('sys.user.delTitle', { name: r.username }),
      icon:    <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('sys.user.delBody'),
      okText:  t('common.delete'),
      okType:  'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteUser(r.id); message.success(t('sys.user.delOk')); fetchData(); }
        catch (err: any) { message.error(err?.response?.data?.error ?? 'Delete failed'); }
      },
    });
  };

  const columns: ColumnsType<SysUser> = [
    { title: t('common.id'),        dataIndex: 'id',       key: 'id',   width: 60 },
    {
      title:     t('sys.user.username'),
      dataIndex: 'username',
      key:       'username',
      render:    (v, r) => r.id === me?.id
        ? <><Text strong>{v}</Text> <Tag color="blue">{t('sys.user.current')}</Tag></>
        : v,
    },
    {
      title:  t('sys.user.group'),
      key:    'group',
      render: (_,r) => (
        <Tag color={r.group?.permissions?.includes('"admin"') ? 'red' : 'default'}>
          {r.group?.name ?? '-'}
        </Tag>
      ),
    },
    {
      title:     t('sys.user.pwdStatus'),
      dataIndex: 'must_change_password',
      key:       'pwd',
      render:    (v: boolean) => v
        ? <Badge status="warning" text={t('sys.user.pwdPending')} />
        : <Badge status="success" text={t('sys.user.pwdOk')} />,
    },
    {
      title:  t('common.actions'),
      key:    'action',
      render: (_, r) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
          <Button size="small" type="text" danger disabled={r.id === me?.id} onClick={() => handleDelete(r)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const groupOptions = groups.map((g) => ({
    value: g.id,
    label: g.name + (g.permissions?.includes('"admin"') ? ' (Admin)' : ''),
  }));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('sys.user.title')}</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t('sys.user.create')}
        </Button>
      </div>

      <Table columns={columns} dataSource={users} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />

      {/* Create */}
      <Modal title={t('sys.user.create')} open={createOpen}
        onOk={handleCreate} onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        okText={t('common.create')} cancelText={t('common.cancel')} confirmLoading={creating} width={480}
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('sys.user.username')} name="username"
            rules={[{ required: true, min: 3, max: 50 }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t('sys.user.initPwd')} name="password"
            rules={[{ required: true, min: 8, message: 'At least 8 characters' }]}
            extra={t('sys.user.initPwdHint')}>
            <Input.Password />
          </Form.Item>
          <Form.Item label={t('sys.user.group')} name="group_id" rules={[{ required: true }]}>
            <Select options={groupOptions} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit */}
      <Modal title={t('sys.user.editTitle', { name: editTarget?.username ?? '' })} open={editOpen}
        onOk={handleEdit} onCancel={() => { setEditOpen(false); editForm.resetFields(); }}
        okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={editing} width={480}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label={t('sys.user.group')} name="group_id">
            <Select options={groupOptions} disabled={editTarget?.id === me?.id} />
          </Form.Item>
          <Form.Item label={t('sys.user.resetPwd')} name="password"
            rules={[{ min: 8, message: 'At least 8 characters' }]}
            extra={t('sys.user.resetHint')}>
            <Input.Password placeholder="Leave blank to keep current" />
          </Form.Item>
        </Form>
        {editTarget?.id === me?.id && (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('sys.user.noSelfGrp')}</Text>
        )}
      </Modal>
    </div>
  );
};

export default SystemUserPage;
