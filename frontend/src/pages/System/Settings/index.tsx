import React, { useState } from 'react';
import { Tabs, Typography } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { useT } from '../../../i18n';
import TabSecuritySettings from './components/TabSecuritySettings';
import TabLockouts from './components/TabLockouts';

const { Title } = Typography;

// ─────────────────────────────────────────────────────────────────────────────
// 系统安全设置页：Tab 容器（与 IPAM / Devices 页面同款交互模式）。
//   Tab 1 防护配置 —— 登录防爆破阈值
//   Tab 2 锁定列表 —— 查看/搜索/解除当前被锁定的「用户名 + IP」
// 仅管理员可见（路由级 + 后端 AdminRequired 双重保障）。
// ─────────────────────────────────────────────────────────────────────────────

const SystemSettingsPage: React.FC = () => {
  const t = useT();
  const [activeKey, setActiveKey] = useState('1');
  // Each tab's version number; incrementing forces a remount → fresh data on every tab switch
  const [versions, setVersions] = useState({ '1': 0, '2': 0 });

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
  ];

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>
        <SafetyCertificateOutlined style={{ marginRight: 8 }} />
        {t('sysset.title')}
      </Title>
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
