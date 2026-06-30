import React, { useEffect, useState } from 'react';
import { Col, Row, Tabs } from 'antd';
import { useT } from '../../i18n';
import PageHeader from '../../components/PageHeader';
import StatTile from '../../components/StatTile';
import { getRootPrefixes, getVRFs, getGroups, getIPAMTypes } from '../../api/ipam';
import TabRootPrefix from './components/TabRootPrefix';
import TabSubnetTree from './components/TabSubnetTree';
import TabGroups     from './components/TabGroups';
import TabTypes      from './components/TabTypes';
import TabVRF        from './components/TabVRF';
import TabAuditLog   from './components/TabAuditLog';

interface Counts { roots: number; vrfs: number; groups: number; types: number }

const IPAMPage: React.FC = () => {
  const t = useT();
  const [activeKey, setActiveKey] = useState('1');
  const [versions, setVersions]   = useState<Record<string, number>>(
    { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 },
  );
  const [counts, setCounts] = useState<Counts | null>(null);

  // Cheap real summary counts — composed from existing list endpoints.
  useEffect(() => {
    Promise.all([getRootPrefixes(), getVRFs(), getGroups(), getIPAMTypes()])
      .then(([r, v, g, tp]) => setCounts({
        roots: r.data.length, vrfs: v.data.length, groups: g.data.length, types: tp.data.length,
      }))
      .catch(() => {});
  }, []);

  const handleTabChange = (key: string) => {
    setActiveKey(key);
    setVersions((prev) => ({ ...prev, [key]: prev[key] + 1 }));
  };

  return (
    <div>
      <PageHeader title={t('ipam.title')} subtitle={t('ipam.subtitle')} />

      <Row gutter={[20, 20]} style={{ marginBottom: 20 }}>
        <Col xs={12} sm={6}><StatTile label={t('ipam.stat.roots')}  value={counts ? counts.roots  : '—'} /></Col>
        <Col xs={12} sm={6}><StatTile label={t('ipam.stat.vrfs')}   value={counts ? counts.vrfs   : '—'} /></Col>
        <Col xs={12} sm={6}><StatTile label={t('ipam.stat.groups')} value={counts ? counts.groups : '—'} /></Col>
        <Col xs={12} sm={6}><StatTile label={t('ipam.stat.types')}  value={counts ? counts.types  : '—'} /></Col>
      </Row>

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
