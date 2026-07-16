/**
 * 自定义标量 OID 新增/编辑 Modal（SNMP 详情 Drawer 内使用）。
 * "从 MIB 解析"按钮用翻译引擎把数字 OID 转成可读名自动填入 Name。
 */
import React, { useEffect, useState } from 'react';
import { Button, Col, Form, Input, Modal, Row, Select, message } from 'antd';
import { createDeviceSNMPOID, updateDeviceSNMPOID, translateMIBOID } from '../../../api/device';
import type { DeviceSNMPOIDEntry } from '../../../types/device';
import { apiErrMsg, useT } from '../../../i18n';
import { FONT_MONO } from '../../../theme/theme';

interface Props {
  open: boolean;
  deviceId: number | null;
  /** 编辑目标；null = 新增 */
  entry: DeviceSNMPOIDEntry | null;
  onClose: () => void;
  /** 保存成功后回调：父组件刷新 Drawer 数据并关闭本 Modal */
  onSaved: () => void;
}

const DeviceOIDEditModal: React.FC<Props> = ({ open, deviceId, entry, onClose, onSaved }) => {
  const t = useT();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      oid:  entry?.oid  ?? '',
      name: entry?.name ?? '',
      unit: entry?.unit ?? '',
      kind: entry?.kind ?? 'gauge',
    });
  }, [open, entry, form]);

  const handleSubmit = async () => {
    if (deviceId == null) return;
    const values = await form.validateFields();
    const payload = {
      oid:  (values.oid  as string).trim(),
      name: ((values.name as string | undefined) ?? '').trim(),
      unit: ((values.unit as string | undefined) ?? '').trim(),
      kind: (values.kind as string | undefined) ?? 'gauge',
    };
    setSaving(true);
    try {
      if (entry) {
        await updateDeviceSNMPOID(deviceId, entry.id, payload);
      } else {
        await createDeviceSNMPOID(deviceId, payload);
      }
      message.success(t('device.oid.saveOk'));
      onSaved();
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setSaving(false);
    }
  };

  // "从 MIB 解析"：用翻译引擎把 OID 转成可读名填入 Name
  const handleTranslate = async () => {
    const oid = ((form.getFieldValue('oid') as string | undefined) ?? '').trim();
    if (!oid) return;
    setTranslating(true);
    try {
      const r = await translateMIBOID(oid);
      if (r.data.found) {
        form.setFieldValue('name', r.data.name);
        message.success(r.data.qualified);
      } else {
        message.info(t('device.oid.translateMiss'));
      }
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setTranslating(false);
    }
  };

  return (
    <Modal
      title={entry ? t('device.oid.edit') : t('device.oid.add')}
      open={open}
      onOk={() => { void handleSubmit(); }}
      confirmLoading={saving}
      onCancel={onClose}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      destroyOnClose
      width={480}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Form.Item
          label="OID"
          name="oid"
          extra={t('device.oid.oidHint')}
          rules={[
            { required: true, message: t('device.oid.oidRequired') },
            { pattern: /^\.?\d+(\.\d+)+$/, message: t('device.oid.oidInvalid') },
          ]}
        >
          <Input placeholder="1.3.6.1.4.1…" style={{ fontFamily: FONT_MONO }} />
        </Form.Item>
        <Form.Item label={t('device.oid.name')} name="name" extra={t('device.oid.nameHint')}>
          <Input
            addonAfter={
              <Button
                type="link"
                size="small"
                style={{ padding: 0, height: 'auto' }}
                loading={translating}
                onClick={() => { void handleTranslate(); }}
              >
                {t('device.oid.translate')}
              </Button>
            }
          />
        </Form.Item>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={t('device.oid.kind')}
              name="kind"
              initialValue="gauge"
              extra={t('device.oid.kindHint')}
            >
              <Select options={[
                { value: 'gauge', label: t('device.oid.kind.gauge') },
                { value: 'counter', label: t('device.oid.kind.counter') },
              ]} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label={t('device.oid.unit')} name="unit">
              <Input placeholder="%, °C, bps…" />
            </Form.Item>
          </Col>
        </Row>
      </Form>
    </Modal>
  );
};

export default DeviceOIDEditModal;
