import React, { useState } from 'react';
import { Button, Form, InputNumber, Modal, Tabs, message } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { apiErrMsg, useT } from '../../i18n';
import { PERM_ADMIN, useCan } from '../../utils/perms';
import { purgeProbeResults } from '../../api/agent';
import PageHeader from '../../components/PageHeader';
import TabGenericResults from './components/TabGenericResults';
import TabMeshPingMatrix from './components/TabMeshPingMatrix';

const ProbeResultsPage: React.FC = () => {
  const t = useT();
  const isAdminUser = useCan(PERM_ADMIN);
  const [activeKey, setActiveKey] = useState('1');
  const [versions, setVersions]   = useState<Record<string, number>>({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purging, setPurging]     = useState(false);
  const [form] = Form.useForm();

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key] + 1 }));
  };

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
          message.success(t('proberesults.purgeOk').replace('{n}', String(r.data.deleted)));
          setPurgeOpen(false);
          // bump all tab versions so they reload
          setVersions({ '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 });
        } catch (err: any) {
          message.error(apiErrMsg(err));
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
    </div>
  );
};

export default ProbeResultsPage;
