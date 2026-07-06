import React, { useState } from 'react';
import { Tabs } from 'antd';
import { useT } from '../../../i18n';
import PageHeader from '../../../components/PageHeader';
import TabSecuritySettings from './components/TabSecuritySettings';
import TabLockouts from './components/TabLockouts';
import TabSysAuditLog from './components/TabSysAuditLog';

// ─────────────────────────────────────────────────────────────────────────────
// 系统安全设置页：Tab 容器（与 IPAM / Devices 页面同款交互模式）。
//   Tab 1 防护配置 —— 登录防爆破阈值 + 会话策略
//   Tab 2 锁定列表 —— 查看/搜索/解除当前被锁定的「用户名 + IP」
//   Tab 3 审计日志 —— 用户/用户组/安全设置/会话管理操作留痕
// 仅管理员可见（路由级 + 后端 AdminRequired 双重保障）。
// ─────────────────────────────────────────────────────────────────────────────

const SystemSettingsPage: React.FC = () => {
  const t = useT();
  const [activeKey, setActiveKey] = useState('1');
  // Each tab's version number; incrementing forces a remount → fresh data on every tab switch
  const [versions, setVersions] = useState({ '1': 0, '2': 0, '3': 0 });

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key as keyof typeof prev] + 1 }));
  };

  const items = [
    {
      key: '1',
      label: t('sysset.tab.settings'),
      children: <TabSecuritySettings key={versions['1']} />,
    },
    {
      key: '2',
      label: t('sysset.lockouts.title'),
      children: <TabLockouts key={versions['2']} />,
    },
    {
      key: '3',
      label: t('sysaudit.title'),
      children: <TabSysAuditLog key={versions['3']} />,
    },
  ];

  return (
    <div>
      <PageHeader title={t('sysset.title')} subtitle={t('sysset.desc')} />
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={items}
        destroyInactiveTabPane={false}
      />
    </div>
  );
};

export default SystemSettingsPage;
