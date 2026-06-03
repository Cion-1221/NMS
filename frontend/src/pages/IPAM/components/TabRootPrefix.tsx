import React, { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, Radio, Space, message, Tag } from 'antd';
import { ExclamationCircleFilled } from '@ant-design/icons';
import { getRootPrefixes, createRootPrefix, updateRootPrefix, deleteRootPrefix } from '../../../api/ipam';
import { RootPrefix } from '../../../types/ipam';
import { AxiosError } from 'axios';

const { confirm } = Modal;

const TabRootPrefix: React.FC = () => {
  const [data, setData] = useState<RootPrefix[]>([]);
  const [loading, setLoading] = useState(false);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
  const [editingRecord, setEditingRecord] = useState<RootPrefix | null>(null);
  
  const [form] = Form.useForm();

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await getRootPrefixes();
      setData(res.data);
    } catch (err) {
      message.error('获取列表失败，请检查网络');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchList();
  }, []);

  const openCreateModal = () => {
    setModalMode('create');
    form.resetFields();
    form.setFieldsValue({ ip_version: 4 });
    setIsModalOpen(true);
  };

  const openEditModal = (record: RootPrefix) => {
    setModalMode('edit');
    setEditingRecord(record);
    form.setFieldsValue({
      ip_version: record.ip_version,
      cidr: record.cidr,
      group: record.group,
      type: record.type,
    });
    setIsModalOpen(true);
  };

  const handleDelete = (id: number) => {
    confirm({
      title: '极其危险的操作确认',
      icon: <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content: '删除根前缀将级联清空其下属的所有 L1 / L2 子网数据，且绝对不可恢复！是否确认彻底删除？',
      okText: '确认彻底删除',
      okType: 'danger',
      cancelText: '取消操作',
      onOk: async () => {
        try {
          await deleteRootPrefix(id);
          message.success('已成功删除及清理级联数据');
          fetchList();
        } catch (err) {
          message.error('删除失败，请稍后重试');
        }
      },
    });
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (modalMode === 'create') {
        await createRootPrefix(values);
        message.success('创建成功');
      } else {
        await updateRootPrefix(editingRecord!.id, {
          group: values.group,
          type: values.type,
        });
        message.success('更新成功');
      }
      setIsModalOpen(false);
      fetchList();
    } catch (err: any) {
      if (err.errorFields) return; 
      
      if (err instanceof AxiosError && err.response?.status === 400) {
        Modal.error({
          title: '地址格式校验被拒绝',
          content: err.response.data.error || 'CIDR 格式不标准，或参数验证失败',
        });
      } else {
         message.error('请求失败，发生未知错误');
      }
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id' },
    { 
      title: 'IP 版本', 
      dataIndex: 'ip_version', 
      key: 'ip_version', 
      render: (v: number) => (
        <Tag color={v === 4 ? 'blue' : 'green'}>IPv{v}</Tag>
      ) 
    },
    { title: '根前缀 (CIDR)', dataIndex: 'cidr', key: 'cidr', render: (text: string) => <strong>{text}</strong> },
    { title: '业务分组', dataIndex: 'group', key: 'group' },
    { title: '网段类型', dataIndex: 'type', key: 'type' },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: RootPrefix) => (
        <Space size="middle">
          <Button type="link" onClick={() => openEditModal(record)}>编辑附加属性</Button>
          <Button type="text" danger onClick={() => handleDelete(record.id)}>删除危险!</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Button type="primary" onClick={openCreateModal}>+ 新增根前缀</Button>
      </div>
      
      <Table 
        columns={columns} 
        dataSource={data} 
        rowKey="id" 
        loading={loading}
        pagination={{ pageSize: 10 }}
      />

      <Modal
        title={modalMode === 'create' ? '新建根前缀' : '编辑根前缀 (受限模式)'}
        open={isModalOpen}
        onOk={handleSubmit}
        onCancel={() => setIsModalOpen(false)}
        okText="保存入库"
        cancelText="取消"
        width={500}
      >
        <Form form={form} layout="vertical">
          <Form.Item label="IP 版本" name="ip_version" rules={[{ required: true }]}>
            <Radio.Group disabled={modalMode === 'edit'}>
              <Radio value={4}>IPv4</Radio>
              <Radio value={6}>IPv6</Radio>
            </Radio.Group>
          </Form.Item>
          
          <Form.Item 
            label="根前缀 (CIDR)" 
            name="cidr" 
            rules={[{ required: true, message: '必须输入 CIDR' }]}
            extra={modalMode === 'create' ? "重要：必须输入标准网络地址（不能带主机位），一经创建绝对不可更改。" : ""}
          >
            <Input disabled={modalMode === 'edit'} placeholder="例如: 10.0.0.0/8 或 2001:db8::/32" />
          </Form.Item>
          
          <Form.Item label="业务分组 (Group)" name="group">
            <Input placeholder="输入业务分组名称" />
          </Form.Item>
          
          <Form.Item label="网段类型 (Type)" name="type">
            <Input placeholder="输入网段类型 (如: 办公区, 生产区)" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabRootPrefix;
