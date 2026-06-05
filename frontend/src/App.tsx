import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Spin } from 'antd';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { MainLayout } from './layouts/MainLayout';
import LoginPage from './pages/Login';
import IPAMPage from './pages/IPAM';
import SystemUserPage from './pages/System/User';
import SystemGroupPage from './pages/System/Group';
import ChangePasswordModal from './components/ChangePasswordModal';

/**
 * AppRouter —— 所有路由决策集中于此
 *
 * 状态机：
 *   loading  → 显示加载占位
 *   未登录    → 显示登录页
 *   已登录但需改密 → 显示强制改密 Modal（底层仍渲染布局，但 API 会被后端 403 拦截）
 *   已登录正常  → 按角色渲染路由
 */
const AppRouter: React.FC = () => {
  const { user, token, loading } = useAuth();

  // 1. 从 localStorage 恢复会话时的加载态
  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  // 2. 未登录 → 所有路径均渲染登录页
  if (!token || !user) {
    return <LoginPage />;
  }

  // 3. 已登录但首次登录强制改密（后端同步拦截非改密接口）
  if (user.must_change_password) {
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #141414 0%, #1d2b45 100%)' }}>
        <ChangePasswordModal open forced onClose={() => {}} />
      </div>
    );
  }

  // 4. 正常路由
  return (
    <MainLayout>
      <Routes>
        <Route path="/" element={<Navigate to="/ipam" replace />} />
        <Route path="/ipam" element={<IPAMPage />} />

        {/* System 路由：仅管理员可访问 */}
        {user.is_admin && (
          <>
            <Route path="/system/users" element={<SystemUserPage />} />
            <Route path="/system/groups" element={<SystemGroupPage />} />
          </>
        )}

        {/* 非管理员访问 /system/* → 静默重定向 */}
        <Route path="/system/*" element={<Navigate to="/ipam" replace />} />

        {/* 兜底 */}
        <Route path="*" element={<Navigate to="/ipam" replace />} />
      </Routes>
    </MainLayout>
  );
};

const App: React.FC = () => (
  <BrowserRouter>
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  </BrowserRouter>
);

export default App;
