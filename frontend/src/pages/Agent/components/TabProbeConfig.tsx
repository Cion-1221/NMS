import React, { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Tooltip, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getAgentTasks, createAgentTasks, updateAgentTask, deleteAgentTask, getAgentGroups, getAgents,
} from '../../../api/agent';
import type { AgentTask, AgentGroup, Agent, TaskType, TaskScope } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';
import { FONT_MONO } from '../../../theme/theme';

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

const { confirm } = Modal;

const TASK_TYPES: TaskType[] = ['ping', 'tcpping', 'httpcheck', 'dnscheck', 'traceroute', 'mtr', 'meshping', 'meshmtr'];

// meshping/meshmtr：目标由 Server 动态解析，无需用户填写 targets_raw。
const MESH_AUTO_TYPES = new Set<TaskType>(['meshping', 'meshmtr']);

// ─────────────────────────────────────────────────────────────────────────────
// Probe Config Tab：任务下发配置。
// 创建时 Type 为多选——提交时后端会按所选类型各拆成一条独立任务（共享
// Name/Targets/Interval/Scope）；编辑时收窄为单选，因为此时已经是某一条具体任务。
// 为避免多选/单选两种 Select 之间值类型（array vs scalar）混用，创建用字段名
// `types`（array），编辑用字段名 `type`（scalar），互不干扰。
// ─────────────────────────────────────────────────────────────────────────────

const TabProbeConfig: React.FC = () => {
  const t = useT();
  const [data, setData]       = useState<AgentTask[]>([]);
  const [groups, setGroups]   = useState<AgentGroup[]>([]);
  const [agents, setAgents]   = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<AgentTask | null>(null);
  const [form] = Form.useForm();
  const scope: TaskScope | undefined          = Form.useWatch('scope', form);
  const selectedTypes: TaskType[] | undefined = Form.useWatch('types', form);
  const selectedType: TaskType | undefined    = Form.useWatch('type', form);

  // 所有选中类型均为自动解析目标时隐藏 Target IPs（meshping 和 meshmtr 均如此）
  const meshAutoOnly = mode === 'create'
    ? (selectedTypes ?? []).length > 0 && (selectedTypes ?? []).every(ty => MESH_AUTO_TYPES.has(ty))
    : selectedType !== undefined && MESH_AUTO_TYPES.has(selectedType);

  const loadData = async () => {
    setLoading(true);
    try { const r = await getAgentTasks(); setData(r.data); }
    catch (err: unknown) { message.error(apiErrMsg(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    loadData();
    getAgentGroups().then(r => setGroups(r.data)).catch(() => {});
    getAgents({ page: 1, page_size: 200 }).then(r => setAgents(r.data.items)).catch(() => {});
  }, []);

  const openCreate = () => {
    setMode('create'); setEditing(null);
    form.resetFields();
    form.setFieldsValue({ scope: 'global', interval_seconds: 60 });
    setOpen(true);
  };
  const openEdit = (r: AgentTask) => {
    setMode('edit'); setEditing(r);
    form.resetFields();
    form.setFieldsValue({
      name: r.name, type: r.type, targets_raw: r.targets_raw,
      interval_seconds: r.interval_seconds, scope: r.scope,
      group_id: r.group_id ?? undefined, agent_id: r.agent_id ?? undefined, enabled: r.enabled,
    });
    setOpen(true);
  };

  const handleDelete = (r: AgentTask) => {
    confirm({
      title: t('agent.task.delTitle'),
      icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('agent.task.delBody'),
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteAgentTask(r.id); message.success(t('common.success')); loadData(); }
        catch (err: unknown) { message.error(apiErrMsg(err)); }
      },
    });
  };

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (mode === 'create') {
        await createAgentTasks({
          name: values.name, types: values.types, targets_raw: values.targets_raw ?? '',
          interval_seconds: values.interval_seconds, scope: values.scope,
          group_id: values.scope === 'group' ? values.group_id : undefined,
          agent_id: values.scope === 'agent' ? values.agent_id : undefined,
        });
      } else {
        await updateAgentTask(editing!.id, {
          name: values.name, type: values.type, targets_raw: values.targets_raw ?? '',
          interval_seconds: values.interval_seconds, scope: values.scope,
          group_id: values.scope === 'group' ? values.group_id : undefined,
          agent_id: values.scope === 'agent' ? values.agent_id : undefined,
          enabled: values.enabled ?? true,
        });
      }
      message.success(t('common.success'));
      setOpen(false); loadData();
    } catch (err: any) {
      message.error(apiErrMsg(err));
    }
  };

  const toggleEnabled = async (r: AgentTask, enabled: boolean) => {
    try {
      await updateAgentTask(r.id, {
        name: r.name, type: r.type, targets_raw: r.targets_raw, interval_seconds: r.interval_seconds,
        scope: r.scope, group_id: r.group_id, agent_id: r.agent_id, enabled,
      });
      loadData();
    } catch (err: any) { message.error(apiErrMsg(err)); }
  };

  const columns: ColumnsType<AgentTask> = [
    { title: t('common.id'), dataIndex: 'id', key: 'id', width: 60, render: (v: number) => mono(v) },
    { title: t('common.name'), dataIndex: 'name', key: 'name', render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span> },
    { title: t('agent.task.type'), dataIndex: 'type', key: 'type', width: 110, render: (v: string) => <Tag style={{ fontFamily: FONT_MONO }}>{v}</Tag> },
    {
      title: t('agent.task.scope'), key: 'scope', width: 180,
      render: (_: unknown, r: AgentTask) => {
        if (r.scope === 'global') return t('agent.task.scopeGlobal');
        if (r.scope === 'group') return `${t('agent.task.scopeGroup')}: ${r.group?.name ?? r.group_id ?? '—'}`;
        return `${t('agent.task.scopeAgent')}: ${r.agent_id ?? '—'}`;
      },
    },
    {
      title: t('agent.task.targets'), dataIndex: 'targets_raw', key: 'targets_raw',
      width: 280, ellipsis: { showTitle: false },
      render: (v: string, r: AgentTask) => {
        if (MESH_AUTO_TYPES.has(r.type)) return t('agent.task.meshAuto');
        if (!v) return '—';
        const oneLine = v.split('\n').map(s => s.trim()).filter(Boolean).join(', ');
        return (
          <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{v}</span>} placement="topLeft">
            <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{oneLine}</span>
          </Tooltip>
        );
      },
    },
    {
      title: t('agent.task.interval'), dataIndex: 'interval_seconds', key: 'interval_seconds', width: 100,
      render: (v: number) => mono(`${v}s`),
    },
    {
      title: t('common.status'), key: 'enabled', width: 90,
      render: (_: unknown, r: AgentTask) => (
        <Switch checked={r.enabled} size="small" onChange={(checked) => toggleEnabled(r, checked)} />
      ),
    },
    {
      title: t('common.actions'), key: 'action', width: 140, fixed: 'right' as const,
      render: (_: unknown, r: AgentTask) => (
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
        <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>{t('common.refresh')}</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('agent.task.add')}</Button>
      </Space>
      <Table columns={columns} dataSource={data} rowKey="id" loading={loading}
        pagination={{
          defaultPageSize: 20, pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true, showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
        }}
        scroll={{ x: 'max-content' }}
      />
      <Modal
        title={mode === 'create' ? t('agent.task.add') : t('agent.task.edit')}
        open={open} onOk={handleSubmit} onCancel={() => setOpen(false)}
        okText={t('common.save')} cancelText={t('common.cancel')} destroyOnClose width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('common.name')} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {mode === 'create' ? (
            <Form.Item label={t('agent.task.type')} name="types" rules={[{ required: true }]} tooltip={t('agent.task.typeMultiHint')}>
              <Select mode="multiple" options={TASK_TYPES.map(ty => ({ value: ty, label: ty }))} />
            </Form.Item>
          ) : (
            <Form.Item label={t('agent.task.type')} name="type" rules={[{ required: true }]} tooltip={t('agent.task.typeEditHint')}>
              <Select options={TASK_TYPES.map(ty => ({ value: ty, label: ty }))} />
            </Form.Item>
          )}
          {meshAutoOnly ? (
            <Alert
              type="info" showIcon style={{ marginBottom: 16 }}
              message={t('agent.task.meshAutoTargets')}
            />
          ) : (
            <Form.Item label={t('agent.task.targets')} name="targets_raw" tooltip={t('agent.task.targetsHint')}>
              <Input.TextArea rows={4} placeholder={'8.8.8.8\n2001:4860:4860::8888'} />
            </Form.Item>
          )}
          <Form.Item label={t('agent.task.interval')} name="interval_seconds" rules={[{ required: true }]}>
            <InputNumber min={1} addonAfter="s" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('agent.task.scope')} name="scope" rules={[{ required: true }]}>
            <Select options={[
              { value: 'global', label: t('agent.task.scopeGlobal') },
              { value: 'group', label: t('agent.task.scopeGroup') },
              { value: 'agent', label: t('agent.task.scopeAgent') },
            ]} />
          </Form.Item>
          {scope === 'group' && (
            <Form.Item label={t('agent.list.group')} name="group_id" rules={[{ required: true }]}>
              <Select options={groups.map(g => ({ value: g.id, label: g.name }))} />
            </Form.Item>
          )}
          {scope === 'agent' && (
            <Form.Item label={t('agent.task.scopeAgent')} name="agent_id" rules={[{ required: true }]}>
              <Select options={agents.map(a => ({ value: a.agent_id, label: `${a.agent_id} (${a.hostname})` }))} />
            </Form.Item>
          )}
          {mode === 'edit' && (
            <Form.Item label={t('common.status')} name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
};

export default TabProbeConfig;
