import { Lang } from './translations';

/**
 * 后端 API 错误码 → 双语文案映射。
 *
 * 后端错误响应形如 {error: "<中文兜底文案>", code: "<错误码>", ...插值参数}。
 * code 命中本表时按当前语言展示（文案中的 {param} 占位符从响应体同名字段插值，
 * 如 auth.locked 的 {minutes}、sys.group_has_users 的 {count}）；未命中或响应
 * 没有 code 时，回退展示后端原始 error 文案。
 *
 * 后端约定：静态、确定性的报错都带 code；动态拼接 DB/校验详情的报错（"创建失败:
 * Error 1062..." 之类）保持无 code，走原文回退。
 */
const apiErrors: Record<string, Record<Lang, string>> = {
  // ── 通用 ──────────────────────────────────────────────────────────────────
  'bad_request':       { en: 'Invalid request parameters', zh: '参数错误' },
  'server_error':      { en: 'Internal server error, please try again later', zh: '服务器内部错误，请稍后重试' },
  'not_found':         { en: 'Resource not found (it may have been deleted)', zh: '资源不存在（可能已被删除）' },
  'common.name_taken': { en: 'Name already exists, please choose another', zh: '名称已存在，请使用其他名称' },
  'common.rate_limited': { en: 'Too many requests — please wait a moment and retry', zh: '请求过于频繁，请稍后再试' },

  // ── 认证 / 授权 ───────────────────────────────────────────────────────────
  'auth.invalid_credentials':  { en: 'Invalid username or password', zh: '用户名或密码错误' },
  'auth.locked':               { en: 'Too many failed attempts — temporarily locked. Try again in {minutes} min.', zh: '登录失败次数过多，账号已临时锁定，请 {minutes} 分钟后重试' },
  'auth.refresh_invalid':      { en: 'Session expired, please sign in again', zh: '会话已过期，请重新登录' },
  'auth.user_not_found':       { en: 'User not found', zh: '用户不存在' },
  'auth.token_missing':        { en: 'Not signed in or token missing', zh: '未登录或 Token 缺失' },
  'auth.token_invalid':        { en: 'Session invalid or expired, please sign in again', zh: 'Token 无效或已过期，请重新登录' },
  'auth.unauthenticated':      { en: 'Not authenticated', zh: '未认证' },
  'auth.admin_required':       { en: 'Administrator permission required', zh: '权限不足，该操作需要管理员权限' },
  'auth.must_change_password': { en: 'Please change your initial password before continuing', zh: '请先修改初始密码后再使用系统' },
  'auth.pwd_too_short':        { en: 'New password must be at least 8 characters', zh: '新密码至少需要 8 位' },
  'auth.pwd_same':             { en: 'New password must differ from the current one', zh: '新密码不能与当前密码相同' },
  'auth.pwd_old_wrong':        { en: 'Current password is incorrect', zh: '当前密码不正确' },
  'auth.lifetime_range':       { en: 'Session lifetime must be between 1 and 720 hours', zh: '会话时长须在 1～720 小时之间' },
  'auth.lifetime_over_cap':    { en: 'Exceeds the maximum session lifetime set by the administrator ({max} hours)', zh: '超出管理员限制的最大会话时长（{max} 小时）' },
  'auth.account_disabled':     { en: 'This account has been disabled — contact an administrator', zh: '账号已被停用，请联系管理员' },
  'auth.perm_required':        { en: 'Permission required for this operation: {perm}', zh: '权限不足，该操作需要权限：{perm}' },

  // ── System（用户 / 用户组 / 安全设置）──────────────────────────────────────
  'sys.username_taken':          { en: 'Username already exists, please choose another', zh: '用户名已存在，请使用其他用户名' },
  'sys.cannot_change_own_group': { en: 'You cannot change your own group — ask another administrator', zh: '不能修改自己的用户组，如需调整请联系其他管理员' },
  'sys.cannot_delete_self':      { en: 'You cannot delete the account you are signed in with', zh: '不能删除当前登录的用户账号' },
  'sys.cannot_disable_self':     { en: 'You cannot disable the account you are signed in with', zh: '不能停用当前登录的用户账号' },
  'sys.last_admin_user':         { en: 'The system must keep at least one enabled administrator account', zh: '系统至少需要保留一个可用的管理员账号' },
  'sys.perms_invalid':           { en: 'Permissions must be a valid JSON string array, e.g. ["admin"]', zh: 'permissions 必须是合法的 JSON 字符串数组，如 ["admin"]' },
  'sys.perms_unknown':           { en: 'Contains an unknown permission value', zh: '包含未知权限值' },
  'sys.session_cap_range':       { en: 'Max session lifetime must be between 1 and 720 hours', zh: '最大会话时长取值范围 1-720 小时' },
  'sys.last_admin_group':        { en: 'At least one administrator group must remain', zh: '系统至少需要保留一个管理员组' },
  'sys.group_has_users':         { en: 'This group still has {count} user(s) — move them to another group first', zh: '该用户组下仍有 {count} 个用户，请先将其迁移至其他组后再删除' },
  'sys.sec_max_attempts_range':  { en: 'Max failed attempts must be between 1 and 100', zh: '最大失败次数取值范围 1-100' },
  'sys.sec_window_range':        { en: 'Window must be between 1 and 1440 minutes', zh: '统计窗口取值范围 1-1440 分钟' },
  'sys.sec_lockout_range':       { en: 'Lockout duration must be between 1 and 1440 minutes', zh: '锁定时长取值范围 1-1440 分钟' },
  'sys.lockout_select_one':      { en: 'Select at least one lockout entry to unlock', zh: '请至少选择一条要解除的锁定' },

  // ── Devices ────────────────────────────────────────────────────────────────
  'device.ipv4_taken':        { en: 'This IPv4 address is already used by another device', zh: '该 IPv4 地址已被其他设备使用，请检查后重试' },
  'device.ipv6_taken':        { en: 'This IPv6 address is already used by another device', zh: '该 IPv6 地址已被其他设备使用，请检查后重试' },
  'device.hostname_taken':    { en: 'Hostname already exists, please choose another', zh: '主机名已存在，请使用其他名称' },
  'device.pop_name_taken':    { en: 'A PoP with this name already exists under the selected site', zh: '该站点下已存在同名的 PoP 节点，请使用其他名称' },
  'device.site_has_pops':     { en: 'This site still has {count} PoP(s) — remove them before deleting the site', zh: '该站点下还有 {count} 个 PoP 节点，请先移除所有关联 PoP 后再删除站点' },
  'device.invalid_ip':        { en: 'Invalid management IP address', zh: '管理 IP 地址无效，请检查格式' },
  'device.ip_required':       { en: 'At least one of management IPv4 / IPv6 is required', zh: '管理 IP (IPv4) 和管理 IPv6 至少填写一个' },
  'device.invalid_status':    { en: 'Invalid status — allowed: active / offline / maintenance / planned', zh: '无效的状态值，可选: active / offline / maintenance / planned' },
  'device.pop_site_mismatch': { en: 'The selected PoP does not belong to the selected site', zh: '所选 PoP 不属于所选站点' },
  'device.invalid_polling_mode':     { en: 'Invalid polling mode — allowed: none / direct / agent', zh: '无效的采集模式，可选: none / direct / agent' },
  'device.invalid_snmp_version':     { en: 'Invalid SNMP version — allowed: 1 / 2c / 3', zh: '无效的 SNMP 版本，可选: 1 / 2c / 3' },
  'device.invalid_snmp_port':        { en: 'Invalid SNMP port (1–65535)', zh: '无效的 SNMP 端口（1-65535）' },
  'device.invalid_snmp_interval':    { en: 'Invalid poll interval (10–86400 s, blank = global default)', zh: '无效的采集间隔（10-86400 秒，留空使用全局默认）' },
  'device.snmp_credential_required': { en: 'Community is required to enable SNMP polling', zh: '开启 SNMP 采集必须填写 Community' },
  'device.snmp_agent_required':      { en: 'Agent Proxy mode requires an assigned agent', zh: '探针代理模式必须指定采集探针' },
  'device.snmp_agent_not_found':     { en: 'The assigned agent does not exist', zh: '指定的采集探针不存在' },
  'device.snmp_agent_revoked':       { en: 'The assigned agent has been revoked — choose another', zh: '指定的采集探针已被吊销，请更换' },
  'device.snmp_test_direct_only':    { en: 'Test Now is only available in Direct SNMP mode — Agent Proxy devices update on the next poll cycle', zh: '仅直连采集模式支持立即测试；探针代理模式请等待下一个采集周期' },
  'device.mib_file_missing':         { en: 'MIB file is required (form field "file")', zh: '缺少 MIB 文件（字段名 file）' },
  'device.mib_too_large':            { en: 'MIB file too large (2 MiB max)', zh: 'MIB 文件过大（上限 2 MiB）' },
  'device.mib_invalid':              { en: 'Not a valid SMI MIB — missing `<MODULE> DEFINITIONS ::= BEGIN` header', zh: '无法识别 MIB 模块定义（缺少 `<模块名> DEFINITIONS ::= BEGIN`）' },
  'device.mib_module_taken':         { en: 'Module {module} already exists — delete the old file first', zh: '模块 {module} 已存在，请先删除旧文件再上传' },
  'device.invalid_snmp_v3_auth_proto': { en: 'Invalid v3 auth protocol — allowed: MD5/SHA/SHA224/SHA256/SHA384/SHA512', zh: '无效的 v3 认证协议，可选: MD5/SHA/SHA224/SHA256/SHA384/SHA512' },
  'device.invalid_snmp_v3_priv_proto': { en: 'Invalid v3 privacy protocol — allowed: DES/AES/AES192/AES256/AES192C/AES256C', zh: '无效的 v3 加密协议，可选: DES/AES/AES192/AES256/AES192C/AES256C' },
  'device.snmp_v3_priv_requires_auth': { en: 'Privacy (authPriv) requires an auth protocol as well', zh: '启用 v3 加密（authPriv）必须同时配置认证协议' },
  'device.snmp_v3_user_required':      { en: 'SNMPv3 requires a username', zh: 'SNMPv3 必须填写用户名' },
  'device.snmp_v3_auth_pass_required': { en: 'Auth passphrase is required when an auth protocol is set', zh: '配置了认证协议必须填写认证口令' },
  'device.snmp_v3_priv_pass_required': { en: 'Privacy passphrase is required when a privacy protocol is set', zh: '配置了加密协议必须填写加密口令' },
  'device.invalid_snmp_oid':           { en: 'Invalid OID (dotted numeric, e.g. 1.3.6.1.2.1.1.3.0)', zh: '无效的 OID（数字点分格式，如 1.3.6.1.2.1.1.3.0）' },
  'device.snmp_oid_limit':             { en: 'At most {max} custom OIDs per device', zh: '每台设备最多 {max} 个自定义 OID' },
  'device.snmp_oid_taken':             { en: 'This OID already exists on the device', zh: '该设备已存在相同 OID' },
  'device.invalid_snmp_oid_kind':      { en: 'Invalid metric type — allowed: gauge / counter', zh: '无效的指标类型，可选: gauge / counter' },

  // ── IPAM ───────────────────────────────────────────────────────────────────
  'ipam.version_mismatch':        { en: 'IP version does not match the CIDR address family', zh: 'IP 版本与 CIDR 地址族不一致' },
  'ipam.invalid_cidr':            { en: 'Invalid CIDR format', zh: '无效的 CIDR 格式' },
  'ipam.cidr_not_canonical':      { en: 'Non-canonical CIDR — did you mean {suggest}?', zh: '地址不标准，您需要的是否是 {suggest}？' },
  'ipam.cidr_taken':              { en: 'This root prefix already exists', zh: '该根前缀已存在' },
  'ipam.subnet_conflict':         { en: 'Resulting subnet already exists under another prefix', zh: '目标网段已存在于其他前缀下，无法创建' },
  'ipam.subnet_missing':          { en: 'Some selected subnets no longer exist — refresh and retry', zh: '部分选中的子网已不存在，请刷新后重试' },
  'ipam.split_bits_too_small':    { en: 'Target mask /{target} must be longer than the current /{current}', zh: '目标掩码 /{target} 必须大于当前掩码 /{current}' },
  'ipam.split_bits_out_of_range': { en: 'Target mask /{target} is out of range', zh: '目标掩码 /{target} 超出合法范围' },
  'ipam.split_too_many':          { en: 'Split would create too many subnets (max 65,536 per operation)', zh: '单次拆分生成的网段数量过多（上限 65536）' },
  'ipam.merge_min_two':           { en: 'Select at least two subnets to merge', zh: '至少需要选择两个子网进行合并' },
  'ipam.merge_family_mismatch':   { en: 'Selected subnets mix IPv4 and IPv6', zh: '所选子网的 IP 版本不一致' },
  'ipam.merge_mask_mismatch':     { en: 'Selected subnets must share the same mask length', zh: '所选子网的掩码长度必须相同' },
  'ipam.merge_not_power_of_two':  { en: 'Number of selected subnets ({count}) must be a power of two', zh: '所选子网数量（{count}）不是 2 的整数次幂，无法合并为标准网段' },
  'ipam.merge_not_adjacent':      { en: 'Selected subnets are not adjacent or do not form a canonical aggregate', zh: '所选子网不相邻或缺失片段，无法构成标准聚合网段' },
  'ipam.merge_level_mismatch':    { en: 'Selected subnets are not at the same level', zh: '所选子网不属于同一级别，禁止合并' },
  'ipam.merge_root_mismatch':     { en: 'Selected subnets belong to different root prefixes', zh: '所选子网不属于同一个根前缀，禁止合并' },
  'ipam.merge_parent_mismatch':   { en: 'Selected subnets do not share the same parent', zh: '所选子网不属于同一个父级节点，禁止合并' },

  // ── Agent ──────────────────────────────────────────────────────────────────
  'agent.invalid_source_ip':    { en: "Invalid Source IP — enter a single IPv4/IPv6, or an 'IPv4 / IPv6' dual-stack pair", zh: 'Source IP 无效——请填写单个 IPv4/IPv6，或 "IPv4 / IPv6" 双栈格式' },
  'agent.invalid_task_type':    { en: 'Unsupported task type', zh: '不支持的任务类型' },
  'agent.invalid_scope':        { en: 'Invalid scope: group scope requires a Group, agent scope requires an Agent', zh: 'Scope 配置无效：group 需指定分组，agent 需指定 Agent' },
  'agent.invalid_target':       { en: 'Targets must be IPv4/IPv6 addresses or domain names, one per line (tcpping/httpcheck may append :port; httpcheck also accepts full URLs)', zh: 'Target 必须是 IPv4/IPv6 地址或域名，每行一个（tcpping/httpcheck 可加 :port 后缀；httpcheck 亦支持完整 URL）' },
  'agent.invalid_address_family': { en: 'Invalid address family — must be auto, v4, v6 or both', zh: '无效的地址族——可选 auto / v4 / v6 / both' },
  'agent.token_not_unused':     { en: 'Only unused tokens can be revoked', zh: '仅可作废未使用的 Token' },
  'agent.release_file_missing': { en: 'Binary file is required (form field "file")', zh: '缺少二进制文件（字段名 file）' },
  'agent.ca_no_pending':        { en: 'No pending CA rotation to finalize', zh: '当前没有待终结的轮换' },
};

/**
 * 将后端错误响应转为指定语言的可展示文案。
 * 优先级：code 命中词条（含参数插值）→ 后端 error 原文 → 调用方 fallback →
 * 内置双语默认（无响应时提示检查网络，有响应但无 error 字段时提示请求失败）。
 * 常规调用不需要传 fallback——内置默认已覆盖"服务器不可达"场景的双语提示。
 */
export function apiErrorMessage(err: unknown, lang: Lang, fallback?: string): string {
  const resp = (err as { response?: { data?: Record<string, unknown> } })?.response;
  const data = resp?.data;
  const code = typeof data?.code === 'string' ? data.code : undefined;
  const entry = code ? apiErrors[code] : undefined;

  if (entry && data) {
    let msg = entry[lang] ?? entry.en;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' || typeof v === 'number') {
        msg = msg.replace(`{${k}}`, String(v));
      }
    }
    return msg;
  }
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (fallback) return fallback;
  if (!resp) {
    return lang === 'zh'
      ? '网络请求失败，请检查连接后重试'
      : 'Network request failed — check your connection and retry';
  }
  return lang === 'zh' ? '请求失败' : 'Request failed';
}

const LS_LANG = 'nms_ui_language'; // 与 AppContext 的持久化 key 保持一致

/**
 * 免 Hook 版本：语言从 localStorage 实时读取（AppContext 的 setLanguage 与登录同步
 * 都会写入该 key）。错误提示是瞬时计算的 toast，不需要响应式重渲染，因此可以在任意
 * 组件/工具函数里直接调用，避免每个组件都要接 useApiError Hook。
 */
export function apiErrMsg(err: unknown, fallback?: string): string {
  const lang = (localStorage.getItem(LS_LANG) as Lang) ?? 'en';
  return apiErrorMessage(err, lang === 'zh' ? 'zh' : 'en', fallback);
}
