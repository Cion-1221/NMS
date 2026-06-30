/**
 * MainLayout — re-skinned app shell (Direction A "Clarity").
 *
 * KEEPS the original behavior: admin-gated nav, react-router navigate,
 * ProfileModal, logout. CHANGES: airy surface-colored sidebar with grouped
 * captions + pill active state, brand lockup, status footer, and a richer
 * topbar (search affordance, theme toggle, notifications, user menu).
 *
 * Nav IA note: the prototype flattens to ONE leaf per domain (each page already
 * has its own Tabs for Sites/Roles/VRF/etc.), with the old parent menus becoming
 * non-clickable group captions. Routes are unchanged. The System domain keeps its
 * three real routes (Users / Groups / Security) as leaves under one caption so
 * nothing is orphaned.
 */
import React, { useState } from 'react';
import { Avatar, Badge, Dropdown, Input, Layout, Menu, Tooltip, Typography } from 'antd';
import {
  AppstoreOutlined, BellOutlined, BulbOutlined, CloudServerOutlined, DesktopOutlined,
  LogoutOutlined, MoonOutlined, RadarChartOutlined, SafetyCertificateOutlined, SearchOutlined,
  ShareAltOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAppContext } from '../contexts/AppContext';
import { updateProfile } from '../api/auth';
import { useT } from '../i18n';
import ProfileModal from '../components/ProfileModal';

const { Header, Content, Sider } = Layout;
const { Text } = Typography;

export const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { resolvedTheme, setTheme } = useAppContext();
  const t = useT();
  const [profileOpen, setProfileOpen] = useState(false);

  const currentPath = location.pathname;

  // Quick light/dark toggle. Persist to the server too (fire-and-forget) so the
  // choice is durable on next login — otherwise AppContext would re-sync from the
  // stale server `user.theme`. System mode stays available via the profile modal.
  const toggleTheme = () => {
    const next = resolvedTheme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    updateProfile({ theme: next }).catch(() => {});
  };

  // Flattened, grouped nav. type:'group' renders a non-clickable caption.
  const items = [
    { key: '/dashboard', icon: <AppstoreOutlined />, label: t('nav.overview') },
    {
      type: 'group' as const, label: t('nav.infrastructure'),
      children: [
        { key: '/devices', icon: <DesktopOutlined />, label: t('nav.devices') },
        { key: '/ipam', icon: <ShareAltOutlined />, label: t('nav.ipam') },
      ],
    },
    {
      type: 'group' as const, label: t('nav.monitoring'),
      children: [
        ...(user?.is_admin ? [{ key: '/agents', icon: <CloudServerOutlined />, label: t('nav.agentManagement') }] : []),
        { key: '/probe-results', icon: <RadarChartOutlined />, label: t('nav.probeResults') },
      ],
    },
    ...(user?.is_admin
      ? [{
          type: 'group' as const, label: t('nav.administration'),
          children: [
            { key: '/system/users', icon: <TeamOutlined />, label: t('nav.users') },
            { key: '/system/groups', icon: <UserOutlined />, label: t('nav.groups') },
            { key: '/system/settings', icon: <SafetyCertificateOutlined />, label: t('nav.settings') },
          ],
        }]
      : []),
  ];

  const userMenu = [
    { key: 'profile', icon: <UserOutlined />, label: t('profile.title'), onClick: () => setProfileOpen(true) },
    { type: 'divider' as const },
    { key: 'logout', icon: <LogoutOutlined />, label: t('auth.logout'), danger: true, onClick: () => logout() },
  ];

  return (
    <>
      <Layout style={{ minHeight: '100vh' }}>
        <Sider
          width={258}
          theme="light"
          style={{
            borderRight: '1px solid var(--ant-color-border-secondary)',
            padding: '18px 14px',
            position: 'sticky', top: 0, height: '100vh',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* brand */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '6px 8px 20px' }}>
              <div style={{
                width: 38, height: 38, borderRadius: 11, display: 'flex', alignItems: 'center',
                justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 19,
                background: 'linear-gradient(150deg,#3b82f6,#1e40af)',
                boxShadow: '0 4px 12px -3px rgba(37,99,235,.6)',
              }}>C</div>
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.05 }}>
                <span style={{ fontSize: 15.5, fontWeight: 800, letterSpacing: '-.01em', color: 'var(--ant-color-text)' }}>CION</span>
                <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.3em', color: 'var(--ant-color-text-tertiary)' }}>NMS</span>
              </div>
            </div>

            <Menu
              mode="inline"
              selectedKeys={[currentPath]}
              items={items}
              onSelect={({ key }) => navigate(key)}
              style={{ border: 'none', background: 'transparent', flex: 1, overflowY: 'auto' }}
            />

            {/* status footer */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '12px 10px 4px',
              fontSize: 12, color: 'var(--ant-color-text-secondary)',
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: 'var(--ant-color-success)',
                animation: 'cionPulse 2s infinite',
              }} />
              {t('common.allSystemsOk')}
            </div>
          </div>
        </Sider>

        <Layout>
          <Header style={{ display: 'flex', alignItems: 'center', gap: 16, borderBottom: '1px solid var(--ant-color-border-secondary)' }}>
            <div style={{ flex: 1 }} />
            <Input
              prefix={<SearchOutlined style={{ color: 'var(--ant-color-text-tertiary)' }} />}
              suffix={<span style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', fontFamily: 'var(--cion-mono)' }}>⌘K</span>}
              placeholder={t('common.searchPlaceholder')}
              variant="filled"
              style={{ maxWidth: 260 }}
            />
            <Tooltip title={t('common.theme')}>
              <span onClick={toggleTheme} style={iconBtn}>
                {resolvedTheme === 'dark' ? <BulbOutlined /> : <MoonOutlined />}
              </span>
            </Tooltip>
            <Badge dot color="#dc2626" offset={[-4, 4]}>
              <span style={iconBtn}><BellOutlined /></span>
            </Badge>

            <Dropdown menu={{ items: userMenu }} placement="bottomRight" trigger={['click']}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '4px 6px', borderRadius: 10 }}>
                <Avatar size={34} style={{ background: 'linear-gradient(135deg,#2563eb,#1e40af)', fontWeight: 700 }}>
                  {user?.username?.slice(0, 2).toUpperCase()}
                </Avatar>
                <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
                  <Text style={{ fontSize: 13, fontWeight: 600 }}>{user?.username}</Text>
                  {user?.is_admin && <Text type="secondary" style={{ fontSize: 11 }}>{t('auth.admin')}</Text>}
                </div>
              </div>
            </Dropdown>
          </Header>

          <Content style={{ overflowY: 'auto' }}>
            {/* key=path re-triggers the subtle enter animation on each navigation */}
            <div key={currentPath} className="cion-page" style={{ padding: 30, maxWidth: 1480, margin: '0 auto' }}>
              {children}
            </div>
          </Content>
        </Layout>
      </Layout>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
};

const iconBtn: React.CSSProperties = {
  width: 38, height: 38, borderRadius: 10, border: '1px solid var(--ant-color-border)',
  background: 'var(--ant-color-bg-container)', color: 'var(--ant-color-text-secondary)',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
};

export default MainLayout;
