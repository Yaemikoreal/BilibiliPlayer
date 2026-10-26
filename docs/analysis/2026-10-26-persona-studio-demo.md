# 人设工作室演示稿 · 交付与验证记录（2026-10-26）

- **对应设计**：[2026-10-26-persona-module-v2-design.md](../superpowers/specs/2026-10-26-persona-module-v2-design.md)
- **对应实施记录**：[2026-10-26-p1-implementation.md](./2026-10-26-p1-implementation.md)
- **状态**：演示稿已交付、已渲染验证；**尚未接入插件真实页面**（改 UI 前的评审件）
- **产物**：`dsh-plugin/persona-studio-demo.html`（单文件，68,373 字节 / 644 行）
- **在线预览**：<https://artifacts.commandcode.ai/e0d3b8pxcid0cil6>（私有，7 天无发布后自动删除；仓库内文件为准）

---

## 1. 背景：这条工作线从哪来

上一会话完成了 P0 + P1，并明确了一个顺序约束：**改 UI 之前，先出一份可评审的 demo HTML**。

上一会话结束在“demo 已生成、校验脚本抓到一个真 bug、正在修”的位置。本次从该中断点接续：先把已知缺陷修掉，再把“能打开”升级为“逐页验证过”。

因此本记录只覆盖**演示稿这条线**，不重复 P1 的模块与测试内容（见实施记录）。

---

## 2. 本次完成的工作

| # | 事项 | 结果 |
|---|---|---|
| 1 | 定位中断点 | 读取上一会话归档，确认 `renderVersion` 反引号截断模板字面量 |
| 2 | 修复缺陷 | `active.json` / `personaPrompt` 的反引号改为「」 |
| 3 | 四层验证 | JSON、数据引用、JS 语法、无头浏览器渲染，全部通过 |
| 4 | 逐页渲染 | 8 个页签各截图一次，确认布局与数据都正常 |
| 5 | 发布预览 | 发布为私有 artifact，拿到可分享链接 |

---

## 3. 缺陷分析

### 3.1 症状

整个页签栏与内容区空白：应用脚本在解析阶段就抛 `SyntaxError`，`panesEl.innerHTML = ...` 从未执行。

### 3.2 根因

`renderVersion()` 用模板字面量返回 HTML，内部又用反引号包了字段名：

```js
function renderVersion() {
  return `
  <div class="note">
    每次保存写一份版本快照；`active.json` 一删回到默认预设；
    配置里填回 `personaPrompt` 就回到旧路。
  </div>`;
}
```

反引号在模板字面量里会**直接终止字符串**，后面的内容被当作代码解析，于是 `active.json` 的 `.` 或 `:` 触发 `SyntaxError: Unexpected token ':'`。

### 3.3 修复

改成中文引号，既避开语法问题，也更符合文档里其余位置的行文：

```diff
- 每次保存写一份版本快照（保留最近 20 个）；`active.json` 一删回到默认预设；
- 配置里填回 `personaPrompt` 就回到旧路（legacy 直通，行为一字不差）。
+ 每次保存写一份版本快照（保留最近 20 个）；「active.json」一删回到默认预设；
+ 配置里填回「personaPrompt」就回到旧路（legacy 直通，行为一字不差）。
```

### 3.4 为什么之前没发现

`node --check` 只对 `.js` 文件有效；直接打开 HTML 时浏览器报错停留在控制台，肉眼只看到“空白页”。本次把“提取 `<script>` 再单独做语法检查”固化成流程，这类问题就不会再漏。

---

## 4. 验证方法与结果（可复现）

演示稿本身是静态页，没有构建步骤，但“能打开”不等于“每页都对”。本次分四层验证：

| 层 | 检查 | 结果 |
|---|---|---|
| 1. 数据 | `<script id="data" type="application/json">` 能否 `JSON.parse` | ✅ 13 个顶层键 |
| 2. 引用 | 应用脚本里所有 `DATA.*` 是否都存在于数据块 | ✅ 12/12 全部解析 |
| 3. 语法 | 抽出 `<script>` 主体跑 `node --check` | ✅ 22,328 字符，0 错误 |
| 4. 渲染 | 无头 Chrome 打开并截图；8 个页签逐一激活后截图 | ✅ 8/8 正常 |

第 4 层的关键点：所有页签在初始化时就**一次性 render**（`panesEl.innerHTML = TABS.map(...)`），因此只要页面不是空白，就说明 8 个 renderer 全部执行成功。随后再逐页激活截图，确认各自的布局与深链数据。

复现命令（Windows / PowerShell）：

```powershell
# 1+2. 数据与引用
node -e "const fs=require('fs');const h=fs.readFileSync('dsh-plugin/persona-studio-demo.html','utf8');const j=JSON.parse(h.match(/<script id=\"data\" type=\"application\/json\">([\s\S]*?)<\/script>/)[1]);console.log('json ok',Object.keys(j).length)"

# 3. 语法：把应用脚本抽出来单独 check
#    （脚本正文从第 2 个 <script> 开始；实际执行时按 /* <script>([\s\S]*?)<\/script>/ 提取）

# 4. 渲染：无头 Chrome 截图
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-sandbox `
  --hide-scrollbars --window-size=1600,1200 --virtual-time-budget=4000 `
  --screenshot="$env:TEMP\persona-studio.png" `
  "file:///D:/projects/bilbili/dsh-plugin/persona-studio-demo.html"
```

逐页签截图的做法：复制一份 HTML，在 `</body>` 前插入
`<script>const k=location.hash.slice(1);const t=k&&document.querySelector('.tab[data-k="'+k+'"]');if(t)t.click();</script>`，
再以 `...#preview`、`...#quality` 等方式打开。

---

## 5. 演示稿内容说明

### 5.1 八个页签

| 页签 | 回答的问题 | 数据来源 |
|---|---|---|
| 卡片 | 人设卡里到底有什么、预算够不够 | 真实 `whale.card.json` |
| 编译预览 | 注入 prompt 的真实文本长什么样、放在哪 | `compilePersona()` 真实输出 |
| 质量 / L0 | 六条格式判据过没过、离真人基线多远 | `l0Checks()` + 247 条热评基线 |
| 语料库 | 6 个形态桶各有多少条、这轮抽哪几条 | `expression-bank.seed.json`（23 条） |
| 见闻库 | 为什么只能“索引常驻 + 正文按需读” | 卡内 `loreIndex` + `lore/*.md` |
| 今日状态 | 心情/时段/最近 3 条/欠账是怎么算出来的 | `deriveState()` + 真实账本 |
| 版本对比 | v1 和 v2 差在哪、砍掉的内容去哪了 | 真实 `persona-whale.md` 现算 |
| 试写沙盒 | 一条评论会被 lint 判成什么 | 真实历史评论 + 真实判定逻辑 |

### 5.2 数据真实性边界

- **真实**：卡片、编译产物、L0 结果、语料库、见闻正文、账本状态、v1→v2 对比数字。
- **真实判定、未接模型**：沙盒里的候选句取自真实历史评论，跑的是真实 lint 逻辑；但“按人设新生成 3 条”这一步没有调用模型（不花 token、不发 B 站）。
- **只读**：所有折叠、切桶、切页签都是前端交互，不写回任何文件。

### 5.3 快照数字

| 指标 | 值 |
|---|---|
| 人设编译总长 | **1,733** / 3,000 字符 |
| ├ P1 常驻核心 | 1,052 / 1,500 |
| ├ P2 见闻索引 | 227 / 300 |
| ├ P3 今日状态 | 208 / 500 |
| ├ P4 语料样本 | 129 / 450 |
| └ P5 最后一公里 | 117 / 250 |
| 整轮 prompt | **10,952** 字符 |
| argv 余量（上限 32,767） | 21,815 |
| L0 六条 | 6/6 pass |
| 表达库 | 23 条 / 6 桶 |

数据快照时间：`2026-10-26 23:10:56 +08:00`（本地时间 + 时区；此前显示的是 UTC，已修正。每次重跑 `demo:persona` 会刷新该字段）。

---

## 6. 如何重新生成数据

数据不是手写的：仓库内脚本 `dsh-plugin/scripts/inject-persona-demo.mjs` 把真实编译结果写进 HTML 的 JSON 块，`verify-persona-demo.mjs` 负责校验。两个脚本都已入库（2026-10-26 晚），不再依赖 `%TEMP%`。

```powershell
cd dsh-plugin
npm run demo:persona          # 重新注入数据（可重复执行）
npm run demo:persona:verify   # 四层校验；失败非 0 退出，成功打印 ALL OK
```

注入脚本做的事：

1. 从 `import.meta.url` 推仓库根，**不写死本机绝对路径**；
2. 用 `mkdtemp` 出来的临时 `BILI_FENSHEN_HOME` 跑编译/接线（不污染真实 `~/.dsh/bili-fenshen`），跑完删除临时目录；
3. **读**真实账本 `<os.homedir()>/.dsh/bili-fenshen/ledger.jsonl`（不存在/读坏都按空数组；一行多对象的脏行由 `readEvents` 逐行抢救）；
4. 固定演示场景「2026-10-26 02:10 本地 / roundId `2026-10-26T02:10:00.000Z`」，跑 `deriveState()` + `compilePersona()` + `l0Checks()` + `buildDutyPrompt()`（整轮长度取真实接线结果）；
5. 生成语料库视图、见闻库视图（正文按需读）、真实历史评论跑判定得到的沙盒、v1→v2 diff（v1 数字从 `prompts/persona-whale.md` 现算）；
6. 用 `/(<script id="data" type="application\/json">)([\s\S]*?)(<\/script>)/` 替换数据块，可重复执行；
7. 输出一行摘要：卡片 / 编译字符 / prompt 长度 / L0 pass 数 / 语料条数 / 沙盒判定。

> 演示场景固定，所以同一份代码重复执行只有 `generatedAt` 会变；该字段是**本地时间 + 时区**（`YYYY-MM-DD HH:mm:ss +08:00`），不是 `toISOString()` 的 UTC。

---

## 7. 已知限制

| # | 限制 | 影响 | 归属 |
|---|---|---|---|
| 1 | ~~注入脚本在临时目录，未入库~~ **已解决（2026-10-26 晚）** | 卡片/编译器改动后可用 `npm run demo:persona` 一键刷新 | ✅ 已入库 `dsh-plugin/scripts/` |
| 2 | 沙盒未接模型 | 只能展示“判定”，不能演示“生成” | P4 |
| 3 | 演示稿是只读视图 | 不能替代真实控制台的保存/版本/回滚 | P4 |
| 4 | 快照会过期 | 页面底部标注了 `generatedAt`，改代码后数字可能不一致 | 重跑注入脚本 |
| 5 | artifact 有 7 天有效期 | 链接过期后需重新发布；仓库文件不受影响 | 运维 |

---

## 8. 下一步

1. **先评审这份演示稿**：确认页签划分、信息密度、术语是否可接受。
2. ~~把注入脚本入库~~（已完成，见 §9）：演示稿现在可随代码重生成。
3. 评审通过后，按设计 §9 把 7 个页签接入真实控制台（`/api/bili-fenshen/persona/*` 已有 3 个端点，语料库/见闻库端点属 P2/P4）。
4. 接入时把“试写沙盒”单独排期（需要模型调用与配额保护），不要与只读页签混在一个里程碑。

---

## 9. 续做记录（2026-10-26 晚）

### 9.1 本次做了什么

| # | 事项 | 结果 |
|---|---|---|
| 1 | 注入脚本入库 | `dsh-plugin/scripts/inject-persona-demo.mjs`（13,541 字节）：`import.meta.url` 推仓库根、`mkdtemp` 临时 `BILI_FENSHEN_HOME` 隔离写入、真实账本容错读取、固定演示场景、可重复替换数据块 |
| 2 | 校验脚本入库 | `dsh-plugin/scripts/verify-persona-demo.mjs`（5,431 字节）：占位符 / JSON / 关键字段 / `node --check` / DOM id / 渲染函数 / div 开合，并加了两处数字修正的回归断言；失败非 0 退出 |
| 3 | npm 脚本 | `demo:persona`、`demo:persona:verify`（`dsh-plugin/package.json`，其余字段未动） |
| 4 | `generatedAt` 修正 | 由 UTC `2026-10-26 12:05:11` 改为本地时间 + 时区（最近一次重跑：`2026-10-26 23:10:56 +08:00`） |
| 5 | 版本对比页两处数字修正 | 红线行 v1 统计改为现算；禁止句占比行改诚实表述；词频行去掉重复括号（见 9.2） |
| 6 | 重新注入 + 复验 | `npm run demo:persona` / `demo:persona:verify` 全绿；无头 Chrome 截图确认版本页三行文案 |
| 7 | 回归测试 | `npm test`：153 pass / 0 fail |

产物：`dsh-plugin/persona-studio-demo.html` 现在 **68,373 字节 / 644 行**（数据块 JSON 16,935 字符）；快照时间见页脚 `generatedAt`（最近一次重跑 `2026-10-26 23:10:56 +08:00`）。

### 9.2 两处数字修正的证据

v1 的红线小节（`prompts/persona-whale.md` 的「红线（踩了就是出事）」）由脚本**现算**，不再写死：

- 共 **13 条**；**13 条全部是否定式**（其中 11 条直接以「不」开头，另 2 条是「游戏圈不引战」「贴吧腔别变成杠味」这类「名词前缀 + 否定」）；**0 条**写「那要写成什么」。同一实测口径见 `docs/research/2026-10-26-github-exemplars.md` 第 242 行。
- v1 禁止句：**5/165 = 3%**（全篇分句 165，以否定词开头 5）；13 条红线全是否定式、0 条给正向替代。
- v2 禁止句：**7/141 = 5%**（L0 `negative-ratio` 判据上限 25%）；9 条红线**全部带 instead**（正向替代）。所以「占比变高」不是变差——禁止句不是越少越好，关键是每条禁止都配「那要写成什么」。

版本对比页对应行现在这样显示（截图逐字确认，无乱码）：

```text
红线         − 13 条，11 条直接以「不」开头、13 条全是否定式，0 条写「那要写成什么」
             ＋ 9 条，全部带 instead（正向替代）
why          否定即粉红大象：只写"不许"会被那个画面捕获
禁止句占比   − 5/165 = 3%（13 条红线全是否定式、0 条给正向替代）
             ＋ 7/141 = 5%（9 条红线全部带 instead；L0 上限 25%）
why          禁止句不是越少越好；关键是每条禁止都配「那要写成什么」
形象词词频   − "鱼" 出现 18 次
             ＋ 无超限词
```

### 9.3 验证命令与输出

```powershell
cd dsh-plugin
npm run demo:persona
# OK 已注入演示数据：card=whale@2.0.0 编译=1733/3000 字符 prompt=10952 字符 L0=6/6 pass 语料=23 条 sandbox=FFFPPP

npm run demo:persona:verify
# OK   无 __DATA__ 残留
# OK   data JSON 可解析（16935 字符，13 个关键顶层字段齐全）
# OK   generatedAt 为本地时间 + 时区：2026-10-26 23:10:56 +08:00
# OK   DATA.* 引用全部可解析（12 个）
# OK   红线行 v1 统计为现算（全否定式 + 0 条正向替代）
# OK   禁止句占比行已改为诚实表述
# OK   形象词词频行无重复括号
# OK   内联脚本语法通过（node --check，1 段 / 22328 字符）
# OK   关键 DOM id 齐全（6 个）
# OK   渲染函数齐全（10 个）
# OK   div 开合平衡（143/143）
# === ALL OK ===

npm test
# tests 153 / pass 153 / fail 0
```

无头 Chrome 截图：`C:\Users\10369\AppData\Local\Temp\version.png`（1500×1300；`--headless=new --virtual-time-budget=3000`；复制 HTML 后在 `</body>` 前插 `setTimeout(()=>document.querySelectorAll('.tab')[6].click(),50)` 切到第 7 个页签「版本对比」）。**截图在临时目录，不入库**；仓库内只保留 HTML 与两个脚本。

### 9.4 续做：真实控制台已接「人设」只读页签（同日）

演示稿评审前先接只读部分（设计 §17.1）：真实控制台操作台新增「人设」tab，读取既有 `GET /persona` 与 `GET /persona/preview`，展示健康度/卡摘要/五块预算/L0 六条/今日状态/编译预览，并支持预设一键切换；legacy 模式明确标「卡未生效，切预设不会覆盖配置」。写入/版本/沙盒仍未做。验证：`test/client.render-smoke.mjs` 新增「人设 tab」「legacy」两组断言，`npm test` 153 pass。
