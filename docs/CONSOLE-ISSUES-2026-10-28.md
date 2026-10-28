# B站分身控制台：已知问题与修复方案（2026-10-28）

> 排查口径：只读代码 + 线上实证（宿主 API `127.0.0.1:49739`、`duty.log`、家目录 state/config）+ 仓库自带 SSR 夹具复现。
> 基线：`node --test test/*.test.js` → **208 pass / 0 fail**（现状测试全绿，说明下面这些缺陷都没有被测试覆盖到）。
> 代码位置均为 `dsh-plugin/` 下的文件。

## 0. 一句话结论

截图里「找不到 dsh CLI」「未找到」「家目录 —」「登录检查中」「数据 刚刚」**不是配置问题，也不是探测不到 CLI**（实测 `health.cli` 有值、`bili_fenshen_diagnose` 10 项全 pass）。真正原因是 **SSE 首帧被客户端的 seq 单调守卫丢掉了**，页面一直停在「空数据态」，而空数据态又被当成真实状态渲染成了红色告警。设置页大面积竖排文字则是独立的 CSS 缺陷。

---

## P0-1　控制台永远空数据：SSE 首帧被 seq 守卫丢弃

**现象**：概览红条「找不到 dsh CLI」、状态行「登录检查中」、运行卡「还没跑过」；设置→运行环境「dsh CLI 未找到」「家目录 —」「账本 —」；但同一页面下方「宿主日志」能正常显示（它走独立的 `/log` 轮询）。刷新按钮也救不回来。

**线上实证**（直连 SSE 抓原始帧）：

```
HTTP 200 text/event-stream
[+8ms] data: {"type":"hello","seq":11,...}
[+8ms] data: {"type":"overview","data":{"ok":true,"seq":11,...}}
                                   ↑ 与 hello 的 seq 相等
```

**根因链**（三处代码共同造成）：

1. `lib/realtime.js:81-87` `view()`：`if (!data || dirty) recompute; return envelope()` —— 服务端**已有数据且不脏时直接返回当前信封，seq 不自增**。
2. `lib/api.js:190,192-193`：先 `write({type:'hello', seq: hub.seq})`，再 `hub.view('stream-open')` 拿到**同一个 seq** 的信封写出去。
3. `client.js:742-760` `accept()`：`if (seq <= r.seq) return false` —— 客户端被 hello 把 `r.seq` 抬到 11，紧接着的首帧 seq 也是 11 → **被当成旧帧丢弃**。

因为自动值班是关的（`autoDuty:false`），空闲期没有 `publish()`，所以**再没有第二帧**；`client.js:904` 的手动 `refresh()` 用的是同一个守卫，点刷新也照样丢。实测这个卡死状态可以一直持续到下一次文件变更（例如保存配置触发 `publish('config')`）才恢复——这就是「有时好有时坏」。

**修复方案**（建议三处都改，成本都很低）：

```js
// ① client.js accept()：首帧不做 seq 比较，拿到数据之前允许相等
const hasData = !!stateRef.data            // 或用 ref 记录 r.hasData
if (Number.isFinite(seq)) {
  if (r.hasData && seq <= r.seq) return false   // 只在已有数据时严格单调
  r.seq = seq
}
r.hasData = true
```

```js
// ② client.js refresh()（~904 行）同样放宽：无数据时允许相等 seq
if (Number.isFinite(seq) && r.hasData && seq <= r.seq) return
```

```js
// ③ lib/api.js openStream：hello 不参与握手序号，或首帧强制新算
write({ type: 'hello', serverTime: new Date().toISOString() })   // 去掉 seq
let env = null
try { env = hub.view('stream-open') } catch { env = null }
if (env) write({ type: 'overview', data: env })
```

**验收/测试**：`test/api.test.js` 新增一例——同一 hub 先算一次（有数据、不脏），再开 `/stream`，断言首帧 `overview.seq > hello.seq` 或首帧必须能被客户端接受；`client` 侧补一例 `accept` 语义单测（无数据 + 相等 seq → 接受）。

---

## P0-2　空数据态渲染成「真实故障」+ 新鲜度谎报「刚刚」

**现象**：首帧未到时（或 P0-1 卡死时）页面不是「加载中」，而是直接报警。

**复现实证**（仓库自带夹具，`ConsolePage` 无 `initialData` 渲染）：

```
overview/无 initialData → 找不到 dsh CLI: true，数据 刚刚: true，登录检查中: true，加载中: false
```

**根因**：

- `client.js:1274`：`if (health && !health.cli)` —— `health = data.health || {}`，`{}` 是 truthy、`cli` 是 undefined → **误判成「探测失败」**。
- `client.js:1150-1163` `Freshness`：`ageMs = state.seenAt ? now-seenAt : 0`；`seenAt` 被 SSE 的 hello 帧刷新过，于是 age=0 → 绿点「数据 刚刚」（实际一个字节业务数据都没有）。
- `client.js:2630-2643`：运行环境页 `ov?.data?.health?.cli ? '已探测' : '未找到'`，无数据时一律「未找到」，`家目录/账本` 落到 `'—'`。

**修复方案**：

```js
// Banner：只在「确实拿到了健康信息」时才判红
if (health && health.cli !== undefined && !health.cli) { ... }

// Freshness：无数据 ≠ 新鲜
if (!data) return h('span',{className:'bf-fresh'}, h('i',{className:'bf-dot warn'}), error ? '数据异常·正在重连' : '正在连接…')

// 运行环境行：三态，别用 falsy 二态
const cliState = health.cli === undefined ? '探测中…' : (health.cli ? '已探测' : '未找到')
```

**测试**：`test/client.render-smoke.mjs` 增加「无 initialData」渲染断言——不得出现「找不到 dsh CLI」「数据 刚刚」。

---

## P1-3　设置页宽行标签被压成竖排（截图 2/3 大面积「一字一行」）

**现象**：`指定 UP 主 / 关键词 / 不看清单 / 人设提示词 / dshBin / 安装自检` 这些行的 label 与说明文字变成一条竖线。

**根因**（CSS，`client.js:500-510`）：

```css
.bf-row{display:flex; ...}            /* 不换行 */
.bf-row-main{flex:1;min-width:0}      /* 允许压缩到 0 */
.bf-row-ctl{flex:0 0 auto; max-width:60%}
.bf-row-ctl.wide{max-width:100%;width:100%}   /* ← 控件要占满整行 */
```

`wide` 行的控件 `flex-basis` = 100%，又不可收缩（`flex-shrink:0`），主轴空间被吃光；`main` 的 `min-width:0` 让它直接塌到 **0 宽**，中文没有断词点 → **每字一行**。共 6 处 `wide: true`：`client.js:2584`(指定 UP 主)、`2594`(关键词)、`2596`(不看清单)、`2620`(人设提示词)、`2632`(dshBin)、`2644`(安装自检)。

**修复方案**：宽行改为纵向堆叠，语义也更清楚（label/说明在上，控件整宽在下）：

```js
// Row 组件（client.js:1229）
const Row = ({ label, help, children, wide }) =>
  h('div', { className: `bf-row${wide ? ' bf-row-wide' : ''}` }, ...)
```

```css
.bf-row-wide{flex-direction:column;align-items:stretch;gap:8px}
.bf-row-wide .bf-row-ctl{max-width:100%;width:100%;justify-content:flex-start}
/* 兜底：窄屏也不允许标签列归零 */
.bf-row-main{flex:1 1 auto;min-width:180px}
```

`test/client.render-smoke.mjs` 补断言：含 `bf-row-wide` 的行内，`bf-row-main` 与 `bf-row-ctl` 不得同时争 100% 宽（或直接截图回归）。

---

## P1-4　`dshBin` 保存后最长 10 分钟不生效 + 探测日志刷屏

**现象**：用户在「设置 → 运行环境」填好 dshBin（`health.cli` 已实测有值），概览红条仍在，最长要等 10 分钟。

**根因**：

- `index.js:970-977` `cliForHealth()`：**10 分钟**缓存，且 `if (!cliHealthCache.value || age > 10min)` —— 「未找到」时每次轮询都重探（`duty.log` 里 23:49–00:45 那段 1 分钟一条就是它），「已找到」却缓存 10 分钟，不对称。
- `index.js:360-399` `dshCliCache`：60 秒 module 级缓存，**key 不含 cfg**，改了 `dshBin` 也返回旧值。
- `lib/api.js:278-283` 保存配置后只 `publish('config')` 重算概览，**没有失效上面两个缓存**。

**修复方案**：保存配置时主动失效；缓存 key 带上配置；只在结果翻转时写日志。

```js
// index.js 导出/就近提供
const resetCliCaches = () => { dshCliCache = { v: null, at: 0 }; cliHealthCache = { at: 0, value: '' } }
// lib/api.js POST /config 成功后：deps.resetCliCaches?.(); deps.overviewHub.publish('config')
```

```js
// findDshCli 降噪：首次 / 结论变化才记录
const lastProbe = { value: null }
const logProbe = (v) => { if (lastProbe.value === v) return; lastProbe.value = v; log(`dshBin 探测：${v || '未找到'}`) }
```

---

## P1-5　`duty.log` 中文整块乱码（子进程输出被误判成 GBK）

**现象**：`duty.log` 中 `2026-10-27T15:46` 之后大段中文变成 `璺?`/`鎺㈡祴` 式乱码，ASCII/英文仍正常。

**根因**：`index.js:431-438` `toText()` 按**每个数据块**判断——先按 UTF-8 解，出现 `U+FFFD` 就整块回落 `gbk`。子进程是 UTF-8，但 Node 的 `stdout` 事件会在**多字节字符中间切块**，边界那个字符必然解出 `U+FFFD` → **整块**（可达 64KB）被当成 GBK 二次解码 → 中文全毁、ASCII 不受影响（与日志现象逐条吻合）。`index.js:789-790` 每个 chunk 都调它。

**修复方案**：每个流一个持久 `StringDecoder`，不要按块嗅探编码：

```js
import { StringDecoder } from 'node:string_decoder'
const decOut = new StringDecoder('utf8'), decErr = new StringDecoder('utf8')
child.stdout?.on('data', (b) => appendLogChunk(decOut.write(b)))   // 传字符串
child.stderr?.on('data', (b) => appendLogChunk(decErr.write(b)))
// toText 只在真正的非 UTF-8 外部输入（如 Windows 控制台 GBK 回显）使用
```

同时把 `appendLogChunk` 改成接受 string（或就地 `typeof buf === 'string' ? buf : toText(buf)`），避免二次解码。

---

## P2-6　日志轮转按「字符」切，且子进程输出不触发轮转

**根因**：`index.js:283-291`：`readFileSync(...).slice(-256*1024)` 是**字符串**切片，中文 3 字节 → `.old` 实际可达 ~768KB，轮转后仍超 512KB 阈值；且 `appendLogChunk`（子进程输出）不调用 `rotateLogIfBig`，一整轮的值班输出可以把文件顶到阈值之上很久。当前 `duty.log` 已 487,698 字节，就在门槛上。

**修复**：按字节截断 + 两处都触发 + 保留 2 代。

```js
const rotateLogIfBig = () => {
  const size = statSync(LOG_FILE).size
  if (size < 512 * 1024) return
  const buf = readFileSync(LOG_FILE)
  writeFileSync(LOG_FILE + '.old', buf.subarray(Math.max(0, buf.length - 256 * 1024)))  // 字节级
  writeFileSync(LOG_FILE, Buffer.alloc(0))
}
// appendLogChunk 之后也调用一次（可加 5s 节流）
```

---

## P2-7　子进程 stdout 全量灌进 `duty.log`（含模型 reasoning 原文）

**现象**：日志里混着 `dsh: reasoning:` 开头的大段英文思考（设置页也标注了「子进程原文（含模型推理文本，默认收起）」）。日志体积与敏感度都被推理文本主导。

**根因**：`index.js:789-790` `child.stdout/stderr` → `appendLogChunk(buf)` 全量落盘，无过滤、无上限。

**修复**：日志只留「可诊断的行」——stderr 全量、stdout 仅尾部 N KB 或过滤 reasoning 段；完整原始流已经由 `live.pushChildChunk` 进环形缓冲（`/live` 面板用），无需重复落盘。

```js
const keepTail = (s, n = 4096) => (s.length > n ? '…（已截断）\n' + s.slice(-n) : s)
child.stdout?.on('data', (b) => { live.pushChildChunk(b); appendLogChunk(keepTail(decOut.write(b))) })
```

---

## P2-8　回复轮询 `fetch failed`：无超时、无退避

**现象**：`duty.log` 有「回复轮询失败（下个周期重试）：fetch failed」；概览 `inbox.pendingReply=5`（5 条回复待接）。当前 `state.json` 已是 `lastReplyPollOk:true`（已自愈），属网络抖动被放大的可用性问题。

**根因**：`lib/replies.js:32-39` `fetchReplyNotifs` 无 `AbortSignal`/超时、无重试；`index.js:862-891` 每 5 分钟一次，失败仅一行日志，页面无从感知；且失败后本轮待接数继续累积。

**修复**：

```js
const res = await fetchImpl(REPLY_API, {
  headers: { 'User-Agent': UA, Cookie: cookieHeader, Referer: 'https://www.bilibili.com/' },
  signal: AbortSignal.timeout(8000),
})
```
失败按 `1min → 5min → 15min` 退避，并把连续失败次数写进 `state.json`，概览 `inbox` 增加 `lastError` 字段供前端显示（而不是只在日志里）。

---

## P2-9　语料库 / 见闻索引的批量删除无留痕、无回收站

**现象**：`duty.log` 12:14:04–12:14:37 连续 5 条 `语料库已更新（remove / experience）：共 22→21→20→19→18→17 条`，随后 `见闻索引已更新（remove）：共 2→1 条`。

**根因**：`index.js:1469-1490` 的 `POST /persona/expression`、`POST /persona/lore` 直接落盘，只有一行日志，**无备份、无 undo、无操作来源**；同时 `prompts/persona/lore/` 下仍有 3 个 md（含 `food-wedding.md`），而索引降到 1 条 → **索引与正文文件脱钩（孤儿文件）**，正文还在但已不可达。

**修复方案**：

1. 写入前落快照：`store.js` 里 `editExpressionBank/editLoreIndex` 落盘前先写 `<file>.bak-<ts>`（保留最近 5 份）。
2. 删除改软删除：索引里置 `disabled:true` 并保留条目，编译期跳过；UI 给「恢复」入口。
3. 启动/保存时做孤儿检测：`prompts/persona/lore/*.md` 中未被索引引用的，日志告警并在素材库页标「未引用」。
4. 日志记录来源：`log('见闻索引已更新（remove）…' )` 追加 `req` 侧指纹（操作台 / API），便于回溯是谁改的。

---

## P3-10　「当前生效」用内部 id、下拉用展示名，看起来像配置与生效不一致

**现象**：设置页 `provider=DeepSeek`、`model=DeepSeek-V4.1-Flash`，而同行「当前生效」写 `deepseek-official / deepseek-flash`。**实际不是 bug**——`config.json` 里就是 `modelName: "deepseek-flash"`，`/models` 目录把它的展示名映射成「DeepSeek-V4.1-Flash」。只是两处口径不同（id vs name）。

**修复**：`client.js:2490-2491` 生效行改为显示 name，id 放 `title`：

```js
help: eff ? `${nameOf(eff.provider)} / ${nameOf(eff.model)}` : '取不到当前会话模型'
// 同级加 h('span',{className:'bf-mono',title:`${eff.provider} / ${eff.model}`})
```

---

## P3-11　`personaPrompt` 把绝对路径写进持久化配置

**现象**：`config.json` 里 `"personaPrompt": "D:\\projects\\bilbili\\dsh-plugin\\prompts\\persona-whale.md"`。

**风险**：换机器 / 移动仓库 / 打包分发后该路径静默不存在，人设直通悄悄失效（且没有告警）。

**修复**：配置里存**相对插件根**或 `preset:<id>`，运行时用 `fileURLToPath(import.meta.url)` 推导解析；找不到时基在 `personaHealth` 里报 warn，并在设置页该行显示「路径不存在」。

---

## 建议落地顺序

1. **P0-1 + P0-2**（一处根因 + 一处防御）——控制台立刻恢复正常，改完刷新页面即可验收。
2. **P1-3**（CSS 纵向堆叠）——视觉回归截图对比。
3. **P1-4 / P1-5**（缓存失效 + StringDecoder）——都属于「改完长期受益」的低风险修补。
4. **P2-6 ~ P2-9**（日志治理 + 回复轮询 + 人设留痕）。
5. **P3-10 / P3-11** 文案与可移植性。

> 待观察（不构成缺陷）：`12:18:20` 切 generic、`12:18:21` 切 whale 的秒级双切。预设按钮有 `disabled: !!busy`（`client.js:2107`），排除双击重复提交，推测是两个页面/标签各自操作，先记着不修。

---

# 修复进展（2026-10-28 20:45）

**基线**：`node --test test/*.test.js` → 修复前 208 pass，修复后 **209 pass / 0 fail**；`test/client.render-smoke.mjs` 全绿。

## 已修复

| 项 | 改动 | 验证 |
|---|---|---|
| **P0-1** SSE 首帧被丢 | `client.js` `accept()` 改为「已有数据才严格单调」（`r.hasData`）；`refresh()` 同口径；`applyTick()` 只丢更旧的 tick（原来 tick 的 seq 恒等于 `r.seq`，运行中秒表也一直不刷新）。`lib/api.js` `hello` 帧去掉 `seq`（服务端不再把客户端单调起点抬到首帧之上） | 新增 `test/api.test.js` 用例「hello 不得带 seq 把单调起点抬到首帧之上」：临时改回旧行为时该用例**失败**，还原后通过 |
| **P0-2** 空数据态误报 | `Banner` 只在 `health.cli !== undefined` 时判红；`Freshness` 无数据时显示「正在连接…」而非「数据 刚刚」；`AccountCard`/`PersonaHealthCard`/设置页 dsh CLI 行改三态（读取中 / 已探测 / 未找到） | render-smoke 新增断言：`ov:{}` 与「无 initialData」两种态下**不得**出现「找不到 dsh CLI」「数据 刚刚」「未找到」，且必须出现「正在连接…」「读取中…」 |
| **P1-3** 设置页竖排标签 | `Row` 增 `bf-row-wide` 类，宽控件行改 `flex-direction:column` 纵向堆叠（不再用 `width:100%` 抢主轴把标签列挤成 0 宽） | Chrome headless 截图：内容源/关键词/不看清单/人设提示词/dshBin/安装自检 全部横向正常 |
| **第 12 项** 账号基础信息区缺失 | v4 重做（`2893713`）把旧 `accountCard` 删掉了。新增 `AccountCard`：44px 头像（`face` + `no-referrer`，失败回退昵称首字）、昵称、大会员/LV 标签、UID、**粉丝 / 关注 / 硬币**、凭证状态（含「信息为缓存」）、检查时间、重新登录按钮 | render-smoke 断言「当前账号 / 蓝鱼小号 / UID 10000001 / LV6 / 粉丝 / 关注 / 硬币 / 重新登录」；另有「有 face 必须渲染 `<img>`」用例 |

顺带给 `ConsolePage` 加了 `initialSub`（与既有 `initialView` 同款），让快照脚本能截到设置页的三个子页签：`settings-content`、`settings-env`。

## 生效方式

- 插件在 `profiles/desktop/node_modules/dsh-bili-fenshen` 是**指向本仓库的 Junction**，改的是仓库文件本身。
- **前端（client.js）**：刷新页面即生效（客户端修复单独就能解决空数据态，不依赖服务端）。
- **服务端（index.js / lib/*）**：需重载插件或重启应用；重载后 `/stream` 的 `hello` 才不再带 `seq`（实测当前宿主仍在发旧格式）。

## 仍未修（按原优先级）

P1-4（dshBin 缓存 10 分钟不失效 + 探测日志噪音）、P1-5（`toText` 按块误判 GBK 导致 duty.log 中文乱码）、P2-6（按字符轮转日志）、P2-7（子进程 reasoning 全量落盘）、P2-8（回复轮询无超时）、P2-9（语料/见闻删除无留痕）、P3-10、P3-11。

