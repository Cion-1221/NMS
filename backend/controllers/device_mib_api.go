package controllers

// MIB 文件库管理（Devices → MIBs Tab）。
//
// 定位：第一阶段只做"校验入库 + 留存管理"。当前采集的 RFC 1213 system 组是
// 众所周知的固定 OID，不需要 MIB 翻译；这里先把 MIB 资产管好（唯一模块名、
// SHA256、大小限制、admin-only 写），后续自定义 OID 采集里程碑落地时，翻译
// 引擎直接按 ModuleName 加载这些文件。
//
// 校验策略是轻量 SMI 语法探测（正则提取 `<Module> DEFINITIONS ::= BEGIN`），
// 而非完整 SMI 解析器：厂商 MIB 普遍 IMPORTS 其他模块，完整解析要求依赖模块
// 全部在库，会让首个文件永远传不进来——校验过严反而不可用。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"nms-backend/models"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// maxMIBSize 单个 MIB 文件大小上限（2 MiB——常见厂商 MIB 在几十 KB 量级，
// 2 MiB 已经非常宽裕，同时防止把任意大文件塞进 data 目录）。
const maxMIBSize = 2 << 20

// mibModuleRe 提取 SMI 模块头：`<MODULE-NAME> DEFINITIONS ::= BEGIN`。
// 模块名允许字母开头、字母/数字/连字符组成（SMI 规范命名）。
var mibModuleRe = regexp.MustCompile(`(?m)^\s*([A-Za-z][A-Za-z0-9-]*)\s+DEFINITIONS\s*::=\s*BEGIN`)

// builtinMIBsSeededKey：sys_settings 的一次性标记。只在首次启动 seed，之后管理员
// 删除内置模块不会在重启时"复活"（尊重人工删除的意图）。
const builtinMIBsSeededKey = "snmp_builtin_mibs_seeded"

// SeedBuiltinMIBs 首次启动时把编译进二进制的标准 MIB 模块（SNMPv2-SMI/TC/CONF、
// IF-MIB 等，见 backend/mibs_builtin/README.md）灌入 MIB 文件库——厂商 MIB 几乎
// 都 IMPORTS 这些基础模块，预置后上传即可解析。调用方需保证随后执行
// engine.Rebuild(db) 回写解析状态。fsys 为 mibs_builtin 目录的子文件系统。
func SeedBuiltinMIBs(db *gorm.DB, mibDir string, fsys fs.FS) {
	var flag models.SysSetting
	if err := db.Where("setting_key = ?", builtinMIBsSeededKey).First(&flag).Error; err == nil {
		return // 已 seed 过（含管理员随后删除的情况），不重复灌入
	}

	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		slog.Error("读取内置 MIB 目录失败", "err", err)
		return
	}
	seeded, skipped := 0, 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".mib") {
			continue
		}
		content, err := fs.ReadFile(fsys, e.Name())
		if err != nil {
			slog.Error("读取内置 MIB 失败", "file", e.Name(), "err", err)
			continue
		}
		m := mibModuleRe.FindSubmatch(content)
		if m == nil {
			slog.Error("内置 MIB 缺少模块头，跳过", "file", e.Name())
			continue
		}
		moduleName := string(m[1])

		// 用户已上传同名模块（先于首次 seed）→ 尊重用户版本
		var exists int64
		db.Model(&models.DeviceMIB{}).Where("module_name = ?", moduleName).Count(&exists)
		if exists > 0 {
			skipped++
			continue
		}

		finalPath := filepath.Join(mibDir, moduleName+".mib")
		if err := os.WriteFile(finalPath, content, 0o644); err != nil {
			slog.Error("写入内置 MIB 失败", "module", moduleName, "err", err)
			continue
		}
		sum := sha256.Sum256(content)
		mib := models.DeviceMIB{
			ModuleName: moduleName,
			FileName:   moduleName + ".mib",
			FilePath:   finalPath,
			FileSize:   int64(len(content)),
			SHA256:     hex.EncodeToString(sum[:]),
			UploadedBy: "system",
		}
		if err := db.Create(&mib).Error; err != nil {
			slog.Error("内置 MIB 入库失败", "module", moduleName, "err", err)
			_ = os.Remove(finalPath)
			continue
		}
		seeded++
	}
	db.Create(&models.SysSetting{Key: builtinMIBsSeededKey, Value: "1"})
	slog.Info("内置标准 MIB 模块 seed 完成", "seeded", seeded, "skipped_existing", skipped)
}

// UploadDeviceMIB POST /api/v1/devices/mibs —— multipart 上传（字段名 file）。
// 校验：大小 ≤ 2 MiB、纯文本（无 NUL 字节）、能提取到 SMI 模块头、模块名唯一。
// 落盘后触发翻译引擎全量重建，响应携带本模块的解析状态。
func UploadDeviceMIB(db *gorm.DB, mibDir string, engine *MIBEngine) gin.HandlerFunc {
	return func(c *gin.Context) {
		fh, err := c.FormFile("file")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 MIB 文件（字段名 file）", "code": "device.mib_file_missing"})
			return
		}
		if fh.Size > maxMIBSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "MIB 文件过大（上限 2 MiB）", "code": "device.mib_too_large"})
			return
		}
		src, err := fh.Open()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "无法读取上传文件", "code": "server_error"})
			return
		}
		defer src.Close()

		// 2 MiB 上限内直接读入内存（LimitReader 兜底 multipart 头声明与实际不符）
		content, err := io.ReadAll(io.LimitReader(src, maxMIBSize+1))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "读取文件失败", "code": "server_error"})
			return
		}
		if len(content) > maxMIBSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "MIB 文件过大（上限 2 MiB）", "code": "device.mib_too_large"})
			return
		}
		if bytes.IndexByte(content, 0) >= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "文件不是文本格式的 SMI MIB", "code": "device.mib_invalid"})
			return
		}
		m := mibModuleRe.FindSubmatch(content)
		if m == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "无法识别 MIB 模块定义（缺少 `<模块名> DEFINITIONS ::= BEGIN`）", "code": "device.mib_invalid"})
			return
		}
		moduleName := string(m[1])
		if len(moduleName) > 200 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "MIB 模块名过长（上限 200 字符）", "code": "device.mib_invalid"})
			return
		}

		// 展示用文件名清洗：去掉路径部分，剔除引号/控制字符（FileName 会回放进
		// 下载响应的 Content-Disposition 头，防止 header 注入），并限制长度
		fileName := strings.Map(func(r rune) rune {
			if r == '"' || r < 0x20 || r == 0x7f {
				return -1
			}
			return r
		}, filepath.Base(fh.Filename))
		if fileName == "" {
			fileName = moduleName + ".mib"
		}
		// 按 rune 截断（字节截断可能切裂 UTF-8 字符，MySQL 严格模式会拒绝写入）
		if r := []rune(fileName); len(r) > 255 {
			fileName = string(r[:255])
		}

		sum := sha256.Sum256(content)
		checksum := hex.EncodeToString(sum[:])

		// 先建记录取 ID 并占住唯一模块名，再以 ID 为文件名落盘（同 Releases 模式）
		mib := models.DeviceMIB{
			ModuleName: moduleName,
			FileName:   fileName,
			FileSize:   int64(len(content)),
			SHA256:     checksum,
			UploadedBy: getUsername(c),
		}
		if err := db.Create(&mib).Error; err != nil {
			if isDuplicateErr(err) {
				c.JSON(http.StatusBadRequest, gin.H{
					"error": "模块 " + moduleName + " 已存在，请先删除旧文件再上传",
					"code":  "device.mib_module_taken", "module": moduleName,
				})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "创建记录失败: " + err.Error()})
			return
		}

		// 落盘文件名必须与模块名一致（gosmi 解析 IMPORTS 依赖按模块名找文件）；
		// moduleName 已被正则限定为 [A-Za-z][A-Za-z0-9-]*，天然是安全文件名
		finalPath := filepath.Join(mibDir, moduleName+".mib")
		if err := os.WriteFile(finalPath, content, 0o644); err != nil {
			db.Delete(&mib)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存文件失败", "code": "server_error"})
			return
		}
		db.Model(&mib).Update("file_path", finalPath)
		mib.FilePath = finalPath

		// 重建翻译引擎并把最新解析状态（含本模块）带回响应
		engine.Rebuild(db)
		db.First(&mib, mib.ID)
		mib.FilePath = finalPath

		writeDeviceAudit(db, getUsername(c), "upload_mib", "mib", &mib.ID,
			fmt.Sprintf("Uploaded MIB %s (%s, %d bytes, sha256=%s, parsed=%v)",
				moduleName, mib.FileName, mib.FileSize, checksum, mib.Parsed))
		c.JSON(http.StatusOK, mib)
	}
}

// TranslateMIBOID GET /api/v1/devices/mibs/translate?oid=1.3.6.1.2.1.1.1
// 数字 OID → 可读名（最长前缀匹配，超出部分保留为数字后缀）。未命中时
// found=false，前端按原样展示数字 OID。
func TranslateMIBOID(engine *MIBEngine) gin.HandlerFunc {
	return func(c *gin.Context) {
		oid := c.Query("oid")
		if oid == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 oid 参数", "code": "bad_request"})
			return
		}
		c.JSON(http.StatusOK, engine.Translate(oid))
	}
}

// ListDeviceMIBs GET /api/v1/devices/mibs
func ListDeviceMIBs(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var mibs []models.DeviceMIB
		db.Order("module_name asc").Find(&mibs)
		c.JSON(http.StatusOK, mibs)
	}
}

// DownloadDeviceMIB GET /api/v1/devices/mibs/:id/download
func DownloadDeviceMIB(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var mib models.DeviceMIB
		if err := db.First(&mib, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "MIB 不存在", "code": "not_found"})
			return
		}
		if mib.FilePath == "" {
			c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在（可能已被删除）", "code": "not_found"})
			return
		}
		if _, err := os.Stat(mib.FilePath); os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在（可能已被删除）", "code": "not_found"})
			return
		}
		c.FileAttachment(mib.FilePath, mib.FileName)
	}
}

// DeleteDeviceMIB DELETE /api/v1/devices/mibs/:id —— 删除后重建翻译引擎
// （依赖它的其他模块会转为解析失败并在列表可见）。
func DeleteDeviceMIB(db *gorm.DB, engine *MIBEngine) gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := parseIDParam(c, "id")
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		var mib models.DeviceMIB
		if err := db.First(&mib, id).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "MIB 不存在", "code": "not_found"})
			return
		}
		if err := db.Delete(&mib).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "删除失败: " + err.Error()})
			return
		}
		if mib.FilePath != "" {
			_ = os.Remove(mib.FilePath) // 忽略文件已不存在等错误
		}
		engine.Rebuild(db)
		writeDeviceAudit(db, getUsername(c), "delete_mib", "mib", &id,
			fmt.Sprintf("Deleted MIB %s (%s)", mib.ModuleName, mib.FileName))
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	}
}
