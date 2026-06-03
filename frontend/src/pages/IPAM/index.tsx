import React from 'react';
import { Tabs } from 'antd';
import TabRootPrefix from './components/TabRootPrefix';
import TabSubnetTree from './components/TabSubnetTree';

const IPAMPage: React.FC = () => {
  return (
    <div className="ipam-container">
      <h2 style={{ marginBottom: 24, fontWeight: 'bold' }}>NMS - IP 地址管理 (IPAM) 系统</h2>
      
      <Tabs
        defaultActiveKey="1"
        items={[
          {
            key: '1',
            label: '根前缀管理 (Root Prefixes)',
            children: <TabRootPrefix />,
          },
          {
            key: '2',
            label: '网段拆分与合并管理 (Subnets Hierarchy)',
            children: <TabSubnetTree />,
          },
        ]}
      />
    </div>
  );
};

export default IPAMPage;
