/** Response of GET /api/v1/overview?range=1h|24h|7d — the NOC dashboard aggregate. */
export interface OverviewProbeBucket {
  ts: string;     // RFC3339 bucket start
  runs: number;
  failed: number;
}

export interface OverviewResp {
  range: string;
  devices: { total: number; active: number; offline: number; maintenance: number; planned: number };
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
