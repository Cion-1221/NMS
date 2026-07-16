/**
 * 设备新增/编辑 Modal（两列布局 + SNMP 采集区块）。
 *
 * 行为与拆分前完全一致：
 *   - 采集模式联动：none 隐藏整个 SNMP 区块，agent 额外显示探针下拉；
 *   - 版本联动：v1/v2c 显示 Community，v3 显示 USM 用户/协议/口令；
 *   - 凭证类字段永不回显（编辑时留空提交 = 保持原值）；
 *   - IPv4/IPv6 至少一项的跨字段校验。
 * 字典数据（sites/pops/roles/vendors/agents）由父组件持有并在打开时刷新。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Col, Divider, Form, Input, InputNumber, Modal, Row, Select, Space, Switch, message,
} from 'antd';
import { createDevice, updateDevice } from '../../../api/device';
import type {
  AgentLite, Device, DevicePoP, DeviceRole, DeviceSite, DeviceVendor,
} from '../../../types/device';
import type { TranslationKey } from '../../../i18n/translations';
import { apiErrMsg, useT } from '../../../i18n';
import { FONT_MONO } from '../../../theme/theme';

// 表单只提供三个管理状态：运行状态（up/down）已由 SNMP 采集驱动，不再手工标记 offline
const FORM_STATUS_VALUES = ['active', 'maintenance', 'planned'] as const;
const POLLING_MODES = ['none', 'direct', 'agent'] as const;
const SNMP_VERSIONS = ['2c', '3', '1'] as const;
// 与后端 validV3AuthProtos / validV3PrivProtos 枚举一致
const V3_AUTH_PROTOS = ['MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512'] as const;
const V3_PRIV_PROTOS = ['DES', 'AES', 'AES192', 'AES256', 'AES192C', 'AES256C'] as const;

// 表单分区标题（Direction A：低对比小字，弱化视觉噪音）
const sectionDividerStyle: React.CSSProperties = {
  marginTop: 4, marginBottom: 12, fontSize: 12, fontWeight: 600,
  color: 'var(--ant-color-text-tertiary)',
};

// ── IP address format helpers (module-level pure functions) ────────────────────
// These provide fast, synchronous feedback before the request reaches the backend.
// Go's net/netip.ParseAddr remains the authoritative validator for edge cases.

/** Returns true when v is a syntactically valid IPv4 address (four 0-255 octets). */
function isValidIPv4(v: string): boolean {
  const parts = v.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Returns true when v looks like a valid IPv6 address.
 * Handles the full 8-group form, the compressed '::' notation, and the
 * IPv4-mapped/embedded form whose last group is a dotted-quad
 * (e.g. ::ffff:192.168.1.1).  Rejects multiple '::' sequences and
 * non-compressed addresses whose group count is not exactly 8.
 */
function isValidIPv6(v: string): boolean {
  if (v === '::') return true;
  // Multiple '::' sequences are illegal
  if ((v.match(/::/g) ?? []).length > 1) return false;
  // Split around the optional '::' and collect all explicit groups
  const halves = v.split('::');
  const hasCompression = halves.length === 2;
  let groups = halves.flatMap(h => (h === '' ? [] : h.split(':')));
  // IPv4-mapped form: a trailing dotted-quad counts as two 16-bit groups
  let embeddedGroups = 0;
  const last = groups[groups.length - 1];
  if (last !== undefined && last.includes('.')) {
    if (!isValidIPv4(last)) return false;
    groups = groups.slice(0, -1);
    embeddedGroups = 2;
  }
  if (groups.some(g => !/^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const totalGroups = groups.length + embeddedGroups;
  // '::' compresses at least one group → at most 7 explicit; otherwise exactly 8
  return hasCompression ? totalGroups <= 7 : totalGroups === 8;
}

interface Props {
  open: boolean;
  mode: 'create' | 'edit';
  /** 编辑目标（mode='edit' 时非空） */
  device: Device | null;
  sites: DeviceSite[];
  pops: DevicePoP[];
  roles: DeviceRole[];
  vendors: DeviceVendor[];
  agents: AgentLite[];
  onClose: () => void;
  /** 保存成功后回调：父组件负责关闭 Modal 并刷新列表 */
  onSaved: () => void;
}

const DeviceFormModal: React.FC<Props> = ({
  open, mode, device, sites, pops, roles, vendors, agents, onClose, onSaved,
}) => {
  const t = useT();
  const [form] = Form.useForm();
  const [selectedSiteId, setSelectedSiteId] = useState<number | undefined>();
  // 采集模式联动：none 隐藏整个 SNMP 区块，agent 额外显示探针下拉
  const watchPollingMode = Form.useWatch('polling_mode', form) as string | undefined;
  // 版本联动：v1/v2c 显示 Community，v3 显示 USM 用户/协议/口令
  const watchSNMPVersion = Form.useWatch('snmp_version', form) as string | undefined;
  const watchV3AuthProto = Form.useWatch('snmp_v3_auth_proto', form) as string | undefined;

  // 打开时初始化表单：编辑回填（凭证字段永不回显），新建重置
  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && device) {
      setSelectedSiteId(device.site_id ?? undefined);
      form.setFieldsValue({
        hostname:        device.hostname,
        management_ip:   device.management_ip   ?? '',
        management_ipv6: device.management_ipv6 ?? '',
        status:          device.status          ?? 'active',
        site_id:         device.site_id   ?? undefined,
        pop_id:          device.pop_id    ?? undefined,
        role_id:         device.role_id   ?? undefined,
        vendor_id:       device.vendor_id ?? undefined,
        remark:          device.remark    ?? '',
        polling_mode:    device.polling_mode ?? 'none',
        snmp_agent_id:   device.snmp_agent_id ?? undefined,
        snmp_version:    device.snmp_version || '2c',
        snmp_community:  '', // 密码类字段永不回显；留空提交 = 保持原值
        snmp_port:       device.snmp_port || 161,
        snmp_interval_seconds: device.snmp_interval_seconds ?? undefined,
        collect_interfaces:    device.collect_interfaces ?? false,
        snmp_v3_user:       device.snmp_v3_user ?? '',
        snmp_v3_auth_proto: device.snmp_v3_auth_proto ?? undefined,
        snmp_v3_auth_pass:  '',
        snmp_v3_priv_proto: device.snmp_v3_priv_proto ?? undefined,
        snmp_v3_priv_pass:  '',
      });
    } else {
      setSelectedSiteId(undefined);
      form.resetFields();
    }
  }, [open, mode, device, form]);

  // ── Derived options ───────────────────────────────────────────────────────────

  const POLLING_MODE_OPTIONS = POLLING_MODES.map(v => ({
    value: v,
    label: t(`device.pollingMode.${v}` as TranslationKey),
  }));

  // PoP options: filtered by the selected site
  const modalPopOptions = useMemo(() =>
    selectedSiteId
      ? pops.filter(p => p.site_id === selectedSiteId).map(p => ({ value: p.id, label: p.name }))
      : [],
  [pops, selectedSiteId]);

  // 表单管理状态选项：常规三项；编辑遗留 offline 设备时附加该项，避免 Select 显示裸值
  const formStatusOptions = useMemo(() => {
    const base = FORM_STATUS_VALUES.map(v => ({
      value: v as string,
      label: t(`device.status.${v}` as TranslationKey),
    }));
    if (mode === 'edit' && device?.status === 'offline') {
      base.push({ value: 'offline', label: t('device.status.offline') });
    }
    return base;
  }, [mode, device, t]);

  // 采集探针下拉：agents-lite 已按在线优先排序；离线探针可选但明确标注。
  // search 字段供 filterOption 文本匹配（label 是 ReactNode，无法直接搜索）。
  const agentOptions = useMemo(() => agents.map(a => {
    const online = a.status === 'online';
    return {
      value: a.agent_id,
      search: `${a.hostname} ${a.agent_id} ${a.group_name}`,
      label: (
        <Space size={6}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
            background: online ? 'var(--ant-color-success)' : 'var(--ant-color-text-quaternary)',
          }} />
          <span>{a.hostname}</span>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>
            {a.agent_id}
          </span>
          {a.group_name && (
            <span style={{ fontSize: 12, color: 'var(--ant-color-text-tertiary)' }}>· {a.group_name}</span>
          )}
          {!online && (
            <span style={{ fontSize: 12, color: 'var(--ant-color-warning)' }}>
              ({t('device.snmp.agentOffline')})
            </span>
          )}
        </Space>
      ),
    };
  }), [agents, t]);

  const handleSiteChange = (val: number | undefined) => {
    setSelectedSiteId(val);
    form.setFieldValue('pop_id', undefined);
  };

  // ── IP field validators ───────────────────────────────────────────────────────
  // Each validator is memoised with useCallback so Ant Design Form doesn't treat
  // it as a changed rule on every render (which would force re-validation loops).

  /** Per-field IPv4 format check — empty value passes; "at least one" is separate. */
  const validateManagementIP = useCallback(
    (_: unknown, value: string | undefined) => {
      if (!value) return Promise.resolve();
      return isValidIPv4(value)
        ? Promise.resolve()
        : Promise.reject(new Error(t('device.ipv4Invalid')));
    },
    [t],
  );

  /** Per-field IPv6 format check — empty value passes. */
  const validateManagementIPv6 = useCallback(
    (_: unknown, value: string | undefined) => {
      if (!value) return Promise.resolve();
      return isValidIPv6(value)
        ? Promise.resolve()
        : Promise.reject(new Error(t('device.ipv6Invalid')));
    },
    [t],
  );

  /**
   * Cross-field rule: at least one of IPv4 / IPv6 must be non-empty.
   * Placed on both fields so the error clears on either field as soon as
   * the user fills in the other one.  The `dependencies` prop on each
   * Form.Item triggers re-validation of the sibling when the current field changes.
   */
  const validateAtLeastOneIP = useCallback(
    () => {
      const v4 = (form.getFieldValue('management_ip')   as string | undefined) ?? '';
      const v6 = (form.getFieldValue('management_ipv6') as string | undefined) ?? '';
      return v4 || v6
        ? Promise.resolve()
        : Promise.reject(new Error(t('device.atLeastOneIP')));
    },
    [form, t],
  );

  const handleSubmit = async () => {
    const values = await form.validateFields();
    const payload = {
      hostname:        values.hostname        as string,
      management_ip:   (values.management_ip   as string) || null,
      management_ipv6: (values.management_ipv6 as string) || null,
      status:          (values.status          as string) || 'active',
      site_id:         (values.site_id   as number | undefined) ?? null,
      pop_id:          (values.pop_id    as number | undefined) ?? null,
      role_id:         (values.role_id   as number | undefined) ?? null,
      vendor_id:       (values.vendor_id as number | undefined) ?? null,
      remark:          (values.remark    as string | undefined) ?? '',
      polling_mode:    (values.polling_mode as 'none' | 'direct' | 'agent') || 'none',
      snmp_agent_id:   (values.snmp_agent_id as string | undefined) ?? null,
      snmp_version:    (values.snmp_version as string) || '2c',
      snmp_community:  (values.snmp_community as string | undefined) ?? '', // 空 = 编辑时保持原值
      snmp_port:       (values.snmp_port as number | undefined) ?? 161,
      snmp_interval_seconds: (values.snmp_interval_seconds as number | undefined) ?? null,
      collect_interfaces:    (values.collect_interfaces as boolean | undefined) ?? false,
      snmp_v3_user:       (values.snmp_v3_user as string | undefined) ?? '',
      snmp_v3_auth_proto: (values.snmp_v3_auth_proto as string | undefined) ?? '',
      snmp_v3_auth_pass:  (values.snmp_v3_auth_pass as string | undefined) ?? '', // 空 = 保持原值
      snmp_v3_priv_proto: (values.snmp_v3_priv_proto as string | undefined) ?? '',
      snmp_v3_priv_pass:  (values.snmp_v3_priv_pass as string | undefined) ?? '',
    };
    try {
      if (mode === 'create') {
        await createDevice(payload);
        message.success(t('device.createOk'));
      } else {
        await updateDevice(device!.id, payload);
        message.success(t('device.saveOk'));
      }
      onSaved();
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    }
  };

  return (
    <Modal
      title={mode === 'create' ? t('device.add') : t('device.edit')}
      open={open}
      onOk={() => { void handleSubmit(); }}
      onCancel={onClose}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      destroyOnClose
      width={760}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
        <Divider titlePlacement="left" orientationMargin={0} plain style={sectionDividerStyle}>
          {t('device.form.basicSection')}
        </Divider>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label={t('device.hostname')}
              name="hostname"
              rules={[{ required: true, message: t('device.hostname') }]}
            >
              <Input />
            </Form.Item>
          </Col>
          <Col span={12}>
            {/* 管理状态（用户意图）：运行状态由 SNMP 采集驱动，不在此设置 */}
            <Form.Item label={t('device.status')} name="status" initialValue="active">
              <Select options={formStatusOptions} />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="left" orientationMargin={0} plain style={sectionDividerStyle}>
          {t('device.form.networkSection')}
        </Divider>
        <Row gutter={16}>
          <Col span={12}>
            {/* IPv4 — validates format and cross-field "at least one" rule */}
            <Form.Item
              label={t('device.mgmtIp')}
              name="management_ip"
              extra="IPv4, e.g. 192.168.1.1"
              dependencies={['management_ipv6']}
              rules={[
                { validator: validateManagementIP },
                { validator: validateAtLeastOneIP },
              ]}
            >
              <Input placeholder="192.168.1.1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            {/* IPv6 — validates format and cross-field "at least one" rule */}
            <Form.Item
              label={t('device.mgmtIpV6')}
              name="management_ipv6"
              extra="IPv6, e.g. 2001:db8::1"
              dependencies={['management_ip']}
              rules={[
                { validator: validateManagementIPv6 },
                { validator: validateAtLeastOneIP },
              ]}
            >
              <Input placeholder="2001:db8::1" />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="left" orientationMargin={0} plain style={sectionDividerStyle}>
          {t('device.form.assignSection')}
        </Divider>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item label={t('device.site')} name="site_id">
              <Select
                allowClear
                options={sites.map(s => ({ value: s.id, label: s.name }))}
                onChange={handleSiteChange}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label={t('device.pop')} name="pop_id">
              <Select
                allowClear
                disabled={!selectedSiteId}
                placeholder={!selectedSiteId ? t('device.popSelectSiteFirst') : undefined}
                options={modalPopOptions}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item label={t('device.role')} name="role_id">
              <Select allowClear options={roles.map(r => ({ value: r.id, label: r.name }))} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label={t('device.vendor')} name="vendor_id">
              <Select allowClear options={vendors.map(v => ({ value: v.id, label: v.name }))} />
            </Form.Item>
          </Col>
        </Row>

        <Divider titlePlacement="left" orientationMargin={0} plain style={sectionDividerStyle}>
          {t('device.form.snmpSection')}
        </Divider>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item label={t('device.pollingMode')} name="polling_mode" initialValue="none">
              <Select options={POLLING_MODE_OPTIONS} />
            </Form.Item>
          </Col>
          {watchPollingMode === 'agent' && (
            <Col span={12}>
              <Form.Item
                label={t('device.snmp.agent')}
                name="snmp_agent_id"
                rules={[{ required: true, message: t('device.snmp.agentRequired') }]}
              >
                <Select
                  showSearch
                  placeholder={t('device.snmp.agentRequired')}
                  options={agentOptions}
                  filterOption={(input, option) =>
                    (option?.search ?? '').toLowerCase().includes(input.toLowerCase())}
                />
              </Form.Item>
            </Col>
          )}
        </Row>
        {watchPollingMode != null && watchPollingMode !== 'none' && (
          <>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label={t('device.snmp.version')} name="snmp_version" initialValue="2c">
                  <Select options={SNMP_VERSIONS.map(v => ({ value: v, label: `v${v}` }))} />
                </Form.Item>
              </Col>
              {watchSNMPVersion !== '3' ? (
                <Col span={12}>
                  {/* 创建必填；编辑且已有凭证时留空 = 保持不变（凭证永不回显） */}
                  <Form.Item
                    label={t('device.snmp.community')}
                    name="snmp_community"
                    rules={[{
                      required: mode === 'create' || !device?.snmp_credential_set,
                      message: t('device.snmp.communityRequired'),
                    }]}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      placeholder={mode === 'edit' && device?.snmp_credential_set
                        ? t('device.snmp.communityKeep')
                        : 'public'}
                    />
                  </Form.Item>
                </Col>
              ) : (
                <Col span={12}>
                  <Form.Item
                    label={t('device.snmp.v3User')}
                    name="snmp_v3_user"
                    rules={[{ required: true, message: t('device.snmp.v3UserRequired') }]}
                  >
                    <Input autoComplete="off" />
                  </Form.Item>
                </Col>
              )}
            </Row>
            {watchSNMPVersion === '3' && (
              <>
                <Row gutter={16}>
                  <Col span={12}>
                    {/* 不选认证协议 = noAuthNoPriv */}
                    <Form.Item
                      label={t('device.snmp.v3AuthProto')}
                      name="snmp_v3_auth_proto"
                      extra={t('device.snmp.v3AuthHint')}
                    >
                      <Select
                        allowClear
                        placeholder={t('device.snmp.v3NoAuth')}
                        options={V3_AUTH_PROTOS.map(v => ({ value: v, label: v }))}
                        onChange={(v) => {
                          // 清掉认证协议时同时清掉加密协议（authPriv 依赖 auth）
                          if (!v) form.setFieldValue('snmp_v3_priv_proto', undefined);
                        }}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label={t('device.snmp.v3AuthPass')}
                      name="snmp_v3_auth_pass"
                      rules={[{
                        required: !!watchV3AuthProto && !device?.snmp_v3_auth_set,
                        message: t('device.snmp.v3PassRequired'),
                      }]}
                    >
                      <Input.Password
                        autoComplete="new-password"
                        disabled={!watchV3AuthProto}
                        placeholder={device?.snmp_v3_auth_set ? t('device.snmp.communityKeep') : undefined}
                      />
                    </Form.Item>
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col span={12}>
                    <Form.Item
                      label={t('device.snmp.v3PrivProto')}
                      name="snmp_v3_priv_proto"
                      extra={t('device.snmp.v3PrivHint')}
                    >
                      <Select
                        allowClear
                        disabled={!watchV3AuthProto}
                        placeholder={t('device.snmp.v3NoPriv')}
                        options={V3_PRIV_PROTOS.map(v => ({ value: v, label: v }))}
                      />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item
                      label={t('device.snmp.v3PrivPass')}
                      name="snmp_v3_priv_pass"
                      dependencies={['snmp_v3_priv_proto']}
                      rules={[({ getFieldValue }) => ({
                        required: !!getFieldValue('snmp_v3_priv_proto') && !device?.snmp_v3_priv_set,
                        message: t('device.snmp.v3PassRequired'),
                      })]}
                    >
                      <Input.Password
                        autoComplete="new-password"
                        disabled={!watchV3AuthProto}
                        placeholder={device?.snmp_v3_priv_set ? t('device.snmp.communityKeep') : undefined}
                      />
                    </Form.Item>
                  </Col>
                </Row>
              </>
            )}
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label={t('device.snmp.port')} name="snmp_port" initialValue={161}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label={t('device.snmp.interval')}
                  name="snmp_interval_seconds"
                  extra={t('device.snmp.intervalHint')}
                >
                  <InputNumber min={10} max={86400} placeholder="60" style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              label={t('device.snmp.collectInterfaces')}
              name="collect_interfaces"
              valuePropName="checked"
              initialValue={false}
              extra={t('device.snmp.collectInterfacesHint')}
            >
              <Switch />
            </Form.Item>
          </>
        )}

        <Form.Item label={t('device.remark')} name="remark" style={{ marginTop: 4 }}>
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default DeviceFormModal;
