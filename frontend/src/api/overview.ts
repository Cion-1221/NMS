import client from './client';
import type { OverviewResp } from '../types/overview';

/** NOC dashboard aggregate. range = '1h' | '24h' | '7d'. */
export const getOverview = (range: string) =>
  client.get<OverviewResp>('/overview', { params: { range } });
