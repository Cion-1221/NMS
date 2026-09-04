import React, { useState } from 'react';
import {
  Badge, Button, Descriptions, Divider, Form, Input, message, Modal, QRCode,
  Radio, Select, Space, Tabs, Typography,
} from 'antd';
import {
  LockOutlined, SafetyCertificateOutlined, SafetyOutlined, SettingOutlined, UserOutlined,
} from '@ant-design/icons';
import {
  changePassword, updateProfile, updateTokenSettings,
  totpSetup, totpEnable, totpDisable, totpRegenerateRecoveryCodes,
} from '../api/auth';
import type { TOTPSetupResp } from '../types/auth';
import { useAuth } from '../contexts/AuthContext';
import { useAppContext, ThemeMode, Language } from '../contexts/AppContext';
import { apiErrMsg, useT } from '../i18n';
import { FONT_MONO } from '../theme/theme';
import StatusTag from './StatusTag';

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
      <Descriptions.Item label={t('security.totp.title')}>
        {user.totp_enabled
          ? <StatusTag status="active" label={t('security.totp.on')} />
          : <StatusTag status="unknown" tone="neutral" label={t('security.totp.off')} />}
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
      message.error(apiErrMsg(err));
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

// ── Recovery codes dialog（明文只展示这一次）──────────────────────────────────
const RecoveryCodesModal: React.FC<{ codes: string[] | null; onClose: () => void }> = ({ codes, onClose }) => {
  const t = useT();
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText((codes ?? []).join('\n'));
      message.success(t('security.totp.copied'));
    } catch { /* http 环境剪贴板可能不可用：用户可手动选中复制 */ }
  };
  return (
    <Modal
      title={t('security.totp.codesTitle')}
      open={!!codes}
      onCancel={onClose}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={copyAll}>{t('security.totp.copyAll')}</Button>
          <Button type="primary" onClick={onClose}>{t('common.close')}</Button>
        </Space>
      }
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>{t('security.totp.codesHint')}</Text>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 18px',
        fontFamily: FONT_MONO, fontSize: 14, padding: '12px 16px',
        background: 'var(--ant-color-fill-quaternary)', border: '1px solid var(--ant-color-border)', borderRadius: 8,
      }}>
        {(codes ?? []).map((c) => <span key={c}>{c}</span>)}
      </div>
    </Modal>
  );
};

// ── Two-factor section ───────────────────────────────────────────────────────
const TwoFactorSection: React.FC = () => {
  const { user, updateStoredUser } = useAuth();
  const t = useT();
  const [setup, setSetup] = useState<TOTPSetupResp | null>(null);
  const [enableCode, setEnableCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableForm] = Form.useForm();
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenCode, setRegenCode] = useState('');

  const enabled = !!user?.totp_enabled;

  const startSetup = async () => {
    setBusy(true);
    try {
      const res = await totpSetup();
      setSetup(res.data);
      setEnableCode('');
    } catch (err: any) { message.error(apiErrMsg(err)); }
    finally { setBusy(false); }
  };

  const confirmEnable = async () => {
    if (!enableCode.trim()) return;
    setBusy(true);
    try {
      const res = await totpEnable(enableCode.trim());
      setSetup(null);
      setCodes(res.data.recovery_codes ?? []);
      updateStoredUser({ totp_enabled: true });
      message.success(t('security.totp.enabledOk'));
    } catch (err: any) { message.error(apiErrMsg(err)); }
    finally { setBusy(false); }
  };

  const handleDisable = async () => {
    let v: { password: string; code: string };
    try { v = await disableForm.validateFields(); } catch { return; }
    setBusy(true);
    try {
      await totpDisable(v.password, v.code.trim());
      setDisableOpen(false);
      disableForm.resetFields();
      updateStoredUser({ totp_enabled: false });
      message.success(t('security.totp.disabledOk'));
    } catch (err: any) { message.error(apiErrMsg(err)); }
    finally { setBusy(false); }
  };

  const handleRegen = async () => {
    if (!regenCode.trim()) return;
    setBusy(true);
    try {
      const res = await totpRegenerateRecoveryCodes(regenCode.trim());
      setRegenOpen(false);
      setRegenCode('');
      setCodes(res.data.recovery_codes ?? []);
    } catch (err: any) { message.error(apiErrMsg(err)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ maxWidth: 440 }}>
      <Space align="center" style={{ marginBottom: 6 }}>
        <SafetyCertificateOutlined />
        <Text strong>{t('security.totp.title')}</Text>
        {enabled
          ? <StatusTag status="active" label={t('security.totp.on')} />
          : <StatusTag status="unknown" tone="neutral" label={t('security.totp.off')} />}
      </Space>
      <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>
        {t('security.totp.intro')}
      </Text>

      {!enabled && !setup && (
        <Button type="primary" loading={busy} onClick={startSetup}>{t('security.totp.enable')}</Button>
      )}

      {!enabled && setup && (
        <div style={{
          padding: 16, borderRadius: 8,
          background: 'var(--ant-color-fill-quaternary)', border: '1px solid var(--ant-color-border)',
        }}>
          <Text style={{ display: 'block', marginBottom: 10 }}>{t('security.totp.scan')}</Text>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <QRCode value={setup.otpauth_uri} size={168} bordered={false} />
            <div style={{ flex: 1, minWidth: 180 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>Secret</Text>
              <Text copyable code style={{ display: 'block', fontFamily: FONT_MONO, wordBreak: 'break-all', marginBottom: 12 }}>
                {setup.secret}
              </Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                {t('security.totp.confirmCode')}
              </Text>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={enableCode}
                  onChange={(e) => setEnableCode(e.target.value)}
                  placeholder="123456"
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  style={{ fontFamily: FONT_MONO, letterSpacing: '.12em' }}
                  onPressEnter={confirmEnable}
                />
                <Button type="primary" loading={busy} onClick={confirmEnable}>{t('security.totp.confirm')}</Button>
              </Space.Compact>
              <Button type="text" size="small" style={{ marginTop: 8 }} onClick={() => setSetup(null)} disabled={busy}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {enabled && (
        <Space wrap>
          <Button onClick={() => setRegenOpen(true)}>{t('security.totp.regen')}</Button>
          <Button danger onClick={() => setDisableOpen(true)}>{t('security.totp.disable')}</Button>
        </Space>
      )}

      {/* 关闭两步验证：当前密码 + 验证码（或恢复码） */}
      <Modal
        title={t('security.totp.disable')}
        open={disableOpen}
        onOk={handleDisable}
        onCancel={() => { setDisableOpen(false); disableForm.resetFields(); }}
        okText={t('security.totp.disable')}
        okButtonProps={{ danger: true, loading: busy }}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>{t('security.totp.disableHint')}</Text>
        <Form form={disableForm} layout="vertical">
          <Form.Item label={t('security.totp.password')} name="password" rules={[{ required: true }]}>
            <Input.Password prefix={<LockOutlined />} />
          </Form.Item>
          <Form.Item label={t('security.totp.code')} name="code" rules={[{ required: true }]}>
            <Input maxLength={32} autoComplete="one-time-code" style={{ fontFamily: FONT_MONO }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重新生成恢复码：验证码确认 */}
      <Modal
        title={t('security.totp.regen')}
        open={regenOpen}
        onOk={handleRegen}
        onCancel={() => { setRegenOpen(false); setRegenCode(''); }}
        okText={t('security.totp.regen')}
        okButtonProps={{ loading: busy }}
        cancelText={t('common.cancel')}
        destroyOnClose
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>{t('security.totp.regenHint')}</Text>
        <Input
          value={regenCode}
          onChange={(e) => setRegenCode(e.target.value)}
          placeholder="123456"
          maxLength={32}
          autoComplete="one-time-code"
          style={{ fontFamily: FONT_MONO }}
          onPressEnter={handleRegen}
        />
      </Modal>

      <RecoveryCodesModal codes={codes} onClose={() => setCodes(null)} />
    </div>
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
      // 改密后服务端已吊销其余会话，响应里的新 Token 对是唯一有效会话
      refreshSession(res.data);
    } catch (err: any) {
      message.error(apiErrMsg(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <Form form={form} layout="vertical" style={{ maxWidth: 340 }}>
        <Form.Item
          label={t('security.oldPwd')} name="old_password"
          rules={[{ required: true }]}
        >
          <Input.Password prefix={<LockOutlined />} />
        </Form.Item>
        <Form.Item
          label={t('security.newPwd')} name="new_password"
          rules={[{ required: true }, { min: 8, message: t('security.pwdMinLen') }, { max: 72 }]}
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

      <Divider style={{ margin: '8px 0 16px' }} />
      <TwoFactorSection />
    </div>
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
      width={560}
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
