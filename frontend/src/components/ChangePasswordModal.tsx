import React, { useState } from 'react';
import { Form, Input, message, Modal } from 'antd';
import { LockOutlined, WarningOutlined } from '@ant-design/icons';
import { changePassword } from '../api/auth';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  open: boolean;
  /** forced=true 时：首次登录强制改密，不可关闭 */
  forced: boolean;
  onClose: () => void;
}

const ChangePasswordModal: React.FC<Props> = ({ open, forced, onClose }) => {
  const { refreshSession } = useAuth();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async () => {
    let values: { old_password: string; new_password: string; confirm: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }

    if (values.new_password !== values.confirm) {
      form.setFields([{ name: 'confirm', errors: ['两次输入的新密码不一致'] }]);
      return;
    }

    setLoading(true);
    try {
      const res = await changePassword(values.old_password, values.new_password);
      message.success('密码已成功修改');
      form.resetFields();
      // 用新 Token 包刷新 session（含新 refresh_token + expires_at）
      refreshSession(res.data);
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.error ?? '修改失败，请稍后重试';
      message.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    if (forced) return;
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title={
        forced ? (
          <span>
            <WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />
            首次登录 — 必须修改密码
          </span>
        ) : (
          '修改密码'
        )
      }
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="确认修改"
      cancelText="取消"
      cancelButtonProps={forced ? { style: { display: 'none' } } : {}}
      closable={!forced}
      maskClosable={!forced}
      confirmLoading={loading}
      width={420}
    >
      {forced && (
        <div
          style={{
            background: '#fffbe6', border: '1px solid #ffe58f',
            borderRadius: 6, padding: '10px 14px', marginBottom: 20,
            fontSize: 13, color: '#614700',
          }}
        >
          您正在使用系统初始密码登录，出于安全考虑，请立即设置您的专属密码后方可使用系统。
        </div>
      )}

      <Form form={form} layout="vertical">
        <Form.Item
          label="当前密码" name="old_password"
          rules={[{ required: true, message: '请输入当前密码' }]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="输入当前（初始）密码" />
        </Form.Item>
        <Form.Item
          label="新密码" name="new_password"
          rules={[{ required: true, message: '请输入新密码' }, { min: 8, message: '密码至少 8 位' }]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位" />
        </Form.Item>
        <Form.Item
          label="确认新密码" name="confirm"
          rules={[{ required: true, message: '请再次输入新密码' }]}
        >
          <Input.Password prefix={<LockOutlined />} placeholder="再次输入新密码" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ChangePasswordModal;
