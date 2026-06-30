/**
 * Dashboard — post-login home (NOC Operations Overview). Direction A "Clarity".
 *
 * Data strategy (frontend-only re-skin): compose from EXISTING APIs with graceful
 * degradation rather than requiring a new backend aggregate:
 *   • KPIs            ← GET /agents/summary  (+ device list status facets)
 *   • Device status   ← GET /devices?status=… page_size:1  (per-status totals)
 *   • Top mesh links  ← GET /probe-results/meshping-matrix  (slowest successful cells)
 *   • Active alerts   ← failed mesh cells + offline agents (derived)
 *   • Group health    ← GET /agent-groups + GET /agents     (online ratio per group)
 *   • Probe volume    ← SAMPLE series (no hourly endpoint yet — see suggestions /overview)
 *
 * Out-of-order responses are dropped via the same reqSeq guard the list pages use,
 * and the whole view polls every 30s.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Segmented, Skeleton, theme } from 'antd';
import { Column, Pie } from '@ant-design/charts';
import {
  DesktopOutlined, CloudServerOutlined, ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons';
import PageHeader from '../components/PageHeader';
import MetricCard from '../components/MetricCard';
import StatusTag from '../components/StatusTag';
import { FONT_MONO, palette } from '../theme/theme';
import { useAppContext } from '../contexts/AppContext';
import { useT } from '../i18n';
import {
  getAgentSummary, getMeshPingMatrix, getAgentGroups, getAgents,
} from '../api/agent';
import { getDevices } from '../api/device';
import { getOverview } from '../api/overview';
import type { AgentSummary } from '../types/agent';
import type { OverviewResp } from '../types/overview';

// ── Derived shapes ─────────────────────────────────────────────────────────────
interface DeviceCounts { total: number; active: number; offline: number; maintenance: number; planned: number }
interface MeshLink { from: string; to: string; ms: number }
interface Alert { sev: 'critical' | 'warning' | 'info'; title: string; meta: string }
interface GroupHealth { name: string; online: number; total: number; pct: number }

// Sample 24-bar series for the probe-volume chart. There is no hourly aggregate
// endpoint yet; this is clearly labelled as a sample until /overview lands.
const SAMPLE_PROBE = Array.from({ length: 24 }, (_, h) => ({
  hour: `${String(h).padStart(2, '0')}:00`,
  runs: 2400 + Math.round(Math.sin(h / 3) * 900 + h * 30),
  fails: h % 5 === 0 ? 60 : h % 3 === 0 ? 28 : 9,
}));

// Short x-axis label for a probe-series bucket, by selected range.
function bucketLabel(ts: string, range: string | number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  // Labels must be unique per bucket — g2 merges columns sharing an x category.
  if (range === '7D') return `${d.getMonth() + 1}/${d.getDate()} ${hh}h`; // 6h buckets, 4/day
  if (range === '1H') return `${hh}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${hh}:00`;
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

const Dashboard: React.FC = () => {
  const { token } = theme.useToken();
  const { resolvedTheme } = useAppContext();
  const t = useT();
  // Charts render to canvas (G2) → they need real hex, not the CSS-var refs that
  // theme.useToken() returns under cssVar:true. DOM styles still use `token.*`.
  const p = palette[resolvedTheme];

  const [range, setRange] = useState<string | number>('24H');
  const [summary, setSummary] = useState<AgentSummary | null>(null);
  const [devices, setDevices] = useState<DeviceCounts | null>(null);
  const [topMesh, setTopMesh] = useState<MeshLink[]>([]);
  const [meshAlerts, setMeshAlerts] = useState<Alert[]>([]);
  const [groupHealth, setGroupHealth] = useState<GroupHealth[]>([]);
  const [overview, setOverview] = useState<OverviewResp | null>(null);

  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;

    // ── Overview aggregate (real hourly probe series + KPI sparklines) ──
    getOverview(String(range).toLowerCase()).then(r => { if (seq === reqSeq.current) setOverview(r.data); }).catch(() => {});

    // ── Agents summary (KPIs) ──
    getAgentSummary().then(r => { if (seq === reqSeq.current) setSummary(r.data); }).catch(() => {});

    // ── Device counts (total + per-status facets) ──
    Promise.all([
      getDevices({ page: 1, page_size: 1 }),
      getDevices({ page: 1, page_size: 1, status: 'active' }),
      getDevices({ page: 1, page_size: 1, status: 'offline' }),
      getDevices({ page: 1, page_size: 1, status: 'maintenance' }),
      getDevices({ page: 1, page_size: 1, status: 'planned' }),
    ]).then(([all, act, off, mnt, pln]) => {
      if (seq !== reqSeq.current) return;
      setDevices({
        total: all.data.total, active: act.data.total, offline: off.data.total,
        maintenance: mnt.data.total, planned: pln.data.total,
      });
    }).catch(() => {});

    // ── Mesh matrix → top latency + failed-cell alerts ──
    getMeshPingMatrix({}).then(r => {
      if (seq !== reqSeq.current) return;
      const nameOf = new Map(r.data.agents.map(a => [a.agent_id, a.hostname || a.agent_id]));
      const links: MeshLink[] = [];
      const failed: Alert[] = [];
      for (const fromId of Object.keys(r.data.matrix)) {
        const row = r.data.matrix[fromId] ?? {};
        for (const toId of Object.keys(row)) {
          if (fromId === toId) continue;
          const cell = row[toId];
          if (!cell) continue;
          const from = nameOf.get(fromId) ?? fromId;
          const to = nameOf.get(toId) ?? toId;
          const protos = [cell.v4, cell.v6].filter(Boolean) as NonNullable<typeof cell.v4>[];
          const okLat = protos.filter(p => p.success && p.latency_ms != null).map(p => p.latency_ms as number);
          if (okLat.length) links.push({ from, to, ms: Math.max(...okLat) });
          const failProto = protos.find(p => !p.success);
          if (failProto) failed.push({ sev: 'critical', title: `${from} → ${to} unreachable`, meta: `mesh ping · ${relTime(failProto.reported_at)}` });
        }
      }
      links.sort((a, b) => b.ms - a.ms);
      setTopMesh(links.slice(0, 4));

      const slow: Alert[] = links.filter(l => l.ms > 180).slice(0, 3)
        .map(l => ({ sev: 'info' as const, title: `High mesh latency ${l.from} → ${l.to}`, meta: `${l.ms.toFixed(0)} ms` }));
      // Recomputed fresh on every poll → no stale alerts accumulate. The offline-agents
      // alert is folded in at render time from the (separately fetched) summary.
      setMeshAlerts([...failed.slice(0, 4), ...slow]);
    }).catch(() => {});

    // ── Group health (online ratio per agent group) ──
    Promise.all([getAgentGroups(), getAgents({ page: 1, page_size: 500 })]).then(([gr, ar]) => {
      if (seq !== reqSeq.current) return;
      const byGroup = new Map<string, { online: number; total: number }>();
      for (const a of ar.data.items) {
        const key = a.group?.name ?? 'Ungrouped';
        const e = byGroup.get(key) ?? { online: 0, total: 0 };
        e.total++;
        if (a.status === 'online' && !a.revoked) e.online++;
        byGroup.set(key, e);
      }
      // ensure empty groups still surface
      for (const g of gr.data) if (!byGroup.has(g.name)) byGroup.set(g.name, { online: 0, total: 0 });
      const gh: GroupHealth[] = [...byGroup.entries()]
        .map(([name, v]) => ({ name, online: v.online, total: v.total, pct: v.total ? (v.online / v.total) * 100 : 0 }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 6);
      setGroupHealth(gh);
    }).catch(() => {});
  }, [range]);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // ── Derived display values ──
  const dev = devices;
  const activePct = dev && dev.total ? (dev.active / dev.total) * 100 : 0;

  // Active alerts = mesh-derived (failed cells + high latency) + an offline-agents
  // summary alert, recomputed each render from fresh state, severity-sorted, capped.
  const alerts: Alert[] = (() => {
    const offline: Alert[] = summary && summary.offline_agents > 0
      ? [{ sev: 'warning', title: `${summary.offline_agents} agent${summary.offline_agents > 1 ? 's' : ''} offline`, meta: `${summary.online_agents}/${summary.total_agents} online` }]
      : [];
    const order = { critical: 0, warning: 1, info: 2 } as const;
    return [...meshAlerts, ...offline].sort((a, b) => order[a.sev] - order[b.sev]).slice(0, 6);
  })();

  const statusData = dev ? [
    { type: 'Active', value: dev.active },
    { type: 'Offline', value: dev.offline },
    { type: 'Maintenance', value: dev.maintenance },
    ...(dev.planned ? [{ type: 'Planned', value: dev.planned }] : []),
  ] : [];

  // Probe volume bars: real hourly buckets from /overview, or the labelled sample.
  const seriesBuckets = overview
    ? overview.probe_series.map(b => ({ label: bucketLabel(b.ts, range), runs: b.runs, failed: b.failed }))
    : SAMPLE_PROBE.map(d => ({ label: d.hour, runs: d.runs, failed: d.fails }));
  const sparkProbes = overview?.sparklines.probes ?? [];
  const sparkFailure = overview?.sparklines.failure ?? [];

  const probeConfig = {
    data: seriesBuckets.flatMap(d => [
      { label: d.label, kind: 'Runs', v: d.runs }, { label: d.label, kind: 'Failures', v: d.failed },
    ]),
    xField: 'label', yField: 'v', colorField: 'kind', stack: true, height: 180,
    scale: { color: { range: [p.accent, p.danger] } },
    legend: { color: { position: 'top' as const } },
  };

  const donutConfig = {
    data: statusData, angleField: 'value', colorField: 'type', innerRadius: 0.64, height: 150,
    scale: { color: { range: [p.success, p.danger, p.warning, p.accent] } },
    legend: false as const, label: false as const,
    annotations: [{ type: 'text', style: { text: `${activePct.toFixed(1)}%`, x: '50%', y: '46%', textAlign: 'center', fontSize: 19, fontWeight: 700 } }],
  };

  const sevColor = (s: string) => (s === 'critical' ? token.colorError : s === 'warning' ? token.colorWarning : token.colorPrimary);

  return (
    <div>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        actions={<Segmented value={range} onChange={setRange} options={['1H', '24H', '7D']} />}
      />

      {/* KPI row */}
      <Row gutter={[20, 20]} style={{ marginBottom: 20 }}>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<DesktopOutlined />} iconBg={token.colorPrimaryBg} iconColor={token.colorPrimary}
            label={t('kpi.devices')}
            value={dev ? dev.total.toLocaleString() : '—'}
            sub={dev ? `${dev.active.toLocaleString()} active · ${dev.offline} offline` : ' '}
            series={[]} lineColor={p.accent} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<CloudServerOutlined />} iconBg={token.colorSuccessBg} iconColor={token.colorSuccess}
            label={t('kpi.agentsOnline')}
            value={summary ? <>{summary.online_agents}<span style={{ fontSize: 17, color: token.colorTextTertiary }}>/{summary.total_agents}</span></> : '—'}
            sub={summary ? `${summary.offline_agents} offline · ${summary.revoked_agents} revoked` : ' '}
            series={[]} lineColor={p.success} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<ThunderboltOutlined />} iconBg="rgba(13,148,136,.12)" iconColor="#0d9488"
            label={t('kpi.probesPerHour')}
            value={summary ? summary.recent_probes_1h.toLocaleString() : '—'}
            sub={summary ? `${summary.recent_failed_1h.toLocaleString()} failed` : ' '}
            series={sparkProbes} lineColor="#0d9488" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<WarningOutlined />} iconBg={token.colorWarningBg} iconColor={token.colorWarning}
            label={t('kpi.failureRate')}
            value={summary ? `${summary.recent_failure_rate_pct.toFixed(2)}%` : '—'}
            sub={summary ? `${summary.recent_failed_1h.toLocaleString()} failed / 1h` : ' '}
            subColor={summary && summary.recent_failure_rate_pct > 10 ? token.colorError : undefined}
            series={sparkFailure} lineColor={p.warning} />
        </Col>
      </Row>

      <Row gutter={[20, 20]} align="top">
        {/* left */}
        <Col xs={24} lg={15}>
          <Card
            title={t('dashboard.probeVolume')}
            extra={<span style={{ fontSize: 12, color: token.colorTextTertiary }}>{overview ? `Last ${String(range)} · UTC` : t('dashboard.sampleNote')}</span>}
            style={{ marginBottom: 20 }}
          >
            {/* charts config cast to any — @ant-design/charts v2 prop types may differ; tune at runtime */}
            <Column {...(probeConfig as any)} />
          </Card>
          <Row gutter={[20, 20]}>
            <Col xs={24} md={12}>
              <Card title={t('dashboard.topLatency')} styles={{ body: { paddingTop: 16 } }}>
                {topMesh.length === 0
                  ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common.noData')} />
                  : topMesh.map(l => {
                    const tone = l.ms >= 180 ? token.colorError : l.ms >= 120 ? token.colorWarning : token.colorSuccess;
                    return (
                      <div key={`${l.from}-${l.to}`} style={{ marginBottom: 13 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                          <span style={{ fontFamily: FONT_MONO, fontSize: 12.5 }}>{l.from} → {l.to}</span>
                          <span style={{ fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 700, color: tone }}>{l.ms.toFixed(0)} ms</span>
                        </div>
                        <div style={{ height: 6, borderRadius: 4, background: token.colorFillTertiary }}>
                          <div style={{ height: '100%', width: `${Math.min(100, l.ms / 250 * 100)}%`, borderRadius: 4, background: tone }} />
                        </div>
                      </div>
                    );
                  })}
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card title={t('dashboard.deviceStatus')}>
                {statusData.length ? <Pie {...(donutConfig as any)} /> : <Skeleton active paragraph={{ rows: 3 }} />}
              </Card>
            </Col>
          </Row>
        </Col>

        {/* right */}
        <Col xs={24} lg={9}>
          <Card title={t('dashboard.activeAlerts')} styles={{ body: { padding: 0 } }} style={{ marginBottom: 20 }}>
            {alerts.length === 0 ? (
              <div style={{ padding: 22 }}><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('dashboard.noAlerts')} /></div>
            ) : alerts.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 22px', borderTop: i ? `1px solid ${token.colorBorderSecondary}` : 'none' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: sevColor(a.sev), marginTop: 5, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.title}</div>
                  <div style={{ fontSize: 11.5, color: token.colorTextTertiary, fontFamily: FONT_MONO }}>{a.meta}</div>
                </div>
                <StatusTag status={a.sev} label={a.sev.toUpperCase()} />
              </div>
            ))}
          </Card>
          <Card title={t('dashboard.regionHealth')}>
            {groupHealth.length === 0 ? <Skeleton active paragraph={{ rows: 3 }} /> : groupHealth.map(r => (
              <div key={r.name} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.name}</span>
                  <span style={{ fontSize: 12, color: token.colorTextSecondary, fontFamily: FONT_MONO }}>{r.online}/{r.total} online</span>
                </div>
                <div style={{ height: 6, borderRadius: 4, background: token.colorFillTertiary }}>
                  <div style={{ height: '100%', width: `${r.pct}%`, borderRadius: 4, background: r.pct >= 95 ? token.colorSuccess : r.pct >= 80 ? token.colorWarning : token.colorError }} />
                </div>
              </div>
            ))}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
