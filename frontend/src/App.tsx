import React, { Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfigProvider, Spin } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';

import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppProvider, useAppContext } from './contexts/AppContext';
import { buildTheme, palette } from './theme/theme';
import { MainLayout } from './layouts/MainLayout';
import LoginPage from './pages/Login';
// Dashboard pulls in @ant-design/charts (g2, heavy) — lazy-load so login and the
// other routes don't carry that chunk.
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
import IPAMPage from './pages/IPAM';
import DevicesPage from './pages/Devices';
import AgentPage from './pages/Agent';
import ProbeResultsPage from './pages/ProbeResults';
import SystemUserPage from './pages/System/User';
import SystemGroupPage from './pages/System/Group';
import SystemSettingsPage from './pages/System/Settings';
import ChangePasswordModal from './components/ChangePasswordModal';

// ── Theme / locale wrapper (must be inside AppProvider) ──────────────────────

const ThemedShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { resolvedTheme, language } = useAppContext();

  useEffect(() => {
    document.title = 'CION NMS';
  }, [language]);

  // Keep the document body bg in sync with the theme so nothing flashes white in
  // dark mode behind full-height screens (body is outside React/antd's cssVar scope).
  useEffect(() => {
    document.body.style.background = palette[resolvedTheme].bg;
  }, [resolvedTheme]);

  return (
    <ConfigProvider
      theme={buildTheme(resolvedTheme)}
      locale={language === 'zh' ? zhCN : enUS}
    >
      {children}
    </ConfigProvider>
  );
};

// ── Route controller ─────────────────────────────────────────────────────────

const AppRouter: React.FC = () => {
  const { user, token, loading } = useAuth();
  const { resolvedTheme } = useAppContext();
  // These two screens render outside any antd component, so their bg must be a
  // real palette hex (cssVar refs don't resolve here) — otherwise white in dark mode.
  const bg = palette[resolvedTheme].bg;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: bg }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!token || !user) return <LoginPage />;

  if (user.must_change_password) {
    return (
      <div style={{ minHeight: '100vh', background: bg }}>
        <ChangePasswordModal open forced onClose={() => {}} />
      </div>
    );
  }

  return (
    <MainLayout>
      <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spin size="large" /></div>}>
      <Routes>
        <Route path="/"             element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard"    element={<Dashboard />} />
        <Route path="/ipam"         element={<IPAMPage />} />
        <Route path="/devices"      element={<DevicesPage />} />
        <Route path="/probe-results" element={<ProbeResultsPage />} />
        {user.is_admin && (
          <>
            <Route path="/agents"          element={<AgentPage />} />
            <Route path="/system/users"    element={<SystemUserPage />} />
            <Route path="/system/groups"   element={<SystemGroupPage />} />
            <Route path="/system/settings" element={<SystemSettingsPage />} />
          </>
        )}
        <Route path="/system/*" element={<Navigate to="/dashboard" replace />} />
        <Route path="*"         element={<Navigate to="/dashboard" replace />} />
      </Routes>
      </Suspense>
    </MainLayout>
  );
};

// ── Root ─────────────────────────────────────────────────────────────────────

const App: React.FC = () => (
  <BrowserRouter>
    <AuthProvider>
      <AppProvider>
        <ThemedShell>
          <AppRouter />
        </ThemedShell>
      </AppProvider>
    </AuthProvider>
  </BrowserRouter>
);

export default App;
