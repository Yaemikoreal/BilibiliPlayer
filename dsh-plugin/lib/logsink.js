/**
 * 日志落盘的三件小事：流式解码、尾部截断、按字节轮转、探测降噪。
 *
 * 为什么单独成模块（全部来自 2026-10-28 的实测事故）：
 *   1. **按块嗅探编码会毁掉中文**：`toText()` 先按 UTF-8 解，出现 U+FFFD 就整块回落 gbk。
 *      子进程是 UTF-8，但 Node 的 `data` 事件会在多字节字符中间切块，边界那个字符必然解出
 *      U+FFFD ⇒ 整块（可达 64KB）被当成 GBK 二次解码 ⇒ 中文全毁、ASCII 完好。
 *      正解：每条流一个**持久** StringDecoder，跨块保存半个字符。
 *   2. **按字符截断不等于按字节截断**：`readFileSync(...).slice(-256*1024)` 是字符串切片，
 *      中文 3 字节 ⇒ `.old` 实际可达 ~768KB，轮转后仍超阈值。
 *   3. **子进程输出会把整份 reasoning 灌进日志**：日志体积与敏感度都被推理文本主导。
 *
 * 纯逻辑（解码/截断/降噪）不碰 IO；只有 `rotateIfBig` 触盘，便于用临时目录单测。
 */
import { StringDecoder } from 'node:string_decoder'
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'

/** 一条流一个持久 UTF-8 解码器：跨 chunk 边界不会解出 U+FFFD。 */
export const createUtf8Decoder = () => {
  const d = new StringDecoder('utf8')
  return {
    write: (buf) => {
      if (typeof buf === 'string') return buf
      try { return d.write(buf) } catch { return '' }
    },
    end: () => { try { return d.end() } catch { return '' } },
  }
}

/** 只留尾部 n 个字符；超了给出明确截断标记（不静默）。 */
export const keepTail = (text, n = 4096) => {
  const s = String(text ?? '')
  const max = Math.max(0, Number(n) || 0)
  if (s.length <= max) return s
  return `…（已截断 ${s.length - max} 字符）\n${s.slice(-max)}`
}

/** 第 i 代归档文件名：0 = `.old`（最新），1 = `.old.1`（更早）。 */
export const archivedPath = (file, gen = 0) => (gen === 0 ? `${file}.old` : `${file}.old.${gen}`)

/**
 * 按**字节**轮转：超 maxBytes 时把尾部 keepBytes 字节挪进 `.old`，主文件清空。
 *
 * 保 `generations` 代（缺省 2：`.old` + `.old.1`）——事故现场是「只保一代」：
 * 连续两次轮转后第一份证据被覆盖，而两轮之间的日志正好是排查窗口。
 * 每次轮转先把旧的往上滚一代（`.old` → `.old.1`），并保证每份归档的真实字节数不超过 keepBytes。
 *
 * @returns {boolean} 是否真的轮转了
 */
export const rotateIfBig = (file, { maxBytes = 512 * 1024, keepBytes = 256 * 1024, generations = 2 } = {}) => {
  try {
    if (!existsSync(file)) return false
    if (statSync(file).size < maxBytes) return false
    const buf = readFileSync(file)
    const head = buf.subarray(0, Math.max(0, buf.length - keepBytes))
    // 别把多字节字符切成半个：从截断点往后找第一个换行，从那里开始保留
    let start = head.length
    if (start > 0) {
      const nl = buf.indexOf(0x0a, start)
      start = nl >= 0 && nl + 1 <= buf.length ? nl + 1 : start
    }
    // 世代上滚：最老的直接淘汰，其余逐个改名，最后把新归档写进第 0 代。
    const genCount = Math.max(1, Number(generations) || 1)
    if (genCount > 1) {
      try {
        const oldest = archivedPath(file, genCount - 1)
        if (existsSync(oldest)) unlinkSync(oldest)
      } catch { /* 删不掉就让它被下一份覆盖 */ }
      for (let i = genCount - 1; i >= 1; i--) {
        try {
          const from = archivedPath(file, i - 1)
          if (existsSync(from)) renameSync(from, archivedPath(file, i))
        } catch { /* 单代滚动失败不影响主流程 */ }
      }
    }
    writeFileSync(archivedPath(file, 0), buf.subarray(start))
    writeFileSync(file, Buffer.alloc(0))
    return true
  } catch {
    return false
  }
}

/**
 * 探测降噪：同一个结论只记一次，**变化时才写**。
 * 事故背景：`findDshCli` 每次调用都 log 三行探测细节，概览轮询把它变成了刷屏（duty.log 一度被顶到 485KB）。
 */
export const createProbeLogger = (log, { label = '探测' } = {}) => {
  let seen = false
  let last = ''
  return (value) => {
    const v = String(value ?? '')
    if (seen && v === last) return false
    seen = true
    last = v
    try { log(`${label}：${v || '未找到'}（结论变化）`) } catch { /* 记日志失败不能影响主流程 */ }
    return true
  }
}
