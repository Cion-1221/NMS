package asndb

import (
	"bufio"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/gaissmai/bart"
)

// ASNInfo is returned to API callers.
type ASNInfo struct {
	ASN  uint32 `json:"asn"`
	Name string `json:"name"`
}

// DB holds an IP routing table (prefix→ASN) and an ASN name map.
// Zero value is valid; call Load to populate.
// Reads are lock-free via atomic.Pointer; Load swaps the tables atomically.
type DB struct {
	table  atomic.Pointer[bart.Table[uint32]] // prefix → ASN number
	names  atomic.Pointer[map[uint32]string]  // ASN number → org name
	loaded atomic.Bool
	dlMu   sync.Mutex // prevents concurrent DownloadAndUpdate calls
}

// Load reads the three data files and atomically replaces the in-memory tables.
// Safe to call while the server is handling Lookup requests (hot reload).
func (db *DB) Load(v4File, v6File, namesFile string) error {
	table := new(bart.Table[uint32])
	for _, f := range []string{v4File, v6File} {
		n, err := loadPrefixes(f, table)
		if err != nil {
			return fmt.Errorf("load %s: %w", f, err)
		}
		slog.Info("asndb: 前缀文件已加载", "file", f, "entries", n)
	}
	names, err := loadNames(namesFile)
	if err != nil {
		return fmt.Errorf("load %s: %w", namesFile, err)
	}
	slog.Info("asndb: 名称文件已加载", "file", namesFile, "entries", len(names))

	// Atomic swap: in-flight Lookup calls see either old or new table, never partial state.
	db.table.Store(table)
	db.names.Store(&names)
	db.loaded.Store(true)
	return nil
}

// Lookup returns ASN info for ipStr.
// Returns nil for private/loopback/link-local/unspecified addresses,
// unknown prefixes, or when the DB has not been loaded yet.
func (db *DB) Lookup(ipStr string) *ASNInfo {
	addr, err := netip.ParseAddr(ipStr)
	if err != nil || !addr.IsValid() {
		return nil
	}
	// Unmap ::ffff:x.x.x.x → x.x.x.x so IPv4 prefixes match correctly.
	addr = addr.Unmap()
	if addr.IsLoopback() || addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() ||
		addr.IsUnspecified() {
		return nil
	}
	if !db.loaded.Load() {
		return nil
	}
	asn, ok := db.table.Load().Lookup(addr)
	if !ok || asn == 0 {
		return nil
	}
	n := db.names.Load()
	return &ASNInfo{ASN: asn, Name: (*n)[asn]}
}

// loadPrefixes parses a CAIDA pfx2as file (tab-separated: ip  len  ASN[,ASN...])
// into the bart routing table. Both IPv4 and IPv6 entries go into the same table.
func loadPrefixes(path string, table *bart.Table[uint32]) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	count := 0
	scanner := bufio.NewScanner(f)
	// CAIDA files have short lines, but allocate a slightly larger buffer to be safe.
	scanner.Buffer(make([]byte, 256*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		prefixLen, err := strconv.Atoi(parts[1])
		if err != nil {
			continue
		}
		// MOAS (multiple-origin AS): take first ASN, strip braces/underscores.
		asnStr := strings.FieldsFunc(parts[2], func(r rune) bool {
			return r == ',' || r == '_'
		})[0]
		asnStr = strings.Trim(asnStr, "{}")
		asn, err := strconv.ParseUint(asnStr, 10, 32)
		if err != nil || asn == 0 {
			continue
		}
		addr, err := netip.ParseAddr(parts[0])
		if err != nil {
			continue
		}
		pfx := netip.PrefixFrom(addr, prefixLen).Masked() // zero out host bits
		if !pfx.IsValid() {
			continue
		}
		table.Insert(pfx, uint32(asn))
		count++
	}
	return count, scanner.Err()
}

// loadNames parses RIPE asn.txt format: "ASN\tHANDLE - Full Name, CC"
// Returns a map of ASN number → cleaned organization name.
func loadNames(path string) (map[uint32]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	names := make(map[uint32]string, 130000)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		// Split on first whitespace to separate ASN from the rest.
		idx := strings.IndexAny(line, " \t")
		if idx == -1 {
			continue
		}
		asn, err := strconv.ParseUint(strings.TrimSpace(line[:idx]), 10, 32)
		if err != nil {
			continue
		}
		name := strings.TrimSpace(line[idx:])
		// "HANDLE - Full Name, CC" → "Full Name"
		if i := strings.Index(name, " - "); i != -1 {
			name = strings.TrimSpace(name[i+3:])
		}
		// Strip trailing 2-char country code: ", US" / ", CN" / ", DE"
		if i := strings.LastIndex(name, ", "); i != -1 && len(name)-i-2 == 2 {
			name = name[:i]
		}
		names[uint32(asn)] = name
	}
	return names, scanner.Err()
}
