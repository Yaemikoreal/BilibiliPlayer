// B站分身运维脚本的公共路径解析。
// 家目录口径必须与插件/ MCP 侧一致：
//   1. 环境变量 BILI_FENSHEN_HOME（插件值班轮、MCP 记账工具都认它）
//   2. 否则 ~/.dsh/bili-fenshen
// ⚠️ 不要在脚本里再写死 C:/Users/<某人>/.dsh/...：2026-10-29 测试报告 §3.3
//    就是 4 个脚本硬编码了另一台机器的用户名，在本机全部 ENOENT。
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 插件家目录（与 dsh-plugin/index.js 的 HOME、mcp_server.py 的 _persona_home 同源）。 */
export function fenshenHome() {
  const env = String(process.env.BILI_FENSHEN_HOME || '').trim()
  return env || join(homedir(), '.dsh', 'bili-fenshen')
}

/** 账本绝对路径：<家目录>/ledger.jsonl。 */
export function ledgerPath() {
  return join(fenshenHome(), 'ledger.jsonl')
}

/** 取账本路径；不存在时给人话报错（而不是裸 ENOENT）。 */
export function requireLedger() {
  const p = ledgerPath()
  if (!existsSync(p)) {
    throw new Error(
      `找不到账本：${p}\n`
      + '  ① 已经跑过值班轮吗？（账本第一行由值班轮写入）\n'
      + '  ② 家目录在别的盘/别的用户下？用环境变量指过去：BILI_FENSHEN_HOME=<你的 .dsh/bili-fenshen 路径>',
    )
  }
  return p
}
