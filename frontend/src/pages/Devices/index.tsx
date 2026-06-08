import React, { useState } from 'react';
import { Tabs, Typography } from 'antd';
import { useT } from '../../i18n';
import TabDeviceList from './components/TabDeviceList';
import TabSites from './components/TabSites';
import TabPoPs from './components/TabPoPs';
import TabRoles from './components/TabRoles';
import TabVendors from './components/TabVendors';
import TabDeviceAuditLog from './components/TabDeviceAuditLog';

const { Title } = Typography;

const DevicesPage: React.FC = () => {
  const t = useT();
  const [activeKey, setActiveKey] = useState('1');
  // Each tab's version number; incrementing the version forces a remount (fresh data)
  const [versions, setVersions] = useState({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 });

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key as keyof typeof prev] + 1 }));
  };

  const items = [
    {
      key: '1',
      label: t('device.tab.list'),
      children: <TabDeviceList key={versions['1']} />,
    },
    {
      key: '2',
      label: t('device.tab.sites'),
      children: <TabSites key={versions['2']} />,
    },
    {
      key: '3',
      label: t('device.tab.pops'),
      children: <TabPoPs key={versions['3']} />,
    },
    {
      key: '4',
      label: t('device.tab.roles'),
      children: <TabRoles key={versions['4']} />,
    },
    {
      key: '5',
      label: t('device.tab.vendors'),
      children: <TabVendors key={versions['5']} />,
    },
    {
      key: '6',
      label: t('device.tab.audit'),
      children: <TabDeviceAuditLog key={versions['6']} />,
    },
  ];

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>{t('device.title')}</Title>
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={items}
        destroyInactiveTabPane={false}
      />
    </div>
  );
};

export default DevicesPage;
