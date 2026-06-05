import React, { useState } from 'react';
import { Form, Input, message, Modal } from 'antd';
import { LockOutlined, WarningOutlined } from '@ant-design/icons';
import { changePassword } from '../api/auth';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../i18n';

interface Props {
  open: boolean;
  forced: boolean;
  onClose: () => void;
}

const ChangePasswordModal: React.FC<Props> = ({ open, forced, onClose }) => {
  const { refreshSession } = useAuth();
  const t = useT();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  const handleOk = async () => {
    let v: { old_password: string; new_password: string; confirm: string };
    try { v = await form.validateFields(); } catch { return; }

    if (v.new_password !== v.confirm) {
      form.setFields([{ name: 'confirm', errors: [t('security.pwdMismatch')] }]);
      return;
    }
    setLoading(true);
    try {
      const res = await changePassword(v.old_password, v.new_password);
      message.success(t('security.changePwdOk'));
      form.resetFields();
      refreshSession(res.data);
      onClose();
    } catch (err: any) {
      message.error(err?.response?.data?.error ?? 'Failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        forced ? (
          <span><WarningOutlined style={{ color: '#faad14', marginRight: 8 }} />{t('security.forcedTitle')}</span>
        ) : t('security.changePwd')
      }
      open={open}
      onOk={handleOk}
      onCancel={forced ? undefined : () => { form.resetFields(); onClose(); }}
      okText={t('security.changePwd')}
      cancelText={t('common.cancel')}
      cancelButtonProps={forced ? { style: { display: 'none' } } : {}}
      closable={!forced}
      maskClosable={!forced}
      confirmLoading={loading}
      width={420}
    >
      {forced && (
        <div style={{
          background: '#fffbe6', border: '1px solid #ffe58f',
          borderRadius: 6, padding: '10px 14px', marginBottom: 20, fontSize: 13,
        }}>
          {t('security.forcedHint')}
        </div>
      )}
      <Form form={form} layout="vertical">
        <Form.Item label={t('security.oldPwd')} name="old_password" rules={[{ required: true }]}>
          <Input.Password prefix={<LockOutlined />} />
        </Form.Item>
        <Form.Item label={t('security.newPwd')} name="new_password"
          rules={[{ required: true }, { min: 8, message: t('security.pwdMinLen') }]}>
          <Input.Password prefix={<LockOutlined />} />
        </Form.Item>
        <Form.Item label={t('security.confirmPwd')} name="confirm" rules={[{ required: true }]}>
          <Input.Password prefix={<LockOutlined />} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ChangePasswordModal;
