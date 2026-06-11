import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, message,
} from 'antd';
import {
  ExclamationCircleFilled, PlusOutlined, ReloadOutlined, SearchOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  getDevices, createDevice, updateDevice, deleteDevice,
  getDeviceSites, getDevicePoPs, getDeviceRoles, getDeviceVendors,
} from '../../../api/device';
import type { Device, DeviceSite, DevicePoP, DeviceRole, DeviceVendor } from '../../../types/device';
import type { TranslationKey } from '../../../i18n/translations';
import { useT } from '../../../i18n';
import { useDebounced } from '../../../utils/useDebounced';

const { confirm } = Modal;

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  active:      'green',
  offline:     'red',
  maintenance: 'orange',
  planned:     'blue',
};

const STATUS_VALUES = ['active', 'offline', 'maintenance', 'planned'] as const;

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

  const STATUS_OPTIONS = STATUS_VALUES.map(v => ({
    value: v,
    label: t(`device.status.${v}` as TranslationKey),
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
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [lookupsError,   setLookupsError]   = useState(false);

  // ── Table filters ─────────────────────────────────────────────────────────────
  const [filterHostname, setFilterHostname] = useState('');
  const [filterIP,       setFilterIP]       = useState('');
  const [filterIPv6,     setFilterIPv6]     = useState('');
  const [filterStatus,   setFilterStatus]   = useState<string | undefined>();
  const [filterSiteId,   setFilterSiteId]   = useState<number | undefined>();
  const [filterPopId,    setFilterPopId]    = useState<number | undefined>();
  const [filterRoleId,   setFilterRoleId]   = useState<number | undefined>();
  const [filterVendorId, setFilterVendorId] = useState<number | undefined>();

  // ── Modal ─────────────────────────────────────────────────────────────────────
  const [isModalOpen,    setIsModalOpen]    = useState(false);
  const [mode,           setMode]           = useState<'create' | 'edit'>('create');
  const [editing,        setEditing]        = useState<Device | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<number | undefined>();
  const [form] = Form.useForm();

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
        hostname:  debHostname || undefined,
        ip:        debIP       || undefined,
        ipv6:      debIPv6     || undefined,
        status:    filterStatus,
        site_id:   filterSiteId,
        pop_id:    filterPopId,
        role_id:   filterRoleId,
        vendor_id: filterVendorId,
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
        message.error(err instanceof Error ? err.message : 'Failed to load devices');
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [page, pageSize, debHostname, debIP, debIPv6, filterStatus,
      filterSiteId, filterPopId, filterRoleId, filterVendorId]);

  const loadLookups = async () => {
    setLookupsLoading(true);
    try {
      const [s, p, r, v] = await Promise.all([
        getDeviceSites(),
        getDevicePoPs(),
        getDeviceRoles(),
        getDeviceVendors(),
      ]);
      setSites(s.data);
      setAllPoPs(p.data);
      setRoles(r.data);
      setVendors(v.data);
      setLookupsError(false); // Clear stale-data banner on successful reload
    } catch (err: unknown) {
      // Surface the error so operators know filter options may be stale,
      // but do NOT block the main device table — it loads independently.
      setLookupsError(true);
      message.warning(err instanceof Error ? err.message : '筛选选项加载失败');
    } finally {
      setLookupsLoading(false);
    }
  };

  // 筛选条件变化时回到第一页（loadData 依赖变化会自动触发重新查询）
  useEffect(() => {
    setPage(1);
  }, [debHostname, debIP, debIPv6, filterStatus,
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
    });
    setIsModalOpen(true);
  };

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
      message.error(err instanceof Error ? err.message : 'Operation failed');
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
          message.error(err instanceof Error ? err.message : 'Delete failed');
        }
      },
    });
  };

  // ── Columns ───────────────────────────────────────────────────────────────────
  const columns: ColumnsType<Device> = [
    { title: t('common.id'),       dataIndex: 'id',       key: 'id',  width: 60 },
    { title: t('device.hostname'), dataIndex: 'hostname', key: 'hostname', width: 180 },
    {
      title: t('device.mgmtIp'), dataIndex: 'management_ip', key: 'management_ip', width: 140,
      render: (v: string | null) => v || '—',
    },
    {
      title: t('device.mgmtIpV6'), dataIndex: 'management_ipv6', key: 'management_ipv6', width: 200,
      render: (v: string | null) => v || '—',
    },
    {
      title: t('device.status'), dataIndex: 'status', key: 'status', width: 120,
      render: (v: string) => (
        <Tag color={STATUS_COLOR[v] ?? 'default'}>
          {t(`device.status.${v}` as TranslationKey) ?? v}
        </Tag>
      ),
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
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('device.add')}
        </Button>
      </Space>

      {/* ── Table (server-side pagination) ── */}
      <Table
        columns={columns}
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
        scroll={{ x: 1600 }}
      />

      {/* ── Create / Edit Modal ── */}
      <Modal
        title={mode === 'create' ? t('device.add') : t('device.edit')}
        open={isModalOpen}
        onOk={handleSubmit}
        onCancel={() => setIsModalOpen(false)}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            label={t('device.hostname')}
            name="hostname"
            rules={[{ required: true, message: t('device.hostname') }]}
          >
            <Input />
          </Form.Item>

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

          <Form.Item label={t('device.status')} name="status" initialValue="active">
            <Select options={STATUS_OPTIONS} />
          </Form.Item>

          <Form.Item label={t('device.site')} name="site_id">
            <Select
              allowClear
              options={sites.map(s => ({ value: s.id, label: s.name }))}
              onChange={handleSiteChange}
            />
          </Form.Item>

          <Form.Item label={t('device.pop')} name="pop_id">
            <Select
              allowClear
              disabled={!selectedSiteId}
              placeholder={!selectedSiteId ? t('device.popSelectSiteFirst') : undefined}
              options={modalPopOptions}
            />
          </Form.Item>

          <Form.Item label={t('device.role')} name="role_id">
            <Select allowClear options={roles.map(r => ({ value: r.id, label: r.name }))} />
          </Form.Item>

          <Form.Item label={t('device.vendor')} name="vendor_id">
            <Select allowClear options={vendors.map(v => ({ value: v.id, label: v.name }))} />
          </Form.Item>

          <Form.Item label={t('device.remark')} name="remark">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TabDeviceList;
