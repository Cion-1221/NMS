//go:build !linux

package core

// FreeDiskBytes is unimplemented on non-Linux build targets — this server is
// deployed on Linux; dev builds on other OSes just skip the disk-space guard
// (ok=false) rather than failing to compile.
func FreeDiskBytes(path string) (free uint64, ok bool) {
	return 0, false
}
