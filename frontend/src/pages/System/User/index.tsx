import React, { useEffect, useState } from 'react';
import {
  Badge, Button, Form, Input, message, Modal, Select, Space, Table, Tag, Typography,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listUsers, createUser, updateUser, deleteUser } from '../../../api/system';
import { listGroups } from '../../../api/system';
import { SysUser, SysGroup } from '../../../types/system';
import { useAuth } from '../../../contexts/AuthContext';

const { confirm } = Modal;
const { Text } = Typography;

const SystemUserPage: React.FC = () => {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<SysUser[]>([]);
  const [groups, setGroups] = useState<SysGroup[]>([]);
  const [loading, setLoading] = useState(false);

  // 新建用户 Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm();
  const [creating, setCreating] = useState(false);

  // 编辑用户 Modal（改分组 + 可选重置密码）
  const [editOpen, setEditOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SysUser | null>(null);
  const [editForm] = Form.useForm();
  const [editing, setEditing] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [usersRes, groupsRes] = await Promise.all([listUsers(), listGroups()]);
      setUsers(usersRes.data);
      setGroups(groupsRes.data);
    } catch {
      message.error('数据加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // ── 新建用户 ──────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    let values: any;
    try { values = await createForm.validateFields(); } catch { return; }
    setCreating(true);
    try {
      await createUser({ username: values.username, password: values.password, group_id: values.group_id });
      message.success('用户创建成功，首次登录需强制改密');
      setCreateOpen(false);
      createForm.resetFields();
      fetchData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? '创建失败');
    } finally {
      setCreating(false);
    }
  };

  // ── 编辑用户 ──────────────────────────────────────────────────────────────
  const openEdit = (record: SysUser) => {
    setEditTarget(record);
    editForm.setFieldsValue({ group_id: record.group_id, password: '' });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    let values: any;
    try { values = await editForm.validateFields(); } catch { return; }
    if (!editTarget) return;
    setEditing(true);
    const payload: any = {};
    if (values.group_id !== editTarget.group_id) payload.group_id = values.group_id;
    if (values.password) payload.password = values.password;
    if (Object.keys(payload).length === 0) {
      message.info('未修改任何内容');
      setEditOpen(false);
      setEditing(false);
      return;
    }
    try {
      await updateUser(editTarget.id, payload);
      message.success('用户已更新');
      setEditOpen(false);
      editForm.resetFields();
      fetchData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? '更新失败');
    } finally {
      setEditing(false);
    }
  };

  // ── 删除用户 ──────────────────────────────────────────────────────────────
  const handleDelete = (record: SysUser) => {
    confirm({
      title: `确认删除用户 "${record.username}"？`,
      icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: '此操作不可恢复，该用户登录权限将立即失效。',
      okText: '确认删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteUser(record.id);
          message.success('用户已删除');
          fetchData();
        } catch (err: any) {
          message.error(err?.response?.data?.error ?? '删除失败');
        }
      },
    });
  };

  const columns: ColumnsType<SysUser> = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 70 },
    { title: '用户名', dataIndex: 'username', key: 'username', render: (v, r) => (
      r.id === currentUser?.id ? <><Text strong>{v}</Text> <Tag color="blue">当前</Tag></> : v
    )},
    {
      title: '所属用户组', key: 'group',
      render: (_, r) => (
        <Tag color={r.group?.permissions?.includes('"admin"') ? 'red' : 'default'}>
          {r.group?.name ?? '-'}
        </Tag>
      ),
    },
    {
      title: '密码状态', dataIndex: 'must_change_password', key: 'pwd_status',
      render: (v: boolean) => v
        ? <Badge status="warning" text="待改密" />
        : <Badge status="success" text="正常" />,
    },
    {
      title: '操作', key: 'action',
      render: (_, r) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(r)}>编辑</Button>
          <Button size="small" type="text" danger
            disabled={r.id === currentUser?.id}
            onClick={() => handleDelete(r)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>用户管理</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建用户
        </Button>
      </div>

      <Table columns={columns} dataSource={users} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />

      {/* 新建用户 Modal */}
      <Modal title="新建用户" open={createOpen} onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        okText="创建" cancelText="取消" confirmLoading={creating} width={480}
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="用户名" name="username"
            rules={[{ required: true, min: 3, max: 50, message: '用户名 3-50 位' }]}
          >
            <Input placeholder="输入登录用户名" />
          </Form.Item>
          <Form.Item label="初始密码" name="password"
            rules={[{ required: true, min: 8, message: '密码至少 8 位' }]}
            extra="用户首次登录后将被强制修改密码"
          >
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item label="所属用户组" name="group_id" rules={[{ required: true, message: '请选择用户组' }]}>
            <Select placeholder="选择用户组">
              {groups.map(g => (
                <Select.Option key={g.id} value={g.id}>
                  {g.name}{g.permissions?.includes('"admin"') ? ' (管理员)' : ''}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑用户 Modal */}
      <Modal title={`编辑用户：${editTarget?.username}`} open={editOpen}
        onOk={handleEdit} onCancel={() => { setEditOpen(false); editForm.resetFields(); }}
        okText="保存" cancelText="取消" confirmLoading={editing} width={480}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="所属用户组" name="group_id">
            <Select placeholder="选择用户组"
              disabled={editTarget?.id === currentUser?.id}
            >
              {groups.map(g => (
                <Select.Option key={g.id} value={g.id}>
                  {g.name}{g.permissions?.includes('"admin"') ? ' (管理员)' : ''}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item label="重置密码" name="password"
            rules={[{ min: 8, message: '密码至少 8 位' }]}
            extra="留空则不修改密码；填写后用户下次登录将被强制再次改密"
          >
            <Input.Password placeholder="（可选）输入新临时密码" />
          </Form.Item>
        </Form>
        {editTarget?.id === currentUser?.id && (
          <div style={{ color: '#888', fontSize: 12, marginTop: -8 }}>
            提示：不能通过此页面修改自己的用户组，请使用右上角菜单自助修改密码。
          </div>
        )}
      </Modal>
    </div>
  );
};

export default SystemUserPage;
