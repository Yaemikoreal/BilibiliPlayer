# DSH UI/UX 规范对齐清单（bili-fenshen 控制台）

> 产出：2026-10-27 · 读者：改造 **dsh-plugin/client.js** 的 Lead  
> 环境：Windows · DSH 桌面运行时 **@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.3**（app.asar/dsh/package.json:3）  
> 性质：只读分析，本文件是唯一产出，没有改任何代码。  
> **快照提示**：client.js 在分析期间正被并行修改（111,931 B / 2,398 行 → **146,811 B / 2,542 行**）。下文“现状”以 00:2x 的 146,811 B 版本为准，CSS 块位于 **client.js:57–605**；若实现继续前进，请按**选择器名**而不是行号对齐。

---

## 0. 摘要（最影响观感的 8 条）

1. **页面容器**：照抄宿主插件页（PluginManagerPage，S3）：**height:100% + overflow:auto + padding:0 clamp(24px,4vw,48px) 48px，子项 max-width:960px，页头 padding-top:28px**（macOS 再叠加 var(--dsh-frame-top-clearance)）。我们现在 1280/1400 + 24/28px，**偏宽 33%**。
2. **按钮**：页面工具条 **高 32 / 13px / 圆角 12 / 边框 .5px solid var(--dsw-alias-border-l3)**；small = **高 28 / 12px / 圆角 8**；primary 文字用 **var(--dsw-alias-label-primary-foreground)**；disabled **opacity:.4**。
3. **输入框**：**高 34 / 圆角 12 / border .5px solid var(--dsw-alias-border-l4) / background var(--dsw-alias-bg-layer-3)**；焦点用 **:focus-visible + border-color:var(--dsw-alias-state-business-primary)**（现在写的是 :focus + label-caption，方向和值都错）。
4. **开关**：**36×20、thumb 16、选中位移 16px**；off 轨道 var(--dsw-alias-border-l3)、off thumb var(--dsw-alias-switch-thumb)、**corner-shape:round**。我们是 34×20 / 位移 14。
5. **圆角只有 6 档**：4 / 8 / 12 / 16 / 20 / 28。卡片 **16（内容卡）/ 20（设置卡）**、弹窗 **28**、按钮 12/8、胶囊 999。
6. **字号只允许 5 档 token**：14/22、13/20、12/18、11/14，加标题 20/28、24/32。现有 **12.5、11.5、10.5、9.5、21、13/21** 约 20 处需吸附。
7. **焦点**：宿主全局 :focus-visible 是 **2px outline、颜色 var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))**；指针模态下宿主置透明。**不要 outline:none**，也不要用 :focus 画边框。
8. **corner-shape:round**：宿主全局 cornershape 为 superellipse(1.5)，只有胶囊/圆形显式 round。我们的 pill / switch / thumb / avatar / dot 都没写，会渲染成方圆形。

---

## 1. 来源：实际读到的文件与行号

### 1.1 怎么读的（可复现）

DSH 检出是**单个打包文件** D:/tools/deepseek harness/resources/app.asar（182,434,783 B，18,188 条目）；app.asar/dsh 不是目录；app.asar.unpacked 里只有原生依赖（koffi、node-pty、sherpa 等），**没有 client 包源码**。

- **read 工具可以直接读 asar 内的路径**：已实测读取 .../app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js:1413 成功（该文件 2,083 行）。
- pwsh / glob / rg **不能进 asar**（rg 报 os error 3）。本清单的 asar 内容通过解析 asar 头（header pickle 4,748,096 B，数据区起点 8+headerSize = 4,748,104）后按 offset 取字节得到，与 read 工具读到的字节一致。

### 1.2 证据清单（全部实际读到）

| # | 来源（asar 内相对路径 / 仓库路径） | 行号 | 覆盖内容 |
|---|---|---|---|
| S1 | dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js | **1407** base.css；**1413** design-platform.css；**1416** focus.css；**1422** scrollbar.css；**1425** gradient-shadow-text.css | 全部 --dsw-* token（浅/深）、字体/圆角、焦点、滚动条、阴影与 elevation、字号 token |
| S2 | @deepseek-ai/dsh-client-ui-layout/lib/client.js | **13** SIDEBAR_AUTO_COLLAPSE=1024；**38** computeColumns；**73** AppFrame CSS；**111** CenterColumn；**118** MainPanel | 三列布局、列宽求解、main 槽挂载位置、窗口留白变量 |
| S3 | @deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js | **1913**（PluginManagerPage.module.css，单行内联） | **宿主“插件页”标准容器**：960 / clamp 边距 / 页头 28 / 标题 20-500 / 工具条 32 |
| S4 | @deepseek-ai/dsh-client-ui-settings-general/lib/client.js | **60**（SettingsRoot.module.css） | 设置面板 800px / 导航 188px / 内容 padding 0 24 24 |
| S5 | @deepseek-ai/dsh-client-ui-settings-plugin-inventory/lib/client.js | **57** | settings.section 容器（max 760 / gap 14）与设置卡材质 |
| S6 | @deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js | **11** | settings section（max 760 / gap 12）、标题 18-600、下划线页签（gap 22 / padding 7-1-9 / 2px 下划线） |
| S7 | @deepseek-ai/dsh-web-frontend/dist/assets/index-BNyAYEM7.css | 2 行压缩，按选择器引用 | primitives 真实规格：._button_1rv3m_*、._switch_1ik0f_*、._tab_1p79o_*、._control_d62eq_*、._tab_d62eq_*、._tag_brmue_*、._pill_1bqmh_*、._checkbox_1wz3s_*、._input_bjqpo_107、._field_bjqpo_3、._form_ft7vz_*、._dialog_o6lrb_*、._toast_l6cvn_6、._list_4ub78_*、._item_4ub78_90、._paneBody_6nhg2_318 |
| S8 | @deepseek-ai/dsh-client-ui-layout/README.md | **30**（264–420 / 280 / 56）、**32**（main keyed 槽）、**39**（--dsh-frame-top-clearance 48px）、**41**（Windows titlebar） | 布局契约、窗口留白 |
| S9 | @deepseek-ai/dsh-client-ui-sidebar/README.md | **38**（面板行 2px gap）、**14**（56px rail） | panellist 行为（宿主负责渲染） |
| S10 | @deepseek-ai/dsh-client-ui-settings/README.md | **44** | settings.section 的归属与用途 |
| S11 | @deepseek-ai/dsh-client-ui-theme/README.md | **53**（modal mask 不模糊）、**62**（radius / settings-card 材质别名） | token 使用约束 |
| R1 | 仓库 dsh-plugin/client.js | **57–605**（STYLE）、905–930（Btn/Switch/Pill/Card）、2474–2495（SettingsEntry）、2513–2542（注册） | 我们的现状与注册面 |
| R2 | dsh-plugin/console-demo-v3.html | **16–119**（自造 --dsw-* 值） | v3 设计稿 token（**值有漂移，见 §2.6**） |
| R3 | docs/analysis/2026-10-26-console-ui-v3-design.md | **36**（26 个 token）、**53–61**（排版间距）、**66**（侧栏 216/64、顶栏 52）、**78**（组件清单） | v3 设计决策（**布局假设与宿主不符**） |
| R4 | dsh-plugin/CONSOLE-DESIGN.md | **14**（sidebar.panellist→main）、**97**（绑定 --dsw-*、左栏由宿主渲染） | 挂载模型（正确） |
| R5 | docs/demo/bili-fenshen-console.html | **12–47**（V2 自造 --bg-base 等，**没有 --dsw-***） | V2 预览：只能当视觉参考，不能当 token 来源 |
| R6 | docs/superpowers/specs/2026-10-23-bili-fenshen-console-design.md | **391–413** | 仓库已有的宿主 token 取值（**与 S1 一致，可交叉验证**） |

### 1.3 未查证（明确标出，未编造）

- **docs/web-styling.md**（S11 引用的 styling reference）：asar 内没有 docs/，读不到 → 组件规则的文字版未查证。
- **@deepseek-ai/dsh-client-ui-primitives 源码**：不在 asar 的 307 个包内；只有编译进 S7 的 CSS 结果（哈希选择器），组件 JS 行为未查证。
- **弹窗的焦点陷阱 / Escape / 键盘 roving / aria 模态语义**：只能读到 CSS 与 aria 属性，JS 行为未查证。
- 设置面板实际内容宽：由 CSS 推算 800 − 188（nav）− 48（padding）= **564px**，未真机量测。

---

## 2. 设计 token（唯一应使用的来源）

> 全部来自 S1 design-platform.css（浅色 body{} / 深色 body[data-ds-dark-theme]{}），值已解析为最终 hex。

### 2.1 背景 / 边框 / 文字阶梯

| 用途 | token | 浅色 | 深色 |
|---|---|---|---|
| 页面底 | --dsw-alias-bg-base | #ffffff | #151517 |
| 层 1（内容卡） | --dsw-alias-bg-layer-1 | #ffffff | #232324 |
| 层 2（弹窗/设置卡） | --dsw-alias-bg-layer-2 | #ffffff | #2c2c2e |
| 层 3（输入框） | --dsw-alias-bg-layer-3 | #ffffff | #353638 |
| 平台模块底 | --dsw-alias-bg-module-platform | #f5f6f7 | #353638 |
| 覆盖底 | --dsw-alias-bg-overlay | #e9ecf2 | #61666b |
| 侧栏底 | --dsw-specific-sidebar-fill | #f9fafb | #1b1b1c |
| 选择器底 | --dsw-specific-selector | #f5f6f7 | #353638 |
| 边框 1/2/3/4 | --dsw-alias-border-l1 / l2 / l3 / l4 | #0000000a / #0000001a / #0000001f / #00000029 | #ffffff0f / #ffffff1f / #ffffff29 / #fff3 |
| 主文字 | --dsw-alias-label-primary | #0f1115 | #f9fafb |
| 次文字 | --dsw-alias-label-secondary | #61666b | #cfd3d6 |
| 三级 | --dsw-alias-label-tertiary | #81858c | #adb2b8 |
| 说明/注脚 | --dsw-alias-label-caption | #adb2b8 | #81858c |
| 更弱/占位 | --dsw-alias-label-dimmed | #e1e5ee | #43454a |
| 品牌填充上的文字 | --dsw-alias-label-primary-foreground | #ffffff | #0f1115 |

### 2.2 品牌 / 语义 / 交互色

| 用途 | token | 浅色 | 深色 |
|---|---|---|---|
| 品牌主色 | --dsw-alias-brand-primary | #0f1115（近黑） | #f9fafb（近白） |
| 主按钮底 / 悬停 | --dsw-alias-button-primary-fill / -hover | 同品牌 / #43454a | 同品牌 / #ebeef2 |
| 悬停底 | --dsw-alias-interactive-bg-hover | #2631480f | #ffffff14 |
| 悬停实底 | --dsw-alias-interactive-bg-hover-solid | #f1f3f5 | #353638 |
| 按下底 | --dsw-alias-interactive-bg-active | #2631481a | #ffffff24 |
| 业务蓝（焦点/链接/信息） | --dsw-alias-state-business-primary | #4176e6 | #7aaaff |
| 业务蓝底 | --dsw-alias-state-business-tertiary | #e4edfd | #34415b |
| 成功 | --dsw-alias-state-success-primary / -tertiary | #22c55e / #e6faed | #22c55e / #233c2c |
| 警告 | --dsw-alias-state-warn-primary / -tertiary | #f59e0b / #fef5e7 | #f59e0b / #27241f |
| 错误 | --dsw-alias-state-error-primary | #ec1313 | #f25a5a |
| 空闲/关 | --dsw-alias-state-idle-primary | #d4d4d4 | #545557 |
| 开关 thumb | --dsw-alias-switch-thumb | #ffffff | #adb2b8 |
| 弹窗遮罩 | --dsw-alias-bg-mask-1 | #0000003d | #00000080 |
| Toast | --dsw-alias-toast-bg / -label | #353638 / #fff | #43454a / #fff |
| 滚动条 l1 | --dsw-alias-scrollbar-bg-l1 / -hover-l1 | #e5e5e5 / #d4d4d4 | #3c3c3d / #545557 |
| 滚动条 l2（面板内） | --dsw-alias-scrollbar-bg-l2 / -hover-l2 | #e5e5e5 / #d4d4d4 | #545557 / #65676b |

**注意**：宿主**没有** --dsw-alias-state-error-tertiary（那是 v3 设计稿编的）。错误底色一律 color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)。

### 2.3 字体栈与字号 token

| 角色 | 值 |
|---|---|
| 正文 | -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif |
| 品牌 | "Montserrat", 正文栈 |
| 代码 | "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei" |

| token | 值 | 用途 |
|---|---|---|
| --dsw-font-xl-24 | 600 24px/32px | hero 数字 / 大标题 |
| --dsw-font-l-20 | 500 20px/28px | **页面标题**、指标数字 |
| --dsw-font-m-18 | 500 16px/28px | 弹窗标题、次级标题 |
| --dsw-font-base-16 | 400 16px/24px | 大正文 |
| --dsw-font-s-14 / -s-strong-14 | 400 / 500 14px/22px | 正文、卡片标题 |
| --dsw-font-xs-13 / -xs-strong-13 | 400 / 500 13px/20px | **控件/正文主档** |
| --dsw-font-xxs-12 / -xxs-strong-12 | 400 / 500 12px/18px | 注脚、卡片说明 |
| --dsw-font-xxxs-11 / -xxxs-strong-11 | 400 / 500 11px/**14px** | 微标签、tag |

正文 body 只设字体栈和 -webkit-font-smoothing:antialiased，**不设全局 font-size**；各组件显式用上表（S7 body 规则、S1:1407）。

### 2.4 圆角 / 高度 / 间距

- **圆角**（S1:1407）：xs 4 · sm 8 · md 12 · lg 16 · xl 20 · panel 28；胶囊/圆形另加 border-radius:999px + corner-shape:round。
- 全局 **corner-shape:superellipse(1.5)**（S1:1410，@supports 生效）作用于 *，所以**我们自己画的圆必须显式 round**。
- **控件高度实测集合**：20（switch）· 24（pill/tag 行）· 28（sm 按钮/图标按钮/分段页签）· 32（页工具条按钮）· 34（设置输入/页签）· 36（md 按钮/搜索）· 40（弹窗大输入）· 44（facts 行）· 48（列表卡图标）。
- **页面级间距**（S3）：水平 clamp(24px,4vw,48px)、底部 48、页头 28、块间 32、工具条 gap 16。
- **卡片级**：卡间距 10、卡内 padding 12–16、字段行 padding:12px 0、按钮/标签 gap 4–8、设置字段组 gap 6。

### 2.5 阴影 / elevation / 动效 / 滚动 / 焦点

| 名称 | 值（S1:1425 / 1416 / 1422） |
|---|---|
| --dsw-elevation-stroke | 0 0 0 .5px var(--dsw-elevation-stroke-color, var(--dsw-alias-border-l4)) |
| --dsw-elevation-soft | stroke + 0 4px 16px #00000008, 0 0 24px #00000008 |
| --dsw-elevation-panel | stroke + 0 3px 8px #00000008, 0 0 16px #00000005 |
| --dsw-elevation-prominent | stroke + 0 3px 8px #0000000a, 0 0 20px #0000000d |
| --dsw-shadow-lv3 | 0 0 1px #0003, 0 0 4px #00000005, 0 12px 32px #00000014（toast / hovercard） |
| 动效 | --ds-transition-duration .2s / -fast .1s / -slow .3s；--ds-ease-in-out: cubic-bezier(.4,0,.2,1)；微交互 .12/.14/.16/.18s |
| 滚动条 | 宽 5px、border-radius:999px、background-clip:content-box、轨道透明；面板内重绑 --dsh-scrollbar-thumb 到 l2 变体（S7 ._paneBody_6nhg2_318） |
| 焦点 | --dsw-focus-ring-width: 2px；颜色 var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))；指针模态下 :focus-visible 环被置透明 |
| 遮罩模糊 | --dsw-mask-blur: none（S11:53 明确“modal mask 不模糊”） |

### 2.6 警告：v3 设计稿里的 token 值是自造值，不能当来源

console-demo-v3.html:16–119 手写了一整套 --dsw-*，与宿主真实值不一致。举例（宿主 → v3 稿）：

| token | 宿主（S1:1413） | v3 稿（R2） | 后果 |
|---|---|---|---|
| --dsw-alias-bg-layer-2 | #ffffff | #f7f8fa | 浅色下卡片被涂灰，宿主不会 |
| --dsw-alias-bg-layer-3 | #ffffff | #f1f3f5 | 输入框在浅色下变灰 |
| --dsw-alias-label-tertiary | #81858c | #5f646c | 三级文字过深 |
| --dsw-alias-label-caption | #adb2b8 | #6b7078 | 注脚过深 |
| --dsw-alias-state-success-primary | #22c55e | #15803d | 绿不对 |
| --dsw-alias-state-business-primary | #4176e6 | #1d4ed8 | 蓝不对 |
| 深色 bg-base | #151517 | #141416 | 轻微偏冷 |

**结论**：client.js 现在用 var(--dsw-*) 是对的（:57–105 映射层），继续用；**不要把 v3 HTML 的 hex 抄进来**，也不要用 v3 的 --shadow-1/2。

---

## 3. 宿主布局约束

### 3.1 三列 AppFrame（S2:13/38/73，S8:30–41）

computeColumns(viewport, sidebar, rightbar, collapsedWidth = 56)：

| 项 | 规则 |
|---|---|
| 侧栏 | 用户可拖 **264–420**；默认 **280**；收起后 **56px rail** |
| 自动折叠 | viewport < **1024**（SIDEBAR_AUTO_COLLAPSE=1024） |
| 右栏 | 0 或 clamp(300, viewport*0.7)；首次打开 viewport*0.45；给中心区保底 **400**，不够先关右栏 |
| 中列 | viewport − sidebar − rightbar，可降到 0 |
| 窗口留白 | macOS：--dsh-frame-top-clearance:48px；Windows：--dsh-frame-top-clearance = --dsh-windows-titlebar-height，同时 --dsh-frame-chrome-top 同值；两者 --dsh-frame-overlay-top = clearance + 20px；Windows 内容区左上圆角 --dsh-windows-content-radius:16px |

### 3.2 main slot = 整个中列（我们的页面）

S2:111/118 证实：MainPanel → renderSlot('main', {}) 直接挂在 CenterColumn（.mP3x-q_centerCol{display:flex;flex-direction:column;min-width:0;overflow:hidden}）内——**宿主不给 padding，也不给滚动，中列自身 overflow:hidden**。页面必须写成“全高 + 自己滚”。

宿主里同类“插件页”的标准写法（S3:1913，PluginManagerPage，**直接照抄**）：

    .page{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;
          gap:32px;padding:0 clamp(24px,4vw,48px) 48px;overflow:auto;color:var(--dsw-alias-label-primary)}
    .page>*{width:100%;max-width:960px}
    .pageHead{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;
          gap:16px;padding-top:28px}
    [data-platform=darwin] .pageHead{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
    .pageTitle{margin:0;font-size:20px;font-weight:500;line-height:28px}
    .pageIntro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}

对照我们（client.js:511）：.bf-shell-inner{max-width:1280px;padding:24px 28px 48px}；.bf-page{max-width:1400px}（且 .bf-page 已无 JS 引用、属死样式）。**结论：容器宽 960、页头 28、水平 clamp、底部 48。**

### 3.3 settings.section 的容器（S4:60，S5:57，S6:11）

设置不是页面，是**模态面板**里的一个 section：

| 层级 | 规格 |
|---|---|
| 设置面板 | width:800px；max-width:calc(100vw − 48px)；max-height:min(800px, 100vh − 2*max(24px, var(--dsh-frame-overlay-top)))；border-radius:var(--dsw-radius-panel)；background:var(--dsw-alias-bg-layer-2)；box-shadow:var(--dsw-elevation-prominent) |
| 左导航 | width:188px；padding:22px 12px 0 |
| 头部 | height:54px；padding:20px 14px 8px 10px |
| 内容区 | flex:1；min-height:0；padding:0 24px 24px；overflow-y:auto（推算内容宽 ≈ **564px**） |
| 一个 section | max-width:760px；display:flex；flex-direction:column；gap:12–14px |
| section 标题 | font-size:18px；font-weight:600 |
| section 说明 | font-size:13px；color:var(--dsw-alias-label-tertiary) |
| 设置卡 | border:.5px solid var(--dsw-alias-settings-card-stroke)；border-radius:var(--dsw-radius-xl)；background:var(--dsw-alias-settings-card-fill)（base.css 把两个别名指到 layer-2 / border-l4） |

我们现状（client.js:2478）：h('div', {className:'bf-console', style:{padding:16}}) —— **把页面壳（height:100%;overflow-y:auto）套进了设置面板**，会出现双重滚动 + 多 16px 内边距，内容宽度也没约束。**必须拆**（见 §6-1）。

### 3.4 侧栏：宿主已经画好，我们不要再画

- 宿主负责 rail 尺寸（280/56）、面板行、选中态、tooltip、2px 行距（S9:38）；我们只注册 sidebar.panellist 图标 + main 页面（R1:2513–2542 已正确）。
- 因此 **v3 设计稿里的“侧栏 216px（折叠 64）+ 顶栏 52px + 内容 max 1320 + <1180 折叠”（R3:66/67/73）全部作废**：宿主是 **280/56、<1024 折叠**，且没有全局顶栏（每页自己画页头）。当前 client.js 没有自绘侧栏（好），bf-shell 是无样式的空类名（可删）。

---

## 4. 组件对照表（最重要）

> “宿主规格”来自 S1/S3–S7；“现状”行号指当前 client.js 的 STYLE 块；“建议”可直接落 CSS。级别：**必改 / 可选**。

| # | 组件 | 宿主真实规格 | client.js 现状 | 建议改成 |
|---|---|---|---|---|
| 1 | **按钮**（默认/primary/ghost/danger/尺寸） | ._button_1rv3m_2：inline-flex、gap 4、border-radius 12、14/22、padding 0 14；._sm_1rv3m_28：**28 高 / 12px / 18lh / pad 0 10 / radius 8**；._md：36 高；插件页工具条按钮 **32 高 / 13px / radius 12**（S3）；primary = button-primary-fill + label-primary-foreground，hover button-primary-hover；ghost hover interactive-bg-hover、active -active；outline border .5px solid var(--dsw-alias-border-l3)；disabled opacity:.4 | .bf-btn（:171–187）：**高 30**、pad 0 12、radius 8、border .5px solid var(--border-l4)、13/20；primary color:var(--bg-base) + font-weight 500；small 26/12；disabled .45；danger 边框 l2 | **必改**：默认 **高 32 / pad 0 12 / radius 12 / 13-20 / 边框 l3**；small **28 / 12 / 18 / pad 0 10 / radius 8**；primary 文字 **var(--dsw-alias-label-primary-foreground)**、去 500；hover 仅变体生效；disabled **.4**；danger 边框 **color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)**；加 :focus-visible 2px 环 |
| 2 | **图标按钮** | 28×28 / radius 8 / color label-secondary / hover 底 interactive-bg-hover + 文字主色 / svg 15–16 / disabled .4（S3、S7 ._iconButton_*） | 无专项类；用 ghost small 文本按钮代替 | **可选**：新增 .bf-iconbtn（28×28 / radius 8），供刷新/关闭/删除用 |
| 3 | **输入框 / 文本域** | 设置输入（S7 ._input_bjqpo_107）：**高 34 / pad 0 12 / border .5 l4 / radius 12 / bg layer-3 / 13px / line-height 1.5**；:focus-visible{border-color:business}；:disabled{color:label-tertiary}；[aria-invalid=true]{border-color:error}；placeholder label-dimmed；弹窗输入 40 高（S3） | .bf-select（:409–416）30 高 / radius 8 / bg layer-2 / focus border-color:label-caption；.bf-search（:474）30 高；textarea（:386–391）min 76 / pad 8 10 / radius 8 / bg layer-2 / 13-21 / focus caption | **必改**：统一 **34 / radius 12 / .5px l4 / bg layer-3 / 13-1.5**；textarea pad 8 12；**:focus → :focus-visible** 且颜色改 **state-business-primary**；placeholder label-dimmed；--input 局部变量改指 bg-layer-3 |
| 4 | **下拉** | 交付 CSS 里**没有原生 select 规格**（未查证）；宿主选择器走自定义菜单：--dsw-menu-surface-fill + blur(40px) saturate(150%)、radius lg、padding 4、item min-h 34 / radius 12 / 13-20 / hover interactive-bg-hover | .bf-select 原生 select（:409），30 高 / radius 8 | **必改（保守版）**：按输入框 34/12/l4/layer-3 改，不引入菜单；**可选**后续换宿主式 MenuSurface（本轮不建议） |
| 5 | **数字步进器** | 宿主无独立 stepper；用 28 高图标按钮 + 输入框组合（S7 ._iconButton 28×28 / radius 8；输入 34） | .bf-num（:361–372）高 30 / radius 8 / border l4 / bg layer-2；按钮 26 宽 | **必改**：外壳 **34 / radius 12 / bg layer-3**；按钮 **28 宽**、hover interactive-bg-hover；focus-within{border-color:business} |
| 6 | **开关** | ._switch_1ik0f_5：**36×20**、padding 2、radius 999 + corner-shape:round、off 轨道 --dsw-alias-border-l3、on 轨道 --dsw-alias-brand-primary；thumb 16、on 位移 **16px**、on thumb label-primary-foreground、off thumb --dsw-alias-switch-thumb；disabled .5；focus 2px 环 offset 2 | .bf-switch（:190–200）：**34×20 / radius 10 / bg idle**；thumb 16 白色 + 0 1px 2px rgba(0,0,0,.22)；on 位移 **14px**、thumb var(--bg-base) | **必改**：36×20、位移 16、off 用 border-l3、off thumb switch-thumb、去阴影、corner-shape:round、disabled .5、focus 环 |
| 7 | **标签 / 胶囊 / 过滤 chip** | 胶囊 ._pill_1bqmh_1：**高 24 / pad 0 8 / radius 999 + round / 12-18 / label-secondary / bg layer-2**；active：bg button-ghost-active-fill + box-shadow:inset 0 0 0 1px button-ghost-active-border。静态 tag ._tag_brmue_4：radius 999、pad **1px 8px**、**11px/17px**、500；色调用 color-mix(...,10%/12%) | .bf-pill（:160）12-18 + border .5 l2 + bg module（≈22 高）；.bf-chip（:248）11-16 / radius 4 / border l1；.bf-chipbtn（:569）24 高 / radius 4 / 11.5-22；.bf-tag（:374）26 高 / radius 8；.bf-grade 11-16 / radius 4 | **必改**：pill → **24 高、去边框、bg layer-2、12-18、round**；静态 tag → **11-17、500、radius 999、round**，色调用 color-mix 10%（info/success）/ 12%（warn）；过滤 chip → **24 高、999、12-18、bg layer-2**，aria-pressed=true 走宿主 active（inset 1px 环 + ghost-active-fill） |
| 8 | **卡片** | 设置/清单卡（S5:57）：**border .5px solid var(--dsw-alias-settings-card-stroke) + border-radius var(--dsw-radius-xl)（20）+ background var(--dsw-alias-settings-card-fill)**；内容 padding **12px 14px**；标题 **14/20 500**；描述 12/18 tertiary；hover interactive-bg-hover；插件列表卡 head padding 8、图标 48 / radius 16 | .bf-card（:134–138）：border .5 l2 / radius 12 / bg layer-1 / padding 14 16；标题 13-20 500；卡间 10 | **必改（配置/信息卡）**：settings-card 材质 + **radius 20**、标题 **14-20 500**；内容列表卡可留 **radius 16 + border l2 + bg layer-1**；卡间 10 保持 |
| 9 | **列表行** | 交互行（S7 ._item_4ub78_90）：**min-h 34 / pad 6 8 / radius 12 / 13-20 / hover interactive-bg-hover / focus-visible 同 hover 无环**；紧凑行 min-h 24 / pad 2 6 / radius 8 / 11-17；带分隔行（S3 ._row）**pad 12 2 + border-bottom .5px l2**；facts 行 **min-h 44 / pad 8 2 / border-bottom .5px l2 / 13-20**；设置字段行 **stacked、gap 6、padding 12px 0、border-top .5px l2** | .bf-artifact-item（:482）pad 7 10 / radius 8 / 12；.bf-log-line（:397）6 0 / 12-19 / border **l1**；.bf-mini-row 9 0 / border l1；.bf-kv-row（:533）8 0 / border l1；.bf-diag-item 7 0 / border l1 | **必改**：分隔线**统一 l2**；交互行 → **34 / 6-8 / radius 12 / 13-20 / hover**；数据行 → **min-h 44 / pad 8 2**；设置字段行 → **stacked** |
| 10 | **页签** | ①下划线（S6:11）：容器 **gap 22** + border-bottom .5px l2；tab **padding:7px 1px 9px**、**13-20**、tertiary；hover/active **13-20 label-primary**；active ::after 2px、bottom:-1px、border-radius:2px 2px 0 0、label-primary；focus 2px 环 offset 2。②pills 页签（S7 ._tabs_1p79o_1）：容器 pad 4 / radius 16 / bg module；tab **34 高 / pad 0 12 / radius 12 / 14-20**，选中 600 + indicator（border .5 l3 + bg layer-3 + radius 12）。③分段（S7 ._control_d62eq_11）：容器 **gap 2、padding 4、radius 12、bg interactive-bg-hover**；tab **28 高 / pad 0 16 / radius 8 / 13-20 / 500**；指示块 bg layer-1 + elevation-soft | .bf-nav（:517–523）gap 20 / pad 6 0 10 / 13-20；**选中加 500** + 2px label-primary；.bf-ctabs（:342）gap 18 / pad 0 0 9 / 选中 500；.bf-subtabs 12.5；.bf-segmented（:118–131）pad 2 / radius 8 / bg selector / 按钮 pad 4 14 / radius 6 / 选中 bg-base + box-shadow 0 0 0 .5px l2 | **必改**：三处下划线页签统一到 ①（**gap 22 / pad 7-1-9 / 13-20 / 选中不改字重 / 2px 下划线 / focus 环**）；.bf-segmented → ③（**padding 4 / radius 12 / gap 2 / bg interactive-hover / 按钮 28 高 pad 0 16 radius 8 / 选中 bg layer-1 + elevation-soft**） |
| 11 | **设置分组（section）** | S4/S5/S6：**max-width 760 / gap 12–14**；标题 **18/600**；说明 13/tertiary；字段 **stacked**：label 13/500、gap 6、padding:12px 0、border-top .5px l2；帮助 12/1.6 secondary；重置 12/1.5 secondary；保存条 padding-top:16px + gap 8；保存键 13px / padding:5px 14px / radius 12 / bg label-primary / color bg-layer-3 | SettingsEntry（:2474–2495）：.bf-console + inline padding:16 包 Card；.bf-form-group（:355）margin-top 18 / border-top .5 l1；.bf-row（:357）**左标签 132px** / pad 7 0 / min 34；help 11-16 caption；.bf-form-foot margin 18 / pad-top 14 / border l1 | **必改（外层）**：SettingsEntry 根改 **bf-console bf-settings-section**（去掉 height/overflow 与 padding:16），max-760 / gap 12 / 标题 18-600 / 说明 13-tertiary；**字段建议改 stacked**（宿主没有“左标签”行）；分隔线 l2；帮助 12-1.6 secondary；保存条 pad-top 16 无边框 |
| 12 | **空状态** | 宿主就是一段文字：color label-tertiary；font-size 13px；line-height 20px；margin 0（S3 ._empty、S7 ._empty_8z71b_201 / ._empty_6nhg2_143）——**没有虚线框、没有底色** | .bf-empty（:321–325）：border .5 dashed l2 / radius 12 / padding 42px 20px / background layer-1；标题 14/500 | **必改**：去虚线/底色/圆角，**padding:24px 0**，正文 **13-20 tertiary**，标题 **14-22 500 secondary**，按钮组 gap 8 margin-top 12 |
| 13 | **弹窗（扫码登录）** | S7 ._dialog_o6lrb_*：遮罩层 padding:max(24px, var(--dsh-frame-overlay-top,24px)) 24px；mask background var(--dsw-alias-bg-mask-1) + backdrop-filter var(--dsw-mask-blur)（=none）；dialog **width:min(380px,100%) / border-radius var(--dsw-radius-panel) / background layer-2 / box-shadow elevation-prominent / gap 20 / padding 0 0 24px / overflow hidden**；标题 **16/24 500**、header padding 22 14 12 24；正文 14/22、padding 0 24；body margin-top 20；footer padding 0 24 / gap 8；关闭 28 / radius 8；容器 focus 无环 | .bf-modal-mask（:595–597）rgba(0,0,0,.42) + grid place-items；.bf-modal（:598–601）**284 宽 / radius 12 / border .5 l2 / bg layer-1 / padding 16 / 自定义阴影**；状态 13；按钮组 margin 12 | **必改**：380 / radius **28** / bg **layer-2** / elevation-prominent / 无边框；mask 用 bg-mask-1 + mask-blur；标题 16-24 500 + header padding；正文 14-22 padding 0 24；按钮组右对齐 padding 0 24 gap 8 margin-top 20 |
| 14 | **横幅 banner** | 警告条（S3 _installSafety）：background warn-tertiary；radius 12；padding 10px 12px；12/18；color label-secondary；16px 图标。成功条：bg success 10%；radius 12；padding 8px 12px；13/20。错误条（S7 ._brokenNote）：bg error 8%；radius 16；padding 8px 10px；12/18；color error | .bf-banner（:328–339）：border .5 l2 / radius 8 / padding 8 12 / 13-20；warn 额外 30% 边框；error 8% + 26% 边框 | **必改**：去边框；warn **radius 12 / padding 10 12 / 12-18**；error **radius 16 / padding 8 10 / 12-18 / 文字 error**；图标 16 |
| 15 | **Toast（当前未实现）** | S7 ._toast_l6cvn_6：fixed top 40、居中、padding 12 16 / radius 16 / bg toast-bg / color toast-label / 14-22 / shadow lv3；最大宽 min(640px, 100vw−48px) | 无 | **可选**：保存成功/失败时补宿主式 toast，替代 alert/confirm |

---

## 5. 交互状态

### 5.1 状态矩阵（宿主值）

| 状态 | 宿主规则 | 我们现在的差距 |
|---|---|---|
| hover | 底 --dsw-alias-interactive-bg-hover（浅 #2631480f / 深 #ffffff14）；ghost、工具栏按钮、菜单项、胶囊统一；只有 hover 才出底色 | 有，但 .bf-chipbtn:hover 只改文字颜色（应加底） |
| active | 底 --dsw-alias-interactive-bg-active；按钮仅 ghost 有 active | 有（.bf-btn:active 对所有变体生效，可保留） |
| focus-visible | 全局 **2px outline + business 蓝**；组件内自定义（switch/checkbox/tab/字段）offset 2px；菜单项用 hover 底代替环；输入框只改边框色 | **全无**：client.js 没有一条 :focus-visible；只有 3 条 :focus 改边框（textarea/select/search，颜色还是 label-caption），鼠标点击也会触发，语义错 |
| disabled | 按钮 opacity:.4 + cursor:not-allowed；开关/复选 .5 + cursor:default；字段 color label-tertiary | 按钮 .45；无开关 disabled 样式；无字段 disabled |
| 选中 | 页签 aria-selected + 颜色/下划线；开关 role=switch + aria-checked；胶囊 active 用 inset 1px 环；分段用指示块 | 语义齐（aria-selected / aria-checked 都在），视觉按 §4-10 改 |
| 不可用/只读 | 宿主对不可写设置显示 margin:0 0 12px; font-size:12px; line-height:1.5; color:label-tertiary 的只读提示（S7 ._readOnly_ft7vz） | 无（可补） |
| 滚动条 | 5px、圆头、轨道透明；面板内重绑 l2；侧栏指针离开即隐藏 | 用宿主全局即可；内嵌滚动区建议重绑 l2 变体 |
| 动效 | .2s / .1s / .3s，ease cubic-bezier(.4,0,.2,1)；prefers-reduced-motion 关闭所有动画/过渡 | client.js 有 --dur:.2s 和 ease（正确），但**没有 reduced-motion 兜底** |

### 5.2 键盘可达性（源码可见的部分）

- 全局 focus.css：:focus-visible{outline-width:2px; outline-color:var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))}；html[data-input-modality=pointer] body :focus-visible:not(:read-write){outline-color:transparent}（**指针用户不显示环，键盘用户显示**——所以我们不能自己 outline:none，否则键盘用户完全看不到焦点）。
- 自定义控件显式环：switch / checkbox / tab / facts 等统一 :focus-visible{outline:2px solid ...; outline-offset:2px}（个别 −2 / 1 / 3，按控件内缩）。
- [data-dsh-automatic-focus]:focus{outline:none}：宿主对“程序化聚焦”的容器主动去环，组件内部另有 outline 方案——不要模仿到可聚焦按钮上。
- 语义属性：开关用 role="switch" + aria-checked（宿主 CSS 就按这个选），页签 role="tab" + aria-selected，菜单 role="menuitem"；我们已具备。
- **未查证**：弹窗焦点陷阱、Escape 关闭、Tab 循环、roving tabindex 的行为实现（只有 CSS，无 JS 源码）。

---

## 6. 落地建议（最小改动、最大收益，按顺序）

| # | 改动 | 必/可选 | 预计收益 |
|---|---|---|---|
| 1 | **拆壳**：.bf-console 只留 token 映射；新增 .bf-root{height:100%;min-height:0;overflow-y:auto;background:var(--dsw-alias-bg-base)} 给 ConsolePage；SettingsEntry 去掉 height/overflow/padding:16，改用 .bf-settings-section | **必改** | 消除设置页双重滚动/多余内边距；滚动模型与宿主一致 |
| 2 | **页面容器**：.bf-shell-inner{max-width:960px;padding:28px clamp(24px,4vw,48px) 48px} + darwin 页头 clearance | **必改** | 一屏观感立刻“像宿主”（宽度/边距是最大差异） |
| 3 | **按钮**：32 / 13 / radius 12 / l3 边框；small 28 / 12 / radius 8；primary 文字 label-primary-foreground；disabled .4；focus 环 | **必改** | 所有页头/卡片操作区统一 |
| 4 | **输入族**：34 / radius 12 / l4 / layer-3；:focus-visible + business 边框；placeholder dimmed；--input → layer-3 | **必改** | 设置页/搜索/模型下拉立刻同源 |
| 5 | **开关**：36×20、位移 16、off 用 border-l3、thumb token、round、disabled .5、focus 环 | **必改** | 设置页高频控件 |
| 6 | **标签体系**：pill 24 / 无边框 / layer-2；静态 tag 11-17 / 999 / round；过滤 chip 24 / 999 + 宿主 active；全部加 corner-shape:round | **必改** | 活动页/概览页 chip 密度与形状 |
| 7 | **卡片材质**：设置/配置卡 → radius 20 + settings-card-fill/stroke；标题 14-20 500 | **必改** | 深色下卡片层次正确（现在 layer-1 偏暗） |
| 8 | **页签 + 分段**：下划线页签 22 / 7-1-9 / 2px label-primary；segmented → padding 4 / radius 12 / 28 高 / elevation-soft | **必改** | 导航区观感 |
| 9 | **字号吸附**：12.5→13、11.5→12、10.5/9.5→11、21→20、13/21→13/20、13/19→13/20；.bf-app-title 600→500；.bf-card-title 13→14；.bf-app-sub → 13-20 secondary | **必改** | 统一节奏；中文行高不再半像素 |
| 10 | **空状态 / banner / 弹窗**：空态去虚线框；banner 去边框改宿主底色；弹窗 380 / 28 / layer-2 / elevation-prominent / mask token | **必改** | 三处“一眼不像宿主”的地方 |
| 11 | **分隔线与列表行**：border-l1 → border-l2（约 20 处）；交互行 34 / 6-8 / radius 12；数据行 44 / 8 2 | **可选（视觉收益高）** | 列表可读性/层级 |
| 12 | **收尾**：所有 :focus 改 :focus-visible；加 prefers-reduced-motion；内嵌滚动区重绑 --dsh-scrollbar-thumb 到 l2；删死样式 .bf-page* / .bf-shell | **可选** | 键盘/无障碍/一致性 |

---

## 附录 A：可直接合并进 STYLE 的 CSS 草案

> 追加在 STYLE 末尾（同优先级覆盖前文），或按注释替换对应块。**只用宿主 token，不写 hex**（B 站粉/蓝除外）。

    /* ── A1 壳层：token 作用域 / 页面滚动 / 页面容器 ───────────────── */
    .bf-console{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
    .bf-root{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-base)}
    .bf-shell-inner{width:100%;max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px}
    [data-platform="darwin"] .bf-shell-inner{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
    @media (max-width:680px){.bf-shell-inner{padding:20px 16px 40px}}
    .bf-app-head{gap:16px;margin-bottom:16px}
    .bf-app-title{font-size:20px;line-height:28px;font-weight:500}
    .bf-app-sub{margin-top:4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}

    /* ── A2 按钮 / 图标按钮 ──────────────────────────────────────── */
    .bf-btn{height:32px;padding:0 12px;border-radius:var(--dsw-radius-md);
      border:.5px solid var(--dsw-alias-border-l3);background:transparent;
      color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:400;gap:4px}
    .bf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
    .bf-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
    .bf-btn.primary{background:var(--dsw-alias-button-primary-fill);
      color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
    .bf-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
    .bf-btn.ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}
    .bf-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);
      color:var(--dsw-alias-label-primary)}
    .bf-btn.small{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);
      font-size:12px;line-height:18px}
    .bf-btn:disabled{opacity:.4;cursor:not-allowed}
    .bf-btn.danger{color:var(--dsw-alias-state-error-primary);
      border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent)}
    .bf-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
      padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;
      color:var(--dsw-alias-label-secondary);cursor:pointer}
    .bf-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);
      color:var(--dsw-alias-label-primary)}
    .bf-iconbtn:disabled{opacity:.4;cursor:default}
    .bf-console :is(button,[role="button"],[role="tab"],[role="switch"],a[href]):focus-visible{
      outline:var(--dsw-focus-ring-width) solid
        var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}

    /* ── A3 输入族 ──────────────────────────────────────────────── */
    .bf-select,.bf-search,.bf-input{box-sizing:border-box;height:34px;padding:0 12px;
      border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
      background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
      font-size:13px;line-height:1.5;outline:none}
    .bf-console textarea{min-height:76px;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l4);
      border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);
      font-size:13px;line-height:1.5;resize:vertical;outline:none}
    .bf-select::placeholder,.bf-search::placeholder,.bf-console textarea::placeholder{
      color:var(--dsw-alias-label-dimmed)}
    .bf-select:focus-visible,.bf-search:focus-visible,.bf-input:focus-visible,
    .bf-console textarea:focus-visible{border-color:var(--dsw-alias-state-business-primary)}
    .bf-select:disabled,.bf-search:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
    .bf-num{height:34px;border:.5px solid var(--dsw-alias-border-l4);
      border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3)}
    .bf-num:focus-within{border-color:var(--dsw-alias-state-business-primary)}
    .bf-num button{width:28px;background:transparent;color:var(--dsw-alias-label-secondary)}
    .bf-num button:hover{background:var(--dsw-alias-interactive-bg-hover);
      color:var(--dsw-alias-label-primary)}
    .bf-num input{width:44px;font-size:13px;font-variant-numeric:tabular-nums}

    /* ── A4 开关 ────────────────────────────────────────────────── */
    .bf-switch{width:36px;height:20px;padding:2px;border:0;border-radius:999px;
      corner-shape:round;background:var(--dsw-alias-border-l3);flex:0 0 36px}
    .bf-switch::after{top:2px;left:2px;width:16px;height:16px;border-radius:50%;
      corner-shape:round;background:var(--dsw-alias-switch-thumb);
      box-shadow:none;transition:transform .12s ease}
    .bf-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
    .bf-switch[aria-checked="true"]::after{transform:translateX(16px);
      background:var(--dsw-alias-label-primary-foreground)}
    .bf-switch:disabled{opacity:.5;cursor:default}

    /* ── A5 胶囊 / 标签 / 过滤 chip ─────────────────────────────── */
    .bf-pill{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;
      border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-2);
      color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
    .bf-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:0;
      border-radius:999px;corner-shape:round;font-size:11px;line-height:17px;font-weight:500;
      color:var(--dsw-alias-label-tertiary)}
    .bf-chip.cmt{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);
      color:var(--dsw-alias-state-business-primary)}
    .bf-chip.rep{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);
      color:var(--dsw-alias-state-success-primary)}
    .bf-chip.warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);
      color:var(--dsw-alias-state-warn-primary)}
    .bf-grade{border:0;border-radius:999px;corner-shape:round;padding:1px 8px;
      font-size:11px;line-height:17px;font-weight:500}
    .bf-chipbtn{display:inline-flex;align-items:center;height:24px;padding:0 8px;border:0;
      border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-2);
      color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
    .bf-chipbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
    .bf-chipbtn[aria-pressed="true"]{color:var(--dsw-alias-label-primary);
      background:var(--dsw-alias-button-ghost-active-fill);
      box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}

    /* ── A6 卡片 ────────────────────────────────────────────────── */
    .bf-card{border:.5px solid var(--dsw-alias-settings-card-stroke);
      border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);
      padding:14px 16px}
    .bf-card-title{font-size:14px;line-height:20px;font-weight:500}
    .bf-metric{border-radius:var(--dsw-radius-lg)}  /* 指标块保留 layer-1 + border-l2 */

    /* ── A7 页签 / 分段 ─────────────────────────────────────────── */
    .bf-nav,.bf-ctabs,.bf-subtabs{display:flex;gap:22px;
      border-bottom:.5px solid var(--dsw-alias-border-l2);margin:10px 0 18px;
      overflow-x:auto;scrollbar-width:none}
    .bf-nav button,.bf-ctabs button,.bf-subtabs button{position:relative;border:0;background:none;
      padding:7px 1px 9px;font-size:13px;line-height:20px;
      color:var(--dsw-alias-label-tertiary);white-space:nowrap;cursor:pointer}
    .bf-nav button:hover,.bf-ctabs button:hover,.bf-subtabs button:hover{
      color:var(--dsw-alias-label-primary)}
    .bf-nav button[aria-selected="true"],.bf-ctabs button[aria-selected="true"],
    .bf-subtabs button[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:400}
    .bf-nav button[aria-selected="true"]::after,.bf-ctabs button[aria-selected="true"]::after,
    .bf-subtabs button[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;
      bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-label-primary)}
    .bf-nav .bf-nav-count{height:18px;padding:0 6px;border:0;border-radius:999px;
      corner-shape:round;background:var(--dsw-alias-bg-module-platform);
      color:var(--dsw-alias-label-secondary);font-size:11px;line-height:14px}
    .bf-segmented{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;
      padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
    .bf-segmented button{height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);
      background:transparent;color:var(--dsw-alias-label-secondary);
      font-size:13px;line-height:20px;font-weight:500}
    .bf-segmented button[aria-selected="true"]{color:var(--dsw-alias-label-primary);
      background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
    .bf-segmented button:focus-visible{outline-offset:-2px}

    /* ── A8 设置 section / 字段 ─────────────────────────────────── */
    .bf-settings-section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:12px;
      color:var(--dsw-alias-label-primary)}
    .bf-settings-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}
    .bf-settings-intro{margin:0;font-size:13px;line-height:20px;
      color:var(--dsw-alias-label-tertiary)}
    .bf-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
    .bf-field+.bf-field{border-top:.5px solid var(--dsw-alias-border-l2)}
    .bf-field-label{font-size:13px;font-weight:500;line-height:1.5;
      color:var(--dsw-alias-label-primary)}
    .bf-field-help{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
    .bf-form-foot{padding-top:16px;border-top:0}

    /* ── A9 空状态 / banner ─────────────────────────────────────── */
    .bf-empty{border:0;border-radius:0;padding:24px 0;background:transparent;text-align:center;
      color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
    .bf-empty-title{margin-bottom:4px;font-size:14px;line-height:22px;font-weight:500;
      color:var(--dsw-alias-label-secondary)}
    .bf-banner{border:0;border-radius:var(--dsw-radius-md);padding:10px 12px;gap:8px;
      font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
    .bf-banner.warn{background:var(--dsw-alias-state-warn-tertiary)}
    .bf-banner.error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);
      border-radius:var(--dsw-radius-lg);padding:8px 10px;
      color:var(--dsw-alias-state-error-primary)}

    /* ── A10 弹窗 ───────────────────────────────────────────────── */
    .bf-modal-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;
      justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;
      background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
    .bf-modal{width:min(380px,100%);max-height:100%;overflow:auto;border:0;text-align:left;
      border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);
      box-shadow:var(--dsw-elevation-prominent);padding:0 0 24px}
    .bf-modal .bf-card-title{padding:22px 14px 12px 24px;font-size:16px;line-height:24px;
      font-weight:500}
    .bf-modal img{width:220px;height:220px;margin:0 24px;border:0;
      border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-3)}
    .bf-modal-state{padding:0 24px;margin:16px 0 0;font-size:14px;line-height:22px;
      color:var(--dsw-alias-label-primary)}
    .bf-modal-actions{padding:0 24px;margin-top:20px;gap:8px;justify-content:flex-end}

    /* ── A11 圆 / 胶囊形状、滚动条、动效 ───────────────────────── */
    .bf-dot,.bf-avatar,.bf-stage b{border-radius:50%;corner-shape:round}
    .bf-live-body,.bf-raw,pre.bf-doc{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
      --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
    @media (prefers-reduced-motion:reduce){
      .bf-console *,.bf-console *::before,.bf-console *::after{
        transition:none!important;animation:none!important}
    }

配套 JSX 两处（只改结构，不改逻辑）：

    // ConsolePage 根（原 :2428）
    h('div', { className: 'bf-console bf-root' }, ...)

    // SettingsEntry 根（原 :2478）：去掉 style padding，改成 section
    h('div', { className: 'bf-console bf-settings-section' },
      h('h3', { className: 'bf-settings-heading' }, 'B站分身'),
      h('p', { className: 'bf-settings-intro' }, '安装自检与入口；完整控制台在左侧栏。'),
      ...)

---

## 附录 B：改完自检（10 条）

1. 页面内容列宽 ≤960，水平内边距 clamp(24px,4vw,48px)，底部 48，页头 28。
2. SettingsEntry 不再有 height:100% / overflow-y:auto / padding:16。
3. 按钮只有三种高度：28（small）/ 32（默认）/ 36（如需要 md）；没有 26 / 30。
4. 所有输入/下拉/搜索高 34、圆角 12、border-l4、bg-layer-3。
5. 开关 36×20、位移 16、corner-shape:round。
6. 圆角只出现 4 / 8 / 12 / 16 / 20 / 28 / 50% / 999px。
7. 字号只出现 24 / 20 / 16 / 14 / 13 / 12 / 11，行高只出现 32 / 28 / 24 / 22 / 20 / 18 / 14。
8. 每个可聚焦控件都有 :focus-visible 环（或输入类的边框变色）；**没有** outline:none。
9. disabled 有 opacity:.4（开关/复选 .5）+ 正确 cursor。
10. 全局搜 #：只剩 B 站粉 #fb7299 / 蓝 #23ade5（品牌识别）和二维码白底；其余颜色必须走 var(--dsw-*)。

---

## 附录 C：与 v3 设计稿的差异（需要 Lead 拍板）

| 项 | v3 稿（R3/R2） | 宿主真实（本清单） | 建议 |
|---|---|---|---|
| 侧栏 | 216px / 折叠 64 / <1180 折叠 | 280（264–420）/ rail 56 / <1024 折叠 | **删掉自绘侧栏**，用宿主 |
| 顶栏 | 52px 常驻（面包屑/主题切换） | 无全局顶栏；每页自画页头 | **删掉自绘顶栏**，状态放页头/状态行 |
| 内容宽 | max 1320，padding 24/28 | max 960，padding clamp(24,4vw,48) | 取 960 |
| token 值 | 自造一套（§2.6） | --dsw-* 实际值 | 只读宿主 token |
| 页签 | 选中 500 + 自定义 | 13/20、下划线 2px、不改字重 | 按 §4-10 |
| 主题切换 | 自绘月亮/太阳 + localStorage | 宿主设置统一控制（light/dark/system），body[data-ds-dark-theme] | **插件内不要再做主题开关** |
