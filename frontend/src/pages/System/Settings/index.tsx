import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Form, InputNumber, Space, Spin, Switch, Typography, message,
} from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { getSecuritySettings, updateSecuritySettings } from '../../../api/system';
import type { SecuritySettings } from '../../../types/system';
import { useT } from '../../../i18n';

const { Title } = Typography;

// ─────────────────────────────────────────────────────────────────────────────
// 系统安全设置：登录防爆破阈值（滑动窗口失败计数 + 临时锁定）。
// 仅管理员可见（路由级 + 后端 AdminRequired 双重保障）。
// ─────────────────────────────────────────────────────────────────────────────

const SystemSettingsPage: React.FC = () => {
  const t = useT();
  const [form] = Form.useForm<SecuritySettings>();
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  // 关闭总开关时禁用阈值输入，避免误导（值仍保留，再次开启即恢复）
  const enabled = Form.useWatch('enabled', form);

  const load = async () => {
    setLoading(true);
    try {
      const r = await getSecuritySettings();
      form.setFieldsValue(r.data);
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await updateSecuritySettings(values);
      message.success(t('sysset.saveOk'));
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <Title level={4} style={{ marginTop: 0 }}>
        <SafetyCertificateOutlined style={{ marginRight: 8 }} />
        {t('sysset.title')}
      </Title>

      <Card>
        <Alert
          type="info"
          showIcon
          message={t('sysset.desc')}
          style={{ marginBottom: 24 }}
        />

        <Spin spinning={loading}>
          <Form form={form} layout="vertical">
            <Form.Item
              label={t('sysset.enabled')}
              name="enabled"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>

            <Form.Item
              label={t('sysset.maxAttempts')}
              name="max_attempts"
              rules={[{ required: true, type: 'number', min: 1, max: 100 }]}
              extra={t('sysset.maxAttemptsHint')}
            >
              <InputNumber min={1} max={100} style={{ width: 200 }} disabled={!enabled} />
            </Form.Item>

            <Form.Item
              label={t('sysset.windowMinutes')}
              name="window_minutes"
              rules={[{ required: true, type: 'number', min: 1, max: 1440 }]}
              extra={t('sysset.windowMinutesHint')}
            >
              <InputNumber min={1} max={1440} style={{ width: 200 }} disabled={!enabled} />
            </Form.Item>

            <Form.Item
              label={t('sysset.lockoutMinutes')}
              name="lockout_minutes"
              rules={[{ required: true, type: 'number', min: 1, max: 1440 }]}
              extra={t('sysset.lockoutMinutesHint')}
            >
              <InputNumber min={1} max={1440} style={{ width: 200 }} disabled={!enabled} />
            </Form.Item>

            <Space>
              <Button type="primary" loading={saving} onClick={handleSave}>
                {t('common.save')}
              </Button>
              <Button onClick={() => { void load(); }} disabled={loading}>
                {t('common.refresh')}
              </Button>
            </Space>
          </Form>
        </Spin>
      </Card>
    </div>
  );
};

export default SystemSettingsPage;
