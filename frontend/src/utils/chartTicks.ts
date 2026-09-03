/**
 * 趋势图坐标轴的共用刻度工具（LatencyTrendModal / DeviceMetricTrendModal 共用）。
 *
 * G2 5 的 point/band 分类轴不支持 tickCount，线性轴默认按数据范围自动缩放并会
 * 推出小数刻度。这里统一成 Cacti 风格：x 轴按密度抽样、标签水平显示；y 轴从 0
 * 起、整数刻度。只影响坐标轴与网格线，数据数值本身不做任何取整。
 */

/**
 * y 轴整数刻度：从 0 起，步长取 1/2/5×10^n 且不小于 1，最后一个刻度 ≥ max。
 * 自动缩放会把 34.5–34.9 这种几乎恒定的序列拉成满幅抖动，从 0 起才反映真实幅度。
 */
export const integerTicks = (max: number, count: number): number[] => {
  const hi = Math.max(1, max);
  const raw = hi / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  const ticks: number[] = [];
  for (let v = 0; v < hi + step; v += step) ticks.push(v);
  return ticks;
};

/**
 * x 轴标签抽样：等间隔挑选 ≤ maxLabels 个分类值（始终含末尾），其余位置不画标签
 * 与刻度线。分类轴上几百个桶若全部出标签会挤成一团；G2 自带的防重叠在
 * point/band 轴上不生效且已知版本有 bug，故自行抽样。太靠近末尾的常规采样点会
 * 让位给末尾标签，避免最后两个标签水平重叠。
 */
export const pickXLabels = (domain: string[], maxLabels: number): Set<string> => {
  const keep = new Set<string>();
  if (domain.length === 0) return keep;
  const lastIdx = domain.length - 1;
  const step = Math.max(1, Math.ceil(domain.length / maxLabels));
  for (let i = 0; i < domain.length; i += step) {
    if (i !== 0 && lastIdx - i < step / 2) continue;
    keep.add(domain[i]);
  }
  keep.add(domain[lastIdx]);
  return keep;
};
