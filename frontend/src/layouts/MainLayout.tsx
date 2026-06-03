import React from 'react';
import { Layout, Menu } from 'antd';
import { ClusterOutlined } from '@ant-design/icons';

const { Header, Content, Sider } = Layout;

export const MainLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={220} theme="dark">
        <div style={{ height: 32, margin: 16, background: 'rgba(255, 255, 255, 0.2)', borderRadius: 4 }} />
        <Menu 
          theme="dark" 
          mode="inline" 
          defaultSelectedKeys={['ipam']}
          defaultOpenKeys={['network_server']}
          items={[
            {
              key: 'network_server',
              icon: <ClusterOutlined />,
              label: 'Network Server',
              children: [
                { key: 'ipam', label: 'IPAM 地址管理' },
              ],
            },
          ]}
        />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: 0, boxShadow: '0 1px 4px rgba(0,21,41,.08)' }} />
        <Content style={{ margin: '16px 16px' }}>
          <div style={{ padding: 24, minHeight: 360, background: '#fff', borderRadius: 8 }}>
            {children}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
};
