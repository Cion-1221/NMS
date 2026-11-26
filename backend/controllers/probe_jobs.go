package controllers

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ── probe_results 维护任务（异步执行 + 进度查询）─────────────────────────────
//
// 清理历史数据 / 批量删除都是对千万级热表的分片删除，同步等待会先后撞上前端
// 10s 超时与反向代理 60s 超时（后端其实仍在删，前端却报"请求失败"）。改为：
// 请求立即返回 202 {job_id}，删除在后台 goroutine 执行，前端每秒轮询
// GET /probe-results/jobs/:id 展示进度条。
//
// 约束：
//   - 全局同一时刻只允许一个维护任务：串行化对热表的删除，避免自相竞争；
//     再次发起返回 409 probe.job_running 并附带正在运行的 job_id，前端直接挂上。
//   - 任务状态只保存在内存（单实例部署），进程重启即丢；已完成任务保留
//     probeJobRetain 供前端最后一次轮询取到终态，之后惰性清理。

type probeJobStatus string

const (
	probeJobCounting probeJobStatus = "counting" // 正在统计待删行数（仅清理任务）
	probeJobRunning  probeJobStatus = "running"
	probeJobDone     probeJobStatus = "done"
	probeJobFailed   probeJobStatus = "failed"
)

// probeJob 是对外暴露的任务快照（JSON 字段即前端 types/agent.ts 的 ProbeJob）。
// 进度口径：purge 以行数计（TotalRows 为启动时统计的待删行数）；bulk_delete 以
// 组合数计（PairsDone / PairsTotal），DeletedRows 仅作展示。
type probeJob struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind"` // purge | bulk_delete
	Status      probeJobStatus `json:"status"`
	TotalRows   int64          `json:"total_rows"`
	DeletedRows int64          `json:"deleted_rows"`
	PairsTotal  int            `json:"pairs_total"`
	PairsDone   int            `json:"pairs_done"`
	Error       string         `json:"error,omitempty"`
	CreatedBy   string         `json:"created_by"`
	StartedAt   time.Time      `json:"started_at"`
	FinishedAt  *time.Time     `json:"finished_at,omitempty"`
}

// probeJobRegistry：mu 同时保护 map 与每个 job 的字段；对外只交出副本。
type probeJobRegistry struct {
	mu      sync.Mutex
	wg      sync.WaitGroup
	jobs    map[string]*probeJob
	current string // 正在运行的任务 ID，空 = 空闲
	seq     uint64
}

var probeJobs = &probeJobRegistry{jobs: map[string]*probeJob{}}

const probeJobRetain = 10 * time.Minute

// start 注册并启动一个任务。已有任务在跑时返回 (该任务副本, false)，调用方据此
// 回 409。setup 在锁内对新任务做初始化（如 PairsTotal）；run 在独立 goroutine
// 中执行，通过 update 回调在锁内改进度，返回 error 即置为 failed。run 内 panic
// 也会被兜住记为 failed，保证 current 一定会被释放。
func (r *probeJobRegistry) start(
	kind, user string,
	setup func(j *probeJob),
	run func(update func(func(j *probeJob))) error,
) (probeJob, bool) {
	r.mu.Lock()
	if r.current != "" {
		if cur, ok := r.jobs[r.current]; ok {
			snap := *cur
			r.mu.Unlock()
			return snap, false
		}
		r.current = ""
	}
	r.gcLocked()
	r.seq++
	j := &probeJob{
		ID:        fmt.Sprintf("%d-%d", time.Now().Unix(), r.seq),
		Kind:      kind,
		Status:    probeJobRunning,
		CreatedBy: user,
		StartedAt: time.Now(),
	}
	if setup != nil {
		setup(j)
	}
	r.jobs[j.ID] = j
	r.current = j.ID
	snap := *j
	r.mu.Unlock()

	update := func(fn func(j *probeJob)) {
		r.mu.Lock()
		fn(j)
		r.mu.Unlock()
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		var err error
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					err = fmt.Errorf("panic: %v", rec)
				}
			}()
			err = run(update)
		}()
		r.finish(j, err)
	}()
	return snap, true
}

// WaitProbeJobs 等待正在运行的异步探测清理/批量删除任务收尾（供停机阶段调用）。
func WaitProbeJobs() {
	probeJobs.wg.Wait()
}

func (r *probeJobRegistry) finish(j *probeJob, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	j.FinishedAt = &now
	if err != nil {
		j.Status = probeJobFailed
		j.Error = err.Error()
	} else {
		j.Status = probeJobDone
	}
	if r.current == j.ID {
		r.current = ""
	}
}

// get 返回任务副本；不存在（或已被清理）返回 false。
func (r *probeJobRegistry) get(id string) (probeJob, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	j, ok := r.jobs[id]
	if !ok {
		return probeJob{}, false
	}
	return *j, true
}

// currentJob 返回正在运行的任务副本；空闲返回 false。
func (r *probeJobRegistry) currentJob() (probeJob, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.current == "" {
		return probeJob{}, false
	}
	j, ok := r.jobs[r.current]
	if !ok {
		return probeJob{}, false
	}
	return *j, true
}

// gcLocked 清理完成超过 probeJobRetain 的任务（调用方持锁）。
func (r *probeJobRegistry) gcLocked() {
	for id, j := range r.jobs {
		if j.FinishedAt != nil && time.Since(*j.FinishedAt) > probeJobRetain {
			delete(r.jobs, id)
		}
	}
}

// GetProbeJob GET /api/v1/probe-results/jobs/:id —— 维护任务进度（管理员）。
// :id 为 "current" 时返回正在运行的任务（{"job": null} 表示空闲），供页面刷新后
// 重新挂上进度框；普通 id 直接返回任务快照，已过期 / 不存在返回 404。
func GetProbeJob(c *gin.Context) {
	id := c.Param("id")
	if id == "current" {
		if j, ok := probeJobs.currentJob(); ok {
			c.JSON(http.StatusOK, gin.H{"job": j})
		} else {
			c.JSON(http.StatusOK, gin.H{"job": nil})
		}
		return
	}
	j, ok := probeJobs.get(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "任务不存在或已过期", "code": "not_found"})
		return
	}
	c.JSON(http.StatusOK, j)
}
