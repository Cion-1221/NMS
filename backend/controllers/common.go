package controllers

// 跨模块共享的 controller 层工具函数。各业务域（IPAM/Devices/System/Agent）自包含，
// 但以下纯技术性 helper 属于全体模块的公共地基，统一收拢在此，避免散落在某个业务
// 文件里靠"同包可见"被其他模块隐式借用。

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"nms-backend/core"
	"nms-backend/middleware"

	"github.com/gin-gonic/gin"
	"github.com/go-sql-driver/mysql"
)

// parseIDParam 解析并校验路径参数中的数字 ID（必须为正整数）。
func parseIDParam(c *gin.Context, name string) (uint, error) {
	id, err := strconv.ParseUint(c.Param(name), 10, 64)
	if err != nil || id == 0 {
		return 0, fmt.Errorf("无效的 ID 参数")
	}
	return uint(id), nil
}

// getUsername 从 JWT 上下文取当前操作者用户名（审计日志用），未认证场景回退 "system"。
func getUsername(c *gin.Context) string {
	raw, exists := c.Get(middleware.CtxUserKey)
	if !exists {
		return "system"
	}
	if claims, ok := raw.(*middleware.Claims); ok {
		return claims.Username
	}
	return "system"
}

// codedErrJSON 将 error 转为标准错误响应体：core.CodedError 携带 code 与插值参数
// （平铺进响应体，供前端 i18n 模板替换），其他错误只有中文文案（无 code，前端回退
// 展示原文）。
func codedErrJSON(err error) gin.H {
	h := gin.H{"error": err.Error()}
	var ce *core.CodedError
	if errors.As(err, &ce) {
		h["code"] = ce.Code
		for k, v := range ce.Params {
			h[k] = v
		}
	}
	return h
}

// isDuplicateErr 判断 err 是否为 MySQL/MariaDB 唯一键冲突（errno 1062）。
// 优先按驱动错误码精确判断；错误被包装或非驱动类型时回退子串匹配兜底。
func isDuplicateErr(err error) bool {
	if err == nil {
		return false
	}
	var me *mysql.MySQLError
	if errors.As(err, &me) {
		return me.Number == 1062
	}
	return strings.Contains(err.Error(), "Duplicate entry")
}

// friendlyNameUniqueErr 将单列 name 唯一索引的冲突翻译为友好提示（IPAMGroup/
// IPAMType/IPAMVRF/DeviceSite/DeviceRole/DeviceVendor/AgentGroup 等字典实体通用）。
// entityName 为展示用标签，如 "站点"、"分组"、"VRF"。非唯一键冲突返回 ""。
// 调用方响应时应附带 "code": "common.name_taken"。
func friendlyNameUniqueErr(err error, entityName string) string {
	if isDuplicateErr(err) {
		return entityName + "名称已存在，请使用其他名称"
	}
	return ""
}
