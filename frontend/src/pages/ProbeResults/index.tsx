import React, { useEffect, useState } from 'react';
import { Button, Form, InputNumber, Modal, Tabs, message } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { apiErrMsg, useT } from '../../i18n';
import { PERM_ADMIN, useCan } from '../../utils/perms';
import { getCurrentProbeJob, purgeProbeResults } from '../../api/agent';
import type { ProbeJob } from '../../types/agent';
import PageHeader from '../../components/PageHeader';
import TabGenericResults from './components/TabGenericResults';
import TabMeshPingMatrix from './components/TabMeshPingMatrix';
import ProbeJobProgressModal from './components/ProbeJobProgressModal';

const ProbeResultsPage: React.FC = () => {
  const t = useT();
  const isAdminUser = useCan(PERM_ADMIN);
  const [activeKey, setActiveKey] = useState('1');
  const [versions, setVersions]   = useState<Record<string, number>>({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purging, setPurging]     = useState(false);
  const [form] = Form.useForm();

  // 页头"清理历史数据"的后台任务进度框。页面挂载时若后端仍有任务在跑（无论是
  // 清理还是某个 Tab 发起的批量删除），也在这里重新挂上——Tab 组件随切换重建，
  // 不适合承担"跨页面刷新找回进度"这件事。
  const [job, setJob] = useState<{ id: string; kind?: ProbeJob['kind'] } | null>(null);

  useEffect(() => {
    if (!isAdminUser) return;
    getCurrentProbeJob()
      .then(r => { if (r.data.job) setJob({ id: r.data.job.id, kind: r.data.job.kind }); })
      .catch(() => { /* 非关键路径：查不到就当没有 */ });
  }, [isAdminUser]);

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key] + 1 }));
  };

  // 递增所有 Tab 的版本号强制重挂载（原先固定写 1，第二次清理后不会再触发重载）
  const reloadAllTabs = () =>
    setVersions((prev) => Object.fromEntries(Object.keys(prev).map(k => [k, prev[k] + 1])));

  const openPurge = () => {
    form.setFieldsValue({ days: 30 });
    setPurgeOpen(true);
  };

  const handlePurge = async () => {
    const { days } = await form.validateFields();
    Modal.confirm({
      title: t('proberesults.purgeTitle'),
      content: t('proberesults.purgeConfirm'),
      okText: t('common.confirm'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        setPurging(true);
        try {
          const r = await purgeProbeResults(days);
          setPurgeOpen(false);
          setJob({ id: r.data.job_id, kind: 'purge' });
        } catch (err: any) {
          // 409：已有清理/删除任务在跑，后端附带了它的 job_id——直接挂到那个任务的进度上
          const running = err?.response?.data?.job_id as string | undefined;
          if (running) {
            setPurgeOpen(false);
            setJob({ id: running });
            message.warning(apiErrMsg(err));
          } else {
            message.error(apiErrMsg(err));
          }
        } finally {
          setPurging(false);
        }
      },
    });
  };

  return (
    <div>
      <PageHeader
        title={t('proberesults.title')}
        subtitle={t('proberesults.subtitle')}
        actions={isAdminUser
          ? <Button danger icon={<DeleteOutlined />} onClick={openPurge}>{t('proberesults.purge')}</Button>
          : undefined}
      />
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={[
          { key: '1', label: t('proberesults.tab.ping'),       children: <TabGenericResults key={versions['1']} type="ping" /> },
          { key: '2', label: t('proberesults.tab.tcpping'),    children: <TabGenericResults key={versions['2']} type="tcpping" /> },
          { key: '3', label: t('proberesults.tab.httpcheck'),  children: <TabGenericResults key={versions['3']} type="httpcheck" /> },
          { key: '4', label: t('proberesults.tab.mtr'),        children: <TabGenericResults key={versions['4']} type="mtr" /> },
          { key: '5', label: t('proberesults.tab.meshping'),   children: <TabMeshPingMatrix key={versions['5']} /> },
        ]}
      />

      <Modal
        title={t('proberesults.purgeTitle')}
        open={purgeOpen}
        onOk={handlePurge}
        onCancel={() => setPurgeOpen(false)}
        okText={t('proberesults.purge')}
        okButtonProps={{ danger: true, loading: purging }}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            label={t('proberesults.purgeDaysLabel')}
            name="days"
            tooltip={t('proberesults.purgeDaysHint')}
            rules={[{ required: true }, { type: 'number', min: 0 }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 后台任务进度：每秒轮询；终态时提示并重载所有 Tab */}
      <ProbeJobProgressModal
        jobId={job?.id ?? null}
        kind={job?.kind}
        onFinished={(j) => {
          if (j.status === 'done') message.success(t('proberesults.job.done', { n: j.deleted_rows.toLocaleString() }));
          else message.error(t('proberesults.job.failed', { error: j.error ?? '' }));
          reloadAllTabs();
        }}
        onClose={() => setJob(null)}
      />
    </div>
  );
};

export default ProbeResultsPage;
