import React, { useEffect, useState } from 'react';
import {
  Badge, Button, Form, Input, message, Modal, Space, Switch, Table, Tag, Typography,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listGroups, createGroup, updateGroup, deleteGroup } from '../../../api/system';
import { SysGroup } from '../../../types/system';

const { confirm } = Modal;

const SystemGroupPage: React.FC = () => {
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
    try {
      const res = await listGroups();
      setGroups(res.data);
    } catch {
      message.error('用户组数据加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const isAdmin = (g: SysGroup) => {
    try { return (JSON.parse(g.permissions) as string[]).includes('admin'); }
    catch { return false; }
  };

  // ── 新建 ──────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    let values: any;
    try { values = await createForm.validateFields(); } catch { return; }
    const permissions = JSON.stringify(values.is_admin ? ['admin'] : []);
    setCreating(true);
    try {
      await createGroup({ name: values.name, permissions });
      message.success('用户组创建成功');
      setCreateOpen(false);
      createForm.resetFields();
      fetchData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? '创建失败');
    } finally {
      setCreating(false);
    }
  };

  // ── 编辑 ──────────────────────────────────────────────────────────────────
  const openEdit = (g: SysGroup) => {
    setEditTarget(g);
    editForm.setFieldsValue({ name: g.name, is_admin: isAdmin(g) });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    let values: any;
    try { values = await editForm.validateFields(); } catch { return; }
    if (!editTarget) return;
    const permissions = JSON.stringify(values.is_admin ? ['admin'] : []);
    setEditing(true);
    try {
      await updateGroup(editTarget.id, { name: values.name, permissions });
      message.success('用户组已更新');
      setEditOpen(false);
      editForm.resetFields();
      fetchData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? '更新失败');
    } finally {
      setEditing(false);
    }
  };

  // ── 删除 ──────────────────────────────────────────────────────────────────
  const handleDelete = (g: SysGroup) => {
    confirm({
      title: `确认删除用户组 "${g.name}"？`,
      icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: '组内不能有用户，否则将拒绝删除。',
      okText: '确认删除', okType: 'danger', cancelText: '取消',
      onOk: async () => {
        try {
          await deleteGroup(g.id);
          message.success('用户组已删除');
          fetchData();
        } catch (err: any) {
          message.error(err?.response?.data?.error ?? '删除失败');
        }
      },
    });
  };

  const columns: ColumnsType<SysGroup> = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 70 },
    { title: '用户组名称', dataIndex: 'name', key: 'name', render: (v) => <strong>{v}</strong> },
    {
      title: '权限级别', key: 'permission',
      render: (_, g) => isAdmin(g)
        ? <Badge status="error" text={<Tag color="red">管理员组</Tag>} />
        : <Badge status="default" text={<Tag>普通用户组</Tag>} />,
    },
    {
      title: '操作', key: 'action',
      render: (_, g) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(g)}>编辑</Button>
          <Button size="small" type="text" danger onClick={() => handleDelete(g)}>删除</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>用户组管理</Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建用户组
        </Button>
      </div>

      <Table columns={columns} dataSource={groups} rowKey="id" loading={loading} pagination={{ pageSize: 10 }} />

      {/* 新建用户组 Modal */}
      <Modal title="新建用户组" open={createOpen} onOk={handleCreate}
        onCancel={() => { setCreateOpen(false); createForm.resetFields(); }}
        okText="创建" cancelText="取消" confirmLoading={creating} width={440}
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}
          initialValues={{ is_admin: false }}
        >
          <Form.Item label="用户组名称" name="name"
            rules={[{ required: true, min: 2, max: 100, message: '组名 2-100 位' }]}
          >
            <Input placeholder="例如：ops、devops、read-only" />
          </Form.Item>
          <Form.Item label="管理员权限" name="is_admin" valuePropName="checked"
            extra="开启后该组成员将拥有完整管理权限（创建/修改用户、管理用户组等）"
          >
            <Switch checkedChildren="管理员组" unCheckedChildren="普通用户组" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑用户组 Modal */}
      <Modal title={`编辑用户组：${editTarget?.name}`} open={editOpen}
        onOk={handleEdit} onCancel={() => { setEditOpen(false); editForm.resetFields(); }}
        okText="保存" cancelText="取消" confirmLoading={editing} width={440}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item label="用户组名称" name="name"
            rules={[{ required: true, min: 2, max: 100, message: '组名 2-100 位' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item label="管理员权限" name="is_admin" valuePropName="checked"
            extra="撤销最后一个管理员组的权限时，系统会自动拒绝"
          >
            <Switch checkedChildren="管理员组" unCheckedChildren="普通用户组" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default SystemGroupPage;
