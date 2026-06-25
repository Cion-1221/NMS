import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space, Table, Tag, Tooltip, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getAgentReleases, createAgentRelease, deleteAgentRelease, setAgentReleaseActive } from '../../../api/agent';
import type { AgentRelease } from '../../../types/agent';
import { useT } from '../../../i18n';

const { confirm } = Modal;

const TabReleases: React.FC = () => {
  const t = useT();
  const [releases, setReleases] = useState<AgentRelease[]>([]);
  const [loading, setLoading]   = useState(false);
  const [addOpen, setAddOpen]   = useState(false);
  const [form] = Form.useForm();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getAgentReleases();
      setReleases(r.data);
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Failed to load releases');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  const handleAdd = async () => {
    const values = await form.validateFields();
    try {
      await createAgentRelease({
        version:      values.version.trim(),
        os:           values.os.trim(),
        arch:         values.arch.trim(),
        download_url: values.download_url.trim(),
        sha256:       values.sha256.trim().toLowerCase(),
        notes:        values.notes?.trim() ?? '',
      });
      message.success(t('common.success'));
      setAddOpen(false);
      form.resetFields();
      void loadData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Create failed');
    }
  };

  const handleDelete = (r: AgentRelease) => {
    confirm({
      title: t('agent.release.delTitle'),
      icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('agent.release.delBody'),
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteAgentRelease(r.id); message.success(t('common.success')); void loadData(); }
        catch (err: any) { message.error(err?.response?.data?.error ?? 'Delete failed'); }
      },
    });
  };

  const handleToggleActive = async (r: AgentRelease) => {
    try {
      await setAgentReleaseActive(r.id, !r.active);
      message.success(t('common.success'));
      void loadData();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Update failed');
    }
  };

  const columns: ColumnsType<AgentRelease> = [
    { title: t('agent.release.version'), dataIndex: 'version', key: 'version', width: 110 },
    { title: t('agent.release.os'),      dataIndex: 'os',      key: 'os',      width: 90 },
    { title: t('agent.release.arch'),    dataIndex: 'arch',    key: 'arch',    width: 90 },
    {
      title: t('agent.release.active'), dataIndex: 'active', key: 'active', width: 100,
      render: (v: boolean) => v ? <Tag color="green">{t('agent.release.active')}</Tag> : <span style={{ color: '#aaa' }}>—</span>,
    },
    {
      title: t('agent.release.downloadUrl'), dataIndex: 'download_url', key: 'download_url',
      render: (v: string) => (
        <Tooltip title={v}>
          <a href={v} target="_blank" rel="noopener noreferrer" style={{ maxWidth: 260, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
            {v}
          </a>
        </Tooltip>
      ),
    },
    {
      title: t('agent.release.sha256'), dataIndex: 'sha256', key: 'sha256', width: 130,
      render: (v: string) => <Tooltip title={v}><code style={{ fontSize: 11 }}>{v.slice(0, 12)}…</code></Tooltip>,
    },
    { title: t('agent.release.notes'), dataIndex: 'notes', key: 'notes', render: (v: string) => v || '—' },
    {
      title: t('common.actions'), key: 'action', width: 180, fixed: 'right' as const,
      render: (_: unknown, r: AgentRelease) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => handleToggleActive(r)}>
            {r.active ? t('agent.release.deactivate') : t('agent.release.activate')}
          </Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Alert
        type="info"
        showIcon
        message={t('agent.release.hint')}
        style={{ marginBottom: 16 }}
      />
      <Space style={{ marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
          {t('agent.release.addRelease')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={() => void loadData()} loading={loading}>
          {t('common.refresh')}
        </Button>
      </Space>

      <Table
        columns={columns}
        dataSource={releases}
        rowKey="id"
        loading={loading}
        pagination={false}
        scroll={{ x: 'max-content' }}
      />

      <Modal
        title={t('agent.release.addRelease')}
        open={addOpen}
        onOk={handleAdd}
        onCancel={() => { setAddOpen(false); form.resetFields(); }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label={t('agent.release.version')} name="version" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="0.6.0" />
          </Form.Item>
          <Form.Item label={t('agent.release.os')} name="os" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="linux" />
          </Form.Item>
          <Form.Item label={t('agent.release.arch')} name="arch" rules={[{ required: true, whitespace: true }]}>
            <Input placeholder="amd64" />
          </Form.Item>
          <Form.Item label={t('agent.release.downloadUrl')} name="download_url" rules={[{ required: true, whitespace: true, type: 'url' }]}>
            <Input placeholder="https://..." />
          </Form.Item>
          <Form.Item label={t('agent.release.sha256')} name="sha256" rules={[{ required: true, whitespace: true, len: 64, message: 'SHA256 must be 64 hex characters' }]}>
            <Input placeholder="64-char hex digest" style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item label={t('agent.release.notes')} name="notes">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabReleases;
