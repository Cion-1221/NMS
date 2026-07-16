/**
 * SNMP 详情 Drawer（设备列表点主机名打开）。
 *
 * 内容：system 组快照 + 采集来源/延迟/最近错误 + 自定义标量 OID 管理（新增/编辑/
 * 删除/趋势）+ 接口表（collect_interfaces 开启时）。direct 模式提供"立即测试"
 * （同步采集一次并落库，成功/失败都刷新 Drawer 并通知父组件刷新列表）。
 * 详情数据由本组件自行加载（device 变化时触发）。
 */
import React, { useEffect, useState } from 'react';
import { Button, Descriptions, Drawer, Modal, Space, Table, Tooltip, message } from 'antd';
import {
  ExclamationCircleFilled, LineChartOutlined, PlusOutlined, ReloadOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { getDeviceSNMP, testDeviceSNMP, deleteDeviceSNMPOID } from '../../../api/device';
import type { Device, DeviceSNMPDetail, DeviceSNMPOIDEntry, DeviceInterfaceEntry } from '../../../types/device';
import type { TranslationKey } from '../../../i18n/translations';
import { apiErrMsg, useT } from '../../../i18n';
import RelativeTime from '../../../components/RelativeTime';
import StatusTag from '../../../components/StatusTag';
import { FONT_MONO } from '../../../theme/theme';
import { mono, formatBps, formatUptime, IF_OPER_TONES, OperStatusTag } from './deviceDisplay';
import DeviceOIDEditModal from './DeviceOIDEditModal';
import DeviceMetricTrendModal from './DeviceMetricTrendModal';

const { confirm } = Modal;

interface Props {
  /** 目标设备；null = 关闭 */
  device: Device | null;
  canWrite: boolean;
  onClose: () => void;
  /** 立即测试落库后回调：父组件刷新列表（运行状态/Uptime 列可能已变化） */
  onChanged: () => void;
}

const DeviceSNMPDrawer: React.FC<Props> = ({ device, canWrite, onClose, onChanged }) => {
  const t = useT();
  const [detail,      setDetail]      = useState<DeviceSNMPDetail | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [testLoading, setTestLoading] = useState(false);

  // 自定义 OID 编辑 Modal
  const [oidModalOpen, setOidModalOpen] = useState(false);
  const [oidEditing,   setOidEditing]   = useState<DeviceSNMPOIDEntry | null>(null);

  // 指标趋势 Modal
  const [trendEntry, setTrendEntry] = useState<DeviceSNMPOIDEntry | null>(null);

  const loadDetail = async () => {
    if (!device) return;
    setLoading(true);
    try {
      const resp = await getDeviceSNMP(device.id);
      setDetail(resp.data);
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setLoading(false);
    }
  };

  // 打开 / 切换设备时重新加载详情
  useEffect(() => {
    setDetail(null);
    if (device) void loadDetail();
  }, [device?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 立即测试（仅 direct 模式）：同步采集一次并落库，成功/失败都刷新 Drawer 与列表
  const handleTestSNMP = async () => {
    if (!device) return;
    setTestLoading(true);
    try {
      const resp = await testDeviceSNMP(device.id);
      if (resp.data.success) {
        message.success(t('device.snmp.testOk', { ms: (resp.data.latency_ms ?? 0).toFixed(1) }));
      } else {
        message.error(t('device.snmp.testFail', { err: resp.data.error ?? resp.data.error_kind ?? '' }));
      }
      await loadDetail();
      onChanged();
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setTestLoading(false);
    }
  };

  const openOidModal = (entry: DeviceSNMPOIDEntry | null) => {
    setOidEditing(entry);
    setOidModalOpen(true);
  };

  const handleOidDelete = (entry: DeviceSNMPOIDEntry) => {
    if (!device) return;
    confirm({
      title:      t('device.oid.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    `${entry.name || entry.oid}`,
      okText:     t('common.delete'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteDeviceSNMPOID(device.id, entry.id);
          message.success(t('device.oid.delDone'));
          await loadDetail();
        } catch (err: unknown) {
          message.error(apiErrMsg(err));
        }
      },
    });
  };

  return (
    <>
      <Drawer
        title={device ? `${device.hostname} — ${t('device.snmp.drawerTitle')}` : t('device.snmp.drawerTitle')}
        open={!!device}
        onClose={onClose}
        width={640}
        extra={
          <Space size={8}>
            {canWrite && detail?.polling_mode === 'direct' && (
              <Button
                size="small"
                type="primary"
                ghost
                icon={<ThunderboltOutlined />}
                loading={testLoading}
                onClick={() => { void handleTestSNMP(); }}
              >
                {t('device.snmp.testNow')}
              </Button>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => { void loadDetail(); }}
            >
              {t('common.refresh')}
            </Button>
          </Space>
        }
      >
        {detail && (
          <Descriptions column={1} size="small" bordered labelStyle={{ width: 150 }}>
            <Descriptions.Item label={t('device.operStatus')}>
              <OperStatusTag
                pollingMode={detail.polling_mode}
                operStatus={detail.oper_status}
                operReason={detail.oper_reason}
              />
            </Descriptions.Item>
            <Descriptions.Item label={t('device.pollingMode')}>
              {t(`device.pollingMode.${detail.polling_mode}` as TranslationKey)}
            </Descriptions.Item>
            {detail.polling_mode !== 'none' && (
              <Descriptions.Item label={t('device.snmp.source')}>
                {detail.polling_mode === 'direct'
                  ? t('device.snmp.sourceDirect')
                  : mono(detail.state?.source_agent_id ?? detail.snmp_agent_id ?? '—')}
              </Descriptions.Item>
            )}
            {detail.state ? (
              <>
                <Descriptions.Item label={t('device.uptime')}>
                  {formatUptime(detail.state.uptime_ticks) ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.bootTime')}>
                  {detail.state.boot_time
                    ? new Date(detail.state.boot_time).toLocaleString()
                    : '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysName')}>
                  {detail.state.sys_name || '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysDescr')}>
                  <span style={{ wordBreak: 'break-all' }}>{detail.state.sys_descr || '—'}</span>
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysObjectID')}>
                  {detail.state.sys_object_id ? (
                    <div>
                      {mono(detail.state.sys_object_id)}
                      {/* MIB 翻译引擎命中时展示可读名（如 CISCO-PRODUCTS-MIB::cisco7206VXR） */}
                      {detail.sys_object_id_name && (
                        <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
                          {detail.sys_object_id_name}
                        </div>
                      )}
                    </div>
                  ) : '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysLocation')}>
                  {detail.state.sys_location || '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysContact')}>
                  {detail.state.sys_contact || '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.latency')}>
                  {detail.state.latency_ms != null
                    ? mono(`${detail.state.latency_ms.toFixed(1)} ms`)
                    : '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.lastPoll')}>
                  <RelativeTime value={detail.state.last_poll_at} />
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.lastSuccess')}>
                  <RelativeTime value={detail.state.last_success_at} />
                </Descriptions.Item>
                {detail.state.last_error && (
                  <Descriptions.Item label={t('device.snmp.lastError')}>
                    <span style={{ color: 'var(--ant-color-error)', wordBreak: 'break-all' }}>
                      {detail.state.last_error}
                    </span>
                  </Descriptions.Item>
                )}
              </>
            ) : (
              <Descriptions.Item label={t('device.snmp.lastPoll')}>
                <span style={{ color: 'var(--ant-color-text-tertiary)' }}>{t('device.snmp.noData')}</span>
              </Descriptions.Item>
            )}
          </Descriptions>
        )}

        {/* ── 自定义标量 OID（随快轮询采集，定义+最新值一体）── */}
        {detail && detail.polling_mode !== 'none' && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t('device.oid.section')}</span>
              {canWrite && (
                <Button size="small" icon={<PlusOutlined />} onClick={() => openOidModal(null)}>
                  {t('device.oid.add')}
                </Button>
              )}
            </div>
            <Table<DeviceSNMPOIDEntry>
              size="small"
              rowKey="id"
              dataSource={detail.custom_oids}
              pagination={false}
              locale={{ emptyText: t('device.oid.empty') }}
              columns={[
                {
                  title: t('device.oid.name'), key: 'name', width: 140, ellipsis: true,
                  render: (_, r) => r.name
                    ? <Tooltip title={mono(r.oid)}>{r.name}</Tooltip>
                    : mono(r.oid),
                },
                {
                  title: t('device.oid.value'), key: 'value', width: 150,
                  render: (_, r) => {
                    if (r.last_error) {
                      return <span style={{ color: 'var(--ant-color-warning)', fontSize: 12 }}>{r.last_error}</span>;
                    }
                    if (!r.polled_at) {
                      return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>;
                    }
                    return mono(`${r.last_value}${r.unit ? ` ${r.unit}` : ''}`);
                  },
                },
                {
                  title: t('device.oid.polledAt'), key: 'polled_at', width: 110,
                  render: (_, r) => <RelativeTime value={r.polled_at} />,
                },
                {
                  title: t('common.actions'), key: 'action', width: canWrite ? 150 : 60,
                  render: (_: unknown, r: DeviceSNMPOIDEntry) => (
                    <Space size={0}>
                      {/* 趋势只对数值型有意义：字符串型 OID 无时序点 */}
                      <Tooltip title={t('device.oid.trend')}>
                        <Button
                          type="link" size="small" icon={<LineChartOutlined />}
                          disabled={r.last_numeric == null && !r.polled_at}
                          onClick={() => setTrendEntry(r)}
                        />
                      </Tooltip>
                      {canWrite && (
                        <>
                          <Button type="link" size="small" onClick={() => openOidModal(r)}>{t('common.edit')}</Button>
                          <Button type="text" size="small" danger onClick={() => handleOidDelete(r)}>{t('common.delete')}</Button>
                        </>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        )}

        {/* ── 接口表（collect_interfaces 开启后每周期 WALK reconcile）── */}
        {detail && detail.collect_interfaces && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              {t('device.if.section')}
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--ant-color-text-tertiary)', marginLeft: 8 }}>
                {detail.interfaces.length}
              </span>
            </div>
            <Table<DeviceInterfaceEntry>
              size="small"
              rowKey="id"
              dataSource={detail.interfaces}
              pagination={detail.interfaces.length > 10
                ? { pageSize: 10, size: 'small', showSizeChanger: false }
                : false}
              locale={{ emptyText: t('device.if.empty') }}
              columns={[
                {
                  title: t('device.if.name'), key: 'name', width: 150, ellipsis: true,
                  render: (_, r) => (
                    <Tooltip title={`ifIndex ${r.if_index}${r.alias ? ` · ${r.alias}` : ''}`}>
                      <span>
                        <span style={{ fontWeight: 600 }}>{r.name || `if${r.if_index}`}</span>
                        {r.alias && (
                          <div style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }}>{r.alias}</div>
                        )}
                      </span>
                    </Tooltip>
                  ),
                },
                {
                  title: t('device.if.status'), key: 'status', width: 90,
                  render: (_, r) => (
                    <Tooltip title={`admin: ${t(`device.if.oper.${r.admin_status}` as TranslationKey)}`}>
                      <span>
                        <StatusTag
                          status={`oper_${r.oper_status}`}
                          label={t(`device.if.oper.${r.oper_status}` as TranslationKey)}
                          tone={IF_OPER_TONES[r.oper_status] ?? 'neutral'}
                        />
                      </span>
                    </Tooltip>
                  ),
                },
                {
                  title: t('device.if.speed'), key: 'speed', width: 80,
                  render: (_, r) => r.speed_mbps > 0
                    ? mono(r.speed_mbps >= 1000 ? `${r.speed_mbps / 1000}G` : `${r.speed_mbps}M`)
                    : '—',
                },
                {
                  title: t('device.if.rate'), key: 'rate', width: 140,
                  render: (_, r) => {
                    const inS = formatBps(r.in_bps);
                    const outS = formatBps(r.out_bps);
                    if (!inS && !outS) return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>;
                    return (
                      <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                        <div>↓ {inS ?? '—'}</div>
                        <div>↑ {outS ?? '—'}</div>
                      </span>
                    );
                  },
                },
                {
                  title: t('device.if.errors'), key: 'errors', width: 90,
                  render: (_, r) => (r.in_errors > 0 || r.out_errors > 0)
                    ? <span style={{ color: 'var(--ant-color-warning)', fontFamily: FONT_MONO, fontSize: 12 }}>
                        {r.in_errors}/{r.out_errors}
                      </span>
                    : mono('0'),
                },
              ]}
            />
          </div>
        )}
      </Drawer>

      {/* ── 自定义 OID 新增/编辑 Modal ── */}
      <DeviceOIDEditModal
        open={oidModalOpen}
        deviceId={device?.id ?? null}
        entry={oidEditing}
        onClose={() => setOidModalOpen(false)}
        onSaved={() => {
          setOidModalOpen(false);
          void loadDetail(); // 刷新 Drawer 内的定义列表
        }}
      />

      {/* ── 指标趋势 Modal ── */}
      <DeviceMetricTrendModal
        deviceId={device?.id ?? null}
        entry={trendEntry}
        onClose={() => setTrendEntry(null)}
      />
    </>
  );
};

export default DeviceSNMPDrawer;
