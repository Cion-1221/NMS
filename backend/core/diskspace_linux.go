//go:build linux

package core

import "syscall"

// FreeDiskBytes reports the free bytes available to unprivileged users on the
// filesystem containing path. ok=false means the check could not be performed
// (statfs failed, e.g. path doesn't exist) — callers should treat that as
// "skip the check", never as "disk is full".
func FreeDiskBytes(path string) (free uint64, ok bool) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, false
	}
	return stat.Bavail * uint64(stat.Bsize), true
}
