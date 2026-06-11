package main

import (
	"compress/gzip"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestParseLogLevel(t *testing.T) {
	cases := []struct {
		in     string
		want   slog.Level
		wantOK bool
	}{
		{"debug", slog.LevelDebug, true},
		{"info", slog.LevelInfo, true},
		{"INFO", slog.LevelInfo, true},
		{"", slog.LevelInfo, true},
		{"warn", slog.LevelWarn, true},
		{"warning", slog.LevelWarn, true},
		{"error", slog.LevelError, true},
		{" Error ", slog.LevelError, true},
		{"verbose", slog.LevelInfo, false},
	}
	for _, c := range cases {
		got, ok := parseLogLevel(c.in)
		if got != c.want || ok != c.wantOK {
			t.Errorf("parseLogLevel(%q) = (%v, %v), want (%v, %v)", c.in, got, ok, c.want, c.wantOK)
		}
	}
}

func TestDailyRotateWriterWritesToDatedFile(t *testing.T) {
	dir := t.TempDir()
	w, err := newDailyRotateWriter(LogConfig{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	if _, err := w.Write([]byte("hello\n")); err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(dir, fmt.Sprintf("%s-%s.log", logBaseName, time.Now().Format(dateLayout)))
	b, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("当日日志文件未创建: %v", err)
	}
	if string(b) != "hello\n" {
		t.Errorf("文件内容 = %q, want %q", b, "hello\n")
	}
}

func TestGzipAndRemove(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.log")
	const content = "line1\nline2\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	if err := gzipAndRemove(path); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Error("原文件应已删除")
	}
	f, err := os.Open(path + ".gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	got, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != content {
		t.Errorf("解压内容 = %q, want %q", got, content)
	}
}

func TestMaintainCompressesOldLogs(t *testing.T) {
	dir := t.TempDir()
	w, err := newDailyRotateWriter(LogConfig{Dir: dir, Compress: true})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	yesterday := time.Now().AddDate(0, 0, -1).Format(dateLayout)
	oldPath := filepath.Join(dir, fmt.Sprintf("%s-%s.log", logBaseName, yesterday))
	if err := os.WriteFile(oldPath, []byte("old\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// 非本程序命名规则的文件必须原样保留
	otherPath := filepath.Join(dir, "nms.log")
	if err := os.WriteFile(otherPath, []byte("legacy\n"), 0644); err != nil {
		t.Fatal(err)
	}

	w.maintain()

	if _, err := os.Stat(oldPath + ".gz"); err != nil {
		t.Errorf("历史日志应已压缩为 .gz: %v", err)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Error("压缩后的原始 .log 应已删除")
	}
	if _, err := os.Stat(otherPath); err != nil {
		t.Errorf("非本程序生成的文件不应被触碰: %v", err)
	}
}

func TestMaintainAppliesRetention(t *testing.T) {
	dir := t.TempDir()
	w, err := newDailyRotateWriter(LogConfig{Dir: dir, MaxBackups: 2, MaxAgeDays: 5})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	// 4 个历史文件：1/2 天前应保留（数量限额内且未过期），3 天前超出 maxBackups，10 天前超龄
	mk := func(daysAgo int) string {
		date := time.Now().AddDate(0, 0, -daysAgo).Format(dateLayout)
		p := filepath.Join(dir, fmt.Sprintf("%s-%s.log.gz", logBaseName, date))
		if err := os.WriteFile(p, []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	keep1, keep2 := mk(1), mk(2)
	overflow, expired := mk(3), mk(10)

	w.maintain()

	for _, p := range []string{keep1, keep2} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("限额内文件不应被删除: %s", filepath.Base(p))
		}
	}
	for _, p := range []string{overflow, expired} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("超出保留策略的文件应被删除: %s", filepath.Base(p))
		}
	}
}

func TestMaintainNeverTouchesActiveFile(t *testing.T) {
	dir := t.TempDir()
	w, err := newDailyRotateWriter(LogConfig{Dir: dir, Compress: true, MaxBackups: 1, MaxAgeDays: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	if _, err := w.Write([]byte("active\n")); err != nil {
		t.Fatal(err)
	}
	w.maintain()

	active := filepath.Join(dir, fmt.Sprintf("%s-%s.log", logBaseName, time.Now().Format(dateLayout)))
	b, err := os.ReadFile(active)
	if err != nil {
		t.Fatalf("当日活跃文件不应被压缩或删除: %v", err)
	}
	if string(b) != "active\n" {
		t.Errorf("活跃文件内容被破坏: %q", b)
	}
}
