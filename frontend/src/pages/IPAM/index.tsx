import React, { useState } from 'react';
import { Tabs } from 'antd';
import { useT } from '../../i18n';
import TabRootPrefix from './components/TabRootPrefix';
import TabSubnetTree from './components/TabSubnetTree';
import TabGroups     from './components/TabGroups';
import TabTypes      from './components/TabTypes';
import TabVRF        from './components/TabVRF';
import TabAuditLog   from './components/TabAuditLog';

const IPAMPage: React.FC = () => {
  const t = useT();
  const [activeKey, setActiveKey] = useState('1');
  const [versions, setVersions]   = useState<Record<string, number>>(
    { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 },
  );

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key] + 1 }));
  };

  return (
    <div>
      <h2 style={{ marginBottom: 24, fontWeight: 700 }}>{t('ipam.title')}</h2>
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={[
          { key: '1', label: t('ipam.tab.roots'),   children: <TabRootPrefix key={versions['1']} /> },
          { key: '2', label: t('ipam.tab.subnets'),  children: <TabSubnetTree key={versions['2']} /> },
          { key: '3', label: t('ipam.tab.groups'),   children: <TabGroups    key={versions['3']} /> },
          { key: '4', label: t('ipam.tab.types'),    children: <TabTypes     key={versions['4']} /> },
          { key: '5', label: t('ipam.tab.vrf'),      children: <TabVRF       key={versions['5']} /> },
          { key: '6', label: t('ipam.tab.audit'),    children: <TabAuditLog  key={versions['6']} /> },
        ]}
      />
    </div>
  );
};

export default IPAMPage;
