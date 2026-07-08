package controllers

// MIB 翻译引擎：基于 gosmi（纯 Go 的 libsmi 移植，参与 CGO_ENABLED=0 交叉编译）
// 把数字 OID 解析为人类可读名。数据源是 MIB 文件库（device_mibs，文件按
// "<ModuleName>.mib" 落盘——gosmi 解析 IMPORTS 依赖时按模块名在搜索路径找文件）。
//
// gosmi 的 SMI 状态是包级全局的，无法按实例隔离，因此：
//   - Rebuild 走 Exit → Init → 逐模块 LoadModule 的全量重建（上传/删除后调用）；
//   - 引擎内 RWMutex 保证 Translate 读与 Rebuild 写互斥；
//   - 单个模块解析失败只影响自身（Parsed=false + ParseError 回写 DB，前端可见），
//     常见原因是 IMPORTS 的依赖模块尚未上传，补传后下次 Rebuild 自动转好。

import (
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"

	"nms-backend/models"

	"github.com/sleepinggenius2/gosmi"
	"github.com/sleepinggenius2/gosmi/types"
	"gorm.io/gorm"
)

// MIBEngine 见包注释。零值不可用，必须经 NewMIBEngine 构造。
type MIBEngine struct {
	mu    sync.RWMutex
	dir   string
	ready bool // Init 成功（哪怕零模块）即为 true；panic 恢复后为 false
}

func NewMIBEngine(dir string) *MIBEngine {
	return &MIBEngine{dir: dir}
}

// Rebuild 全量重建 SMI 状态并回写各模块的解析结果。幂等，可在启动与每次
// 上传/删除后调用；库为空时引擎照常就绪（翻译查询返回未命中）。
func (e *MIBEngine) Rebuild(db *gorm.DB) {
	e.mu.Lock()
	defer e.mu.Unlock()

	e.ready = false
	// gosmi.Init 失败时 panic（内部断言）；恢复后引擎保持不可用而不是拖垮进程
	defer func() {
		if r := recover(); r != nil {
			slog.Error("MIB 引擎初始化失败", "panic", r)
		}
	}()

	gosmi.Exit()
	gosmi.Init()
	gosmi.SetPath(e.dir)

	var mibs []models.DeviceMIB
	db.Order("id asc").Find(&mibs)
	loaded := 0
	for _, m := range mibs {
		_, err := gosmi.LoadModule(m.ModuleName)
		parsed, msg := err == nil, ""
		if err != nil {
			msg = err.Error()
			if r := []rune(msg); len(r) > 500 {
				msg = string(r[:500])
			}
		} else {
			loaded++
		}
		if m.Parsed != parsed || m.ParseError != msg {
			db.Model(&models.DeviceMIB{}).Where("id = ?", m.ID).
				UpdateColumns(map[string]interface{}{"parsed": parsed, "parse_error": msg})
		}
	}
	e.ready = true
	if len(mibs) > 0 {
		slog.Info("MIB 引擎重建完成", "total", len(mibs), "parsed", loaded)
	}
}

// MIBTranslation 一次 OID 翻译的结果。libsmi 语义是最长前缀匹配：输入 OID 超出
// 命中节点的部分作为 Suffix 保留（如 sysObjectID 值命中厂商产品子树的场景）。
type MIBTranslation struct {
	Found       bool   `json:"found"`
	Name        string `json:"name"`        // 节点名（含后缀，如 enterprises.9.1.685）
	Module      string `json:"module"`      // 命中节点所属模块
	Qualified   string `json:"qualified"`   // Module::Name 形式
	Description string `json:"description"` // 节点的 DESCRIPTION（可能为空）
}

// Translate 把数字 OID（可带前导点）翻译为可读名。未命中/引擎未就绪时
// Found=false，调用方按原样展示数字 OID 即可。
func (e *MIBEngine) Translate(oidStr string) MIBTranslation {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if !e.ready {
		return MIBTranslation{}
	}
	oidStr = strings.TrimPrefix(strings.TrimSpace(oidStr), ".")
	oid, err := types.OidFromString(oidStr)
	if err != nil || len(oid) == 0 {
		return MIBTranslation{}
	}
	node, err := gosmi.GetNodeByOID(oid)
	if err != nil || node.Name == "" {
		return MIBTranslation{}
	}
	// 输入超出命中节点的部分拼为后缀（node.Oid 是命中节点的完整 OID）
	name := node.Name
	if int(node.OidLen) < len(oid) {
		parts := make([]string, 0, len(oid)-int(node.OidLen))
		for _, sub := range oid[node.OidLen:] {
			parts = append(parts, strconv.FormatUint(uint64(sub), 10))
		}
		name = fmt.Sprintf("%s.%s", name, strings.Join(parts, "."))
	}
	module := node.GetModule().Name
	return MIBTranslation{
		Found:       true,
		Name:        name,
		Module:      module,
		Qualified:   fmt.Sprintf("%s::%s", module, name),
		Description: strings.TrimSpace(node.Description),
	}
}
