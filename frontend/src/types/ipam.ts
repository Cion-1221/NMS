export interface RootPrefix {
  id: number;
  ip_version: number;
  cidr: string;
  group: string;
  type: string;
  CreatedAt: string;
  UpdatedAt: string;
}

export interface SubnetNode {
  id: number;
  level: string;
  cidr: string;
  parent_id: number | null;
  children: SubnetNode[];
}

export interface CreateRootPrefixReq {
  ip_version: number;
  cidr: string;
  group: string;
  type: string;
}

export interface UpdateRootPrefixReq {
  group: string;
  type: string;
}
