# 内置标准 MIB 模块

首次启动时自动 seed 进 MIB 文件库（`controllers.SeedBuiltinMIBs`，以 `sys_settings`
的 `snmp_builtin_mibs_seeded` 标记保证只执行一次——管理员删除后不会在重启时复活）。

这些是几乎所有厂商 MIB 都会 IMPORTS 的基础模块（SMIv1/SMIv2 核心 + 接口/地址类型），
预置后上传厂商 MIB 通常可直接解析成功：

SNMPv2-SMI · SNMPv2-TC · SNMPv2-CONF · SNMPv2-MIB · SNMP-FRAMEWORK-MIB ·
INET-ADDRESS-MIB · IANAifType-MIB · IF-MIB · RFC1155-SMI · RFC-1215 · RFC1213-MIB

来源：net-snmp 项目 mibs 目录（https://github.com/net-snmp/net-snmp/tree/master/mibs），
内容为 IETF RFC / IANA registry 的 MIB 模块原文。文件名必须与模块名一致
（gosmi 按模块名解析 IMPORTS）。本目录的 `.mib` 文件经 go:embed 编译进二进制。
