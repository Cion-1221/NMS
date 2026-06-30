/**
 * Login — re-skinned split-panel sign-in (Direction A "Clarity").
 * KEEPS the original loginApi + useAuth flow and validation; only the layout
 * and styling change. The left brand panel is hidden under 900px (.cion-login-brand
 * media query in index.html) so the form centers on narrow viewports.
 */
import React, { useState } from 'react';
import { Button, Checkbox, Form, Input, message } from 'antd';
import { ArrowRightOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { login as loginApi } from '../../api/auth';
import { useAuth } from '../../contexts/AuthContext';
import { useT } from '../../i18n';

const MONO = "var(--cion-mono)";

const MiniStat: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <div>
    <div style={{ fontSize: 24, fontWeight: 800, fontFamily: MONO, letterSpacing: '-.02em' }}>{value}</div>
    <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,.6)', marginTop: 2 }}>{label}</div>
  </div>
);

const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const t = useT();
  const [loading, setLoading] = useState(false);

  const handleFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await loginApi(values.username, values.password);
      login(res.data);
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? t('auth.login.errCred'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: 'var(--ant-color-bg-layout)' }}>
      {/* brand panel */}
      <div className="cion-login-brand" style={{
        width: '46%', maxWidth: 620, padding: 46, color: '#fff',
        display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden',
        background: 'linear-gradient(155deg,#0f1d3d 0%,#1e3a8a 55%,#1d4ed8 100%)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, background: 'rgba(255,255,255,.14)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 19 }}>C</div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
            <span style={{ fontSize: 17, fontWeight: 800 }}>CION</span>
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.32em', color: 'rgba(255,255,255,.6)' }}>NMS</span>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', maxWidth: 440 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '.18em', color: 'rgba(255,255,255,.55)', fontFamily: MONO, marginBottom: 20 }}>
            NETWORK MANAGEMENT SYSTEM
          </div>
          <h1 style={{ fontSize: 38, lineHeight: 1.15, fontWeight: 800, margin: '0 0 18px', letterSpacing: '-.02em' }}>
            One console for every network you operate.
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,.72)', margin: 0 }}>
            Device inventory, IPAM, distributed probes and mesh latency monitoring — unified, observable, and built for NOC teams.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 40 }}>
          <MiniStat value="1,284" label="Managed devices" />
          <MiniStat value="92" label="Active probes" />
          <MiniStat value="99.2%" label="Probe success" />
        </div>
      </div>

      {/* form panel */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <div style={{ width: '100%', maxWidth: 380 }}>
          <h2 style={{ fontSize: 25, fontWeight: 700, margin: '0 0 7px', color: 'var(--ant-color-text)' }}>
            {t('auth.login.title')}
          </h2>
          <p style={{ fontSize: 14, color: 'var(--ant-color-text-secondary)', margin: '0 0 30px' }}>
            {t('auth.login.subtitle')}
          </p>

          <Form layout="vertical" onFinish={handleFinish} autoComplete="off" size="large" requiredMark={false}>
            <Form.Item name="username" label={t('auth.login.username')}
              rules={[{ required: true, message: `${t('auth.login.username')} is required` }]}>
              <Input prefix={<UserOutlined />} placeholder={t('auth.login.username')} />
            </Form.Item>
            <Form.Item name="password"
              label={
                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                  <span>{t('auth.login.password')}</span>
                </div>
              }
              rules={[{ required: true, message: `${t('auth.login.password')} is required` }]}>
              <Input.Password prefix={<LockOutlined />} placeholder={t('auth.login.password')} />
            </Form.Item>
            <Form.Item>
              <Checkbox defaultChecked>{t('auth.login.remember')}</Checkbox>
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Button type="primary" htmlType="submit" block loading={loading} iconPosition="end" icon={<ArrowRightOutlined />}>
                {t('auth.login.btn')}
              </Button>
            </Form.Item>
          </Form>

          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: 26, fontSize: 12, color: 'var(--ant-color-text-tertiary)',
          }}>
            <span style={{ fontFamily: MONO }}>v2.4.1 · SSO enabled</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
