import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfigProvider, Spin, theme as antdTheme } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';

import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AppProvider, useAppContext } from './contexts/AppContext';
import { MainLayout } from './layouts/MainLayout';
import LoginPage from './pages/Login';
import IPAMPage from './pages/IPAM';
import SystemUserPage from './pages/System/User';
import SystemGroupPage from './pages/System/Group';
import ChangePasswordModal from './components/ChangePasswordModal';

// ── Theme / locale wrapper (must be inside AppProvider) ──────────────────────

const ThemedShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { resolvedTheme, language } = useAppContext();
  return (
    <ConfigProvider
      theme={{ algorithm: resolvedTheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}
      locale={language === 'zh' ? zhCN : enUS}
    >
      {children}
    </ConfigProvider>
  );
};

// ── Route controller ─────────────────────────────────────────────────────────

const AppRouter: React.FC = () => {
  const { user, token, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!token || !user) return <LoginPage />;

  if (user.must_change_password) {
    return (
      <div style={{ minHeight: '100vh' }}>
        <ChangePasswordModal open forced onClose={() => {}} />
      </div>
    );
  }

  return (
    <MainLayout>
      <Routes>
        <Route path="/"      element={<Navigate to="/ipam" replace />} />
        <Route path="/ipam"  element={<IPAMPage />} />
        {user.is_admin && (
          <>
            <Route path="/system/users"  element={<SystemUserPage />} />
            <Route path="/system/groups" element={<SystemGroupPage />} />
          </>
        )}
        <Route path="/system/*" element={<Navigate to="/ipam" replace />} />
        <Route path="*"         element={<Navigate to="/ipam" replace />} />
      </Routes>
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
