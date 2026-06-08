export interface DeviceSite {
  id: number;
  name: string;
  region?: string;
  address?: string;
  description?: string;
  /** Derived by the list API via LEFT JOIN COUNT — not present on update/create responses. */
  pop_count?: number;
  created_at: string;
  updated_at: string;
}

export interface DevicePoP {
  id: number;
  name: string;
  site_id: number;
  site?: DeviceSite | null;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface DeviceRole {
  id: number;
  name: string;
  description?: string;
  created_at: string;
}

export interface DeviceVendor {
  id: number;
  name: string;
  description?: string;
  created_at: string;
}

export interface Device {
  id: number;
  hostname: string;
  management_ip?: string | null;
  management_ipv6?: string | null;
  status: string;
  site_id?: number | null;
  site?: DeviceSite | null;
  pop_id?: number | null;
  pop?: DevicePoP | null;
  role_id?: number | null;
  role?: DeviceRole | null;
  vendor_id?: number | null;
  vendor?: DeviceVendor | null;
  remark?: string;
  created_at: string;
  updated_at: string;
}

export interface DeviceAuditLog {
  id: number;
  username: string;
  action: string;
  resource_type: string;
  resource_id?: number | null;
  detail: string;
  created_at: string;
}

export interface CreateDeviceReq {
  hostname: string;
  management_ip?: string | null;
  management_ipv6?: string | null;
  status?: string;
  site_id?: number | null;
  pop_id?: number | null;
  role_id?: number | null;
  vendor_id?: number | null;
  remark?: string;
}

export interface UpdateDeviceReq {
  hostname: string;
  management_ip?: string | null;
  management_ipv6?: string | null;
  status?: string;
  site_id?: number | null;
  pop_id?: number | null;
  role_id?: number | null;
  vendor_id?: number | null;
  remark?: string;
}
