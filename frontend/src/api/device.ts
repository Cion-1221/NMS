import client from './client';
import type {
  Device, CreateDeviceReq, UpdateDeviceReq, DeviceListParams, DeviceListResp,
  DeviceSite, DevicePoP, DeviceRole, DeviceVendor, DeviceAuditLog,
  AgentLite, DeviceSNMPDetail, SNMPTestResult, DeviceMIB,
  DeviceSNMPOIDEntry, MIBTranslation, MetricSeriesResp,
} from '../types/device';

// ── Sites ──────────────────────────────────────────────────────────────────────

export const getDeviceSites = () =>
  client.get<DeviceSite[]>('/devices/sites');

export const createDeviceSite = (data: { name: string; region?: string; address?: string; description?: string }) =>
  client.post<DeviceSite>('/devices/sites', data);

export const updateDeviceSite = (id: number, data: { name: string; region?: string; address?: string; description?: string }) =>
  client.put<DeviceSite>(`/devices/sites/${id}`, data);

export const deleteDeviceSite = (id: number) =>
  client.delete(`/devices/sites/${id}`);

// ── PoPs ───────────────────────────────────────────────────────────────────────

// Pass siteId to load only PoPs for a specific site (used by the Site edit drawer).
// Omit siteId to load all PoPs (used by the Device List filter bar and form).
export const getDevicePoPs = (siteId?: number) =>
  client.get<DevicePoP[]>('/devices/pops', siteId != null ? { params: { site_id: siteId } } : undefined);

export const createDevicePoP = (data: { name: string; site_id: number; description?: string }) =>
  client.post<DevicePoP>('/devices/pops', data);

export const updateDevicePoP = (id: number, data: { name: string; site_id: number; description?: string }) =>
  client.put<DevicePoP>(`/devices/pops/${id}`, data);

export const deleteDevicePoP = (id: number) =>
  client.delete(`/devices/pops/${id}`);

// ── Roles ──────────────────────────────────────────────────────────────────────

export const getDeviceRoles = () =>
  client.get<DeviceRole[]>('/devices/roles');

export const createDeviceRole = (data: { name: string; description?: string }) =>
  client.post<DeviceRole>('/devices/roles', data);

export const updateDeviceRole = (id: number, data: { name: string; description?: string }) =>
  client.put<DeviceRole>(`/devices/roles/${id}`, data);

export const deleteDeviceRole = (id: number) =>
  client.delete(`/devices/roles/${id}`);

// ── Vendors ────────────────────────────────────────────────────────────────────

export const getDeviceVendors = () =>
  client.get<DeviceVendor[]>('/devices/vendors');

export const createDeviceVendor = (data: { name: string; description?: string }) =>
  client.post<DeviceVendor>('/devices/vendors', data);

export const updateDeviceVendor = (id: number, data: { name: string; description?: string }) =>
  client.put<DeviceVendor>(`/devices/vendors/${id}`, data);

export const deleteDeviceVendor = (id: number) =>
  client.delete(`/devices/vendors/${id}`);

// ── Devices ────────────────────────────────────────────────────────────────────

// 服务端分页：undefined 的过滤参数会被 axios 自动从 query string 中剔除
export const getDevices = (params: DeviceListParams) =>
  client.get<DeviceListResp>('/devices', { params });

export const createDevice = (data: CreateDeviceReq) =>
  client.post<Device>('/devices', data);

export const updateDevice = (id: number, data: UpdateDeviceReq) =>
  client.put<Device>(`/devices/${id}`, data);

export const deleteDevice = (id: number) =>
  client.delete(`/devices/${id}`);

// ── SNMP 辅助端点 ──────────────────────────────────────────────────────────────

// 表单"采集探针"下拉的数据源（登录即可读，不需要 Agent 模块的 admin 权限）
export const getDeviceAgentsLite = () =>
  client.get<AgentLite[]>('/devices/agents-lite');

// 详情 Drawer：设备 SNMP 配置 + 最新状态快照
export const getDeviceSNMP = (id: number) =>
  client.get<DeviceSNMPDetail>(`/devices/${id}/snmp`);

// 立即测试（仅 direct 模式）：同步采集一次并落库，约 6 秒内返回
export const testDeviceSNMP = (id: number) =>
  client.post<SNMPTestResult>(`/devices/${id}/snmp/test`);

// ── 自定义标量 OID（Drawer 内管理，随快轮询采集）────────────────────────────────

export const createDeviceSNMPOID = (deviceId: number, data: { oid: string; name?: string; unit?: string; kind?: string }) =>
  client.post<DeviceSNMPOIDEntry>(`/devices/${deviceId}/snmp/oids`, data);

export const updateDeviceSNMPOID = (deviceId: number, oidId: number, data: { oid: string; name?: string; unit?: string; kind?: string }) =>
  client.put<DeviceSNMPOIDEntry>(`/devices/${deviceId}/snmp/oids/${oidId}`, data);

export const deleteDeviceSNMPOID = (deviceId: number, oidId: number) =>
  client.delete(`/devices/${deviceId}/snmp/oids/${oidId}`);

// 指标趋势序列（gauge 原值 / counter 每秒速率，时间桶聚合 avg/min/max）
export const getDeviceOIDSeries = (deviceId: number, oidId: number, range: string) =>
  client.get<MetricSeriesResp>(`/devices/${deviceId}/snmp/oids/${oidId}/series`, { params: { range } });

// 数字 OID → 可读名（MIB 翻译引擎，最长前缀匹配）
export const translateMIBOID = (oid: string) =>
  client.get<MIBTranslation>('/devices/mibs/translate', { params: { oid } });

// ── MIB 文件库 ─────────────────────────────────────────────────────────────────

export const getDeviceMIBs = () =>
  client.get<DeviceMIB[]>('/devices/mibs');

// multipart 上传（字段名 file）；服务端校验大小/文本/SMI 模块头并提取模块名
export const uploadDeviceMIB = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return client.post<DeviceMIB>('/devices/mibs', form);
};

export const deleteDeviceMIB = (id: number) =>
  client.delete(`/devices/mibs/${id}`);

// 带 JWT 的下载：axios 拿 blob 后用临时 object URL 触发浏览器保存
export const downloadDeviceMIB = async (id: number, fileName: string) => {
  const resp = await client.get<Blob>(`/devices/mibs/${id}/download`, { responseType: 'blob' });
  const url = URL.createObjectURL(resp.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};

// ── Audit Logs ─────────────────────────────────────────────────────────────────

export const getDeviceAuditLogs = (
  page: number,
  pageSize: number,
  filters?: { username?: string; action?: string; resource_type?: string },
) =>
  client.get<{ total: number; items: DeviceAuditLog[]; page: number; page_size: number }>(
    '/devices/audit-logs',
    { params: { page, page_size: pageSize, ...filters } },
  );

export const purgeDeviceAuditLogs = (days: number) =>
  client.delete<{ deleted: number }>('/devices/audit-logs', { params: { days } });
