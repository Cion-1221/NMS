import React, { useCallback, useState } from 'react';
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
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key] + 1 }));
  };

  // Stable callbacks so child components don't re-render on every parent render
  const onCount1 = useCallback((n: number) => setCounts((p) => ({ ...p, '1': n })), []);
  const onCount2 = useCallback((n: number) => setCounts((p) => ({ ...p, '2': n })), []);
  const onCount3 = useCallback((n: number) => setCounts((p) => ({ ...p, '3': n })), []);
  const onCount4 = useCallback((n: number) => setCounts((p) => ({ ...p, '4': n })), []);
  const onCount5 = useCallback((n: number) => setCounts((p) => ({ ...p, '5': n })), []);
  const onCount6 = useCallback((n: number) => setCounts((p) => ({ ...p, '6': n })), []);

  const label = (key: string, text: string) => {
    const n = counts[key];
    return n !== undefined ? `${text} (${n})` : text;
  };

  return (
    <div>
      <h2 style={{ marginBottom: 24, fontWeight: 700 }}>{t('ipam.title')}</h2>
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={[
          { key: '1', label: label('1', t('ipam.tab.roots')),
            children: <TabRootPrefix key={versions['1']} onCount={onCount1} /> },
          { key: '2', label: label('2', t('ipam.tab.subnets')),
            children: <TabSubnetTree key={versions['2']} onCount={onCount2} /> },
          { key: '3', label: label('3', t('ipam.tab.groups')),
            children: <TabGroups    key={versions['3']} onCount={onCount3} /> },
          { key: '4', label: label('4', t('ipam.tab.types')),
            children: <TabTypes     key={versions['4']} onCount={onCount4} /> },
          { key: '5', label: label('5', t('ipam.tab.vrf')),
            children: <TabVRF       key={versions['5']} onCount={onCount5} /> },
          { key: '6', label: label('6', t('ipam.tab.audit')),
            children: <TabAuditLog  key={versions['6']} onCount={onCount6} /> },
        ]}
      />
    </div>
  );
};

export default IPAMPage;
