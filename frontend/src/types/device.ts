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

/** SNMP 状态快照（device_snmp_states，每设备一行，机器写入） */
export interface DeviceSNMPState {
  id: number;
  device_id: number;
  sys_name: string;
  sys_descr: string;
  sys_object_id: string;
  sys_location: string;
  sys_contact: string;
  uptime_ticks?: number | null;   // TimeTicks（1/100 秒）
  boot_time?: string | null;
  latency_ms?: number | null;
  last_poll_at?: string | null;
  last_success_at?: string | null;
  last_error: string;
  source_agent_id?: string | null;
  updated_at: string;
}

export type PollingMode = 'none' | 'direct' | 'agent';
export type OperStatus = 'up' | 'down' | 'unknown';

export interface Device {
  id: number;
  hostname: string;
  management_ip?: string | null;
  management_ipv6?: string | null;
  /** 管理状态（用户意图）：active / maintenance / planned（offline 为遗留值） */
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
  // ── SNMP 采集配置 ──
  polling_mode: PollingMode;
  snmp_agent_id?: string | null;
  snmp_version: string;
  snmp_port: number;
  snmp_interval_seconds?: number | null;
  /** 每周期 WALK ifTable/ifXTable 维护接口维表 */
  collect_interfaces: boolean;
  /** SNMPv3（USM）非敏感配置；口令永不回显，以 *_set 标志感知 */
  snmp_v3_user?: string | null;
  snmp_v3_auth_proto?: string | null;
  snmp_v3_priv_proto?: string | null;
  /** 凭证是否已配置（密码类字段永不回显，编辑时留空 = 保持不变） */
  snmp_credential_set: boolean;
  snmp_v3_auth_set: boolean;
  snmp_v3_priv_set: boolean;
  // ── 运行状态（机器写入）──
  oper_status: OperStatus;
  oper_reason: string;
  /** 状态快照（列表 Preload 返回；Drawer 用 getDeviceSNMP 拿最新） */
  snmp?: DeviceSNMPState | null;
  created_at: string;
  updated_at: string;
}

/** agents-lite 端点返回的探针候选项（devices:write 用户可读的最小字段集） */
export interface AgentLite {
  agent_id: string;
  hostname: string;
  status: string;
  group_name: string;
  last_seen_at?: string | null;
}

/** MIB 文件库条目（file_path 为服务器内部路径，不下发） */
export interface DeviceMIB {
  id: number;
  module_name: string;
  file_name: string;
  file_size: number;
  sha256: string;
  /** 翻译引擎解析状态（失败常见原因是 IMPORTS 依赖模块未上传，补传后自动转好） */
  parsed: boolean;
  parse_error: string;
  uploaded_by: string;
  created_at: string;
}

/** POST /devices/:id/snmp/test 响应（direct 模式同步采集一次） */
export interface SNMPTestResult {
  success: boolean;
  latency_ms?: number | null;
  error_kind?: string;
  error?: string;
  uptime_ticks?: number | null;
  sys_name?: string;
  sys_descr?: string;
}

/** GET /devices/:id/snmp 响应 */
export interface DeviceSNMPDetail {
  device_id: number;
  hostname: string;
  polling_mode: PollingMode;
  snmp_agent_id?: string | null;
  snmp_version: string;
  snmp_port: number;
  oper_status: OperStatus;
  oper_reason: string;
  state?: DeviceSNMPState | null;
  /** MIB 引擎对 sysObjectID 的翻译（如 CISCO-PRODUCTS-MIB::cisco7206VXR），未命中为 null */
  sys_object_id_name?: string | null;
  custom_oids: DeviceSNMPOIDEntry[];
  collect_interfaces: boolean;
  interfaces: DeviceInterfaceEntry[];
}

/** 接口维表行（ifTable/ifXTable 快照 + 服务端换算的当前速率） */
export interface DeviceInterfaceEntry {
  id: number;
  device_id: number;
  if_index: number;
  name: string;
  alias: string;
  if_type: number;
  speed_mbps: number;
  admin_status: number;      // 1 up / 2 down / 3 testing
  oper_status: number;       // 1 up … 7 lowerLayerDown（RFC 2863）
  in_bps?: number | null;    // bit/s，首个采样周期为 null
  out_bps?: number | null;
  in_errors: number;
  out_errors: number;
  polled_at?: string | null;
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

/** 设备列表查询参数 — 服务端分页 + 过滤 */
export interface DeviceListParams {
  page: number;
  page_size: number;
  hostname?: string;
  ip?: string;
  ipv6?: string;
  status?: string;
  oper_status?: string;
  polling_mode?: string;
  site_id?: number;
  pop_id?: number;
  role_id?: number;
  vendor_id?: number;
}

/** 服务端分页响应 */
export interface DeviceListResp {
  total: number;
  items: Device[];
  page: number;
  page_size: number;
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
  polling_mode?: PollingMode;
  snmp_agent_id?: string | null;
  snmp_version?: string;
  /** 密码类字段：编辑时空字符串 = 保持原值不变 */
  snmp_community?: string;
  snmp_port?: number;
  snmp_interval_seconds?: number | null;
  collect_interfaces?: boolean;
  snmp_v3_user?: string;
  snmp_v3_auth_proto?: string;
  snmp_v3_auth_pass?: string;
  snmp_v3_priv_proto?: string;
  snmp_v3_priv_pass?: string;
}

export type UpdateDeviceReq = CreateDeviceReq;

/** 设备自定义标量 OID（定义 + 最新值一体，快照语义；数值型另有时序） */
export interface DeviceSNMPOIDEntry {
  id: number;
  device_id: number;
  oid: string;
  name: string;
  unit: string;
  /** gauge = 瞬时量原值入库；counter = 单调计数器，入库时换算每秒速率 */
  kind: 'gauge' | 'counter';
  last_value: string;
  last_numeric?: number | null;
  last_error: string;
  polled_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /devices/:id/snmp/oids/:oid_id/series 响应（时间桶聚合） */
export interface MetricSeriesPoint {
  ts: string;
  avg: number;
  min: number;
  max: number;
  count: number;
}

export interface MetricSeriesResp {
  oid_id: number;
  oid: string;
  name: string;
  unit: string;
  kind: 'gauge' | 'counter';
  range: string;
  points: MetricSeriesPoint[];
}

/** GET /devices/mibs/translate?oid= 响应 */
export interface MIBTranslation {
  found: boolean;
  name: string;
  module: string;
  qualified: string;
  description: string;
}
