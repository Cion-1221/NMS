import React, { useEffect, useState } from 'react';
import { Form, message, Modal, Select, Typography } from 'antd';
import { ClockCircleOutlined } from '@ant-design/icons';
import { updateTokenSettings } from '../api/auth';
import { useAuth } from '../contexts/AuthContext';
import { useApiError, useT } from '../i18n';
import type { TranslationKey } from '../i18n/translations';

interface Props {
  open: boolean;
  onClose: () => void;
}

// 选项文案走 i18n（key 在渲染时经 t() 解析），value 单位为小时
const LIFETIME_OPTIONS: { value: number; key: TranslationKey }[] = [
  { value: 1,   key: 'session.opt.h1' },
  { value: 8,   key: 'session.opt.h8' },
  { value: 24,  key: 'session.opt.h24' },
  { value: 72,  key: 'session.opt.d3' },
  { value: 168, key: 'session.opt.d7' },
  { value: 720, key: 'session.opt.d30' },
];

const { Text } = Typography;

const SessionSettingsModal: React.FC<Props> = ({ open, onClose }) => {
  const { user } = useAuth();
  const t = useT();
  const apiErr = useApiError();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);

  // 打开时回填当前设置
  useEffect(() => {
    if (open && user) {
      form.setFieldValue('hours', user.token_lifetime_hours || 24);
    }
  }, [open, user, form]);

  const labelFor = (hours: number) => {
    const matched = LIFETIME_OPTIONS.find((o) => o.value === hours);
    return matched ? t(matched.key) : t('session.hours', { n: hours });
  };

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
      message.success(t('session.updated', { label: labelFor(values.hours) }));
      onClose();
    } catch (err: any) {
      message.error(apiErr(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={
        <span>
          <ClockCircleOutlined style={{ marginRight: 8, color: '#1677ff' }} />
          {t('session.title')}
        </span>
      }
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={loading}
      width={400}
    >
      <div style={{ marginBottom: 16, marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          {t('session.desc')}
        </Text>
      </div>

      <Form form={form} layout="vertical">
        <Form.Item
          label={t('session.lifetime')}
          name="hours"
          rules={[{ required: true, message: t('session.required') }]}
        >
          <Select
            size="large"
            options={LIFETIME_OPTIONS.map((o) => ({ value: o.value, label: t(o.key) }))}
            placeholder={t('session.placeholder')}
          />
        </Form.Item>
      </Form>

      <Text type="secondary" style={{ fontSize: 12 }}>
        {t('session.current')}: <strong>{labelFor(user?.token_lifetime_hours || 24)}</strong>
        &nbsp;·&nbsp;{t('session.refreshNote')}
      </Text>
    </Modal>
  );
};

export default SessionSettingsModal;
