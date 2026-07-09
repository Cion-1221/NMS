import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Col, Descriptions, Divider, Drawer, Form, Input, InputNumber,
  Modal, Row, Segmented, Select, Skeleton, Space, Switch, Table, Tooltip, message,
} from 'antd';
import {
  ExclamationCircleFilled, LineChartOutlined, PlusOutlined, ReloadOutlined,
  SearchOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getDevices, createDevice, updateDevice, deleteDevice,
  getDeviceSites, getDevicePoPs, getDeviceRoles, getDeviceVendors,
  getDeviceAgentsLite, getDeviceSNMP, testDeviceSNMP,
  createDeviceSNMPOID, updateDeviceSNMPOID, deleteDeviceSNMPOID, translateMIBOID,
  getDeviceOIDSeries,
} from '../../../api/device';
import type {
  AgentLite, Device, DeviceSNMPDetail, DeviceSNMPOIDEntry, DeviceInterfaceEntry,
  MetricSeriesResp, DeviceSite, DevicePoP, DeviceRole, DeviceVendor,
} from '../../../types/device';
import type { TranslationKey } from '../../../i18n/translations';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_DEVICES_WRITE, useCan } from '../../../utils/perms';
import { useDebounced } from '../../../utils/useDebounced';
import StatusTag from '../../../components/StatusTag';
import RelativeTime from '../../../components/RelativeTime';
import { FONT_MONO } from '../../../theme/theme';

const { confirm } = Modal;

// 趋势图懒加载：@ant-design/charts 很重，Devices 路由不应因 Drawer 里的可选
// 功能拖慢首屏——只有真正打开趋势 Modal 时才拉取图表代码块。
const LazyLine = React.lazy(() =>
  import('@ant-design/charts').then(m => ({ default: m.Line })));

// IPs / IDs render in the mono stack against a dimmed colour (Direction A).
const mono = (v: React.ReactNode) => (
  <span style={{ fontFamily: FONT_MONO, color: 'var(--ant-color-text-secondary)' }}>{v}</span>
);

// 筛选栏保留全部四个管理状态（存量数据可能仍是遗留值 offline/已停用）
const STATUS_VALUES = ['active', 'offline', 'maintenance', 'planned'] as const;
// 表单只提供三个：运行状态（up/down）已由 SNMP 采集驱动，不再手工标记 offline
const FORM_STATUS_VALUES = ['active', 'maintenance', 'planned'] as const;
const OPER_STATUS_VALUES = ['up', 'down', 'unknown'] as const;
const POLLING_MODES = ['none', 'direct', 'agent'] as const;
const SNMP_VERSIONS = ['2c', '3', '1'] as const;
// 与后端 validV3AuthProtos / validV3PrivProtos 枚举一致
const V3_AUTH_PROTOS = ['MD5', 'SHA', 'SHA224', 'SHA256', 'SHA384', 'SHA512'] as const;
const V3_PRIV_PROTOS = ['DES', 'AES', 'AES192', 'AES256', 'AES192C', 'AES256C'] as const;

// oper_reason → i18n 词条存在的已知值；未知值原样展示（向前兼容后端新增原因）
const KNOWN_OPER_REASONS = new Set([
  'snmp_timeout', 'snmp_error', 'unreachable', 'no_target',
  'agent_down', 'agent_revoked', 'poller_stale', 'auth_fail',
]);

// 表单分区标题（Direction A：低对比小字，弱化视觉噪音）
const sectionDividerStyle: React.CSSProperties = {
  marginTop: 4, marginBottom: 12, fontSize: 12, fontWeight: 600,
  color: 'var(--ant-color-text-tertiary)',
};

/** bit/s → "1.24 Gbps" / "820 Mbps" / "3.2 Kbps"（接口速率展示） */
function formatBps(bps?: number | null): string | null {
  if (bps == null) return null;
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} Kbps`;
  return `${Math.round(bps)} bps`;
}

// RFC 2863 ifOperStatus → StatusTag tone（1 up；2 down；6 notPresent 视为中性）
const IF_OPER_TONES: Record<number, 'success' | 'danger' | 'warning' | 'neutral'> = {
  1: 'success', 2: 'danger', 3: 'warning', 4: 'neutral', 5: 'warning', 6: 'neutral', 7: 'warning',
};

/** sysUpTime TimeTicks（1/100 秒）→ "37d 4h" / "3h 12m" / "45m" */
function formatUptime(ticks?: number | null): string | null {
  if (ticks == null) return null;
  const s = Math.floor(ticks / 100);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

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


// ── Component ─────────────────────────────────────────────────────────────────
const TabDeviceList: React.FC = () => {
  const t = useT();
  const canWrite = useCan(PERM_DEVICES_WRITE);

  const STATUS_OPTIONS = STATUS_VALUES.map(v => ({
    value: v,
    label: t(`device.status.${v}` as TranslationKey),
  }));
  const OPER_STATUS_OPTIONS = OPER_STATUS_VALUES.map(v => ({
    value: v,
    label: t(`device.operStatus.${v}` as TranslationKey),
  }));
  const POLLING_MODE_OPTIONS = POLLING_MODES.map(v => ({
    value: v,
    label: t(`device.pollingMode.${v}` as TranslationKey),
  }));

  // ── Data (server-side pagination) ────────────────────────────────────────────
  const [data, setData]       = useState<Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total,    setTotal]    = useState(0);

  // ── Lookup lists ─────────────────────────────────────────────────────────────
  const [sites,          setSites]          = useState<DeviceSite[]>([]);
  const [allPoPs,        setAllPoPs]        = useState<DevicePoP[]>([]);
  const [roles,          setRoles]          = useState<DeviceRole[]>([]);
  const [vendors,        setVendors]        = useState<DeviceVendor[]>([]);
  const [agents,         setAgents]         = useState<AgentLite[]>([]);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsError,   setLookupsError]   = useState(false);

  // ── Table filters ─────────────────────────────────────────────────────────────
  const [filterHostname,   setFilterHostname]   = useState('');
  const [filterIP,         setFilterIP]         = useState('');
  const [filterIPv6,       setFilterIPv6]       = useState('');
  const [filterStatus,     setFilterStatus]     = useState<string | undefined>();
  const [filterOperStatus, setFilterOperStatus] = useState<string | undefined>();
  const [filterSiteId,     setFilterSiteId]     = useState<number | undefined>();
  const [filterPopId,      setFilterPopId]      = useState<number | undefined>();
  const [filterRoleId,     setFilterRoleId]     = useState<number | undefined>();
  const [filterVendorId,   setFilterVendorId]   = useState<number | undefined>();

  // ── Modal ─────────────────────────────────────────────────────────────────────
  const [isModalOpen,    setIsModalOpen]    = useState(false);
  const [mode,           setMode]           = useState<'create' | 'edit'>('create');
  const [editing,        setEditing]        = useState<Device | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<number | undefined>();
  const [form] = Form.useForm();
  // 采集模式联动：none 隐藏整个 SNMP 区块，agent 额外显示探针下拉
  const watchPollingMode = Form.useWatch('polling_mode', form) as string | undefined;
  // 版本联动：v1/v2c 显示 Community，v3 显示 USM 用户/协议/口令
  const watchSNMPVersion = Form.useWatch('snmp_version', form) as string | undefined;
  const watchV3AuthProto = Form.useWatch('snmp_v3_auth_proto', form) as string | undefined;

  // ── SNMP 详情 Drawer ──────────────────────────────────────────────────────────
  const [drawerDevice,  setDrawerDevice]  = useState<Device | null>(null);
  const [drawerDetail,  setDrawerDetail]  = useState<DeviceSNMPDetail | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [testLoading,   setTestLoading]   = useState(false);

  // ── 自定义 OID 编辑 Modal（Drawer 内）─────────────────────────────────────────
  const [oidModalOpen,   setOidModalOpen]   = useState(false);
  const [oidEditing,     setOidEditing]     = useState<DeviceSNMPOIDEntry | null>(null);
  const [oidSaving,      setOidSaving]      = useState(false);
  const [oidTranslating, setOidTranslating] = useState(false);
  const [oidForm] = Form.useForm();

  // ── 指标趋势 Modal ────────────────────────────────────────────────────────────
  const [trendEntry,   setTrendEntry]   = useState<DeviceSNMPOIDEntry | null>(null);
  const [trendRange,   setTrendRange]   = useState<string>('24h');
  const [trendData,    setTrendData]    = useState<MetricSeriesResp | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);

  // ── Loaders ───────────────────────────────────────────────────────────────────

  // 文本筛选取防抖后的值作为请求依赖，避免每个按键都触发服务端查询
  const debHostname = useDebounced(filterHostname);
  const debIP       = useDebounced(filterIP);
  const debIPv6     = useDebounced(filterIPv6);

  // 请求序号守卫：筛选/翻页连续变化时丢弃乱序返回的过期响应
  const reqSeq = useRef(0);

  const loadData = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const r = await getDevices({
        page,
        page_size: pageSize,
        hostname:    debHostname || undefined,
        ip:          debIP       || undefined,
        ipv6:        debIPv6     || undefined,
        status:      filterStatus,
        oper_status: filterOperStatus,
        site_id:     filterSiteId,
        pop_id:      filterPopId,
        role_id:     filterRoleId,
        vendor_id:   filterVendorId,
      });
      if (seq !== reqSeq.current) return; // 已有更新的请求发出，丢弃本次结果
      // 删除当前页最后一条记录后该页可能为空 —— 自动回退一页重新加载
      if (r.data.items.length === 0 && r.data.total > 0 && page > 1) {
        setPage(p => Math.max(1, p - 1));
        return;
      }
      setData(r.data.items);
      setTotal(r.data.total);
    } catch (err: unknown) {
      if (seq === reqSeq.current) {
        message.error(apiErrMsg(err));
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debHostname, debIP, debIPv6, filterStatus, filterOperStatus,
      filterSiteId, filterPopId, filterRoleId, filterVendorId]);

  const loadLookups = async () => {
    setLookupsLoading(true);
    try {
      const [s, p, r, v, a] = await Promise.all([
        getDeviceSites(),
        getDevicePoPs(),
        getDeviceRoles(),
        getDeviceVendors(),
        getDeviceAgentsLite(),
      ]);
      setSites(s.data);
      setAllPoPs(p.data);
      setRoles(r.data);
      setVendors(v.data);
      setAgents(a.data);
      setLookupsError(false); // Clear stale-data banner on successful reload
    } catch (err: unknown) {
      // Surface the error so operators know filter options may be stale,
      // but do NOT block the main device table — it loads independently.
      setLookupsError(true);
      message.warning(apiErrMsg(err));
    } finally {
      setLookupsLoading(false);
    }
  };

  // 筛选条件变化时回到第一页（loadData 依赖变化会自动触发重新查询）
  useEffect(() => {
    setPage(1);
  }, [debHostname, debIP, debIPv6, filterStatus, filterOperStatus,
      filterSiteId, filterPopId, filterRoleId, filterVendorId]);

  // 分页 / 筛选任一变化即重新查询；首次挂载同样由此触发
  useEffect(() => { void loadData(); }, [loadData]);

  useEffect(() => { void loadLookups(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch lookups every time the modal opens to pick up any dictionary changes
  useEffect(() => {
    if (isModalOpen) loadLookups();
  }, [isModalOpen]);

  // ── Derived options ───────────────────────────────────────────────────────────

  // PoP options in the modal: filtered by the selected site
  const modalPopOptions = useMemo(() =>
    selectedSiteId
      ? allPoPs.filter(p => p.site_id === selectedSiteId).map(p => ({ value: p.id, label: p.name }))
      : [],
  [allPoPs, selectedSiteId]);

  // PoP options in the filter bar: only valid when a site is already selected.
  // When no site is selected the dropdown is disabled, so this can return [].
  const filterPopOptions = useMemo(() =>
    filterSiteId
      ? allPoPs.filter(p => p.site_id === filterSiteId).map(p => ({ value: p.id, label: p.name }))
      : [],
  [allPoPs, filterSiteId]);

  // 表单管理状态选项：常规三项；编辑遗留 offline 设备时附加该项，避免 Select 显示裸值
  const formStatusOptions = useMemo(() => {
    const base = FORM_STATUS_VALUES.map(v => ({
      value: v as string,
      label: t(`device.status.${v}` as TranslationKey),
    }));
    if (mode === 'edit' && editing?.status === 'offline') {
      base.push({ value: 'offline', label: t('device.status.offline') });
    }
    return base;
  }, [mode, editing, t]);

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

  // ── Filter bar handlers ───────────────────────────────────────────────────────
  const handleFilterSiteChange = (val: number | undefined) => {
    setFilterSiteId(val);
    // Clear dependent PoP filter whenever site filter changes
    setFilterPopId(undefined);
  };

  // ── Modal helpers ─────────────────────────────────────────────────────────────
  const openCreate = () => {
    setMode('create');
    setEditing(null);
    setSelectedSiteId(undefined);
    form.resetFields();
    setIsModalOpen(true);
  };

  const openEdit = (r: Device) => {
    setMode('edit');
    setEditing(r);
    setSelectedSiteId(r.site_id ?? undefined);
    form.setFieldsValue({
      hostname:        r.hostname,
      management_ip:   r.management_ip   ?? '',
      management_ipv6: r.management_ipv6 ?? '',
      status:          r.status          ?? 'active',
      site_id:         r.site_id   ?? undefined,
      pop_id:          r.pop_id    ?? undefined,
      role_id:         r.role_id   ?? undefined,
      vendor_id:       r.vendor_id ?? undefined,
      remark:          r.remark    ?? '',
      polling_mode:    r.polling_mode ?? 'none',
      snmp_agent_id:   r.snmp_agent_id ?? undefined,
      snmp_version:    r.snmp_version || '2c',
      snmp_community:  '', // 密码类字段永不回显；留空提交 = 保持原值
      snmp_port:       r.snmp_port || 161,
      snmp_interval_seconds: r.snmp_interval_seconds ?? undefined,
      collect_interfaces:    r.collect_interfaces ?? false,
      snmp_v3_user:       r.snmp_v3_user ?? '',
      snmp_v3_auth_proto: r.snmp_v3_auth_proto ?? undefined,
      snmp_v3_auth_pass:  '',
      snmp_v3_priv_proto: r.snmp_v3_priv_proto ?? undefined,
      snmp_v3_priv_pass:  '',
    });
    setIsModalOpen(true);
  };

  // ── SNMP Drawer helpers ───────────────────────────────────────────────────────
  const openDrawer = async (r: Device) => {
    setDrawerDevice(r);
    setDrawerDetail(null);
    setDrawerLoading(true);
    try {
      const resp = await getDeviceSNMP(r.id);
      setDrawerDetail(resp.data);
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setDrawerLoading(false);
    }
  };

  // 立即测试（仅 direct 模式）：同步采集一次并落库，成功/失败都刷新 Drawer 与列表
  const handleTestSNMP = async () => {
    if (!drawerDevice) return;
    setTestLoading(true);
    try {
      const resp = await testDeviceSNMP(drawerDevice.id);
      if (resp.data.success) {
        message.success(t('device.snmp.testOk', { ms: (resp.data.latency_ms ?? 0).toFixed(1) }));
      } else {
        message.error(t('device.snmp.testFail', { err: resp.data.error ?? resp.data.error_kind ?? '' }));
      }
      await openDrawer(drawerDevice);
      void loadData();
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setTestLoading(false);
    }
  };

  const handleSiteChange = (val: number | undefined) => {
    setSelectedSiteId(val);
    form.setFieldValue('pop_id', undefined);
  };

  // ── 自定义 OID handlers（Drawer 内管理，随快轮询采集）────────────────────────
  const openOidModal = (entry: DeviceSNMPOIDEntry | null) => {
    setOidEditing(entry);
    oidForm.setFieldsValue({
      oid:  entry?.oid  ?? '',
      name: entry?.name ?? '',
      unit: entry?.unit ?? '',
      kind: entry?.kind ?? 'gauge',
    });
    setOidModalOpen(true);
  };

  const handleOidSubmit = async () => {
    if (!drawerDevice) return;
    const values = await oidForm.validateFields();
    const payload = {
      oid:  (values.oid  as string).trim(),
      name: ((values.name as string | undefined) ?? '').trim(),
      unit: ((values.unit as string | undefined) ?? '').trim(),
      kind: (values.kind as string | undefined) ?? 'gauge',
    };
    setOidSaving(true);
    try {
      if (oidEditing) {
        await updateDeviceSNMPOID(drawerDevice.id, oidEditing.id, payload);
      } else {
        await createDeviceSNMPOID(drawerDevice.id, payload);
      }
      message.success(t('device.oid.saveOk'));
      setOidModalOpen(false);
      await openDrawer(drawerDevice); // 刷新 Drawer 内的定义列表
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setOidSaving(false);
    }
  };

  const handleOidDelete = (entry: DeviceSNMPOIDEntry) => {
    if (!drawerDevice) return;
    confirm({
      title:      t('device.oid.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    `${entry.name || entry.oid}`,
      okText:     t('common.delete'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteDeviceSNMPOID(drawerDevice.id, entry.id);
          message.success(t('device.oid.delDone'));
          await openDrawer(drawerDevice);
        } catch (err: unknown) {
          message.error(apiErrMsg(err));
        }
      },
    });
  };

  // ── 指标趋势 handlers ─────────────────────────────────────────────────────────
  const loadTrend = async (entry: DeviceSNMPOIDEntry, range: string) => {
    if (!drawerDevice) return;
    setTrendLoading(true);
    try {
      const r = await getDeviceOIDSeries(drawerDevice.id, entry.id, range);
      setTrendData(r.data);
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setTrendLoading(false);
    }
  };

  const openTrend = (entry: DeviceSNMPOIDEntry) => {
    setTrendEntry(entry);
    setTrendData(null);
    setTrendRange('24h');
    void loadTrend(entry, '24h');
  };

  const handleTrendRange = (r: string) => {
    setTrendRange(r);
    if (trendEntry) void loadTrend(trendEntry, r);
  };

  // 趋势图 x 轴标签：24h 内只显时分，7d/30d 加月日，90d（天级桶）只显月日
  const trendLabel = (ts: string) => {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (trendRange === '90d') return `${d.getMonth() + 1}/${d.getDate()}`;
    if (trendRange === '7d' || trendRange === '30d') return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
    return `${hh}:${mm}`;
  };

  // counter 序列的值是每秒速率，单位展示自动追加 /s
  const trendUnit = trendData
    ? (trendData.kind === 'counter' ? `${trendData.unit || ''}/s` : trendData.unit)
    : '';

  // "从 MIB 解析"：用翻译引擎把 OID 转成可读名填入 Name
  const handleOidTranslate = async () => {
    const oid = ((oidForm.getFieldValue('oid') as string | undefined) ?? '').trim();
    if (!oid) return;
    setOidTranslating(true);
    try {
      const r = await translateMIBOID(oid);
      if (r.data.found) {
        oidForm.setFieldValue('name', r.data.name);
        message.success(r.data.qualified);
      } else {
        message.info(t('device.oid.translateMiss'));
      }
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    } finally {
      setOidTranslating(false);
    }
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
        await updateDevice(editing!.id, payload);
        message.success(t('device.saveOk'));
      }
      setIsModalOpen(false);
      loadData();
    } catch (err: unknown) {
      message.error(apiErrMsg(err));
    }
  };

  const handleDelete = (r: Device) => {
    confirm({
      title:      t('device.delTitle'),
      icon:       <ExclamationCircleFilled style={{ color: '#ff4d4f' }} />,
      content:    t('device.delBody'),
      okText:     t('device.delOk'),
      okType:     'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteDevice(r.id);
          message.success(t('device.delDone'));
          loadData();
        } catch (err: unknown) {
          message.error(apiErrMsg(err));
        }
      },
    });
  };

  // ── Oper status cell ──────────────────────────────────────────────────────────
  // polling_mode=none 显示 "—"（没有采集就没有可信结论）；unknown + agent_down 特殊
  // 展示为 "Proxy Down"（探针失联，设备本身状态未知）。tooltip 给出 oper_reason 详情。
  const renderOperStatus = (r: Device) => {
    if (r.polling_mode === 'none') {
      return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>;
    }
    let tone: 'success' | 'danger' | 'warning' | 'neutral' = 'neutral';
    let label = t(`device.operStatus.${r.oper_status}` as TranslationKey);
    if (r.oper_status === 'up') tone = 'success';
    else if (r.oper_status === 'down') tone = 'danger';
    else if (r.oper_status === 'unknown' && (r.oper_reason === 'agent_down' || r.oper_reason === 'agent_revoked')) {
      tone = 'warning';
      label = t('device.operStatus.proxyDown');
    }
    const tag = <StatusTag status={r.oper_status} label={label} tone={tone} />;
    if (!r.oper_reason) return tag;
    const reasonText = KNOWN_OPER_REASONS.has(r.oper_reason)
      ? t(`device.operReason.${r.oper_reason}` as TranslationKey)
      : r.oper_reason;
    return <Tooltip title={reasonText}>{tag}</Tooltip>;
  };

  // ── Columns ───────────────────────────────────────────────────────────────────
  const columns: ColumnsType<Device> = [
    { title: t('common.id'),       dataIndex: 'id',       key: 'id',  width: 60, render: (v: number) => mono(v) },
    {
      title: t('device.hostname'), dataIndex: 'hostname', key: 'hostname', width: 180,
      render: (v: string, r) => (
        <a onClick={() => { void openDrawer(r); }} style={{ fontWeight: 600 }}>{v}</a>
      ),
    },
    {
      title: t('device.mgmtIp'), dataIndex: 'management_ip', key: 'management_ip', width: 140,
      render: (v: string | null) => (v ? mono(v) : '—'),
    },
    {
      title: t('device.mgmtIpV6'), dataIndex: 'management_ipv6', key: 'management_ipv6', width: 200,
      render: (v: string | null) => (v ? mono(v) : '—'),
    },
    {
      title: t('device.status'), dataIndex: 'status', key: 'status', width: 110,
      render: (v: string) => <StatusTag status={v} label={t(`device.status.${v}` as TranslationKey)} />,
    },
    {
      title: t('device.operStatus'), key: 'oper_status', width: 120,
      render: (_, r) => renderOperStatus(r),
    },
    {
      title: t('device.uptime'), key: 'uptime', width: 110,
      render: (_, r) => {
        const up = formatUptime(r.snmp?.uptime_ticks);
        if (!up || r.polling_mode === 'none') return <span style={{ color: 'var(--ant-color-text-tertiary)' }}>—</span>;
        return r.snmp?.boot_time
          ? <Tooltip title={`${t('device.snmp.bootTime')}: ${new Date(r.snmp.boot_time).toLocaleString()}`}>{mono(up)}</Tooltip>
          : mono(up);
      },
    },
    { title: t('device.site'),   key: 'site',   width: 120, render: (_, r) => r.site?.name   ?? '—' },
    { title: t('device.pop'),    key: 'pop',    width: 120, render: (_, r) => r.pop?.name    ?? '—' },
    { title: t('device.role'),   key: 'role',   width: 120, render: (_, r) => r.role?.name   ?? '—' },
    { title: t('device.vendor'), key: 'vendor', width: 120, render: (_, r) => r.vendor?.name ?? '—' },
    {
      title: t('device.remark'), dataIndex: 'remark', key: 'remark', width: 180, ellipsis: true,
      render: (v: string) => v
        ? <Tooltip title={v} placement="topLeft"><span>{v}</span></Tooltip>
        : '—',
    },
    {
      title: t('common.actions'), key: 'action', width: 130, fixed: 'right' as const,
      render: (_: unknown, r: Device) => (
        <Space size={4}>
          <Button type="link"  size="small" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
          <Button type="text"  size="small" danger onClick={() => handleDelete(r)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Lookup-error banner — shown only when filter options could not load ── */}
      {lookupsError && (
        <Alert
          type="warning"
          showIcon
          message={t('device.lookupsError')}
          action={
            <Button size="small" onClick={() => { void loadLookups(); }}>
              {t('common.refresh')}
            </Button>
          }
          closable
          onClose={() => setLookupsError(false)}
          style={{ marginBottom: 12 }}
        />
      )}

      {/* ── Filter bar ── */}
      <Space wrap style={{ marginBottom: 16 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('device.search.hostname')}
          value={filterHostname}
          onChange={e => setFilterHostname(e.target.value)}
          allowClear style={{ width: 160 }}
        />
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('device.search.ip')}
          value={filterIP}
          onChange={e => setFilterIP(e.target.value)}
          allowClear style={{ width: 140 }}
        />
        <Input
          prefix={<SearchOutlined />}
          placeholder={t('device.search.ipv6')}
          value={filterIPv6}
          onChange={e => setFilterIPv6(e.target.value)}
          allowClear style={{ width: 160 }}
        />
        <Select
          placeholder={t('device.search.status')}
          value={filterStatus}
          onChange={setFilterStatus}
          allowClear style={{ width: 140 }}
          options={STATUS_OPTIONS}
        />
        <Select
          placeholder={t('device.search.operStatus')}
          value={filterOperStatus}
          onChange={setFilterOperStatus}
          allowClear style={{ width: 150 }}
          options={OPER_STATUS_OPTIONS}
        />
        <Select
          placeholder={t('device.search.site')}
          value={filterSiteId}
          onChange={handleFilterSiteChange}
          allowClear style={{ width: 140 }}
          options={sites.map(s => ({ value: s.id, label: s.name }))}
        />
        {/* PoP filter: disabled until a site is chosen, then scoped to that site's PoPs */}
        <Select
          placeholder={filterSiteId ? t('device.search.pop') : t('device.popSelectSiteFirst')}
          value={filterPopId}
          onChange={setFilterPopId}
          allowClear
          disabled={!filterSiteId}
          loading={lookupsLoading && !!filterSiteId}
          style={{ width: 150 }}
          options={filterPopOptions}
        />
        <Select
          placeholder={t('device.search.role')}
          value={filterRoleId}
          onChange={setFilterRoleId}
          allowClear style={{ width: 130 }}
          options={roles.map(r => ({ value: r.id, label: r.name }))}
        />
        <Select
          placeholder={t('device.search.vendor')}
          value={filterVendorId}
          onChange={setFilterVendorId}
          allowClear style={{ width: 130 }}
          options={vendors.map(v => ({ value: v.id, label: v.name }))}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => { void loadData(); void loadLookups(); }}
          loading={loading}
        >
          {t('common.refresh')}
        </Button>
        {canWrite && (
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('device.add')}
          </Button>
        )}
      </Space>

      {/* ── Table (server-side pagination) ── */}
      <Table
        columns={canWrite ? columns : columns.filter((c) => c.key !== 'action')}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          pageSizeOptions: ['10', '20', '50', '100'],
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (n, range) => `${range[0]}-${range[1]} / ${n}`,
          onChange: (p, ps) => {
            // 切换每页条数时回到第一页，避免落在超出范围的页码上
            if (ps !== pageSize) {
              setPageSize(ps);
              setPage(1);
            } else {
              setPage(p);
            }
          },
        }}
        scroll={{ x: 1830 }}
      />

      {/* ── Create / Edit Modal（两列布局 + SNMP 采集区块）── */}
      <Modal
        title={mode === 'create' ? t('device.add') : t('device.edit')}
        open={isModalOpen}
        onOk={handleSubmit}
        onCancel={() => setIsModalOpen(false)}
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
                        required: mode === 'create' || !editing?.snmp_credential_set,
                        message: t('device.snmp.communityRequired'),
                      }]}
                    >
                      <Input.Password
                        autoComplete="new-password"
                        placeholder={mode === 'edit' && editing?.snmp_credential_set
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
                          required: !!watchV3AuthProto && !editing?.snmp_v3_auth_set,
                          message: t('device.snmp.v3PassRequired'),
                        }]}
                      >
                        <Input.Password
                          autoComplete="new-password"
                          disabled={!watchV3AuthProto}
                          placeholder={editing?.snmp_v3_auth_set ? t('device.snmp.communityKeep') : undefined}
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
                          required: !!getFieldValue('snmp_v3_priv_proto') && !editing?.snmp_v3_priv_set,
                          message: t('device.snmp.v3PassRequired'),
                        })]}
                      >
                        <Input.Password
                          autoComplete="new-password"
                          disabled={!watchV3AuthProto}
                          placeholder={editing?.snmp_v3_priv_set ? t('device.snmp.communityKeep') : undefined}
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

      {/* ── SNMP 详情 Drawer（点击主机名打开）── */}
      <Drawer
        title={drawerDevice ? `${drawerDevice.hostname} — ${t('device.snmp.drawerTitle')}` : t('device.snmp.drawerTitle')}
        open={!!drawerDevice}
        onClose={() => { setDrawerDevice(null); setDrawerDetail(null); }}
        width={640}
        extra={
          <Space size={8}>
            {canWrite && drawerDetail?.polling_mode === 'direct' && (
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
              loading={drawerLoading}
              onClick={() => { if (drawerDevice) void openDrawer(drawerDevice); }}
            >
              {t('common.refresh')}
            </Button>
          </Space>
        }
      >
        {drawerDetail && (
          <Descriptions column={1} size="small" bordered labelStyle={{ width: 150 }}>
            <Descriptions.Item label={t('device.operStatus')}>
              {drawerDevice ? renderOperStatus({
                ...drawerDevice,
                polling_mode: drawerDetail.polling_mode,
                oper_status: drawerDetail.oper_status,
                oper_reason: drawerDetail.oper_reason,
              }) : null}
            </Descriptions.Item>
            <Descriptions.Item label={t('device.pollingMode')}>
              {t(`device.pollingMode.${drawerDetail.polling_mode}` as TranslationKey)}
            </Descriptions.Item>
            {drawerDetail.polling_mode !== 'none' && (
              <Descriptions.Item label={t('device.snmp.source')}>
                {drawerDetail.polling_mode === 'direct'
                  ? t('device.snmp.sourceDirect')
                  : mono(drawerDetail.state?.source_agent_id ?? drawerDetail.snmp_agent_id ?? '—')}
              </Descriptions.Item>
            )}
            {drawerDetail.state ? (
              <>
                <Descriptions.Item label={t('device.uptime')}>
                  {formatUptime(drawerDetail.state.uptime_ticks) ?? '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.bootTime')}>
                  {drawerDetail.state.boot_time
                    ? new Date(drawerDetail.state.boot_time).toLocaleString()
                    : '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysName')}>
                  {drawerDetail.state.sys_name || '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysDescr')}>
                  <span style={{ wordBreak: 'break-all' }}>{drawerDetail.state.sys_descr || '—'}</span>
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysObjectID')}>
                  {drawerDetail.state.sys_object_id ? (
                    <div>
                      {mono(drawerDetail.state.sys_object_id)}
                      {/* MIB 翻译引擎命中时展示可读名（如 CISCO-PRODUCTS-MIB::cisco7206VXR） */}
                      {drawerDetail.sys_object_id_name && (
                        <div style={{ fontSize: 12, color: 'var(--ant-color-text-secondary)' }}>
                          {drawerDetail.sys_object_id_name}
                        </div>
                      )}
                    </div>
                  ) : '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysLocation')}>
                  {drawerDetail.state.sys_location || '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.sysContact')}>
                  {drawerDetail.state.sys_contact || '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.latency')}>
                  {drawerDetail.state.latency_ms != null
                    ? mono(`${drawerDetail.state.latency_ms.toFixed(1)} ms`)
                    : '—'}
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.lastPoll')}>
                  <RelativeTime value={drawerDetail.state.last_poll_at} />
                </Descriptions.Item>
                <Descriptions.Item label={t('device.snmp.lastSuccess')}>
                  <RelativeTime value={drawerDetail.state.last_success_at} />
                </Descriptions.Item>
                {drawerDetail.state.last_error && (
                  <Descriptions.Item label={t('device.snmp.lastError')}>
                    <span style={{ color: 'var(--ant-color-error)', wordBreak: 'break-all' }}>
                      {drawerDetail.state.last_error}
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
        {drawerDetail && drawerDetail.polling_mode !== 'none' && (
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
              dataSource={drawerDetail.custom_oids}
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
                          onClick={() => openTrend(r)}
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
        {drawerDetail && drawerDetail.collect_interfaces && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
              {t('device.if.section')}
              <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--ant-color-text-tertiary)', marginLeft: 8 }}>
                {drawerDetail.interfaces.length}
              </span>
            </div>
            <Table<DeviceInterfaceEntry>
              size="small"
              rowKey="id"
              dataSource={drawerDetail.interfaces}
              pagination={drawerDetail.interfaces.length > 10
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
      <Modal
        title={oidEditing ? t('device.oid.edit') : t('device.oid.add')}
        open={oidModalOpen}
        onOk={() => { void handleOidSubmit(); }}
        confirmLoading={oidSaving}
        onCancel={() => setOidModalOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
        width={480}
      >
        <Form form={oidForm} layout="vertical" style={{ marginTop: 8 }}>
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
                  loading={oidTranslating}
                  onClick={() => { void handleOidTranslate(); }}
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

      {/* ── 指标趋势 Modal（懒加载图表；counter 已是每秒速率）── */}
      <Modal
        title={trendEntry
          ? `${trendEntry.name || trendEntry.oid} — ${t('device.oid.trend')}${trendUnit ? `（${trendUnit}）` : ''}`
          : t('device.oid.trend')}
        open={!!trendEntry}
        footer={null}
        onCancel={() => { setTrendEntry(null); setTrendData(null); }}
        width={720}
        destroyOnClose
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Segmented
            value={trendRange}
            onChange={(v) => handleTrendRange(String(v))}
            options={['1h', '6h', '24h', '7d', '30d', '90d']}
          />
          {trendEntry && mono(trendEntry.oid)}
        </div>
        {trendLoading && !trendData ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : trendData && trendData.points.length > 0 ? (
          <Suspense fallback={<Skeleton active paragraph={{ rows: 5 }} />}>
            <LazyLine {...({
              data: trendData.points.map(p => ({ ts: trendLabel(p.ts), v: p.avg })),
              xField: 'ts',
              yField: 'v',
              height: 280,
              smooth: true,
              axis: { y: { title: trendUnit || undefined } },
            } as any)} />
          </Suspense>
        ) : (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--ant-color-text-tertiary)' }}>
            {t('device.oid.trendEmpty')}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default TabDeviceList;
