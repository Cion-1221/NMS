/**
 * LatencySpark — 悬停延迟按钮/数值时展示的近 24 小时 avg 延迟迷你趋势
 * （手绘 SVG polyline，不引入图表库）。放进 Tooltip 后首次展开才挂载、才发
 * 请求；模块级缓存 60 秒，同一序列反复悬停不重复请求。
 * TabMeshPingMatrix / TabGenericResults 共用。
 */
import React, { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { getLatencySeries } from '../api/agent';
import type { LatencySeriesPoint } from '../types/agent';
import { useT } from '../i18n';

const sparkCache = new Map<string, { at: number; pts: LatencySeriesPoint[] }>();

const LatencySpark: React.FC<{ agentId: string; target: string; type: string; reportedAt: string }> = ({
  agentId, target, type, reportedAt,
}) => {
  const t = useT();
  const [pts, setPts] = useState<LatencySeriesPoint[] | null>(null);

  useEffect(() => {
    const key = `${type}|${agentId}|${target}`;
    const hit = sparkCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) { setPts(hit.pts); return; }
    let alive = true;
    getLatencySeries({
      agent_id: agentId, target, type,
      start: new Date(Date.now() - 24 * 3600_000).toISOString(),
      end: new Date().toISOString(),
    }).then((r) => {
      if (!alive) return;
      sparkCache.set(key, { at: Date.now(), pts: r.data.points });
      setPts(r.data.points);
    }).catch(() => { if (alive) setPts([]); });
    return () => { alive = false; };
  }, [agentId, target, type]);

  const ok = (pts ?? []).filter((p) => p.avg_ms != null);
  let body: React.ReactNode;
  if (pts === null) {
    body = <Spin size="small" />;
  } else if (ok.length >= 2) {
    const vals = ok.map((p) => p.avg_ms as number);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const W = 180;
    const H = 32;
    const coords = ok.map((p, i) =>
      `${((i / (ok.length - 1)) * W).toFixed(1)},${(H - 2 - (((p.avg_ms as number) - min) / span) * (H - 4)).toFixed(1)}`,
    ).join(' ');
    body = (
      <>
        <svg width={W} height={H} style={{ display: 'block' }}>
          <polyline points={coords} fill="none" stroke="#69b1ff" strokeWidth={1.5} />
        </svg>
        <div style={{ fontSize: 10, opacity: 0.65 }}>
          24h · min {min.toFixed(1)} / max {max.toFixed(1)} ms
        </div>
      </>
    );
  } else {
    body = <span style={{ fontSize: 11, opacity: 0.65 }}>{t('trend.noData')}</span>;
  }

  return (
    <div style={{ padding: '2px 0' }}>
      <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 4 }}>{new Date(reportedAt).toLocaleString()}</div>
      {body}
    </div>
  );
};

export default LatencySpark;
