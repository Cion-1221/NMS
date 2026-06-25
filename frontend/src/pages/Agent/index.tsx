import React, { useState } from 'react';
import { Tabs } from 'antd';
import { useT } from '../../i18n';
import TabAgentList   from './components/TabAgentList';
import TabGroups      from './components/TabGroups';
import TabProbeConfig from './components/TabProbeConfig';
import TabTokens      from './components/TabTokens';
import TabReleases    from './components/TabReleases';

const AgentPage: React.FC = () => {
  const t = useT();
  const [activeKey, setActiveKey] = useState('1');
  const [versions, setVersions]   = useState<Record<string, number>>({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key] + 1 }));
  };

  return (
    <div>
      <h2 style={{ marginBottom: 24, fontWeight: 700 }}>{t('agent.title')}</h2>
      <Tabs
        activeKey={activeKey}
        onChange={handleTabChange}
        items={[
          { key: '1', label: t('agent.tab.list'),        children: <TabAgentList   key={versions['1']} /> },
          { key: '2', label: t('agent.tab.group'),        children: <TabGroups      key={versions['2']} /> },
          { key: '3', label: t('agent.tab.probeConfig'),  children: <TabProbeConfig key={versions['3']} /> },
          { key: '4', label: t('agent.tab.token'),        children: <TabTokens      key={versions['4']} /> },
          { key: '5', label: t('agent.tab.releases'),     children: <TabReleases    key={versions['5']} /> },
        ]}
      />
    </div>
  );
};

export default AgentPage;
