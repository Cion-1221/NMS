import client from './client';
import type {
  Device, CreateDeviceReq, UpdateDeviceReq, DeviceListParams, DeviceListResp,
  DeviceSite, DevicePoP, DeviceRole, DeviceVendor, DeviceAuditLog,
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
