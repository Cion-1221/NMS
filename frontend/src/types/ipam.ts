export interface IPAMGroup {
  id: number;
  name: string;
  description?: string;
  created_at: string;
}

export interface IPAMType {
  id: number;
  name: string;
  description?: string;
  created_at: string;
}

export interface IPAMVRF {
  id: number;
  name: string;
  rd?: string;
  description?: string;
  created_at: string;
}

export interface RootPrefix {
  id: number;
  ip_version: number;
  cidr: string;
  group_id?: number | null;
  group?: IPAMGroup | null;
  type_id?: number | null;
  type?: IPAMType | null;
  vrf_id?: number | null;
  vrf?: IPAMVRF | null;
  remark?: string;
  created_at: string;
  updated_at: string;
}

export interface SubnetNode {
  id: number;
  level: string;
  cidr: string;
  parent_id: number | null;
  group_id?: number | null;
  group?: IPAMGroup | null;
  type_id?: number | null;
  type?: IPAMType | null;
  vrf_id?: number | null;
  vrf?: IPAMVRF | null;
  remark?: string;
  children: SubnetNode[];
}

export interface IPAMAuditLog {
  id: number;
  username: string;
  action: string;
  resource_type: string;
  resource_id?: number | null;
  detail: string;
  created_at: string;
}

export interface CreateRootPrefixReq {
  ip_version: 4 | 6;
  cidr: string;
  group_id?: number | null;
  type_id?: number | null;
  vrf_id?: number | null;
  remark?: string;
}

export interface UpdateRootPrefixReq {
  group_id?: number | null;
  type_id?: number | null;
  vrf_id?: number | null;
  remark?: string;
}
