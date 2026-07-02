#!/usr/bin/env node
/**
 * API 错误码一致性检查（CI 与本地均可运行：node scripts/check-error-codes.mjs）
 *
 * 后端约定（见 README「API 速查」）：错误响应为 {error, code, ...params}，
 * code 在 Go 侧只允许三种书写位置（新增错误码请使用其一，否则本脚本无法采集）：
 *   1. gin.H 字面量:            "code": "auth.invalid_credentials"
 *   2. core.CodedError 字面量:   Code: "ipam.cidr_not_canonical"
 *   3. codedf 构造调用:          codedf("ipam.invalid_cidr", ...)
 * 前端映射表：frontend/src/i18n/apiErrors.ts 的 apiErrors 对象。
 *
 * 规则：
 *   - 后端出现、前端缺词条  → 失败（EN 用户会看到中文回退，属于漏配）
 *   - 前端有词条、后端未使用 → 警告（可能是遗留，不阻塞）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_RE = /"code":\s*"([a-z][a-z0-9_.]*)"/g;
const STRUCT_RE = /\bCode:\s*"([a-z][a-z0-9_.]*)"/g;
const CODEDF_RE = /\bcodedf\(\s*"([a-z][a-z0-9_.]*)"/g;
const FRONTEND_KEY_RE = /^\s*'([a-z][a-z0-9_.]*)':\s*\{/gm;

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

// ── 收集后端错误码 ───────────────────────────────────────────────────────────
const backendCodes = new Map(); // code → first file seen
for (const file of walk(join(root, 'backend'), '.go')) {
  const src = readFileSync(file, 'utf8');
  for (const re of [CODE_RE, STRUCT_RE, CODEDF_RE]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      if (!backendCodes.has(m[1])) backendCodes.set(m[1], file.slice(root.length + 1));
    }
  }
}

// ── 收集前端词条 ─────────────────────────────────────────────────────────────
const apiErrorsFile = join(root, 'frontend', 'src', 'i18n', 'apiErrors.ts');
const frontendCodes = new Set(
  [...readFileSync(apiErrorsFile, 'utf8').matchAll(FRONTEND_KEY_RE)].map((m) => m[1]),
);

// ── 比对 ────────────────────────────────────────────────────────────────────
const missing = [...backendCodes.entries()].filter(([c]) => !frontendCodes.has(c));
const unused = [...frontendCodes].filter((c) => !backendCodes.has(c));

console.log(`backend codes: ${backendCodes.size}, frontend entries: ${frontendCodes.size}`);

if (unused.length) {
  console.warn('\n[warn] 前端词条未被后端使用（可能是遗留，可考虑清理）:');
  unused.forEach((c) => console.warn(`  - ${c}`));
}

if (missing.length) {
  console.error('\n[FAIL] 后端错误码缺少前端词条（请补充 frontend/src/i18n/apiErrors.ts）:');
  missing.forEach(([c, f]) => console.error(`  - ${c}  (${f})`));
  process.exit(1);
}

console.log('\nOK: 所有后端错误码均有前端词条。');
