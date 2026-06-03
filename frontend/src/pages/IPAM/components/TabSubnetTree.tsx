import React, { useEffect, useState, useMemo } from 'react';
import { Table, Button, Select, Space, Modal, Form, message, Tag, Alert } from 'antd';
import { getRootPrefixes, getSubnetTree, splitSubnet, mergeSubnets } from '../../../api/ipam';
import { RootPrefix, SubnetNode } from '../../../types/ipam';
import { AxiosError } from 'axios';

interface UINode {
  key: string;
  id: number;
  cidr: string;
  level: string;
  target_type: 'root' | 'subnet';
  is_v4: boolean;
  children?: UINode[];
}

const TabSubnetTree: React.FC = () => {
  const [roots, setRoots] = useState<RootPrefix[]>([]);
  const [selectedRootId, setSelectedRootId] = useState<number | undefined>();
  const [treeData, setTreeData] = useState<UINode[]>([]);
  const [loading, setLoading] = useState(false);

  const [isSplitOpen, setIsSplitOpen] = useState(false);
  const [splitNode, setSplitNode] = useState<UINode | null>(null);
  const [splitForm] = Form.useForm();

  const [isMergeOpen, setIsMergeOpen] = useState(false);
  const [mergeParentNode, setMergeParentNode] = useState<UINode | null>(null);
  const [mergeSelectedKeys, setMergeSelectedKeys] = useState<React.Key[]>([]);
  
  useEffect(() => {
    const init = async () => {
      try {
        const res = await getRootPrefixes();
        setRoots(res.data);
        if (res.data.length > 0) {
          setSelectedRootId(res.data[0].id);
        }
      } catch (err) {
        message.error('无法获取根前缀列表');
      }
    };
    init();
  }, []);

  const fetchTree = async () => {
    if (!selectedRootId) return;
    setLoading(true);
    try {
      const res = await getSubnetTree(selectedRootId);
      const selectedRoot = roots.find(r => r.id === selectedRootId);
      
      if (selectedRoot) {
        const is_v4 = selectedRoot.ip_version === 4;
        
        const mapSubnetToUI = (node: SubnetNode): UINode => ({
          key: `subnet-${node.id}`,
          id: node.id,
          cidr: node.cidr,
          level: node.level,
          target_type: 'subnet',
          is_v4,
          children: node.children?.length ? node.children.map(mapSubnetToUI) : undefined
        });

        const syntheticRoot: UINode = {
          key: `root-${selectedRoot.id}`,
          id: selectedRoot.id,
          cidr: selectedRoot.cidr,
          level: 'Root',
          target_type: 'root',
          is_v4,
          children: res.data.length ? res.data.map(mapSubnetToUI) : undefined
        };
        
        setTreeData([syntheticRoot]);
      }
    } catch (err) {
      message.error('获取网段树失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTree();
  }, [selectedRootId, roots]); 

  const openSplitModal = (node: UINode) => {
    setSplitNode(node);
    splitForm.resetFields();
    setIsSplitOpen(true);
  };

  const handleSplitSubmit = async () => {
    if (!splitNode) return;
    try {
      const values = await splitForm.validateFields();
      await splitSubnet({
        target_type: splitNode.target_type,
        target_id: splitNode.id,
        target_bits: values.target_bits
      });
      message.success('拆分覆盖成功');
      setIsSplitOpen(false);
      fetchTree(); 
    } catch (err: any) {
      if (err.errorFields) return;
      if (err instanceof AxiosError && err.response?.status === 400) {
        Modal.error({ title: '拆分失败', content: err.response.data.error });
      } else {
        message.error('请求失败');
      }
    }
  };

  const maskOptions = useMemo(() => {
    if (!splitNode) return [];
    const parts = splitNode.cidr.split('/');
    if (parts.length !== 2) return [];
    
    const currentMask = parseInt(parts[1], 10);
    const maxMask = splitNode.is_v4 ? 32 : 128;
    const options = [];
    
    for (let i = currentMask + 1; i <= maxMask; i++) {
        if (i - currentMask <= 16) {
          options.push(
            <Select.Option key={i} value={i}>
              /{i} (生成 {1 << (i - currentMask)} 个)
            </Select.Option>
          );
        }
    }
    return options;
  }, [splitNode]);

  const openMergeModal = (parentNode: UINode) => {
    setMergeParentNode(parentNode);
    setMergeSelectedKeys([]);
    setIsMergeOpen(true);
  };

  const handleMergeSubmit = async () => {
    if (mergeSelectedKeys.length < 2) {
      message.warning('必须至少选择两个子网进行合并');
      return;
    }
    try {
      const ids = mergeSelectedKeys.map(key => parseInt(String(key).split('-')[1], 10));

      await mergeSubnets({ subnet_ids: ids });
      message.success('合并重归属成功');
      setIsMergeOpen(false);
      fetchTree(); 
    } catch (err: any) {
      if (err instanceof AxiosError && err.response?.status === 400) {
        Modal.error({ title: '安全合并校验被拒绝', content: err.response.data.error });
      } else {
        message.error('请求失败');
      }
    }
  };

  const columns = [
    { 
      title: '网段 (CIDR)', 
      dataIndex: 'cidr', 
      key: 'cidr', 
      render: (text: string, r: UINode) => r.level === 'Root' ? <strong style={{ fontSize: 15 }}>{text}</strong> : text 
    },
    { 
      title: '级别', 
      dataIndex: 'level', 
      key: 'level', 
      render: (l: string) => <Tag color={l === 'Root' ? 'purple' : l === 'L1' ? 'blue' : 'cyan'}>{l}</Tag> 
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: UINode) => (
        <Space size="middle">
          <Button type="link" size="small" onClick={() => openSplitModal(record)}>
            {record.children?.length ? '覆盖拆分' : '往下拆分'}
          </Button>
          
          {record.children && record.children.length > 0 && (
            <Button type="link" size="small" onClick={() => openMergeModal(record)}>
              合并下属子网
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16, background: '#f5f5f5', padding: '12px 16px', borderRadius: 6 }}>
        <span style={{ marginRight: 12, fontWeight: 500 }}>当前作用域 (根前缀) :</span>
        <Select 
          style={{ width: 350 }} 
          value={selectedRootId} 
          onChange={setSelectedRootId}
          placeholder="请选择顶级根前缀"
        >
          {roots.map(r => (
            <Select.Option key={r.id} value={r.id}>
              {r.cidr} ({r.group || '无分组'})
            </Select.Option>
          ))}
        </Select>
      </div>

      <Table 
        columns={columns} 
        dataSource={treeData} 
        rowKey="key"
        loading={loading}
        defaultExpandAllRows
        pagination={false}
      />

      <Modal
        title={splitNode?.children?.length ? "危险：覆盖拆分" : "新建拆分"}
        open={isSplitOpen}
        onOk={handleSplitSubmit}
        onCancel={() => setIsSplitOpen(false)}
        okText="确认拆分"
        destroyOnClose
      >
        <Form form={splitForm} layout="vertical">
          <div style={{ marginBottom: 20 }}>
            <div>当前目标：<strong>{splitNode?.cidr}</strong> <Tag>{splitNode?.level}</Tag></div>
            {splitNode?.children?.length ? (
               <Alert style={{ marginTop: 12 }} type="error" message="危险操作" description="当前节点已存在子网，此操作将清除旧的所有级联子网数据，并完全覆盖为新拆分的网段！" showIcon />
            ) : null}
          </div>
          <Form.Item name="target_bits" label="选择目标掩码长度 (Subnet Mask)" rules={[{ required: true, message: '请选择目标掩码' }]}>
            <Select placeholder="请选择将要切割出的网段大小">
              {maskOptions}
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`安全合并下属子网 - 所属父级: ${mergeParentNode?.cidr}`}
        open={isMergeOpen}
        onOk={handleMergeSubmit}
        onCancel={() => setIsMergeOpen(false)}
        okText="确认尝试合并"
        width={650}
        destroyOnClose
      >
        <Alert 
          style={{ marginBottom: 16 }} 
          type="info" 
          message="合并校验规则" 
          description="请勾选需要合并的同级子网。它们必须严格相邻、连续，且选中的数量必须是 2 的整数次幂（2, 4, 8, 16...），后端将执行绝对严格的标准网段判定。" 
          showIcon 
        />
        <Table
          rowSelection={{
            selectedRowKeys: mergeSelectedKeys,
            onChange: setMergeSelectedKeys,
          }}
          columns={[
            { title: '需要合并的子网', dataIndex: 'cidr', key: 'cidr', render: (t) => <strong>{t}</strong> },
            { title: '级别', dataIndex: 'level', key: 'level' }
          ]}
          dataSource={mergeParentNode?.children || []}
          rowKey="key"
          pagination={false}
          size="small"
        />
      </Modal>
    </div>
  );
};

export default TabSubnetTree;
