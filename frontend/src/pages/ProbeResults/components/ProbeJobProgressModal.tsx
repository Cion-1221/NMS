/**
 * 清理历史数据 / 批量删除的后台任务进度框。
 *
 * 后端把删除放进 goroutine 执行并立即返回 job_id（见 backend/controllers/probe_jobs.go），
 * 这里每秒轮询 GET /probe-results/jobs/:id 展示进度条；到达终态（done / failed）
 * 时回调一次 onFinished，调用方据此刷新列表并给提示。
 *
 * "后台运行" 只是关闭窗口、停止轮询，任务本身不受影响；ProbeResults 页面挂载时
 * 会用 jobs/current 把仍在运行的任务重新挂上来。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Button, Modal, Progress, Typography } from 'antd';
import { getProbeJob } from '../../../api/agent';
import type { ProbeJob } from '../../../types/agent';
import { useT } from '../../../i18n';

const POLL_MS = 1000;

interface Props {
  /** 为 null 时不显示 */
  jobId: string | null;
  /** 首帧数据到达前用于标题；之后以轮询到的 job.kind 为准 */
  kind?: ProbeJob['kind'];
  onFinished: (job: ProbeJob) => void;
  onClose: () => void;
}

const fmtElapsed = (job: ProbeJob): string => {
  const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(job.started_at).getTime()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
};

const ProbeJobProgressModal: React.FC<Props> = ({ jobId, kind, onFinished, onClose }) => {
  const t = useT();
  const [job, setJob]   = useState<ProbeJob | null>(null);
  const [lost, setLost] = useState(false);
  // onFinished 只在终态触发一次；放 ref 里，避免调用方每次渲染传新函数导致轮询重启
  const onFinishedRef = useRef(onFinished);
  useEffect(() => { onFinishedRef.current = onFinished; });

  useEffect(() => {
    setJob(null);
    setLost(false);
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await getProbeJob(jobId);
        if (cancelled) return;
        setJob(r.data);
        if (r.data.status === 'done' || r.data.status === 'failed') {
          onFinishedRef.current(r.data);
          return; // 终态：停止轮询
        }
      } catch (err: unknown) {
        if (cancelled) return;
        // 404 = 任务已过期或后端重启过，再轮询没有意义
        if ((err as { response?: { status?: number } })?.response?.status === 404) {
          setLost(true);
          return;
        }
        // 其他错误（网络抖动）下一轮继续
      }
      timer = setTimeout(() => { void tick(); }, POLL_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  const finished = lost || job?.status === 'done' || job?.status === 'failed';
  const isPurge  = (job?.kind ?? kind) === 'purge';

  // ── 进度条 ──
  let percent = 0;
  let status: 'active' | 'success' | 'exception' = 'active';
  if (lost || job?.status === 'failed') {
    status = 'exception';
  }
  if (job?.status === 'done') {
    percent = 100;
    status = 'success';
  } else if (job && job.status === 'running') {
    // 未完成前封顶 99%，避免最后一片还在删时就显示 100%
    percent = job.kind === 'purge'
      ? (job.total_rows > 0 ? Math.min(99, Math.floor((job.deleted_rows / job.total_rows) * 100)) : 0)
      : (job.pairs_total > 0 ? Math.min(99, Math.floor((job.pairs_done / job.pairs_total) * 100)) : 0);
  }

  // ── 文案 ──
  let detail: string;
  if (lost)                                 detail = t('proberesults.job.lost');
  else if (!job || job.status === 'counting') detail = t('proberesults.job.counting');
  else if (job.status === 'failed')         detail = t('proberesults.job.failed', { error: job.error ?? '' });
  else if (job.status === 'done')           detail = t('proberesults.job.done', { n: job.deleted_rows.toLocaleString() });
  else if (job.kind === 'purge')            detail = t('proberesults.job.purgeRows', { done: job.deleted_rows.toLocaleString(), total: job.total_rows.toLocaleString() });
  else                                      detail = t('proberesults.job.pairs', { done: job.pairs_done, total: job.pairs_total, rows: job.deleted_rows.toLocaleString() });

  return (
    <Modal
      title={isPurge ? t('proberesults.purgeTitle') : t('proberesults.bulkDelete')}
      open={!!jobId}
      onCancel={onClose}
      maskClosable={false}
      destroyOnClose
      footer={
        <Button type={finished ? 'primary' : 'default'} onClick={onClose}>
          {finished ? t('common.close') : t('proberesults.job.background')}
        </Button>
      }
    >
      <Progress percent={percent} status={status} />
      <div style={{ marginTop: 8 }}>{detail}</div>
      {job && (
        <div style={{ marginTop: 4 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('proberesults.job.elapsed')}: {fmtElapsed(job)}
          </Typography.Text>
        </div>
      )}
      {!finished && (
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('proberesults.job.bgHint')}</Typography.Text>
        </div>
      )}
    </Modal>
  );
};

export default ProbeJobProgressModal;
