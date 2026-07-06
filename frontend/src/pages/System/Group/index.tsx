import React, { useEffect, useState } from 'react';
import {
  Button, Checkbox, Form, Input, message, Modal, Space, Switch, Table,
} from 'antd';
import { ExclamationCircleFilled, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { listGroups, createGroup, updateGroup, deleteGroup } from '../../../api/system';
import { SysGroup } from '../../../types/system';
import { apiErrMsg, useT } from '../../../i18n';
import {
  PERM_ADMIN, PERM_DEVICES_WRITE, PERM_IPAM_WRITE, groupIsAdmin, parsePerms,
} from '../../../utils/perms';
import PageHeader from '../../../components/PageHeader';
import StatusTag from '../../../components/StatusTag';
import { FONT_MONO } from '../../../theme/theme';

const { confirm } = Modal;

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

  // 模块级写权限选项（admin 隐含全部权限，勾选 admin 时禁用）
  const MODULE_PERMS = [
    { value: PERM_IPAM_WRITE,    label: t('sys.group.permIpamWrite') },
    { value: PERM_DEVICES_WRITE, label: t('sys.group.permDevicesWrite') },
  ];

  const fetchData = async () => {
    setLoading(true);
    try { const r = await listGroups(); setGroups(r.data); }
    catch (err) { message.error(apiErrMsg(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  // 表单值 → permissions JSON：admin 开启时忽略模块勾选（隐含全部）
  const buildPerms = (v: { is_admin?: boolean; module_perms?: string[] }) =>
    JSON.stringify(v.is_admin ? [PERM_ADMIN] : (v.module_perms ?? []));

  const handleCreate = async () => {
    let v: any;
    try { v = await createForm.validateFields(); } catch { return; }
    setCreating(true);
    try {
      await createGroup({ name: v.name, permissions: buildPerms(v) });
      message.success(t('sys.group.createOk'));
      setCreateOpen(false);
      createForm.resetFields();
      fetchData();
    } catch (err: any) { message.error(apiErrMsg(err)); }
    finally { setCreating(false); }
  };

  const openEdit = (g: SysGroup) => {
    setEditTarget(g);
    editForm.setFieldsValue({
      name: g.name,
      is_admin: groupIsAdmin(g),
      module_perms: parsePerms(g.permissions).filter((p) => p !== PERM_ADMIN),
    });
    setEditOpen(true);
  };

  const handleEdit = async () => {
    let v: any;
    try { v = await editForm.validateFields(); } catch { return; }
    if (!editTarget) return;
    setEditing(true);
    try {
      await updateGroup(editTarget.id, { name: v.name, permissions: buildPerms(v) });
      message.success(t('sys.group.editOk'));
      setEditOpen(false);
      editForm.resetFields();
      fetchData();
    } catch (err: any) { message.error(apiErrMsg(err)); }
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
        catch (err: any) { message.error(apiErrMsg(err)); }
      },
    });
  };

  const permLabel = (p: string) => {
    if (p === PERM_IPAM_WRITE)    return t('sys.group.permIpamWrite');
    if (p === PERM_DEVICES_WRITE) return t('sys.group.permDevicesWrite');
    return p;
  };

  const columns: ColumnsType<SysGroup> = [
    { title: t('common.id'),       dataIndex: 'id',   key: 'id',   width: 60, render: (v: number) => <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span> },
    { title: t('sys.group.name'),  dataIndex: 'name', key: 'name', render: (v) => <strong>{v}</strong> },
    {
      title:  t('sys.group.level'),
      key:    'level',
      width:  120,
      render: (_, g) => groupIsAdmin(g)
        ? <StatusTag status="planned" tone="accent" label={t('sys.group.admin')} />
        : <StatusTag status="unknown" tone="neutral" label={t('sys.group.regular')} />,
    },
    {
      title:  t('sys.group.permsCol'),
      key:    'perms',
      render: (_, g) => {
        if (groupIsAdmin(g)) return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>{t('sys.group.permsAll')}</span>;
        const mods = parsePerms(g.permissions).filter((p) => p !== PERM_ADMIN);
        if (!mods.length) return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>{t('sys.group.permsReadonly')}</span>;
        return (
          <Space size={4} wrap>
            {mods.map((p) => <StatusTag key={p} status="used" tone="teal" label={permLabel(p)} />)}
          </Space>
        );
      },
    },
    {
      title:  t('common.actions'),
      key:    'action',
      width:  140,
      render: (_, g) => (
        <Space>
          <Button size="small" type="link" onClick={() => openEdit(g)}>{t('common.edit')}</Button>
          <Button size="small" type="text" danger onClick={() => handleDelete(g)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  const groupForm = (form: any) => (
    <Form form={form} layout="vertical" style={{ marginTop: 16 }} initialValues={{ is_admin: false, module_perms: [] }}>
      <Form.Item label={t('sys.group.name')} name="name" rules={[{ required: true, min: 2, max: 100 }]}>
        <Input />
      </Form.Item>
      <Form.Item label={t('sys.group.isAdmin')} name="is_admin" valuePropName="checked"
        extra={t('sys.group.adminHint')}>
        <Switch checkedChildren={t('sys.group.admin')} unCheckedChildren={t('sys.group.regular')} />
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.is_admin !== cur.is_admin}>
        {({ getFieldValue }) => (
          <Form.Item label={t('sys.group.modulePerms')} name="module_perms"
            extra={getFieldValue('is_admin') ? t('sys.group.permsAllHint') : t('sys.group.modulePermsHint')}>
            <Checkbox.Group options={MODULE_PERMS} disabled={getFieldValue('is_admin')} />
          </Form.Item>
        )}
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
        okText={t('common.create')} cancelText={t('common.cancel')} confirmLoading={creating} width={460}>
        {groupForm(createForm)}
      </Modal>

      <Modal title={t('sys.group.editTitle', { name: editTarget?.name ?? '' })} open={editOpen}
        onOk={handleEdit} onCancel={() => { setEditOpen(false); editForm.resetFields(); }}
        okText={t('common.save')} cancelText={t('common.cancel')} confirmLoading={editing} width={460}>
        {groupForm(editForm)}
      </Modal>
    </div>
  );
};

export default SystemGroupPage;
