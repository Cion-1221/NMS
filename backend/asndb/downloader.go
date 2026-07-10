package asndb

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const (
	caida4BaseURL = "https://publicdata.caida.org/datasets/routing/routeviews-prefix2as"
	caida6BaseURL = "https://publicdata.caida.org/datasets/routing/routeviews6-prefix2as"
	ripeNamesURL  = "https://ftp.ripe.net/ripe/asnames/asn.txt"
	maxDaysBack   = 7 // fall back this many days when current day's CAIDA file is unavailable
	httpTimeout   = 15 * time.Minute
)

func caida4URL(t time.Time) string {
	return fmt.Sprintf("%s/%04d/%02d/routeviews-rv2-%04d%02d%02d-1200.pfx2as.gz",
		caida4BaseURL, t.Year(), int(t.Month()), t.Year(), int(t.Month()), t.Day())
}

func caida6URL(t time.Time) string {
	return fmt.Sprintf("%s/%04d/%02d/routeviews-rv6-%04d%02d%02d-1200.pfx2as.gz",
		caida6BaseURL, t.Year(), int(t.Month()), t.Year(), int(t.Month()), t.Day())
}

// DownloadAndUpdate downloads CAIDA + RIPE ASN data files and hot-reloads the DB.
// Only one download may run at a time; concurrent calls return an error immediately.
func (db *DB) DownloadAndUpdate(v4File, v6File, namesFile string) error {
	if !db.dlMu.TryLock() {
		return fmt.Errorf("已有 ASN 数据下载任务正在进行中，本次请求已忽略")
	}
	defer db.dlMu.Unlock()

	slog.Info("asndb: 开始下载更新", "v4_file", v4File, "v6_file", v6File, "names_file", namesFile)

	// Ensure destination directories exist.
	for _, f := range []string{v4File, v6File, namesFile} {
		if err := os.MkdirAll(filepath.Dir(f), 0755); err != nil {
			return fmt.Errorf("创建目录失败 %q: %w", filepath.Dir(f), err)
		}
	}

	if err := downloadWithDateFallback(caida4URL, v4File); err != nil {
		return fmt.Errorf("IPv4 前缀文件下载失败: %w", err)
	}
	if err := downloadWithDateFallback(caida6URL, v6File); err != nil {
		return fmt.Errorf("IPv6 前缀文件下载失败: %w", err)
	}
	if err := downloadPlain(ripeNamesURL, namesFile); err != nil {
		return fmt.Errorf("ASN 名称文件下载失败: %w", err)
	}

	slog.Info("asndb: 所有文件下载完成，开始热重载")
	if err := db.Load(v4File, v6File, namesFile); err != nil {
		return fmt.Errorf("热重载失败: %w", err)
	}
	slog.Info("asndb: 下载更新完成")
	return nil
}

// StartScheduler starts a background goroutine that calls DownloadAndUpdate
// at updateHour (0–23, server local time) each day.
func StartScheduler(db *DB, v4File, v6File, namesFile string, updateHour int) {
	go func() {
		for {
			now := time.Now()
			next := time.Date(now.Year(), now.Month(), now.Day(),
				updateHour, 0, 0, 0, now.Location())
			// If today's scheduled time has already passed, advance to tomorrow.
			if !now.Before(next) {
				next = next.Add(24 * time.Hour)
			}
			slog.Info("asndb: 下次自动更新已调度",
				"next_run", next.Format("2006-01-02 15:04:05 MST"),
				"wait", next.Sub(now).Round(time.Minute).String(),
			)
			<-time.After(next.Sub(now))

			slog.Info("asndb: 开始执行定时自动更新")
			if err := db.DownloadAndUpdate(v4File, v6File, namesFile); err != nil {
				slog.Error("asndb: 定时自动更新失败", "err", err)
			}
		}
	}()
}

// downloadWithDateFallback tries today's date first, then falls back up to
// maxDaysBack days. CAIDA files are published periodically, not necessarily daily.
func downloadWithDateFallback(urlFn func(time.Time) string, destFile string) error {
	base := time.Now().UTC()
	var lastErr error
	for i := 0; i <= maxDaysBack; i++ {
		date := base.AddDate(0, 0, -i)
		url := urlFn(date)
		slog.Info("asndb: 尝试下载", "url", url, "days_back", i)
		if err := downloadGZ(url, destFile); err != nil {
			slog.Warn("asndb: 下载失败，尝试前一天",
				"date", date.Format("20060102"),
				"err", err,
			)
			lastErr = err
			continue
		}
		return nil
	}
	return fmt.Errorf("最近 %d 天内无可用文件: %w", maxDaysBack, lastErr)
}

// downloadGZ fetches a gzip-compressed URL, decompresses it, and writes to destFile.
// Uses a .tmp intermediate file to ensure atomic replacement.
func downloadGZ(url, destFile string) error {
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, url)
	}

	gr, err := gzip.NewReader(resp.Body)
	if err != nil {
		return fmt.Errorf("gzip 打开失败: %w", err)
	}
	defer gr.Close()

	return writeToTemp(gr, destFile)
}

// downloadPlain fetches a plain-text URL and writes it to destFile.
// Uses a .tmp intermediate file to ensure atomic replacement.
func downloadPlain(url, destFile string) error {
	slog.Info("asndb: 下载", "url", url)
	ctx, cancel := context.WithTimeout(context.Background(), httpTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, url)
	}
	return writeToTemp(resp.Body, destFile)
}

// writeToTemp copies r into destFile via a .tmp sidecar, then renames atomically.
// The .tmp file is removed on any error.
func writeToTemp(r io.Reader, destFile string) error {
	tmp := destFile + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(f, r)
	closeErr := f.Close()
	if copyErr != nil {
		os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		os.Remove(tmp)
		return closeErr
	}
	if err := os.Rename(tmp, destFile); err != nil {
		os.Remove(tmp)
		return err
	}
	slog.Info("asndb: 文件写入完成", "file", destFile, "bytes", n)
	return nil
}
