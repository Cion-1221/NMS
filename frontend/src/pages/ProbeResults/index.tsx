import React, { useState } from 'react';
import { Tabs } from 'antd';
import { useT } from '../../i18n';
import TabGenericResults from './components/TabGenericResults';
import TabMeshPingMatrix from './components/TabMeshPingMatrix';

const ProbeResultsPage: React.FC = () => {
  const t = useT();
  const [activeKey, setActiveKey] = useState('1');
  const [versions, setVersions]   = useState<Record<string, number>>({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key] + 1 }));
  };

  return (
    <div>
      <h2 style={{ marginBottom: 24, fontWeight: 700 }}>{t('proberesults.title')}</h2>
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={[
          { key: '1', label: t('proberesults.tab.ping'),       children: <TabGenericResults key={versions['1']} type="ping" /> },
          { key: '2', label: t('proberesults.tab.tcpping'),    children: <TabGenericResults key={versions['2']} type="tcpping" /> },
          { key: '3', label: t('proberesults.tab.httpcheck'),  children: <TabGenericResults key={versions['3']} type="httpcheck" /> },
          { key: '4', label: t('proberesults.tab.mtr'),        children: <TabGenericResults key={versions['4']} type="mtr" /> },
          { key: '5', label: t('proberesults.tab.meshping'),   children: <TabMeshPingMatrix key={versions['5']} /> },
        ]}
      />
    </div>
  );
};

export default ProbeResultsPage;
