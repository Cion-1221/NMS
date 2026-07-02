import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space, Spin, Table, Tag, Tooltip, Upload, message } from 'antd';
import { CheckCircleFilled, ExclamationCircleFilled, InboxOutlined, PlusOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { RcFile } from 'antd/es/upload';
import {
  getAgentReleases, createAgentRelease, deleteAgentRelease,
  setAgentReleaseActive, getAgentReleaseProgress,
} from '../../../api/agent';
import type { AgentRelease, AgentReleaseProgress, AgentReleaseProgressItem } from '../../../types/agent';
import { apiErrMsg, useT } from '../../../i18n';
import StatusTag from '../../../components/StatusTag';
import RelativeTime from '../../../components/RelativeTime';
import { FONT_MONO } from '../../../theme/theme';

const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

const { confirm } = Modal;
const { Dragger } = Upload;

const REFRESH_MS = 10_000;

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const TabReleases: React.FC = () => {
  const t = useT();
  const [releases, setReleases]     = useState<AgentRelease[]>([]);
  const [loading, setLoading]       = useState(false);
  const [addOpen, setAddOpen]       = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [selectedFile, setSelectedFile] = useState<RcFile | null>(null);
  const [form] = Form.useForm();

  // Per-release summary badge: { [id]: { total, updated_count } }
  const [summaries, setSummaries] = useState<Record<number, { total: number; updated_count: number }>>({});

  // Progress modal
  const [progressRelease, setProgressRelease] = useState<AgentRelease | null>(null);
  const [progressData, setProgressData]       = useState<AgentReleaseProgress | null>(null);
  const [progressLoading, setProgressLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSummaries = useCallback(async (rels: AgentRelease[]) => {
    if (rels.length === 0) return;
    const results = await Promise.allSettled(rels.map(r => getAgentReleaseProgress(r.id)));
    setSummaries(prev => {
      const next = { ...prev };
      rels.forEach((r, i) => {
        const res = results[i];
        if (res.status === 'fulfilled') {
          next[r.id] = { total: res.value.data.total, updated_count: res.value.data.updated_count };
        }
      });
      return next;
    });
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getAgentReleases();
      setReleases(r.data);
      void loadSummaries(r.data);
    } catch (err: any) {
      message.error(apiErrMsg(err));
    } finally {
      setLoading(false);
    }
  }, [loadSummaries]);

  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const fetchDetail = useCallback(async (rel: AgentRelease) => {
    setProgressLoading(true);
    try {
      const r = await getAgentReleaseProgress(rel.id);
      setProgressData(r.data);
      // keep summary badge in sync while modal is open
      setSummaries(prev => ({
        ...prev,
        [rel.id]: { total: r.data.total, updated_count: r.data.updated_count },
      }));
    } catch (err: any) {
      message.error(apiErrMsg(err));
    } finally {
      setProgressLoading(false);
    }
  }, []);

  const openProgress = useCallback((r: AgentRelease) => {
    setProgressRelease(r);
    setProgressData(null);
    void fetchDetail(r);
    timerRef.current = setInterval(() => { void fetchDetail(r); }, REFRESH_MS);
  }, [fetchDetail]);

  const closeProgress = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setProgressRelease(null);
    setProgressData(null);
  }, []);

  const handleCloseAdd = () => { setAddOpen(false); setSelectedFile(null); form.resetFields(); };

  const handleAdd = async () => {
    const values = await form.validateFields();
    if (!selectedFile) { message.error(t('agent.release.uploadFile') + ' is required'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('version', values.version.trim());
      fd.append('os', values.os.trim());
      fd.append('arch', values.arch.trim());
      fd.append('notes', values.notes?.trim() ?? '');
      fd.append('file', selectedFile);
      await createAgentRelease(fd);
      message.success(t('common.success'));
      handleCloseAdd();
      void loadData();
    } catch (err: any) {
      message.error(apiErrMsg(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = (r: AgentRelease) => {
    confirm({
      title: t('agent.release.delTitle'),
      icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: t('agent.release.delBody'),
      okText: t('common.delete'), okType: 'danger', cancelText: t('common.cancel'),
      onOk: async () => {
        try { await deleteAgentRelease(r.id); message.success(t('common.success')); void loadData(); }
        catch (err: any) { message.error(apiErrMsg(err)); }
      },
    });
  };

  const handleToggleActive = async (r: AgentRelease) => {
    try {
      await setAgentReleaseActive(r.id, !r.active);
      message.success(t('common.success'));
      void loadData();
    } catch (err: any) {
      message.error(apiErrMsg(err));
    }
  };

  const columns: ColumnsType<AgentRelease> = [
    { title: t('agent.release.version'), dataIndex: 'version', key: 'version', width: 110, render: (v: string) => <span style={{ fontFamily: FONT_MONO, fontWeight: 600 }}>{v}</span> },
    { title: t('agent.release.os'),      dataIndex: 'os',      key: 'os',      width: 90, render: (v: string) => mono(v) },
    { title: t('agent.release.arch'),    dataIndex: 'arch',    key: 'arch',    width: 90, render: (v: string) => mono(v) },
    {
      title: t('agent.release.active'), dataIndex: 'active', key: 'active', width: 100,
      render: (v: boolean) => v
        ? <StatusTag status="active" label={t('agent.release.active')} />
        : <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>,
    },
    {
      title: t('agent.release.fileSize'), dataIndex: 'file_size', key: 'file_size', width: 110,
      render: (v: number) => mono(fmtSize(v)),
    },
    {
      title: t('agent.release.sha256'), dataIndex: 'sha256', key: 'sha256', width: 130,
      render: (v: string) => v
        ? <Tooltip title={v}><code style={{ fontFamily: FONT_MONO, fontSize: 11, color: 'var(--ant-color-text-secondary)' }}>{v.slice(0, 12)}…</code></Tooltip>
        : '—',
    },
    { title: t('agent.release.notes'), dataIndex: 'notes', key: 'notes', render: (v: string) => v || '—' },
    {
      title: t('agent.release.progress'), key: 'progress', width: 110,
      render: (_: unknown, r: AgentRelease) => {
        const s = summaries[r.id];
        if (!s || s.total === 0) return <span style={{ color: '#aaa' }}>—</span>;
        const done = s.updated_count === s.total;
        return (
          <Tag color={done ? 'success' : 'processing'} style={{ cursor: 'pointer' }} onClick={() => openProgress(r)}>
            {s.updated_count}/{s.total}
          </Tag>
        );
      },
    },
    {
      title: t('common.actions'), key: 'action', width: 230, fixed: 'right' as const,
      render: (_: unknown, r: AgentRelease) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openProgress(r)}>
            {t('agent.release.progress')}
          </Button>
          <Button type="link" size="small" onClick={() => handleToggleActive(r)}>
            {r.active ? t('agent.release.deactivate') : t('agent.release.activate')}
          </Button>
          <Button type="text" size="small" danger onClick={() => handleDelete(r)}>
            {t('common.delete')}
          </Button>
        </Space>
      ),
    },
  ];

  const progressCols: ColumnsType<AgentReleaseProgressItem> = [
    {
      title: t('agent.list.hostname'), key: 'hostname', width: 160,
      render: (_: unknown, r: AgentReleaseProgressItem) => (
        <Tooltip title={r.agent_id}>
          <span style={{ cursor: 'default' }}>{r.hostname || r.agent_id}</span>
        </Tooltip>
      ),
    },
    {
      title: t('agent.list.version'), dataIndex: 'current_version', key: 'current_version', width: 110,
      render: (v: string) => v ? mono(v) : <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>,
    },
    {
      title: t('agent.release.progress'), key: 'updated', width: 110,
      render: (_: unknown, r: AgentReleaseProgressItem) => r.updated
        ? <Tag icon={<CheckCircleFilled />} color="success">{t('agent.release.updated')}</Tag>
        : <Tag icon={<SyncOutlined spin />} color="processing">{t('agent.release.pending')}</Tag>,
    },
    {
      title: t('common.status'), dataIndex: 'status', key: 'status', width: 90,
      render: (v: string) => <StatusTag status={v} />,
    },
    {
      title: t('agent.list.lastSeen'), dataIndex: 'last_seen_at', key: 'last_seen_at',
      render: (v: string | null) => <RelativeTime value={v} />,
    },
  ];

  return (
    <div>
      <Alert type="info" showIcon message={t('agent.release.hint')} style={{ marginBottom: 16 }} />
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

      {/* Upload Release Modal */}
      <Modal
        title={t('agent.release.addRelease')}
        open={addOpen}
        onOk={handleAdd}
        onCancel={handleCloseAdd}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={uploading}
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
          <Form.Item label={t('agent.release.notes')} name="notes">
            <Input />
          </Form.Item>
          <Form.Item label={t('agent.release.uploadFile')} required>
            <Dragger
              beforeUpload={(file) => { setSelectedFile(file); return false; }}
              onRemove={() => setSelectedFile(null)}
              maxCount={1}
              fileList={selectedFile ? [{ uid: '1', name: selectedFile.name, size: selectedFile.size, status: 'done' }] : []}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">{t('agent.release.uploadHint')}</p>
              <p className="ant-upload-hint" style={{ fontSize: 12 }}>{t('agent.release.uploadNote')}</p>
            </Dragger>
          </Form.Item>
        </Form>
      </Modal>

      {/* Progress Modal */}
      <Modal
        title={
          progressRelease
            ? `${t('agent.release.progress')}: ${progressRelease.version} (${progressRelease.os}/${progressRelease.arch})`
            : t('agent.release.progress')
        }
        open={progressRelease !== null}
        onCancel={closeProgress}
        footer={null}
        width={860}
        destroyOnClose
      >
        <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          {progressData ? (
            <>
              <Tag
                color={progressData.updated_count === progressData.total && progressData.total > 0 ? 'success' : 'processing'}
                style={{ fontSize: 13, padding: '3px 10px' }}
              >
                {progressData.updated_count} / {progressData.total} {t('agent.release.updated')}
              </Tag>
              <span style={{ color: '#888', fontSize: 12 }}>
                <SyncOutlined spin={progressLoading} style={{ marginRight: 4 }} />
                {t('agent.release.autoRefresh')}
              </span>
            </>
          ) : (
            <Spin size="small" />
          )}
        </div>
        <Table
          size="small"
          dataSource={progressData?.agents ?? []}
          rowKey="agent_id"
          loading={progressLoading && !progressData}
          pagination={false}
          columns={progressCols}
        />
      </Modal>
    </div>
  );
};

export default TabReleases;
