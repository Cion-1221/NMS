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
  const [treeKey, setTreeKey]     = useState(0);

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    if (key === '2') setTreeKey((n) => n + 1);
  };

  return (
    <div>
      <h2 style={{ marginBottom: 24, fontWeight: 700 }}>{t('ipam.title')}</h2>
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={[
          { key: '1', label: t('ipam.tab.roots'),   children: <TabRootPrefix /> },
          { key: '2', label: t('ipam.tab.subnets'),  children: <TabSubnetTree key={treeKey} /> },
          { key: '3', label: t('ipam.tab.groups'),   children: <TabGroups /> },
          { key: '4', label: t('ipam.tab.types'),    children: <TabTypes /> },
          { key: '5', label: t('ipam.tab.vrf'),      children: <TabVRF /> },
          { key: '6', label: t('ipam.tab.audit'),    children: <TabAuditLog /> },
        ]}
      />
    </div>
  );
};

export default IPAMPage;
