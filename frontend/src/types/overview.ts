/** Response of GET /api/v1/overview?range=1h|24h|7d — the NOC dashboard aggregate. */
export interface OverviewProbeBucket {
  ts: string;     // RFC3339 bucket start
  runs: number;
  failed: number;
}

/** SNMP 运行状态分面（仅统计 polling_mode != none 的设备）。 */
export interface OverviewDeviceOper {
  monitored: number;
  up: number;
  down: number;
  /** unknown 且原因为探针失联/吊销 — 采集链路故障，需要立即处理 */
  proxy_down: number;
  unknown: number;
}

export interface OverviewResp {
  range: string;
  devices: {
    total: number; active: number; offline: number; maintenance: number; planned: number;
    oper: OverviewDeviceOper;
  };
  agents: { total: number; online: number; offline: number; revoked: number };
  probes: { window_runs: number; window_failed: number; failure_rate_pct: number; delta_pct: number };
  probe_series: OverviewProbeBucket[];
  // Small per-bucket series backing the KPI sparklines. devices/agents are empty
  // (no historical count series is stored) — the frontend hides those sparklines.
  sparklines: { probes: number[]; failure: number[]; devices: number[]; agents: number[] };
  region_health: { region: string; online: number; total: number; uptime_pct: number }[];
  recent_alerts: { severity: string; title: string; detail: string; at: string }[];
  alerts: { open_total: number; critical: number; warning: number };
}
