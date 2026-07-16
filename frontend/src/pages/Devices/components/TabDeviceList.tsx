/**
 * 设备列表 Tab：筛选栏 + 服务端分页表格。
 *
 * 大块交互拆分为独立组件（本文件只负责列表与接线）：
 *   - DeviceFormModal      新增/编辑表单（两列布局 + SNMP 采集区块）
 *   - DeviceSNMPDrawer     SNMP 详情 Drawer（自定义 OID 管理 + 接口表 + 立即测试）
 *   - deviceDisplay        共享展示工具（mono / formatUptime / OperStatusTag …）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Table, Tooltip, message } from 'antd';
import { ExclamationCircleFilled, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getDevices, deleteDevice,
  getDeviceSites, getDevicePoPs, getDeviceRoles, getDeviceVendors, getDeviceAgentsLite,
} from '../../../api/device';
import type {
  AgentLite, Device, DeviceSite, DevicePoP, DeviceRole, DeviceVendor,
} from '../../../types/device';
import type { TranslationKey } from '../../../i18n/translations';
import { apiErrMsg, useT } from '../../../i18n';
import { PERM_DEVICES_WRITE, useCan } from '../../../utils/perms';
import { useDebounced } from '../../../utils/useDebounced';
import StatusTag from '../../../components/StatusTag';
import { mono, formatUptime, OperStatusTag } from './deviceDisplay';
import DeviceFormModal from './DeviceFormModal';
import DeviceSNMPDrawer from './DeviceSNMPDrawer';

const { confirm } = Modal;

// 筛选栏保留全部四个管理状态（存量数据可能仍是遗留值 offline/已停用）
const STATUS_VALUES = ['active', 'offline', 'maintenance', 'planned'] as const;
const OPER_STATUS_VALUES = ['up', 'down', 'unknown'] as const;

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

  // ── Modal / Drawer wiring ─────────────────────────────────────────────────────
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mode,        setMode]        = useState<'create' | 'edit'>('create');
  const [editing,     setEditing]     = useState<Device | null>(null);
  const [drawerDevice, setDrawerDevice] = useState<Device | null>(null);

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

  // PoP options in the filter bar: only valid when a site is already selected.
  // When no site is selected the dropdown is disabled, so this can return [].
  const filterPopOptions = useMemo(() =>
    filterSiteId
      ? allPoPs.filter(p => p.site_id === filterSiteId).map(p => ({ value: p.id, label: p.name }))
      : [],
  [allPoPs, filterSiteId]);

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
    setIsModalOpen(true);
  };

  const openEdit = (r: Device) => {
    setMode('edit');
    setEditing(r);
    setIsModalOpen(true);
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

  // ── Columns ───────────────────────────────────────────────────────────────────
  const columns: ColumnsType<Device> = [
    { title: t('common.id'),       dataIndex: 'id',       key: 'id',  width: 60, render: (v: number) => mono(v) },
    {
      title: t('device.hostname'), dataIndex: 'hostname', key: 'hostname', width: 180,
      render: (v: string, r) => (
        <a onClick={() => setDrawerDevice(r)} style={{ fontWeight: 600 }}>{v}</a>
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
      render: (_, r) => (
        <OperStatusTag pollingMode={r.polling_mode} operStatus={r.oper_status} operReason={r.oper_reason} />
      ),
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
    // Site/PoP/Role/Vendor 不设固定宽度——随内容自适应（表格已取消 scroll.x，
    // 交给浏览器的默认表格布局按各列实际内容分配宽度，短名称不占多余空间）
    { title: t('device.site'),   key: 'site',   render: (_, r) => r.site?.name   ?? '—' },
    { title: t('device.pop'),    key: 'pop',    render: (_, r) => r.pop?.name    ?? '—' },
    { title: t('device.role'),   key: 'role',   render: (_, r) => r.role?.name   ?? '—' },
    { title: t('device.vendor'), key: 'vendor', render: (_, r) => r.vendor?.name ?? '—' },
    {
      title: t('device.remark'), dataIndex: 'remark', key: 'remark', width: 180,
      // 手动内联截断而非列级 ellipsis：tableLayout="auto" 下 antd 的 ellipsis
      // 依赖 fixed 布局才能可靠生效，长文本会把列撑开而不是截断；这里用
      // maxWidth + overflow:hidden 自行限定，与表格整体布局模式无关。
      render: (v: string) => v
        ? (
          <Tooltip title={v} placement="topLeft">
            <span style={{
              display: 'inline-block', maxWidth: 180, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
            }}>
              {v}
            </span>
          </Tooltip>
        )
        : '—',
    },
    {
      title: t('common.actions'), key: 'action', width: 130,
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

      {/* ── Table (server-side pagination) ──
          默认 tableLayout="auto"（不设 scroll、不设 tableLayout="fixed"）：
          未设宽度的 Site/PoP/Role/Vendor 四列才会真正按各自内容宽度自适应——
          fixed 布局下无宽度列只会平分剩余空间，无法体现"短名称窄、长名称宽"的
          差异。remark 的截断因此改为手动内联样式（见上方 render），不再依赖
          fixed 布局才能生效。不设 scroll.x 意味着 antd 的横向滚动包裹层从不会
          被创建，也就不会再出现表格自身的左右拖动条。*/}
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
      />

      {/* ── Create / Edit Modal ── */}
      <DeviceFormModal
        open={isModalOpen}
        mode={mode}
        device={editing}
        sites={sites}
        pops={allPoPs}
        roles={roles}
        vendors={vendors}
        agents={agents}
        onClose={() => setIsModalOpen(false)}
        onSaved={() => {
          setIsModalOpen(false);
          void loadData();
        }}
      />

      {/* ── SNMP 详情 Drawer（点击主机名打开）── */}
      <DeviceSNMPDrawer
        device={drawerDevice}
        canWrite={canWrite}
        onClose={() => setDrawerDevice(null)}
        onChanged={() => { void loadData(); }}
      />
    </div>
  );
};

export default TabDeviceList;
