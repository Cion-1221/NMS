import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Divider, Form, InputNumber, Space, Spin, Switch, message,
} from 'antd';
import {
  getSecuritySettings, updateSecuritySettings,
  getSessionPolicy, updateSessionPolicy,
} from '../../../../api/system';
import type { SecuritySettings, SessionPolicy } from '../../../../types/system';
import { apiErrMsg, useT } from '../../../../i18n';

// ─────────────────────────────────────────────────────────────────────────────
// 防护配置 Tab：登录防爆破阈值（滑动窗口失败计数 + 临时锁定）+ 会话策略
// （全局最大会话时长，签发 Token 时对用户自设值做钳制）。
// ─────────────────────────────────────────────────────────────────────────────

const TabSecuritySettings: React.FC = () => {
  const t = useT();
  const [form] = Form.useForm<SecuritySettings>();
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);

  const [sessionForm] = Form.useForm<SessionPolicy>();
  const [sessionSaving, setSessionSaving] = useState(false);

  // 关闭总开关时禁用阈值输入，避免误导（值仍保留，再次开启即恢复）
  const enabled = Form.useWatch('enabled', form);

  const load = async () => {
    setLoading(true);
    try {
      const [sec, sess] = await Promise.all([getSecuritySettings(), getSessionPolicy()]);
      form.setFieldsValue(sec.data);
      sessionForm.setFieldsValue(sess.data);
    } catch (err: any) {
      message.error(apiErrMsg(err));
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
      message.error(apiErrMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSessionSave = async () => {
    const values = await sessionForm.validateFields();
    setSessionSaving(true);
    try {
      await updateSessionPolicy(values);
      message.success(t('sysset.saveOk'));
    } catch (err: any) {
      message.error(apiErrMsg(err));
    } finally {
      setSessionSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 640 }}>
      <Alert
        type="info"
        showIcon
        message={t('sysset.desc')}
        style={{ marginBottom: 24 }}
      />

      <Spin spinning={loading}>
        <Form form={form} layout="vertical" style={{ maxWidth: 560 }}>
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

        <Divider />

        {/* ── 会话策略 ── */}
        <Form form={sessionForm} layout="vertical" style={{ maxWidth: 560 }}>
          <Form.Item
            label={t('sysset.session.maxLifetime')}
            name="max_token_lifetime_hours"
            rules={[{ required: true, type: 'number', min: 1, max: 720 }]}
            extra={t('sysset.session.maxLifetimeHint')}
          >
            <InputNumber min={1} max={720} style={{ width: 200 }} />
          </Form.Item>
          <Button type="primary" loading={sessionSaving} onClick={handleSessionSave}>
            {t('common.save')}
          </Button>
        </Form>
      </Spin>
    </div>
  );
};

export default TabSecuritySettings;
