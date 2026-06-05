import React, { useEffect, useState } from 'react';
import { Form, message, Modal, Select, Typography } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { updateTokenSettings } from '../api/auth';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  open: boolean;
  onClose: () => void;
}

const LIFETIME_OPTIONS = [
  { value: 1,   label: '1 小时' },
  { value: 8,   label: '8 小时' },
  { value: 24,  label: '24 小时（推荐）' },
  { value: 72,  label: '3 天' },
  { value: 168, label: '7 天' },
  { value: 720, label: '30 天' },
];

const { Text } = Typography;

const SessionSettingsModal: React.FC<Props> = ({ open, onClose }) => {
  const { user } = useAuth();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  // 打开时回填当前设置
  useEffect(() => {
    if (open && user) {
      const hours = user.token_lifetime_hours || 24;
      // 找最近的预设值，或者允许自定义
      const matched = LIFETIME_OPTIONS.find((o) => o.value === hours);
      form.setFieldValue('hours', matched ? hours : hours);
    }
  }, [open, user, form]);

  const handleOk = async () => {
    let values: { hours: number };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    setLoading(true);
    try {
      await updateTokenSettings(values.hours);
      message.success(`会话时长已更新为 ${LIFETIME_OPTIONS.find(o => o.value === values.hours)?.label ?? values.hours + ' 小时'}，下次 Token 刷新时生效`);
      onClose();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? '更新失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <ClockCircleOutlined style={{ marginRight: 8, color: '#1677ff' }} />
          会话时长设置
        </span>
      }
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      confirmLoading={loading}
      width={400}
    >
      <div style={{ marginBottom: 16, marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          设置登录会话令牌的有效期。到期前 5 分钟系统将自动静默刷新，无需重新登录。
          修改后将在下次 Token 刷新（或重新登录）时生效。
        </Text>
      </div>

      <Form form={form} layout="vertical">
        <Form.Item
          label="会话有效期"
          name="hours"
          rules={[{ required: true, message: '请选择会话时长' }]}
        >
          <Select
            size="large"
            options={LIFETIME_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            placeholder="选择会话有效期"
          />
        </Form.Item>
      </Form>

      <Text type="secondary" style={{ fontSize: 12 }}>
        当前设置：<strong>{user?.token_lifetime_hours || 24} 小时</strong>
        &nbsp;·&nbsp;Refresh Token 有效期由管理员在服务器配置中统一设定（默认 7 天）。
      </Text>
    </Modal>
  );
};

export default SessionSettingsModal;
