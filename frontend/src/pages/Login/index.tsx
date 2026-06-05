import React, { useState } from 'react';
import { Button, Card, Form, Input, message, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { login as loginApi } from '../../api/auth';
import { useAuth } from '../../contexts/AuthContext';

const { Title, Text } = Typography;

const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await loginApi(values.username, values.password);
      // 将完整 Token 包存入 AuthContext（含 refresh_token + expires_at）
      login(res.data);
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? '登录失败，请检查网络';
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #141414 0%, #1d2b45 100%)',
      }}
    >
      <Card
        style={{ width: 380, borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.4)' }}
        variant="borderless"
      >
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: 12,
              background: 'linear-gradient(135deg, #1677ff, #0958d9)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: 12,
            }}
          >
            <span style={{ color: '#fff', fontSize: 24, fontWeight: 'bold' }}>N</span>
          </div>
          <Title level={3} style={{ margin: 0 }}>NMS 网络管理系统</Title>
          <Text type="secondary" style={{ fontSize: 13 }}>Network Management System</Text>
        </div>

        <Form layout="vertical" onFinish={handleFinish} autoComplete="off">
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input
              size="large"
              prefix={<UserOutlined style={{ color: '#bfbfbf' }} />}
              placeholder="用户名"
            />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
            style={{ marginBottom: 24 }}
          >
            <Input.Password
              size="large"
              prefix={<LockOutlined style={{ color: '#bfbfbf' }} />}
              placeholder="密码"
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" size="large" block loading={loading}>
              登 录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
};

export default LoginPage;
