import React, { useState } from 'react';
import {
  Badge, Button, Descriptions, Form, Input, message, Modal,
  Radio, Select, Space, Tabs, Typography,
} from 'antd';
import {
  LockOutlined, SafetyOutlined, SettingOutlined, UserOutlined,
} from '@ant-design/icons';
import { changePassword, updateProfile, updateTokenSettings } from '../api/auth';
import { useAuth } from '../contexts/AuthContext';
import { useAppContext, ThemeMode, Language } from '../contexts/AppContext';
import { useT } from '../i18n';

const { Text } = Typography;

const SESSION_OPTIONS = [
  { value: 1,   label: '1 hour' },
  { value: 8,   label: '8 hours' },
  { value: 24,  label: '24 hours (default)' },
  { value: 72,  label: '3 days' },
  { value: 168, label: '7 days' },
  { value: 720, label: '30 days' },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

// ── Account Tab ──────────────────────────────────────────────────────────────
const AccountTab: React.FC = () => {
  const { user } = useAuth();
  const t = useT();
  if (!user) return null;
  return (
    <Descriptions column={1} bordered size="small" style={{ marginTop: 8 }}>
      <Descriptions.Item label={<><UserOutlined /> {t('profile.username')}</>}>
        <Text strong>{user.username}</Text>
      </Descriptions.Item>
      <Descriptions.Item label={t('profile.group')}>{user.group_name}</Descriptions.Item>
      <Descriptions.Item label={t('profile.role')}>
        {user.is_admin
          ? <Badge status="error" text={<Text type="danger">{t('profile.role.admin')}</Text>} />
          : <Badge status="default" text={t('profile.role.user')} />}
      </Descriptions.Item>
    </Descriptions>
  );
};

// ── Preferences Tab ──────────────────────────────────────────────────────────
const PreferencesTab: React.FC = () => {
  const { user, refreshSession, token } = useAuth();
  const { theme, language, setTheme, setLanguage } = useAppContext();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [sessionHours, setSessionHours] = useState(user?.token_lifetime_hours ?? 24);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Persist theme + language to server
      await updateProfile({ theme, language });
      // Persist session duration
      await updateTokenSettings(sessionHours);
      // Refresh client-side user so AppContext picks up new values on next login
      if (token && user) {
        const refreshToken = localStorage.getItem('nms_refresh_token') ?? '';
        const expiresAt = localStorage.getItem('nms_token_expires_at') ?? '';
        refreshSession({
          access_token: localStorage.getItem('nms_access_token') ?? '',
          refresh_token: refreshToken,
          access_token_expires_at: expiresAt,
          user: { ...user, theme, language, token_lifetime_hours: sessionHours },
        });
      }
      message.success(t('common.success'));
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size="large">
      {/* Theme */}
      <div>
        <Text strong>{t('prefs.theme')}</Text>
        <br />
        <Radio.Group
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeMode)}
          style={{ marginTop: 8 }}
          optionType="button"
          buttonStyle="solid"
          options={[
            { label: t('prefs.theme.light'),  value: 'light' },
            { label: t('prefs.theme.dark'),   value: 'dark' },
            { label: t('prefs.theme.system'), value: 'system' },
          ]}
        />
      </div>

      {/* Language */}
      <div>
        <Text strong>{t('prefs.language')}</Text>
        <br />
        <Radio.Group
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          style={{ marginTop: 8 }}
          optionType="button"
          buttonStyle="solid"
          options={[
            { label: 'English', value: 'en' },
            { label: '中文',    value: 'zh' },
          ]}
        />
      </div>

      {/* Session duration */}
      <div>
        <Text strong>{t('prefs.session')}</Text>
        <br />
        <Select
          value={sessionHours}
          onChange={setSessionHours}
          options={SESSION_OPTIONS}
          style={{ width: 220, marginTop: 8 }}
        />
        <br />
        <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
          {t('prefs.session.hint')}
        </Text>
      </div>

      <div>
        <Button type="primary" loading={saving} onClick={handleSave}>
          {t('prefs.savePrefs')}
        </Button>
      </div>
    </Space>
  );
};

// ── Security Tab ─────────────────────────────────────────────────────────────
const SecurityTab: React.FC = () => {
  const { refreshSession } = useAuth();
  const t = useT();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const handleChangePwd = async () => {
    let v: { old_password: string; new_password: string; confirm: string };
    try { v = await form.validateFields(); } catch { return; }
    if (v.new_password !== v.confirm) {
      form.setFields([{ name: 'confirm', errors: [t('security.pwdMismatch')] }]);
      return;
    }
    setSaving(true);
    try {
      const res = await changePassword(v.old_password, v.new_password);
      message.success(t('security.changePwdOk'));
      form.resetFields();
      refreshSession(res.data);
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form form={form} layout="vertical" style={{ marginTop: 8, maxWidth: 340 }}>
      <Form.Item
        label={t('security.oldPwd')} name="old_password"
        rules={[{ required: true }]}
      >
        <Input.Password prefix={<LockOutlined />} />
      </Form.Item>
      <Form.Item
        label={t('security.newPwd')} name="new_password"
        rules={[{ required: true }, { min: 8, message: t('security.pwdMinLen') }]}
      >
        <Input.Password prefix={<LockOutlined />} />
      </Form.Item>
      <Form.Item
        label={t('security.confirmPwd')} name="confirm"
        rules={[{ required: true }]}
      >
        <Input.Password prefix={<LockOutlined />} />
      </Form.Item>
      <Form.Item>
        <Button type="primary" loading={saving} onClick={handleChangePwd}>
          {t('security.changePwd')}
        </Button>
      </Form.Item>
    </Form>
  );
};

// ── Main Modal ────────────────────────────────────────────────────────────────
const ProfileModal: React.FC<Props> = ({ open, onClose }) => {
  const { user } = useAuth();
  const t = useT();

  return (
    <Modal
      title={
        <Space>
          <UserOutlined />
          {t('profile.title')} — {user?.username}
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      destroyOnClose
    >
      <Tabs
        items={[
          {
            key: 'account',
            label: <span><UserOutlined /> {t('profile.tab.account')}</span>,
            children: <AccountTab />,
          },
          {
            key: 'prefs',
            label: <span><SettingOutlined /> {t('profile.tab.prefs')}</span>,
            children: <PreferencesTab />,
          },
          {
            key: 'security',
            label: <span><SafetyOutlined /> {t('profile.tab.security')}</span>,
            children: <SecurityTab />,
          },
        ]}
      />
    </Modal>
  );
};

export default ProfileModal;
