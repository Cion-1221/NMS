package core

import "fmt"

// CodedError 携带机器可读错误码与插值参数的业务错误，core 包内任何模块
// （IPAM 算法、PKI 等）均可使用。API 层用 errors.As 识别后映射为
// {error, code, ...params} 响应体（见 controllers/common.go 的 codedErrJSON），
// 前端按 code 做 i18n 映射（frontend/src/i18n/apiErrors.ts）。
// 新增 Code 必须同步前端词条，CI 的 scripts/check-error-codes.mjs 会校验一致性。
type CodedError struct {
	Code   string            // 前端映射键，如 "ipam.cidr_not_canonical"
	Msg    string            // 中文兜底文案（可含具体数值）
	Params map[string]string // 平铺进响应体的插值参数，如 {"suggest": "10.0.0.0/24"}
}

func (e *CodedError) Error() string { return e.Msg }

// codedf 构造 CodedError 的便捷函数：Msg 用 fmt 格式化。
func codedf(code string, params map[string]string, format string, a ...interface{}) *CodedError {
	return &CodedError{Code: code, Msg: fmt.Sprintf(format, a...), Params: params}
}
