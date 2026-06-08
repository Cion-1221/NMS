import React, { useState } from 'react';
import { Avatar, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import {
  ClusterOutlined,
  DesktopOutlined,
  LogoutOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../i18n';
import ProfileModal from '../components/ProfileModal';

const { Header, Content, Sider } = Layout;
const { Text } = Typography;

export const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const t = useT();
  const [profileOpen, setProfileOpen] = useState(false);

  const currentPath = location.pathname;
  const defaultOpen = currentPath.startsWith('/system')
    ? ['system']
    : currentPath.startsWith('/devices')
      ? ['devices']
      : ['network_services'];

  const sidebarItems = [
    {
      key:      'network_services',
      icon:     <ClusterOutlined />,
      label:    t('nav.networkServices'),
      children: [{ key: '/ipam', label: t('nav.ipam') }],
    },
    {
      key:      'devices',
      icon:     <DesktopOutlined />,
      label:    t('nav.devices'),
      children: [{ key: '/devices', label: t('nav.deviceList') }],
    },
    ...(user?.is_admin
      ? [{
          key:      'system',
          icon:     <SettingOutlined />,
          label:    t('nav.system'),
          children: [
            { key: '/system/users',  icon: <UserOutlined />, label: t('nav.users') },
            { key: '/system/groups', icon: <TeamOutlined />, label: t('nav.groups') },
          ],
        }]
      : []),
  ];

  const dropdownItems = [
    {
      key:     'profile',
      icon:    <UserOutlined />,
      label:   t('profile.title'),
      onClick: () => setProfileOpen(true),
    },
    { type: 'divider' as const },
    {
      key:     'logout',
      icon:    <LogoutOutlined />,
      label:   t('auth.logout'),
      danger:  true,
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
              background: 'rgba(255,255,255,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontWeight: 700, fontSize: 15, letterSpacing: 1,
            }}
          >
            {t('nav.brand')}
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[currentPath]}
            defaultOpenKeys={defaultOpen}
            items={sidebarItems}
            onSelect={({ key }) => navigate(key)}
          />
        </Sider>

        <Layout>
          <Header
            style={{
              background: 'inherit',
              padding: '0 24px',
              boxShadow: '0 1px 4px rgba(0,0,0,.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
            }}
          >
            <Dropdown menu={{ items: dropdownItems }} placement="bottomRight" trigger={['click']}>
              <Space style={{ cursor: 'pointer', userSelect: 'none' }}>
                <Avatar size="small" icon={<UserOutlined />} style={{ background: '#1677ff' }} />
                <Text style={{ fontSize: 14 }}>{user?.username}</Text>
                {user?.is_admin && (
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('auth.admin')}</Text>
                )}
              </Space>
            </Dropdown>
          </Header>

          <Content style={{ margin: 16 }}>
            <div style={{ padding: 24, minHeight: 360, borderRadius: 8 }}>
              {children}
            </div>
          </Content>
        </Layout>
      </Layout>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
};
