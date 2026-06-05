import React, { useState } from 'react';
import { Button, Card, Form, Input, message, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { login as loginApi } from '../../api/auth';
import { useAuth } from '../../contexts/AuthContext';
import { useAppContext } from '../../contexts/AppContext';
import { useT } from '../../i18n';

const { Title, Text } = Typography;

const LoginPage: React.FC = () => {
  const { login }         = useAuth();
  const { resolvedTheme } = useAppContext();
  const t                 = useT();
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

  const isDark = resolvedTheme === 'dark';

  const bg = isDark
    ? 'linear-gradient(135deg, #0a0a0a 0%, #111c30 100%)'
    : 'linear-gradient(135deg, #e8f0fe 0%, #f0f4ff 100%)';

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
        padding: '16px',
      }}
    >
      <Card
        style={{
          width: '100%',
          maxWidth: 400,
          borderRadius: 16,
          boxShadow: isDark
            ? '0 8px 40px rgba(0,0,0,0.6)'
            : '0 8px 40px rgba(0,0,0,0.12)',
        }}
        variant="borderless"
      >
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 14,
              background: 'linear-gradient(135deg,#1677ff,#0950d9)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 14,
            }}
          >
            <span style={{ color: '#fff', fontSize: 26, fontWeight: 900, fontFamily: 'monospace' }}>N</span>
          </div>
          <Title level={3} style={{ margin: 0 }}>NMS</Title>
          <Text type="secondary">{t('auth.login.subtitle')}</Text>
        </div>

        <Form layout="vertical" onFinish={handleFinish} autoComplete="off" size="large">
          <Form.Item name="username" rules={[{ required: true, message: `${t('auth.login.username')} is required` }]}>
            <Input prefix={<UserOutlined />} placeholder={t('auth.login.username')} />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: `${t('auth.login.password')} is required` }]}
            style={{ marginBottom: 24 }}
          >
            <Input.Password prefix={<LockOutlined />} placeholder={t('auth.login.password')} />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>
              {t('auth.login.btn')}
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default LoginPage;
