import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Descriptions, Form, InputNumber, Modal, Select, Space, Statistic, Table, Tag, Typography, message } from 'antd';
import { CopyOutlined, PlusOutlined, ReloadOutlined, StopOutlined, SyncOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getAgentTokens, createAgentToken, revokeAgentToken, getAgentGroups,
  getCAStatus, rotateCA, finalizeCA,
} from '../../../api/agent';
import type { AgentToken, AgentGroup, PKIStatus } from '../../../types/agent';
import { useT } from '../../../i18n';

const { Countdown } = Statistic;
const { Text, Paragraph } = Typography;
const { confirm } = Modal;

// ─────────────────────────────────────────────────────────────────────────────
// Token Tab：生成一次性注册码（provisioning token）。明文仅在创建响应中出现一次，
// 通过弹窗展示+倒计时，关闭后无法再次查看（数据库只持久化 SHA-256 哈希）。
// ─────────────────────────────────────────────────────────────────────────────

const TabTokens: React.FC = () => {
  const t = useT();
  const [tokens, setTokens]     = useState<AgentToken[]>([]);
  const [groups, setGroups]     = useState<AgentGroup[]>([]);
  const [loading, setLoading]   = useState(false);
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal]       = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultToken, setResultToken] = useState<{ token: string; expires_at: string } | null>(null);
  const [caStatus, setCaStatus]       = useState<PKIStatus | null>(null);
  const [caBusy, setCaBusy]           = useState(false);
  const [form] = Form.useForm();
  const reqSeq = useRef(0);

  const loadCAStatus = useCallback(async () => {
    try { const r = await getCAStatus(); setCaStatus(r.data); }
    catch { /* 非关键路径，静默失败 */ }
  }, []);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await getAgentTokens(page, pageSize);
      if (seq !== reqSeq.current) return;
      setTokens(r.data.items);
      setTotal(r.data.total);
    } catch (err: any) {
      if (seq === reqSeq.current) message.error(err?.response?.data?.error ?? 'Failed to load tokens');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => { getAgentGroups().then(r => setGroups(r.data)).catch(() => {}); }, []);
  useEffect(() => { void loadCAStatus(); }, [loadCAStatus]);

  const handleRotateCA = () => {
    confirm({
      title: t('agent.ca.rotateTitle'),
      content: t('agent.ca.rotateBody'),
      okText: t('agent.ca.rotate'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        setCaBusy(true);
        try {
          const r = await rotateCA();
          message.success(r.data.message);
          void loadCAStatus();
        } catch (err: any) {
          message.error(err?.response?.data?.error ?? 'Rotate failed');
        } finally {
          setCaBusy(false);
        }
      },
    });
  };

  const handleFinalizeCA = () => {
    confirm({
      title: t('agent.ca.finalizeTitle'),
      content: t('agent.ca.finalizeBody'),
      okText: t('agent.ca.finalize'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        setCaBusy(true);
        try {
          const r = await finalizeCA();
          message.success(r.data.message);
          void loadCAStatus();
        } catch (err: any) {
          message.error(err?.response?.data?.error ?? 'Finalize failed');
        } finally {
          setCaBusy(false);
        }
      },
    });
  };

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ expires_in_minutes: 60 });
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const values = await form.validateFields();
    try {
      const r = await createAgentToken({
        expires_in_minutes: values.expires_in_minutes,
        preset_group_id: values.preset_group_id ?? undefined,
      });
      setCreateOpen(false);
      setResultToken({ token: r.data.token, expires_at: r.data.expires_at });
      setResultOpen(true);
      void loadData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Create failed');
    }
  };

  const handleCopy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); message.success(t('agent.token.copied')); }
    catch { message.error('Copy failed'); }
  };

  const handleRevoke = (r: AgentToken) => {
    confirm({
      title: t('agent.token.revokeTitle'),
      content: t('agent.token.revokeBody'),
      okText: t('agent.token.revoke'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await revokeAgentToken(r.id); message.success(t('common.success')); void loadData(); }
        catch (err: any) { message.error(err?.response?.data?.error ?? 'Revoke failed'); }
      },
    });
  };

  const statusTag = (r: AgentToken) => {
    if (r.status === 'used') return <Tag color="blue">{t('agent.token.used')}</Tag>;
    if (r.status === 'revoked') return <Tag color="default">{t('agent.token.revokedStatus')}</Tag>;
    if (new Date(r.expires_at).getTime() < Date.now()) return <Tag color="default">{t('agent.token.expired')}</Tag>;
    return <Tag color="green">{t('agent.token.unused')}</Tag>;
  };

  const columns: ColumnsType<AgentToken> = [
    { title: t('common.id'), dataIndex: 'id', key: 'id', width: 70 },
    { title: t('agent.list.group'), key: 'group', width: 120, render: (_: unknown, r: AgentToken) => r.preset_group?.name ?? '—' },
    { title: t('common.status'), key: 'status', width: 100, render: (_: unknown, r: AgentToken) => statusTag(r) },
    {
      title: t('agent.token.expiresAt'), dataIndex: 'expires_at', key: 'expires_at', width: 220,
      render: (v: string, r: AgentToken) => (
        r.status === 'unused' && new Date(v).getTime() > Date.now()
          ? <Countdown value={new Date(v).getTime()} format="HH:mm:ss" valueStyle={{ fontSize: 14 }} />
          : new Date(v).toLocaleString()
      ),
    },
    { title: t('agent.token.usedBy'), dataIndex: 'used_by_agent_id', key: 'used_by_agent_id', width: 140, render: (v: string | null) => v || '—' },
    { title: t('agent.token.createdBy'), dataIndex: 'created_by', key: 'created_by', width: 120 },
    {
      title: t('common.actions'), key: 'action', width: 100, fixed: 'right' as const,
      render: (_: unknown, r: AgentToken) => (
        r.status === 'unused'
          ? <Button type="text" size="small" danger icon={<StopOutlined />} onClick={() => handleRevoke(r)}>{t('agent.token.revoke')}</Button>
          : null
      ),
    },
  ];

  return (
    <div>
      <Card size="small" title={t('agent.ca.title')} style={{ marginBottom: 16 }}>
        {caStatus ? (
          <Descriptions size="small" column={2}>
            <Descriptions.Item label={t('agent.ca.activeExpiry')}>
              {new Date(caStatus.active_ca_expiry).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label={t('agent.ca.pendingRotation')}>
              {caStatus.has_pending_previous
                ? <Tag color="orange">{t('agent.ca.pending')}</Tag>
                : <Tag color="green">{t('agent.ca.none')}</Tag>}
            </Descriptions.Item>
          </Descriptions>
        ) : <Text type="secondary">{t('common.loading')}</Text>}
        <Space style={{ marginTop: 8 }}>
          <Button icon={<SyncOutlined />} loading={caBusy} onClick={handleRotateCA}>{t('agent.ca.rotate')}</Button>
          <Button danger disabled={!caStatus?.has_pending_previous} loading={caBusy} onClick={handleFinalizeCA}>
            {t('agent.ca.finalize')}
          </Button>
        </Space>
      </Card>

      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ReloadOutlined />} onClick={() => { void loadData(); }} loading={loading}>{t('common.refresh')}</Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('agent.token.generate')}</Button>
      </Space>
      <Table
        columns={columns} dataSource={tokens} rowKey="id" loading={loading}
        pagination={{
          current: page, pageSize, total,
          pageSizeOptions: ['10', '20', '50'], showSizeChanger: true, showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
          onChange: (p, ps) => { if (ps !== pageSize) { setPageSize(ps); setPage(1); } else { setPage(p); } },
        }}
        scroll={{ x: 'max-content' }}
      />

      <Modal
        title={t('agent.token.generate')}
        open={createOpen} onOk={handleCreate} onCancel={() => setCreateOpen(false)}
        okText={t('agent.token.generate')} cancelText={t('common.cancel')} destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('agent.token.expiresInMinutes')} name="expires_in_minutes" rules={[{ required: true }]}>
            <InputNumber min={1} max={43200} addonAfter={t('agent.token.minutes')} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label={t('agent.list.group')} name="preset_group_id" tooltip={t('agent.token.presetGroupHint')}>
            <Select allowClear options={groups.map(g => ({ value: g.id, label: g.name }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('agent.token.resultTitle')}
        open={resultOpen} onCancel={() => setResultOpen(false)}
        footer={[<Button key="close" type="primary" onClick={() => setResultOpen(false)}>{t('common.confirm')}</Button>]}
      >
        <Paragraph type="warning">{t('agent.token.resultWarning')}</Paragraph>
        <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
          <Text code style={{ flex: 1, padding: 8, overflowWrap: 'anywhere' }}>{resultToken?.token}</Text>
          <Button icon={<CopyOutlined />} onClick={() => resultToken && handleCopy(resultToken.token)} />
        </Space.Compact>
        {resultToken && (
          <Countdown title={t('agent.token.expiresAt')} value={new Date(resultToken.expires_at).getTime()} format="HH:mm:ss" />
        )}
      </Modal>
    </div>
  );
};

export default TabTokens;
