import React, { useState } from 'react';
import { Avatar, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import {
  ClockCircleOutlined,
  ClusterOutlined,
  LogoutOutlined,
  LockOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import ChangePasswordModal from '../components/ChangePasswordModal';
import SessionSettingsModal from '../components/SessionSettingsModal';

const { Header, Content, Sider } = Layout;
const { Text } = Typography;

export const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const [changePwdOpen, setChangePwdOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);

  const currentPath = location.pathname;
  const defaultOpenKeys = currentPath.startsWith('/system') ? ['system'] : ['network_server'];

  const sidebarItems = [
    {
      key: 'network_server',
      icon: <ClusterOutlined />,
      label: 'Network Server',
      children: [{ key: '/ipam', label: 'IPAM 地址管理' }],
    },
    ...(user?.is_admin
      ? [{
          key: 'system',
          icon: <SettingOutlined />,
          label: 'System',
          children: [
            { key: '/system/users',  icon: <UserOutlined />, label: 'User' },
            { key: '/system/groups', icon: <TeamOutlined />, label: 'Group' },
          ],
        }]
      : []),
  ];

  const userMenuItems = [
    {
      key: 'change-pwd',
      icon: <LockOutlined />,
      label: '修改密码',
      onClick: () => setChangePwdOpen(true),
    },
    {
      key: 'session',
      icon: <ClockCircleOutlined />,
      label: '会话时长设置',
      onClick: () => setSessionOpen(true),
    },
    { type: 'divider' as const },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
      onClick: () => logout(),
    },
  ];

  return (
    <>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider width={220} theme="dark">
          <div
            style={{
              height: 40, margin: '12px 16px', borderRadius: 6,
              background: 'rgba(255,255,255,0.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontWeight: 700, fontSize: 14, letterSpacing: 1,
            }}
          >
            NMS 网络管理
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[currentPath]}
            defaultOpenKeys={defaultOpenKeys}
            items={sidebarItems}
            onSelect={({ key }) => navigate(key)}
          />
        </Sider>

        <Layout>
          <Header
            style={{
              background: '#fff', padding: '0 24px',
              boxShadow: '0 1px 4px rgba(0,21,41,.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            }}
          >
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
              <Space style={{ cursor: 'pointer', userSelect: 'none' }}>
                <Avatar size="small" icon={<UserOutlined />} style={{ background: '#1677ff' }} />
                <Text style={{ fontSize: 14 }}>{user?.username}</Text>
                {user?.is_admin && (
                  <Text type="secondary" style={{ fontSize: 12 }}>管理员</Text>
                )}
              </Space>
            </Dropdown>
          </Header>

          <Content style={{ margin: 16 }}>
            <div style={{ padding: 24, minHeight: 360, background: '#fff', borderRadius: 8 }}>
              {children}
            </div>
          </Content>
        </Layout>
      </Layout>

      <ChangePasswordModal open={changePwdOpen} forced={false} onClose={() => setChangePwdOpen(false)} />
      <SessionSettingsModal open={sessionOpen} onClose={() => setSessionOpen(false)} />
    </>
  );
};
