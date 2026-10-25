/**
 * dsh-bili-fenshen —— Client 半部（单文件控制台）
 *
 * 注册：sidebar.panellist（图标）+ main（控制台页面）+ settings.section（瘦身版）
 * 结构（设计文档 §10）：
 *   §0 常量（PANEL_ID / 文案表 T / 轮询间隔）
 *   §1 CSS（宿主 --dsw-* token 映射为局部变量 + demo 组件样式，bf- 前缀）
 *   §2 数据层（apiGet/apiPost/usePoll + useModels/useLive/useDiagnose：SSE 优先、降级轮询、visibility 暂停）
 *   §3 基础组件（Btn/Switch/Num/Chip/Pill/Card/Tabs/Group/Row/ChipsInput/Select/Banner/EmptyState/DiagnosePanel/LoginModal）
 *   §4 看板（AccountBar/DutyBar/LiveCard/QuotaTiles/ActivityFeed/ActivityCard/StageRail/ReplyThread）
 *   §5 操作台（LivePane/ConfigPane/LogPane/SeenPane/ArtifactsPane）
 *   §6 页面（ConsolePage：标题行 + 子页切换；SettingsEntry：设置页瘦身版）
 *   §7 注册（apply → panellist 图标 + main 页面 + settings.section）
 *
 * 约束：不 require 任何 @deepseek-ai/dsh-client-* 包（宿主 primitives 会变、无类型检查）；
 *       控件自己实现，行为对齐宿主（role="switch"+aria-checked、Escape 关抽屉、disabled 语义）。
 * i18n：V1 不接 locale（设计文档 §11 例外），文案集中在 T 表。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-fenshen',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ═══════════════════════ §0 常量 ═══════════════════════ */

    const PANEL_ID = 'bili-fenshen'
    const TAG_ID = 'dsh-bili-fenshen/console.css'

    const T = {
      title: 'B站分身',
      subtitle: '让小号在B站保持存在感 · 先发后报，可随时接管',
      dashboard: '看板',
      console: '操作台',
      refresh: '刷新',
      run: '跑一轮',
      stop: '中止',
      login: '扫码登录',
      reopen: '重新扫码',
      live: '实时',
    }

    const SRC_LABEL = { hot: '热门', search: '搜索', follow: '订阅' }
    const GRADE_TEXT = { worth: '值得看', ok: '可以看', meh: '不值当' }

    // 实时事件：本地最多留 300 条（§1.5）；kind → 中文短标签（配色走 CSS）
    const LIVE_MAX_EVENTS = 300
    const LIVE_KIND_CN = { host: '宿主', tool: '工具', reasoning: '推理', error: '错误', text: '输出', state: '状态' }
    const DIAG_ICON = { pass: '✓', warn: '!', fail: '✗' }

    /* ═══════════════════════ §1 CSS ═══════════════════════
     * token 全部映射自宿主真实定义（--dsw-*）：
     *   浅 body{} / 深 body[data-ds-dark-theme]{}，切换外观时页面颜色自动跟随。
     * 组件样式逐块移植自 docs/demo/bili-fenshen-console.html（去掉 :root 与暗色块，类名加 bf- 前缀）。
     */

    const STYLE = `
      .bf-console{
        --bg-base:var(--dsw-alias-bg-base);
        --bg-layer-1:var(--dsw-alias-bg-layer-1);
        --bg-layer-2:var(--dsw-alias-bg-layer-2);
        --bg-layer-3:var(--dsw-alias-bg-layer-3);
        --bg-module-platform:var(--dsw-alias-bg-module-platform);
        --border-l1:var(--dsw-alias-border-l1);
        --border-l2:var(--dsw-alias-border-l2);
        --border-l4:var(--dsw-alias-border-l4);
        --label-primary:var(--dsw-alias-label-primary);
        --label-secondary:var(--dsw-alias-label-secondary);
        --label-tertiary:var(--dsw-alias-label-tertiary);
        --label-caption:var(--dsw-alias-label-caption);
        --brand-primary:var(--dsw-alias-brand-primary);
        --brand-hover:var(--dsw-alias-button-primary-hover);
        --interactive-hover:var(--dsw-alias-interactive-bg-hover);
        --interactive-hover-solid:var(--dsw-alias-interactive-bg-hover-solid);
        --interactive-active:var(--dsw-alias-interactive-bg-active);
        --nav-active:var(--dsw-specific-sidebar-nav-item-active);
        --selector:var(--dsw-specific-selector);
        --input:var(--dsw-alias-bg-layer-2);
        --success:var(--dsw-alias-state-success-primary);
        --success-3:var(--dsw-alias-state-success-tertiary);
        --warn:var(--dsw-alias-state-warn-primary);
        --warn-3:var(--dsw-alias-state-warn-tertiary);
        --error:var(--dsw-alias-state-error-primary);
        --idle:var(--dsw-alias-state-idle-primary);
        --business:var(--dsw-alias-state-business-primary);
        --business-1:color-mix(in srgb, var(--business) 14%, var(--bg-base));
        --business-0:color-mix(in srgb, var(--business) 8%, var(--bg-layer-1));
        --bubble:color-mix(in srgb, var(--business) 10%, var(--bg-layer-1));
        --bili-pink:#fb7299;
        --bili-blue:#23ade5;
        --live-tool:color-mix(in srgb, var(--bili-blue) 76%, var(--label-primary));
        --live-host:color-mix(in srgb, var(--bili-pink) 52%, var(--bili-blue));
        --r-xs:4px; --r-sm:8px; --r-md:12px; --r-lg:16px; --r-xl:20px;
        --font-text:inherit;
        --font-code:"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,monospace;
        --ease:cubic-bezier(.4,0,.2,1); --dur:.2s;
        color:var(--label-primary);
        background:var(--bg-base);
        /* ⭐ 面板根容器自己承担滚动（写法对齐 dsh-context 的 .lc-root）：height:100% + overflow-y:auto */
        height:100%;
        min-height:100%;
        overflow-y:auto;
        overflow-x:hidden;
        font-size:14px; line-height:22px;
      }
      .bf-console, .bf-console *{box-sizing:border-box}
      .bf-console button{font:inherit;color:inherit}

      /* ───────── page ───────── */
      /* ⭐ 全屏适配：流式宽度 + 居中，宽屏最多用到 1400px（demo 的 920px 定稿在真机全屏下显得过窄且不居中） */
      .bf-page{width:100%;max-width:1400px;margin:0 auto;padding:26px 32px 72px}
      .bf-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
      .bf-page-title{margin:0;font-size:18px;line-height:26px;font-weight:600;letter-spacing:-.01em}
      .bf-page-sub{margin:2px 0 0;font-size:13px;line-height:20px;color:var(--label-tertiary)}
      .bf-head-tools{display:flex;align-items:center;gap:8px;padding-top:2px}

      /* ───────── segmented（看板 / 操作台） ───────── */
      .bf-segmented{
        display:inline-flex;gap:2px;padding:2px;background:var(--selector);
        border-radius:var(--r-sm);margin-bottom:18px;
      }
      .bf-segmented button{
        border:0;background:transparent;color:var(--label-secondary);cursor:pointer;
        padding:4px 14px;border-radius:6px;font-size:13px;line-height:20px;
        transition:background var(--dur) var(--ease),color var(--dur) var(--ease);
      }
      .bf-segmented button:hover{color:var(--label-primary)}
      .bf-segmented button[aria-selected="true"]{
        background:var(--bg-base);color:var(--label-primary);
        box-shadow:0 0 0 .5px var(--border-l2);font-weight:500;
      }

      /* ───────── generic card ───────── */
      .bf-card{
        border:.5px solid var(--border-l2);border-radius:var(--r-md);
        background:var(--bg-layer-1);padding:14px 16px;
      }
      .bf-card + .bf-card{margin-top:10px}
      .bf-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      .bf-card-title{font-size:13px;line-height:20px;font-weight:500;color:var(--label-primary)}
      .bf-card-note{font-size:12px;line-height:18px;color:var(--label-tertiary)}
      .bf-note{font-size:12px;line-height:18px;color:var(--label-tertiary)}

      /* ───────── account strip ───────── */
      .bf-account{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
      .bf-avatar{
        width:38px;height:38px;border-radius:50%;flex:0 0 38px;display:grid;place-items:center;overflow:hidden;
        background:linear-gradient(135deg,var(--bili-pink),var(--bili-blue));
        color:#fff;font-size:15px;font-weight:600;line-height:1;
        box-shadow:0 0 0 1px var(--border-l2) inset;
      }
      .bf-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
      .bf-account-name{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500}
      .bf-account-meta{font-size:12px;line-height:18px;color:var(--label-tertiary)}
      .bf-lv{
        font-size:10px;line-height:14px;padding:0 4px;border-radius:var(--r-xs);
        background:var(--bg-module-platform);color:var(--label-secondary);
        border:.5px solid var(--border-l2);font-family:var(--font-code);
      }
      .bf-pill{
        display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:18px;
        padding:1px 8px;border-radius:999px;border:.5px solid var(--border-l2);
        color:var(--label-secondary);background:var(--bg-module-platform);
      }
      .bf-dot{width:6px;height:6px;border-radius:50%;flex:0 0 6px;display:inline-block}
      .bf-dot.ok{background:var(--success)}
      .bf-dot.warn{background:var(--warn)}
      .bf-dot.off{background:var(--idle)}

      /* ───────── buttons ───────── */
      .bf-btn{
        display:inline-flex;align-items:center;justify-content:center;gap:6px;
        height:30px;padding:0 12px;border-radius:var(--r-sm);cursor:pointer;
        border:.5px solid var(--border-l4);background:transparent;color:var(--label-primary);
        font-size:13px;line-height:20px;
        transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease),opacity var(--dur) var(--ease);
      }
      .bf-btn:hover{background:var(--interactive-hover)}
      .bf-btn:active{background:var(--interactive-active)}
      .bf-btn.primary{background:var(--brand-primary);color:var(--bg-base);border-color:transparent;font-weight:500}
      .bf-btn.primary:hover{background:var(--brand-hover)}
      .bf-btn.ghost{border-color:transparent;color:var(--label-secondary)}
      .bf-btn.ghost:hover{color:var(--label-primary)}
      .bf-btn.small{height:26px;padding:0 10px;font-size:12px}
      .bf-btn:disabled{opacity:.45;cursor:not-allowed}
      .bf-btn.danger{color:var(--error);border-color:var(--border-l2)}
      .bf-btn.danger:hover{background:var(--interactive-hover)}

      /* ───────── switch ───────── */
      .bf-switch{
        position:relative;display:inline-flex;margin:0;width:34px;height:20px;border-radius:10px;border:0;padding:0;cursor:pointer;
        background:var(--idle);transition:background var(--dur) var(--ease);flex:0 0 34px;
      }
      .bf-switch::after{
        content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
        background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.22);
        transition:transform var(--dur) var(--ease);
      }
      .bf-switch[aria-checked="true"]{background:var(--brand-primary)}
      .bf-switch[aria-checked="true"]::after{transform:translateX(14px);background:var(--bg-base)}

      /* ───────── duty strip ───────── */
      .bf-duty{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
      .bf-duty-item{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--label-secondary)}
      .bf-duty-item b{color:var(--label-primary);font-weight:500}
      .bf-duty-actions{margin-left:auto;display:flex;gap:8px}

      /* ───────── quota tiles ───────── */
      .bf-quota{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
      .bf-tile{
        border:.5px solid var(--border-l1);border-radius:var(--r-sm);
        background:var(--bg-module-platform);padding:10px 12px;
      }
      .bf-tile-label{font-size:12px;line-height:18px;color:var(--label-tertiary)}
      .bf-tile-value{font-size:15px;line-height:22px;font-weight:500;margin-top:2px;font-variant-numeric:tabular-nums}
      .bf-tile-value span{font-size:12px;color:var(--label-tertiary);font-weight:400}
      .bf-bar{height:2px;border-radius:2px;background:var(--border-l2);margin-top:8px;overflow:hidden}
      .bf-bar i{display:block;height:100%;border-radius:2px;background:var(--business)}

      /* ───────── round header ───────── */
      .bf-round-head{display:flex;align-items:baseline;gap:10px;margin:22px 0 10px;flex-wrap:wrap}
      .bf-round-time{font-size:13px;font-weight:500;color:var(--label-primary);font-variant-numeric:tabular-nums}
      .bf-round-src{font-size:12px;color:var(--label-tertiary)}

      /* ───────── activity card ───────── */
      details.bf-act{border:.5px solid var(--border-l2);border-radius:var(--r-md);background:var(--bg-layer-1)}
      details.bf-act + details.bf-act{margin-top:8px}
      details.bf-act > summary{
        list-style:none;cursor:pointer;padding:12px 14px;border-radius:var(--r-md);
        transition:background var(--dur) var(--ease);
      }
      details.bf-act > summary::-webkit-details-marker{display:none}
      details.bf-act > summary:hover{background:var(--interactive-hover)}
      details.bf-act[open] > summary{border-bottom:.5px solid var(--border-l1);border-radius:var(--r-md) var(--r-md) 0 0}
      .bf-sum-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .bf-bvid{font-family:var(--font-code);font-size:11px;line-height:16px;color:var(--label-tertiary);letter-spacing:.02em}
      .bf-grade{
        font-size:11px;line-height:16px;padding:0 6px;border-radius:var(--r-xs);font-weight:500;
        border:.5px solid transparent;
      }
      .bf-grade.worth{
        background:color-mix(in srgb, var(--bili-pink) 12%, transparent);
        color:color-mix(in srgb, var(--bili-pink) 62%, var(--label-primary));
        border-color:color-mix(in srgb, var(--bili-pink) 28%, transparent);
      }
      .bf-grade.ok{background:var(--bg-module-platform);color:var(--label-secondary);border-color:var(--border-l2)}
      .bf-grade.meh{background:var(--bg-module-platform);color:var(--label-tertiary);border-color:var(--border-l1)}
      .bf-chip{
        font-size:11px;line-height:16px;padding:0 5px;border-radius:var(--r-xs);
        color:var(--label-secondary);background:var(--bg-module-platform);border:.5px solid var(--border-l1);
        display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;
      }
      .bf-chip.cmt{color:var(--business);background:var(--business-0);border-color:transparent}
      .bf-chip.rep{color:var(--success);background:var(--success-3);border-color:transparent}
      .bf-chip.warn{color:var(--warn);background:var(--warn-3);border-color:transparent}
      .bf-sum-title{font-size:13px;line-height:20px;color:var(--label-primary);font-weight:500;margin-top:4px}
      .bf-sum-meta{font-size:12px;line-height:18px;color:var(--label-tertiary)}
      .bf-chev{margin-left:auto;color:var(--label-caption);transition:transform var(--dur) var(--ease);flex:0 0 12px}
      details[open] > summary .bf-chev{transform:rotate(90deg)}

      .bf-act-body{padding:12px 14px 14px}

      /* ───────── stage rail ───────── */
      .bf-stages{display:grid;grid-template-columns:repeat(6,1fr);margin:2px 0 14px}
      .bf-stage{position:relative;padding-top:14px;min-width:0}
      .bf-stage::before{
        content:"";position:absolute;top:4px;left:0;right:0;height:1px;background:var(--border-l2);
      }
      .bf-stage:first-child::before{left:5px}
      .bf-stage:last-child::before{right:calc(100% - 5px)}
      .bf-stage b{
        position:absolute;top:0;left:0;width:9px;height:9px;border-radius:50%;
        background:var(--bg-base);box-shadow:inset 0 0 0 1.5px var(--idle);
      }
      .bf-stage.done b{background:var(--business);box-shadow:none}
      .bf-stage span{display:block;font-size:11px;line-height:16px;color:var(--label-tertiary);white-space:nowrap}
      .bf-stage.done span{color:var(--label-secondary)}
      .bf-stage em{display:block;font-size:10px;line-height:15px;color:var(--label-caption);font-style:normal;font-variant-numeric:tabular-nums}

      /* ───────── comment + thread ───────── */
      .bf-quote{
        font-size:13px;line-height:21px;color:var(--label-primary);
        padding:2px 0 2px 10px;border-left:2px solid var(--border-l2);margin:0 0 10px;
      }
      .bf-quote .bf-who{font-size:11px;color:var(--label-tertiary);margin-right:6px}
      .bf-thread{margin:0 0 2px;padding-left:12px;border-left:1px solid var(--border-l2)}
      .bf-msg{display:flex;gap:8px;padding:6px 0;align-items:baseline;flex-wrap:wrap}
      .bf-msg + .bf-msg{border-top:.5px solid var(--border-l1)}
      .bf-msg-name{font-size:12px;line-height:18px;color:var(--label-secondary);flex:0 0 auto;font-weight:500}
      .bf-msg-time{font-size:11px;line-height:18px;color:var(--label-caption);flex:0 0 auto;font-variant-numeric:tabular-nums}
      .bf-msg-text{font-size:13px;line-height:20px;color:var(--label-primary);min-width:0}
      .bf-msg.mine .bf-msg-text{background:var(--bubble);border-radius:var(--r-sm);padding:2px 8px;margin:-2px 0}
      .bf-msg.mine .bf-msg-name{color:var(--business)}
      .bf-dyn{font-size:12px;line-height:19px;color:var(--label-secondary);margin:8px 0 0}
      .bf-act-foot{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px;color:var(--label-tertiary);flex-wrap:wrap}
      .bf-link{color:var(--business);text-decoration:none;cursor:pointer}
      .bf-link:hover{text-decoration:underline}
      .bf-mono{font-family:var(--font-code);font-size:11px}

      /* ───────── skip group / earlier group ───────── */
      details.bf-group{margin-top:10px}
      details.bf-group > summary{
        list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;
        padding:8px 10px;border-radius:var(--r-sm);color:var(--label-secondary);font-size:12px;
        transition:background var(--dur) var(--ease);
      }
      details.bf-group > summary::-webkit-details-marker{display:none}
      details.bf-group > summary:hover{background:var(--interactive-hover)}
      details.bf-group[open] > summary{color:var(--label-primary)}
      .bf-skip-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
      .bf-skip-item{
        display:flex;align-items:baseline;gap:8px;padding:9px 12px;
        border:.5px solid var(--border-l1);border-radius:var(--r-sm);background:var(--bg-module-platform);
      }
      .bf-skip-item .bf-bvid{flex:0 0 auto}
      .bf-skip-title{font-size:12px;line-height:18px;color:var(--label-secondary);min-width:0;flex:1;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bf-skip-reason{font-size:11px;line-height:16px;color:var(--label-tertiary);flex:0 0 auto}

      /* ───────── empty state ───────── */
      .bf-empty{
        border:.5px dashed var(--border-l2);border-radius:var(--r-md);padding:42px 20px;
        text-align:center;color:var(--label-tertiary);background:var(--bg-layer-1);
      }
      .bf-empty-title{font-size:14px;font-weight:500;color:var(--label-secondary);margin-bottom:6px}

      /* ───────── banners ───────── */
      .bf-banner{
        display:flex;gap:10px;align-items:center;padding:8px 12px;border-radius:var(--r-sm);
        font-size:13px;line-height:20px;margin-bottom:10px;border:.5px solid var(--border-l2);flex-wrap:wrap;
      }
      .bf-banner.warn{
        background:var(--warn-3);border-color:color-mix(in srgb, var(--warn) 30%, transparent);
      }
      .bf-banner.error{
        background:color-mix(in srgb, var(--error) 8%, var(--bg-layer-1));
        border-color:color-mix(in srgb, var(--error) 26%, transparent);
      }
      .bf-banner .bf-btn{margin-left:auto;flex:0 0 auto}

      /* ───────── 操作台 ───────── */
      .bf-ctabs{display:flex;gap:18px;border-bottom:.5px solid var(--border-l2);margin:2px 0 18px}
      .bf-ctabs button{
        border:0;background:transparent;cursor:pointer;padding:0 0 9px;position:relative;
        font-size:13px;line-height:20px;color:var(--label-secondary);
        transition:color var(--dur) var(--ease);
      }
      .bf-ctabs button:hover{color:var(--label-primary)}
      .bf-ctabs button[aria-selected="true"]{color:var(--label-primary);font-weight:500}
      .bf-ctabs button[aria-selected="true"]::after{
        content:"";position:absolute;left:0;right:0;bottom:-.5px;height:2px;border-radius:2px;background:var(--brand-primary);
      }
      .bf-panel-tools{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}

      .bf-form-group + .bf-form-group{margin-top:18px;padding-top:18px;border-top:.5px solid var(--border-l1)}
      .bf-group-title{font-size:13px;font-weight:500;margin:0 0 10px;color:var(--label-primary)}
      .bf-row{display:flex;align-items:center;gap:12px;padding:7px 0;min-height:34px}
      .bf-row-label{flex:0 0 132px;font-size:13px;color:var(--label-secondary)}
      .bf-row-help{font-size:11px;line-height:16px;color:var(--label-caption);margin-top:2px;font-weight:400}
      .bf-row-body{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .bf-num{
        display:inline-flex;align-items:center;border:.5px solid var(--border-l4);border-radius:var(--r-sm);
        overflow:hidden;background:var(--input);height:30px;
      }
      .bf-num button{
        width:26px;height:100%;border:0;background:transparent;color:var(--label-secondary);cursor:pointer;font-size:14px;
      }
      .bf-num button:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-num input{
        width:44px;height:100%;border:0;background:transparent;color:var(--label-primary);
        text-align:center;font-size:13px;font-variant-numeric:tabular-nums;outline:none;
      }
      .bf-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .bf-tag{
        display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 6px 0 9px;border-radius:var(--r-sm);
        background:var(--bg-module-platform);border:.5px solid var(--border-l2);
        font-size:12px;color:var(--label-primary);
      }
      .bf-tag button{border:0;background:transparent;color:var(--label-caption);cursor:pointer;padding:0 2px;border-radius:var(--r-xs)}
      .bf-tag button:hover{color:var(--label-primary);background:var(--interactive-hover)}
      .bf-tag-add{
        height:26px;padding:0 9px;border:.5px dashed var(--border-l4);border-radius:var(--r-sm);
        background:transparent;color:var(--label-tertiary);font-size:12px;cursor:pointer;
      }
      .bf-tag-add:hover{color:var(--label-primary);border-color:var(--label-caption)}
      .bf-console textarea{
        width:100%;min-height:76px;resize:vertical;padding:8px 10px;border-radius:var(--r-sm);
        border:.5px solid var(--border-l4);background:var(--input);color:var(--label-primary);
        font-family:var(--font-text);font-size:13px;line-height:21px;outline:none;
      }
      .bf-console textarea:focus{border-color:var(--label-caption)}
      .bf-form-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:18px;padding-top:14px;border-top:.5px solid var(--border-l1)}
      .bf-form-foot .bf-note{margin-right:auto}

      /* ───────── log ───────── */
      .bf-log-events{display:flex;flex-direction:column}
      .bf-log-line{display:flex;gap:10px;padding:6px 0;font-size:12px;line-height:19px;border-bottom:.5px solid var(--border-l1)}
      .bf-log-line:last-child{border-bottom:0}
      .bf-log-t{font-family:var(--font-code);font-size:11px;color:var(--label-caption);flex:0 0 74px;font-variant-numeric:tabular-nums}
      .bf-log-msg{color:var(--label-secondary);min-width:0;word-break:break-word}
      .bf-log-line.err .bf-log-msg{color:var(--error)}
      pre.bf-raw{
        margin:8px 0 0;padding:10px 12px;border-radius:var(--r-sm);background:var(--bg-module-platform);
        border:.5px solid var(--border-l1);font-family:var(--font-code);font-size:11px;line-height:18px;
        color:var(--label-secondary);max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;
      }

      /* ───────── select（模型配置下拉） ───────── */
      .bf-select{
        height:30px;min-width:180px;max-width:280px;padding:0 8px;border-radius:var(--r-sm);
        border:.5px solid var(--border-l4);background:var(--input);color:var(--label-primary);
        font-size:13px;line-height:20px;outline:none;cursor:pointer;
      }
      .bf-select:focus{border-color:var(--label-caption)}
      .bf-select:disabled{opacity:.5;cursor:not-allowed}
      .bf-select option{background:var(--bg-layer-1);color:var(--label-primary)}

      /* ───────── 一键诊断 ───────── */
      .bf-diag{display:flex;flex-direction:column;gap:8px;margin-top:6px}
      .bf-diag-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .bf-diag-summary{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--label-secondary)}
      .bf-diag-stat{font-family:var(--font-code);font-size:12px;font-variant-numeric:tabular-nums}
      .bf-diag-stat.pass{color:var(--success)}
      .bf-diag-stat.warn{color:var(--warn)}
      .bf-diag-stat.fail{color:var(--error)}
      .bf-diag-head .bf-btn{margin-left:auto}
      .bf-diag-list{display:flex;flex-direction:column;border-top:.5px solid var(--border-l1)}
      .bf-diag-item{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:.5px solid var(--border-l1)}
      .bf-diag-item:last-child{border-bottom:0}
      .bf-diag-icon{flex:0 0 14px;text-align:center;font-family:var(--font-code);font-size:12px;line-height:18px;font-weight:600}
      .bf-diag-item.pass .bf-diag-icon{color:var(--success)}
      .bf-diag-item.warn .bf-diag-icon{color:var(--warn)}
      .bf-diag-item.fail .bf-diag-icon{color:var(--error)}
      .bf-diag-label{flex:0 0 118px;font-size:12px;line-height:18px;color:var(--label-primary)}
      .bf-diag-body{flex:1;min-width:0}
      .bf-diag-detail{font-size:12px;line-height:18px;color:var(--label-secondary);word-break:break-word}
      .bf-diag-fix{font-size:11px;line-height:16px;color:var(--label-caption);margin-top:2px}
      .bf-diag-empty{font-size:12px;line-height:18px;color:var(--label-tertiary)}

      /* ───────── 实时运行 ───────── */
      .bf-live-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .bf-live-clock{font-family:var(--font-code);font-size:13px;line-height:20px;color:var(--label-primary);font-variant-numeric:tabular-nums}
      .bf-live-meta{font-size:12px;line-height:18px;color:var(--label-tertiary)}
      .bf-live-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .bf-live-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0 10px}
      .bf-live-body{
        max-height:440px;overflow:auto;border:.5px solid var(--border-l1);border-radius:var(--r-sm);
        background:var(--bg-module-platform);padding:8px 10px;
        font-family:var(--font-code);font-size:11px;line-height:18px;
      }
      .bf-live-body.mini{max-height:none;overflow:hidden;margin-top:10px}
      .bf-live-line{display:flex;gap:8px;padding:1px 0;word-break:break-word}
      .bf-live-t{flex:0 0 54px;color:var(--label-caption);font-variant-numeric:tabular-nums}
      .bf-live-kind{flex:0 0 auto;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--label-tertiary)}
      .bf-live-text{flex:1;min-width:0;color:var(--label-secondary);white-space:pre-wrap}
      .bf-live-line.tool .bf-live-kind,.bf-live-line.tool .bf-live-text{color:var(--live-tool)}
      .bf-live-line.reasoning .bf-live-text{color:var(--label-tertiary)}
      .bf-live-line.error .bf-live-kind,.bf-live-line.error .bf-live-text{color:var(--error)}
      .bf-live-line.host .bf-live-text{color:var(--live-host)}
      .bf-live-line.state .bf-live-text{color:var(--warn)}
      .bf-live-empty{padding:30px 14px;text-align:center;color:var(--label-tertiary);font-family:var(--font-text);font-size:13px;line-height:20px}
      .bf-live-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;font-size:11px;line-height:16px;color:var(--label-caption)}
      .bf-live-err{color:var(--warn)}

      /* ───────── table（判重表） ───────── */
      table.bf-grid{width:100%;border-collapse:collapse;font-size:12px;line-height:19px}
      table.bf-grid th{
        text-align:left;font-weight:500;color:var(--label-tertiary);padding:0 10px 8px 0;
        border-bottom:.5px solid var(--border-l2);white-space:nowrap;font-size:11px;
      }
      table.bf-grid td{padding:7px 10px 7px 0;border-bottom:.5px solid var(--border-l1);color:var(--label-secondary);vertical-align:top}
      table.bf-grid td.bv{font-family:var(--font-code);font-size:11px;color:var(--label-primary);white-space:nowrap}
      table.bf-grid tr:last-child td{border-bottom:0}
      .bf-search{
        height:30px;padding:0 10px;border-radius:var(--r-sm);border:.5px solid var(--border-l4);
        background:var(--input);color:var(--label-primary);font-size:13px;outline:none;width:220px;
      }
      .bf-search:focus{border-color:var(--label-caption)}

      /* ───────── artifacts ───────── */
      .bf-artifact-list{display:flex;flex-direction:column;gap:2px}
      .bf-artifact-item{
        display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--r-sm);
        border:0;background:transparent;cursor:pointer;text-align:left;width:100%;
        transition:background var(--dur) var(--ease);
      }
      .bf-artifact-item:hover{background:var(--interactive-hover)}
      .bf-artifact-item[aria-selected="true"]{background:var(--bg-module-platform)}
      .bf-artifact-item .name{font-size:12px;color:var(--label-primary);font-family:var(--font-code)}
      .bf-artifact-item .meta{font-size:11px;color:var(--label-caption);margin-left:auto}
      pre.bf-doc{
        margin:0;padding:14px 16px;border-radius:var(--r-sm);border:.5px solid var(--border-l1);
        background:var(--bg-module-platform);font-family:var(--font-code);font-size:11px;line-height:19px;
        color:var(--label-secondary);white-space:pre-wrap;max-height:340px;overflow:auto;
      }
      .bf-split{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:start}

      /* ───────── 窄容器降级（宿主面板拖窄时） ───────── */
      @media (max-width:680px){
        .bf-page{padding:20px 16px 56px}
        .bf-quota{grid-template-columns:repeat(2,1fr)}
        .bf-split{grid-template-columns:1fr}
        .bf-row{flex-wrap:wrap}
        .bf-row-label{flex:0 0 auto;min-width:96px}
      }

      /* ───────── login modal ───────── */
      .bf-modal-mask{
        position:fixed;inset:0;background:rgba(0,0,0,.42);display:grid;place-items:center;z-index:9999;
      }
      .bf-modal{
        width:284px;background:var(--bg-layer-1);border:.5px solid var(--border-l2);border-radius:var(--r-md);
        padding:16px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.22);
      }
      .bf-modal img{width:220px;height:220px;border-radius:var(--r-sm);border:.5px solid var(--border-l2);background:#fff}
      .bf-modal-state{font-size:13px;color:var(--label-secondary);margin:10px 0 0}
      .bf-modal-actions{display:flex;gap:8px;justify-content:center;margin-top:12px}
    `

    const ensureStyle = () => {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${TAG_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-bili-fenshen'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = STYLE
      document.head.appendChild(tag)
    }

    /* ═══════════════════════ §2 数据层 ═══════════════════════ */

    const apiGet = (path) => fetch(`/api/bili-fenshen${path}`).then((r) => r.json())
    const apiPost = (path, body) => fetch(`/api/bili-fenshen${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    }).then((r) => r.json())

    /**
     * 轮询 hook：intervalMs 可变（运行中 3s / 空闲 15s），页面隐藏时暂停、回前台立即刷一次。
     */
    function usePoll(load, intervalMs) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const tick = React.useCallback(async () => {
        try {
          const v = await load()
          setState(v)
          setError('')
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [load])
      React.useEffect(() => {
        let alive = true
        let timer = null
        const run = async () => { if (alive) await tick() }
        const start = () => {
          run()
          if (timer) clearInterval(timer)
          timer = setInterval(run, intervalMs)
        }
        const onVis = () => {
          if (document.hidden) { if (timer) clearInterval(timer); timer = null }
          else start()
        }
        start()
        document.addEventListener('visibilitychange', onVis)
        return () => {
          alive = false
          if (timer) clearInterval(timer)
          document.removeEventListener('visibilitychange', onVis)
        }
      }, [tick, intervalMs])
      return { data: state, error, refresh: tick }
    }

    const useOverview = () => usePoll(React.useCallback(() => apiGet('/overview'), []), 3000)
    // 活动流：运行中 3s、空闲 15s（§8 轮询节奏）
    const useActivity = (running) => usePoll(React.useCallback(() => apiGet('/activity'), []), running ? 3000 : 15000)
    // /account 响应是 { ok, account } —— 解包成账号对象，未登录降级 { loggedIn:false }
    const useAccount = () => usePoll(React.useCallback(async () => {
      const r = await apiGet('/account')
      return r?.account || { loggedIn: false }
    }, []), 60000)

    /* ─── 实时运行（§1.5）：SSE 优先，EventSource 不可用或断线时降级轮询 ─── */

    const LIVE_EMPTY = {
      running: false,
      roundId: null,
      startedAt: null,
      elapsedMs: 0,
      why: '',
      phase: { key: 'think', label: '思考' },
      stats: { events: 0, tools: {}, actions: { like: 0, comment: 0, dynamic: 0, reply: 0 }, errors: 0 },
      quota: null,
      events: [],
      lastCode: null,
      lastDurationMs: null,
    }

    const hasEventSource = () => typeof EventSource !== 'undefined'
    const pageHidden = () => typeof document !== 'undefined' && document.hidden === true

    /**
     * useLive：优先 EventSource('/api/bili-fenshen/live/stream')；
     *   - type:'snapshot' 覆盖 meta（含 events 快照），type:'event' 追加 frame；
     *   - EventSource 不存在或 onerror → 降级 GET /live?after=<cursor>（运行中 1000ms / 空闲 5000ms）；
     *   - 本地按 seq 去重、最多 300 条；页面隐藏暂停轮询；卸载 close / clearTimeout。
     * 返回 { data, mode:'sse'|'poll', error, refresh }（refresh 供跑一轮后立刻拉一次）。
     */
    function useLive() {
      const sse = hasEventSource()
      const [state, setState] = React.useState({ data: LIVE_EMPTY, mode: sse ? 'sse' : 'poll', error: '' })
      const refreshRef = React.useRef(() => {})
      React.useEffect(() => {
        let alive = true
        let mode = sse ? 'sse' : 'poll'
        let cursor = 0
        let running = false
        let roundId = null
        let meta = { ...LIVE_EMPTY, events: [] }
        let buf = []
        let timer = null
        let es = null
        let busy = false

        const build = () => ({
          running: !!meta.running,
          roundId: meta.roundId ?? null,
          startedAt: meta.startedAt ?? null,
          elapsedMs: Number(meta.elapsedMs) || 0,
          why: meta.why || '',
          phase: meta.phase || { key: 'think', label: '思考' },
          stats: meta.stats || LIVE_EMPTY.stats,
          quota: meta.quota || null,
          lastCode: meta.lastCode ?? null,
          lastDurationMs: meta.lastDurationMs ?? null,
          events: buf.slice(),
        })
        const publish = (patch) => { if (alive) setState((prev) => ({ ...prev, ...patch })) }
        const emit = (patch) => publish({ data: build(), ...(patch || {}) })

        // 按 seq 去重合并（快照和增量帧可能重叠）
        const mergeFrames = (frames) => {
          if (!Array.isArray(frames) || !frames.length) return
          const seen = new Set()
          for (const e of buf) if (e && e.seq != null) seen.add(e.seq)
          let added = 0
          for (const f of frames) {
            if (!f || typeof f !== 'object') continue
            if (f.seq != null && seen.has(f.seq)) continue
            if (f.seq != null) seen.add(f.seq)
            buf.push(f)
            added++
          }
          if (!added) return
          buf.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0))
          if (buf.length > LIVE_MAX_EVENTS) buf = buf.slice(-LIVE_MAX_EVENTS)
        }

        // 轮次切换（roundId 变了）→ 清空本地事件与游标，避免 seq 重置后误去重
        const applyMeta = (raw) => {
          if (!raw || typeof raw !== 'object') return
          if (raw.roundId && raw.roundId !== roundId) { buf = []; cursor = 0 }
          roundId = raw.roundId ?? roundId
          const { events, ...rest } = raw
          meta = { ...meta, ...rest }
          running = !!raw.running
          if (typeof raw.cursor === 'number') cursor = Math.max(cursor, raw.cursor)
          mergeFrames(events)
        }

        const applySnapshot = (snap) => {
          if (!snap || typeof snap !== 'object') return
          applyMeta(snap)
          emit({ error: '' })
        }

        const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null } }

        const schedulePoll = (delay) => {
          if (!alive || mode !== 'poll' || timer) return
          timer = setTimeout(() => { timer = null; pollOnce() }, delay)
        }

        const pollOnce = async () => {
          if (!alive || mode !== 'poll' || busy) return
          if (pageHidden()) return // 页面隐藏：暂停轮询（回前台时 onVis 立即补一次）
          busy = true
          try {
            const raw = await apiGet(`/live?after=${cursor}`)
            if (!alive) return
            if (raw && raw.ok) {
              applyMeta(raw)
              emit({ error: '' })
            } else {
              publish({ error: raw?.error || '实时数据不可用' })
            }
          } catch (e) {
            if (alive) publish({ error: String(e?.message ?? e) })
          } finally {
            busy = false
            if (alive && mode === 'poll') schedulePoll(running ? 1000 : 5000)
          }
        }

        const startPoll = () => {
          mode = 'poll'
          publish({ mode: 'poll' })
          stopTimer()
          pollOnce()
        }

        const startSse = () => {
          if (!sse) { startPoll(); return }
          try { es = new EventSource('/api/bili-fenshen/live/stream') } catch { es = null }
          if (!es) { startPoll(); return }
          mode = 'sse'
          publish({ mode: 'sse' })
          es.onmessage = (ev) => {
            if (!alive) return
            let msg = null
            try { msg = JSON.parse(ev?.data) } catch { return }
            if (!msg || typeof msg !== 'object') return
            if (msg.type === 'snapshot' && msg.snapshot) applySnapshot(msg.snapshot)
            else if (msg.type === 'event' && msg.frame) {
              mergeFrames([msg.frame])
              if (msg.frame.seq != null) cursor = Math.max(cursor, msg.frame.seq)
              if (msg.frame.kind === 'tool') running = true
              emit({ error: '' })
            }
          }
          es.onerror = () => {
            if (!alive) return
            try { es.close?.() } catch { /* 已断开，忽略 */ }
            es = null
            publish({ error: '事件流断开，已降级轮询' })
            startPoll()
          }
        }

        const onVis = () => {
          if (!alive) return
          if (pageHidden()) stopTimer()
          else if (mode === 'poll') { stopTimer(); pollOnce() }
        }
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', onVis)
        }

        refreshRef.current = () => {
          if (!alive) return
          if (mode === 'poll') { stopTimer(); pollOnce() }
          // SSE 已实时，无需手动刷新
        }

        startSse()

        return () => {
          alive = false
          stopTimer()
          if (es) { try { es.close?.() } catch { /* 忽略 */ } es = null }
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', onVis)
          }
        }
      }, [sse])
      const refresh = React.useCallback(() => { try { refreshRef.current?.() } catch { /* 忽略 */ } }, [])
      return { data: state.data, mode: state.mode, error: state.error, refresh }
    }

    /** 本地秒表：running 时每秒更新（不依赖服务端刷新）；否则用服务端 elapsedMs */
    function useElapsed(running, startedAt, fallbackMs) {
      const [now, setNow] = React.useState(() => Date.now())
      React.useEffect(() => {
        if (!running) return undefined
        setNow(Date.now())
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
      }, [running, startedAt])
      const fallback = Math.max(0, Number(fallbackMs) || 0)
      if (!running) return fallback
      const start = startedAt ? Date.parse(startedAt) : NaN
      return Number.isFinite(start) ? Math.max(0, now - start) : fallback
    }

    /** /models：当前生效模型 + provider/model/推理强度目录，60s 轮询 + 手动 refresh */
    const useModels = () => usePoll(React.useCallback(() => apiGet('/models'), []), 60000)

    /** POST /diagnose 的加载/结果状态（失败保留 error，成功覆盖 report） */
    function useDiagnose() {
      const [report, setReport] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const run = React.useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const r = await apiPost('/diagnose')
          if (r && Array.isArray(r.items)) setReport(r)
          else { setReport(null); setError(r?.error || '返回格式不对') }
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setLoading(false)
        }
      }, [])
      return { report, loading, error, run }
    }

    /* ═══════════════════════ §3 基础组件 ═══════════════════════ */

    const Btn = ({ variant = 'default', small, children, ...rest }) =>
      h('button', {
        className: `bf-btn${variant === 'primary' ? ' primary' : variant === 'ghost' ? ' ghost' : variant === 'danger' ? ' danger' : ''}${small ? ' small' : ''}`,
        ...rest,
      }, children)

    const Switch = ({ checked, onChange, label }) =>
      h('button', {
        className: 'bf-switch', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label,
        onClick: () => onChange(!checked),
      })

    const Num = ({ value, onChange, min = 0, max = 99 }) =>
      h('div', { className: 'bf-num' },
        h('button', { onClick: () => onChange(Math.max(min, Number(value) - 1)), 'aria-label': '减少' }, '−'),
        h('input', { value: Number(value) || 0, readOnly: true, 'aria-label': '数值' }),
        h('button', { onClick: () => onChange(Math.min(max, Number(value) + 1)), 'aria-label': '增加' }, '+'),
      )

    const Chip = ({ kind = '', children }) => h('span', { className: `bf-chip ${kind}`.trimEnd() }, children)
    const Pill = ({ tone = '', children }) =>
      h('span', { className: 'bf-pill' }, h('i', { className: `bf-dot ${tone}`, 'aria-hidden': 'true' }), children)
    const Card = ({ children, className = '', style }) =>
      h('div', { className: `bf-card ${className}`.trimEnd(), style }, children)

    /** 原生下拉（模型配置用），token 配色；options: [[value, label], ...] */
    function Select({ value, onChange, options = [], disabled, label, width }) {
      return h('select', {
        className: 'bf-select',
        value: value ?? '',
        disabled: !!disabled,
        'aria-label': label,
        style: width ? { width } : undefined,
        onChange: (e) => onChange(e.target.value),
      }, options.map(([v, text]) => h('option', { key: v, value: v }, text)))
    }

    /** 一键诊断面板（§1.5）：汇总行 + 逐项状态/说明/修复提示；compact 只列 warn/fail */
    function DiagnosePanel({ report, loading, onRun, compact = false, error = '' }) {
      const items = report?.items || []
      const s = report?.summary || {}
      const shown = compact ? items.filter((it) => it.status !== 'pass') : items
      const summary = report
        ? h('span', { className: 'bf-diag-summary' },
            h('span', { className: 'bf-diag-stat pass' }, `${DIAG_ICON.pass}${s.pass ?? 0}`),
            h('span', { className: 'bf-diag-stat warn' }, `${DIAG_ICON.warn}${s.warn ?? 0}`),
            h('span', { className: 'bf-diag-stat fail' }, `${DIAG_ICON.fail}${s.fail ?? 0}`),
            report.durationMs != null ? h('span', { className: 'bf-note' }, `耗时 ${fmtDur(report.durationMs)}`) : null,
          )
        : h('span', { className: 'bf-note' }, loading ? '正在检查插件安装状态…' : '还没诊断过')
      return h('div', { className: 'bf-diag' },
        h('div', { className: 'bf-diag-head' },
          summary,
          onRun
            ? h(Btn, {
                small: true, variant: compact ? 'primary' : 'default',
                disabled: !!loading, onClick: onRun,
              }, loading ? '诊断中…' : '一键诊断')
            : null,
        ),
        error
          ? h('div', { className: 'bf-banner error', style: { margin: '2px 0 0' } }, h('span', null, `诊断失败：${error}`))
          : null,
        shown.length
          ? h('div', { className: 'bf-diag-list' }, shown.map((it) => h('div', {
              className: `bf-diag-item ${it.status || 'pass'}`, key: it.id || it.label,
            },
              h('span', { className: 'bf-diag-icon', 'aria-hidden': 'true' }, DIAG_ICON[it.status] || '·'),
              h('span', { className: 'bf-diag-label' }, it.label || it.id || '检查项'),
              h('div', { className: 'bf-diag-body' },
                h('div', { className: 'bf-diag-detail' }, it.detail || ''),
                it.fix ? h('div', { className: 'bf-diag-fix' }, `修复：${it.fix}`) : null,
              ),
            )))
          : report
            ? h('div', { className: 'bf-diag-empty' }, compact ? '全部通过，没有需要处理的项' : '（没有检查项）')
            : null,
      )
    }

    function Tabs({ items, value, onChange }) {
      return h('div', { className: 'bf-ctabs', role: 'tablist' },
        items.map(([k, label]) => h('button', {
          key: k, role: 'tab', 'aria-selected': String(value === k), onClick: () => onChange(k),
        }, label)))
    }

    const Group = ({ title, children }) =>
      h('div', { className: 'bf-form-group' },
        h('h3', { className: 'bf-group-title' }, title), children)

    const Row = ({ label, children }) =>
      h('div', { className: 'bf-row' },
        h('span', { className: 'bf-row-label' }, label),
        h('div', { className: 'bf-row-body' }, children))

    function ChipsInput({ values, onChange }) {
      const [draft, setDraft] = React.useState('')
      const add = () => {
        const v = draft.trim()
        if (!v) return
        if (!values.includes(v)) onChange([...values, v])
        setDraft('')
      }
      return h('div', { className: 'bf-chips' },
        values.map((v) => h('span', { className: 'bf-tag', key: v }, v,
          h('button', { 'aria-label': `删除 ${v}`, onClick: () => onChange(values.filter((x) => x !== v)) }, '×'),
        )),
        h('input', {
          className: 'bf-tag-add',
          value: draft,
          placeholder: '+ 添加',
          style: { width: 84 },
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') add() },
          onBlur: add,
        }),
      )
    }

    /** 异常横幅：未登录 / 无 CLI / 上一轮退出码 ≠ 0（§5.6） */
    function Banner({ health, account, round, onLogin }) {
      const items = []
      if (account && account.loggedIn === false) {
        items.push({ tone: 'warn', text: '未登录，点赞/评论/动态都会失败。', action: '扫码登录', onAction: onLogin })
      }
      if (health && !health.cli) {
        items.push({ tone: 'error', text: '找不到 dsh CLI，值班轮跑不起来 —— 到「操作台 → 配置」填写 dshBin。' })
      }
      if (round && round.lastCode != null && round.lastCode !== 0) {
        items.push({ tone: 'error', text: `上一轮退出码 ${round.lastCode}（${round.lastWhy || '未知来源'}）—— 到「操作台 → 日志」看尾部。` })
      }
      if (!items.length) return null
      return h('div', null, items.map((it, i) =>
        h('div', { className: `bf-banner ${it.tone}`, key: i },
          h('span', null, it.text),
          it.action ? h(Btn, { small: true, variant: 'ghost', onClick: it.onAction }, it.action) : null,
        )))
    }

    function EmptyState({ onRun, onLogin }) {
      return h('div', { className: 'bf-empty' },
        h('div', { className: 'bf-empty-title' }, '还没有活动记录'),
        h('div', { className: 'bf-note' }, '跑一轮值班，或先扫码登录小号 —— 每条视频的「刷到→看→赞→评→被回复→我回」都会在这里连成一条线。'),
        h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 } },
          h(Btn, { variant: 'primary', onClick: onRun }, T.run),
          h(Btn, { onClick: onLogin }, T.login),
        ),
      )
    }

    /** 扫码登录抽屉：/login/start 起码 → 2s 轮询 /login/poll → 成功回调；Escape 关闭 */
    function LoginModal({ onClose, onLoggedIn }) {
      const [st, setSt] = React.useState({ qrUrl: '', qrImage: '', state: '生成二维码…' })
      const start = React.useCallback(async () => {
        setSt((s) => ({ ...s, qrUrl: '', state: '生成二维码…' }))
        try {
          const r = await apiPost('/login/start')
          if (r.ok) setSt({ qrUrl: r.url, qrImage: r.qrImage || '', state: '等待扫码…' })
          else setSt((s) => ({ ...s, state: '失败：' + (r.error || '未知') }))
        } catch (e) { setSt((s) => ({ ...s, state: '失败：' + String(e?.message ?? e) })) }
      }, [])
      React.useEffect(() => { start() }, [start])
      React.useEffect(() => {
        if (!st.qrUrl) return undefined
        let dead = false
        const t = setInterval(async () => {
          try {
            const r = await apiGet('/login/poll')
            if (dead) return
            const msg = r.state === 'waiting' ? '等待扫码…'
              : r.state === 'scanned' ? '已扫码，请在手机上点确认'
              : r.state === 'ok' ? '✅ 登录成功'
              : r.state === 'expired' ? '二维码已过期，请重新生成'
              : (r.message || r.state)
            setSt((s) => ({ ...s, state: msg }))
            if (r.state === 'ok') { clearInterval(t); onLoggedIn?.() }
            if (r.state === 'expired') { clearInterval(t); setSt((s) => ({ ...s, qrUrl: '' })) }
          } catch { /* 下一轮再试 */ }
        }, 2000)
        return () => { dead = true; clearInterval(t) }
      }, [st.qrUrl, onLoggedIn])
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return h('div', {
        className: 'bf-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose?.() },
      },
        h('div', { className: 'bf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '扫码登录B站' },
          h('div', { className: 'bf-card-title' }, '扫码登录小号'),
          st.qrUrl
            ? h('img', {
                src: st.qrImage || ('https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(st.qrUrl)),
                alt: '登录二维码',
              })
            : h('div', { className: 'bf-modal-state' }, '点击「生成二维码」开始'),
          h('div', { className: 'bf-modal-state' }, st.state),
          h('div', { className: 'bf-modal-actions' },
            h(Btn, { small: true, onClick: start }, st.qrUrl ? '重新生成' : '生成二维码'),
            h(Btn, { small: true, variant: 'ghost', onClick: onClose }, '关闭'),
          ),
        ),
      )
    }

    /* ═══════════════════════ §4 看板 ═══════════════════════ */

    const fmtDur = (ms) => {
      const s = Math.round(ms / 1000)
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
    }
    const fmtNum = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n))
    const fmtClock = (sec) => {
      const s = Math.max(0, Math.round(sec))
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    const hhmm = (iso) => {
      try { return new Date(iso).toTimeString().slice(0, 5) } catch { return '' }
    }
    const pct = (u, l) => (l > 0 ? `${Math.min(100, Math.round(((u || 0) / l) * 100))}%` : '0%')

    function AccountBar({ data, onLogin }) {
      const a = data?.account || {}
      const initial = (a.uname || 'B').slice(0, 1)
      return h(Card, null,
        h('div', { className: 'bf-account' },
          h('div', { className: 'bf-avatar', 'aria-hidden': 'true' }, a.face
            ? h('img', { src: a.face, alt: '', onError: (e) => { e.currentTarget.style.display = 'none' } })
            : initial),
          h('div', null,
            h('div', { className: 'bf-account-name' }, a.uname || '未登录',
              a.level ? h('span', { className: 'bf-lv' }, `LV${a.level}`) : null,
              h(Pill, { tone: a.loggedIn ? 'ok' : 'warn' }, a.loggedIn ? '登录有效' : '未登录')),
            h('div', { className: 'bf-account-meta' },
              a.mid ? `UID ${a.mid} · 硬币 ${a.coins} · 粉丝 ${a.fans}${a.vip ? ' · 大会员' : ''}` : '登录后显示账号简况'),
          ),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
            h(Btn, {
              small: true, variant: 'ghost',
              disabled: !a.mid,
              onClick: () => a.mid && window.open(`https://space.bilibili.com/${a.mid}`, '_blank'),
            }, 'B站主页'),
            h(Btn, { small: true, onClick: onLogin }, T.reopen),
          ),
        ),
      )
    }

    function DutyBar({ data, onToggle, onRun, onStop }) {
      const d = data?.duty || {}
      const r = data?.round || {}
      return h(Card, null,
        h('div', { className: 'bf-duty' },
          h('div', { className: 'bf-duty-item' },
            h(Switch, { checked: d.autoDuty, label: '自动值班', onChange: onToggle }),
            h('span', null, '自动值班 ', h('b', null, d.autoDuty ? '已开' : '已关')),
          ),
          h('div', { className: 'bf-duty-item' }, '下一窗 ', h('b', null, d.nextWindowLabel || '—')),
          h('div', { className: 'bf-duty-item' }, '本轮 ', h('b', null, r.running ? '运行中' : '空闲'),
            r.running && r.elapsedMs ? h('span', { className: 'bf-note' }, ` ${fmtDur(r.elapsedMs)}`) : null),
          h('div', { className: 'bf-duty-actions' },
            h(Btn, { variant: 'danger', small: true, disabled: !r.running, onClick: onStop }, T.stop),
            h(Btn, { variant: 'primary', disabled: r.running, onClick: onRun }, T.run),
          ),
        ),
      )
    }

    function QuotaTiles({ data }) {
      const q = data?.quota || {}
      const L = q.limits || {}
      const rows = [
        ['挑中', q.picked, L.perDay],
        ['评论', q.comments, L.commentsPerDay],
        ['点赞', q.likes, L.likesPerDay],
        ['动态', q.dynamics, L.dynamicsPerDay],
      ]
      return h(Card, null,
        h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '今日配额'),
          h('span', { className: 'bf-card-note' }, '按动作类型分别计数，到量即停')),
        h('div', { className: 'bf-quota' },
          rows.map(([label, used, limit]) => h('div', { className: 'bf-tile', key: label },
            h('div', { className: 'bf-tile-label' }, label),
            h('div', { className: 'bf-tile-value' }, `${used ?? 0} `, h('span', null, `/ ${limit ?? 0}`)),
            h('div', { className: 'bf-bar' }, h('i', { style: { width: pct(used, limit) } })),
          )),
        ),
      )
    }

    /* ─── 活动卡（生命周期） ─── */

    const STAGES = [
      ['viewed', '刷到'], ['viewed', '看'], ['liked', '赞'],
      ['commented', '评'], ['replied', '被回复'], ['repliedBack', '我回'],
    ]

    const stampOf = (a, types) => types.map((t) => {
      const ev = a.events.find((e) => e.type === t)
      return ev ? hhmm(ev.t) : ''
    })

    function StageRail({ activity }) {
      const s = activity.stage
      const flags = [s.viewed, s.viewed, s.liked, s.commented, s.replies > 0, s.repliedBack]
      const times = stampOf(activity, ['view', 'view', 'like', 'comment', 'reply-in', 'reply-out'])
      return h('div', { className: 'bf-stages' },
        STAGES.map(([key, label], i) => h('div', {
          key: label, className: `bf-stage${flags[i] ? ' done' : ''}`,
        },
          h('b'), h('span', null, label), h('em', null, times[i] || '—'))),
      )
    }

    function ReplyThread({ activity }) {
      const items = []
      for (const e of activity.events) {
        if (e.type === 'reply-in') items.push({ mine: false, who: e.from, t: e.t, text: e.text, rpid: e.rpid, pending: true })
        if (e.type === 'reply-out') items.push({ mine: true, who: '我', t: e.t, text: e.text, rpid: e.rpid })
      }
      const answered = new Set(activity.events.filter((e) => e.type === 'reply-out').map((e) => e.parent))
      for (const it of items) if (it.pending && answered.has(it.rpid)) it.pending = false
      if (!items.length) return null
      return h('div', { className: 'bf-thread' },
        items.map((it, i) => h('div', { className: `bf-msg${it.mine ? ' mine' : ''}`, key: i },
          h('span', { className: 'bf-msg-name' }, it.who),
          h('span', { className: 'bf-msg-time' }, hhmm(it.t)),
          h('span', { className: 'bf-msg-text' }, it.text),
          it.pending ? h(Chip, { kind: 'warn' }, '待跟进') : null,
        )),
      )
    }

    const GradeBadge = ({ grade }) =>
      h('span', { className: `bf-grade ${grade}` }, GRADE_TEXT[grade] || grade)

    function ActivityCard({ item }) {
      const c = item.events.find((e) => e.type === 'comment')
      const dyn = item.events.find((e) => e.type === 'dynamic')
      const commentRpid = c?.rpid
      const replyRpid = item.events.find((e) => e.type === 'reply-in')?.rpid
      const open = item.stage.replies > 0 || item.stage.repliedBack
      return h('details', { className: 'bf-act', open },
        h('summary', null,
          h('div', { className: 'bf-sum-row' },
            h('span', { className: 'bf-bvid' }, item.bvid),
            item.grade ? h(GradeBadge, { grade: item.grade }) : null,
            item.stage.liked ? h(Chip, null, '赞') : null,
            item.stage.commented ? h(Chip, { kind: 'cmt' }, '评论') : null,
            item.stage.replies ? h(Chip, { kind: 'rep' }, `${item.stage.replies} 回复`) : null,
            item.stage.pendingReply ? h(Chip, { kind: 'warn' }, `${item.stage.pendingReply} 未回`) : null,
            h('span', { className: 'bf-chev' }, '›'),
          ),
          h('div', { className: 'bf-sum-title' }, item.title || item.bvid),
          h('div', { className: 'bf-sum-meta' },
            [item.author, item.views ? `${fmtNum(item.views)}播放` : '', item.duration ? fmtClock(item.duration) : '', item.source ? `来源 ${SRC_LABEL[item.source] || item.source}` : '']
              .filter(Boolean).join(' · ')),
        ),
        h('div', { className: 'bf-act-body' },
          h(StageRail, { activity: item }),
          c ? h('p', { className: 'bf-quote' }, h('span', { className: 'bf-who' }, `我 · ${hhmm(c.t)}`), c.text) : null,
          h(ReplyThread, { activity: item }),
          dyn ? h('div', { className: 'bf-dyn' }, `动态「${dyn.text || ''}」`) : null,
          h('div', { className: 'bf-act-foot' },
            (item.stage.commented && !item.stage.replies && !item.stage.repliedBack)
              ? h('span', null, '还没有人回复') : null,
            h('a', { className: 'bf-link', href: `https://www.bilibili.com/video/${item.bvid}`, target: '_blank', rel: 'noreferrer' }, '打开视频'),
            h('span', { className: 'bf-mono' }, `评论 rpid ${commentRpid ?? '未取到'}`),
            replyRpid ? h('span', { className: 'bf-mono' }, `回复 rpid ${replyRpid}`) : null,
            item.flags?.fromReport ? h('span', { className: 'bf-note' }, '部分事件据报告回填') : null,
          ),
        ),
      )
    }

    /** 轮内分组：跳过的收进折叠组，其余按顺序渲染活动卡（§5.4/§5.5） */
    function groupItems(items) {
      const skipped = items.filter((x) => x.skipped)
      const normal = items.filter((x) => !x.skipped)
      const reasonCount = {}
      for (const s of skipped) {
        const key = s.skipped.reason || '其他'
        reasonCount[key] = (reasonCount[key] || 0) + 1
      }
      const summary = skipped.length
        ? `跳过 ${skipped.length} 条：${Object.entries(reasonCount).map(([k, v]) => `${k} ${v}`).join(' · ')}`
        : ''
      return h(React.Fragment, null,
        normal.map((item) => h(ActivityCard, { key: item.bvid, item })),
        skipped.length
          ? h('details', { className: 'bf-group' },
              h('summary', null, summary),
              h('ul', { className: 'bf-skip-list' },
                skipped.map((s) => h('li', { className: 'bf-skip-item', key: s.bvid },
                  h('span', { className: 'bf-bvid' }, s.bvid),
                  h('span', { className: 'bf-skip-title' }, s.title || s.bvid),
                  h('span', { className: 'bf-skip-reason' }, s.skipped.reason || ''),
                )),
              ),
            )
          : null,
      )
    }

    function RoundBlock({ round }) {
      return h('div', { key: round.id },
        h('div', { className: 'bf-round-head' },
          h('span', { className: 'bf-round-time' }, `${hhmm(round.startedAt)} 这一轮`),
          h('span', { className: 'bf-round-src' }, round.sourceLabel ? `来源：${round.sourceLabel}` : ''),
        ),
        groupItems(round.items),
      )
    }

    /** 活动流：今天的轮次平铺；更早的按天折叠进「更早」组（§5.5） */
    function ActivityFeed({ data, onRun, onLogin }) {
      const days = data?.days || []
      if (!days.length) return h(EmptyState, { onRun, onLogin })
      const now = new Date()
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const nodes = []
      for (const day of days) {
        if (day.date === todayKey || days.length === 1) {
          nodes.push(h('div', { key: day.date }, day.rounds.map((round) => h(RoundBlock, { key: round.id, round }))))
        } else {
          const count = day.rounds.reduce((n, r) => n + (r.items?.length || 0), 0)
          nodes.push(h('details', { className: 'bf-group', key: day.date },
            h('summary', null, `更早 · ${day.date.slice(5)}（${count} 条活动）`),
            day.rounds.map((round) => h(RoundBlock, { key: round.id, round })),
          ))
        }
      }
      return h('div', null, nodes)
    }

    /* ─── 实时运行（LiveCard / LivePane 共用） ─── */

    const liveClock = (iso) => {
      try { return new Date(iso).toTimeString().slice(0, 8) } catch { return '' }
    }

    /** 一行实时事件：时间 + kind/tool 标签 + 正文（配色由 CSS 按 kind 决定） */
    function LiveLine({ e }) {
      const kind = e?.kind || 'text'
      return h('div', { className: `bf-live-line ${kind}` },
        h('span', { className: 'bf-live-t' }, liveClock(e?.t)),
        h('span', { className: 'bf-live-kind' }, e?.tool || LIVE_KIND_CN[kind] || ''),
        h('span', { className: 'bf-live-text' }, e?.text || ''),
      )
    }

    /** 看板实时卡：运行中才显示（DutyBar 之后），最近 5 条事件 + 打开实时 */
    function LiveCard({ live, onOpen }) {
      const d = live?.data || LIVE_EMPTY
      const elapsed = useElapsed(d.running, d.startedAt, d.elapsedMs)
      if (!d.running) return null
      const stats = d.stats || {}
      const toolTotal = Object.values(stats.tools || {}).reduce((n, v) => n + (Number(v) || 0), 0)
      const acts = stats.actions || {}
      const recent = (d.events || []).slice(-5)
      return h(Card, null,
        h('div', { className: 'bf-live-head' },
          h(Pill, { tone: 'ok' }, '运行中'),
          h('span', { className: 'bf-live-clock' }, fmtDur(elapsed)),
          h('span', { className: 'bf-live-meta' }, `阶段 ${d.phase?.label || '思考'}`),
          h(Chip, null, `工具 ${toolTotal}`),
          h(Chip, null, `赞 ${acts.like || 0} · 评 ${acts.comment || 0} · 动态 ${acts.dynamic || 0}`),
          h('div', { className: 'bf-live-actions' },
            h(Btn, { small: true, onClick: onOpen }, '打开实时')),
        ),
        recent.length
          ? h('div', { className: 'bf-live-body mini' },
              recent.map((e, i) => h(LiveLine, { key: e?.seq != null ? e.seq : i, e })))
          : h('div', { className: 'bf-live-meta', style: { marginTop: 8 } }, '还没有实时事件…'),
      )
    }

    function Dashboard({ ov, act, acct, live, onOpenLive }) {
      const data = ov.data
      const onToggle = async (v) => { await apiPost('/duty', { autoDuty: v }); ov.refresh() }
      const onRun = async () => {
        let r = null
        try { r = await apiPost('/run') } catch { /* 失败留在看板，Banner 会提示 */ }
        ov.refresh()
        live?.refresh?.()
        // POST /run 成功返回 { started:true, why, roundId }（没有 ok 字段）；失败是 { started:false, error }
        if (r?.started || r?.ok) onOpenLive?.() // 跑一轮成功后自动切「操作台 → 实时」
      }
      const onStop = async () => { await apiPost('/stop'); ov.refresh() }
      const onLogin = React.useCallback(() => { window.dispatchEvent(new CustomEvent('bf-login')) }, [])
      return h('div', null,
        h(Banner, { health: data?.health, account: acct.data, round: data?.round, onLogin }),
        h(AccountBar, { data: { ...data, account: acct.data }, onLogin }),
        h(DutyBar, { data, onToggle, onRun, onStop }),
        h(LiveCard, { live, onOpen: onOpenLive }),
        h(QuotaTiles, { data }),
        h(ActivityFeed, { data: act.data, onRun, onLogin }),
      )
    }

    /* ═══════════════════════ §5 操作台 ═══════════════════════ */

    /** 模型组（§1.5）：当前生效 + 值班轮 provider/model/推理强度；留空 = 跟随当前会话默认 */
    function ModelFields({ draft, onChange, models, onFollow }) {
      const md = models?.data || null
      const loading = !md
      const eff = md?.effective || null
      const providers = md?.providers || []
      const modelsByProvider = md?.models || {}
      const efforts = md?.reasoningEfforts || []
      const warnings = md?.warnings || []
      const provider = draft.modelProvider || ''
      const model = draft.modelName || ''
      const providerModels = provider ? (modelsByProvider[provider] || []) : []

      const providerOptions = [['', '跟随默认（不指定）'], ...providers.map((p) => [p.id, p.name || p.id])]
      if (provider && !providers.some((p) => p.id === provider)) providerOptions.push([provider, `${provider}（目录里没有）`])
      const modelOptions = [[
        '', provider ? (providerModels.length ? '跟随默认（自动选）' : '该 provider 没有可用模型') : '先选 provider',
      ], ...providerModels.map((m) => [m.id, m.name || m.id])]
      if (model && !providerModels.some((m) => m.id === model)) modelOptions.push([model, `${model}（目录里没有）`])
      const effortOptions = [['', '默认'], ...efforts.map((x) => [x.id, x.name || x.id])]

      return h(Group, { title: '模型' },
        h(Row, { label: '当前生效' },
          loading
            ? h('span', { className: 'bf-note' }, '加载中…')
            : eff
              ? h(React.Fragment, null,
                  h(Pill, { tone: 'ok' }, `${eff.provider || '—'} / ${eff.model || '—'}`),
                  h(Pill, { tone: eff.mode === 'config' ? 'ok' : 'off' }, eff.mode === 'config' ? '插件配置' : '跟随默认'),
                  eff.reasoningEffort ? h(Chip, null, `推理 ${eff.reasoningEffort}`) : null,
                )
              : h('span', { className: 'bf-note' }, '取不到当前会话模型，保存后仍按宿主默认处理'),
          h(Btn, { small: true, variant: 'ghost', onClick: onFollow }, '跟随当前会话模型'),
        ),
        h(Row, { label: 'provider' },
          h(Select, {
            label: '值班轮 provider', value: provider, disabled: loading,
            onChange: (v) => onChange({ modelProvider: v, modelName: '' }),
            options: providerOptions,
          }),
        ),
        h(Row, { label: 'model' },
          h(Select, {
            label: '值班轮 model', value: model, disabled: loading || !provider,
            onChange: (v) => onChange({ modelName: v }),
            options: modelOptions,
          }),
          provider && !model ? h(Chip, { kind: 'warn' }, 'provider 有值但 model 为空：保存后按跟随默认处理') : null,
        ),
        h(Row, { label: '推理强度' },
          h(Select, {
            label: '推理强度', value: draft.modelReasoningEffort || '', disabled: loading,
            onChange: (v) => onChange({ modelReasoningEffort: v }),
            options: effortOptions,
          }),
          h('span', { className: 'bf-note' }, '留空＝不改值班轮的推理强度'),
        ),
        warnings.length ? h('div', { className: 'bf-note' }, warnings.join('；')) : null,
        h('div', { className: 'bf-note', style: { marginTop: 8 } }, '只影响值班轮（headless 会话），不影响当前对话。'),
      )
    }

    function ConfigPane({ ov }) {
      const cfg = usePoll(React.useCallback(() => apiGet('/config'), []), 30000)
      const models = useModels()
      const diag = useDiagnose()
      const [draft, setDraft] = React.useState(null)
      React.useEffect(() => { if (cfg.data && !draft) setDraft({ ...cfg.data.values }) }, [cfg.data, draft])
      const [msg, setMsg] = React.useState('')
      if (!draft) return h('div', { className: 'bf-note' }, '加载中…')

      const setPatch = (patch) => setDraft((prev) => ({ ...(prev || {}), ...patch }))
      const set = (k, v) => setPatch({ [k]: v })
      const save = async () => {
        const patch = {}
        for (const k of Object.keys(draft)) {
          if (JSON.stringify(draft[k]) !== JSON.stringify(cfg.data?.values?.[k])) patch[k] = draft[k]
        }
        if (!Object.keys(patch).length) { setMsg('没有改动'); return }
        const r = await apiPost('/config', patch)
        setMsg(r.ok ? '已保存并生效' : `保存失败：${r.error}`)
        cfg.refresh()
        models.refresh?.()
      }
      // 「跟随当前会话模型」：清空 3 个模型字段并立即保存
      const followDefault = async () => {
        const patch = { modelProvider: '', modelName: '', modelReasoningEffort: '' }
        setPatch(patch)
        try {
          const r = await apiPost('/config', patch)
          setMsg(r?.ok ? '已跟随当前会话模型' : `保存失败：${r?.error || '未知错误'}`)
        } catch (e) { setMsg('保存失败：' + String(e?.message ?? e)) }
        cfg.refresh()
        models.refresh?.()
      }
      return h(Card, null,
        h(ModelFields, { draft, onChange: setPatch, models, onFollow: followDefault }),
        h(Group, { title: '值班节奏' },
          h(Row, { label: '自动值班' }, h(Switch, { checked: !!draft.autoDuty, onChange: (v) => set('autoDuty', v) }),
            h('span', { className: 'bf-note' }, '开启后在谷时窗口自动拉起一轮；关闭后只能手动触发')),
          h(Row, { label: '中午窗口' }, h(Switch, { checked: !!draft.noon, onChange: (v) => set('noon', v) }), h('span', { className: 'bf-note' }, '12:00 – 14:00')),
          h(Row, { label: '晚间窗口' }, h(Switch, { checked: !!draft.night, onChange: (v) => set('night', v) }), h('span', { className: 'bf-note' }, '18:00 – 次日 09:00')),
        ),
        h(Group, { title: '配额' },
          [['perDay', '每天挑中', '全天总量上限'], ['commentsPerDay', '每天评论', ''], ['commentsPerRound', '每轮评论', ''],
           ['likesPerDay', '每天点赞', '成本最低的存在感'], ['dynamicsPerDay', '每天动态', ''], ['repliesPerRound', '每轮跟进回复', '']]
            .map(([k, label, note]) => h(Row, { key: k, label },
              h(Num, { value: Number(draft[k] ?? 0), onChange: (v) => set(k, v) }),
              note ? h('span', { className: 'bf-note' }, note) : null))),
        h(Group, { title: '内容源' },
          h(Row, { label: '指定 UP 主' }, h(ChipsInput, {
            values: (draft.followUids || []).map(String),
            onChange: (v) => set('followUids', v.map((x) => Number(x)).filter(Boolean)),
          }), h('span', { className: 'bf-note' }, 'UID，可留空；留空就靠下面的自动拉取')),
          h(Row, { label: '自动拉关注' }, h(Switch, { checked: draft.followAuto !== false, onChange: (v) => set('followAuto', v) }),
            h('span', { className: 'bf-note' }, '用 bili_followings 按「最常访问」拉常看的 UP 主，免手填 UID')),
          h(Row, { label: '每轮抽查' }, h(Num, { value: Number(draft.followPerRound ?? 8), onChange: (v) => set('followPerRound', v) }),
            h('span', { className: 'bf-note' }, '取「最常访问」前几个常看 UP 主的最新投稿（都看过就顺延；0 = 不抽查）')),
          h(Row, { label: '关键词' }, h(ChipsInput, { values: draft.keywords || [], onChange: (v) => set('keywords', v) }),
            h('span', { className: 'bf-note' }, '其次搜索')),
          h(Row, { label: '不看清单' }, h(ChipsInput, { values: draft.avoidList || [], onChange: (v) => set('avoidList', v) }),
            h('span', { className: 'bf-note' }, 'BV号 / UP主（名或UID）/ 标题关键词；命中整条跳过（不读不赞不评不发）')),
        ),
        h(Group, { title: '禁令' },
          [['banPrivacy', '不透露隐私', '账号 / 路径 / 用户名 / 聊天内容不进评论与动态'],
           ['banImpersonation', '不冒充真实的人', '不模仿任何具体用户'],
           ['banControversy', '不碰争议话题', '立场 / 性别 / 地域 / 引战'],
           ['banRepeat', '同视频只评一次 / 不刷屏', '含动态不连发'],
           ['banReplyRefusal', '不接敏感请求', '写代码 / 做作品 / 承诺 / 贴隐私 / 无关请求']]
            .map(([k, label, note]) => h(Row, { key: k, label },
              h(Switch, { checked: draft[k] !== false, onChange: (v) => set(k, v) }),
              note ? h('span', { className: 'bf-note' }, note) : null)),
          h(Row, { label: '纯文本感想动态' },
            h(Switch, { checked: draft.dynamicPureText !== false, onChange: (v) => set('dynamicPureText', v) }),
            h('span', { className: 'bf-note' }, '关闭后动态只发「分享视频 + 短评」')),
          h('div', { className: 'bf-note' }, '提示注入防御与「先落报告/账本」等保底纪律始终生效，不在开关范围。'),
        ),
        h(Group, { title: '人设' },
          h(Row, { label: '人设提示词' },
            h('textarea', {
              className: 'bf-textarea',
              value: draft.personaPrompt || '',
              placeholder: '例如：二十五六岁，喜欢硬件测评和游戏，说话短、不客套，偶尔自嘲。',
              onChange: (e) => set('personaPrompt', e.target.value),
            }),
            h('span', { className: 'bf-note' }, '留空＝中性说话；也可填文件路径，支持 /绝对路径 与 ~/（目录则读其中的 AGENTS.md）')),
        ),
        h(Group, { title: '运行环境' },
          h(Row, { label: 'dsh CLI' },
            ov?.data?.health?.cli ? h(Pill, { tone: 'ok' }, '已探测') : h(Pill, { tone: 'warn' }, '未找到'),
            h('span', { className: 'bf-note bf-mono' }, ov?.data?.health?.cli || '值班轮会先自动探测')),
          h(Row, { label: 'dshBin' },
            h('input', {
              className: 'bf-search', style: { width: 320 },
              value: draft.dshBin || '',
              placeholder: '留空自动探测（…/@deepseek-ai/dsh/lib/bin.js）',
              onChange: (e) => set('dshBin', e.target.value),
            })),
          h(Row, { label: 'headless profile' }, h('span', { className: 'bf-tag' }, draft.headlessProfile || 'headless'),
            h('span', { className: 'bf-note' }, '值班轮用独立 profile，避免与桌面版抢锁')),
          h(Row, { label: '家目录' }, h('span', { className: 'bf-note bf-mono' }, ov?.data?.home || '—')),
          h(Row, { label: '账本' }, h('span', { className: 'bf-note bf-mono' }, ov?.data?.ledgerFile || '—')),
          h('div', { className: 'bf-card-note', style: { margin: '10px 0 2px' } },
            '安装自检：检查 Python 依赖、MCP 连接、登录凭证与模型是否就绪'),
          h(DiagnosePanel, {
            report: diag.report, loading: diag.loading, error: diag.error, onRun: diag.run,
          }),
        ),
        h('div', { className: 'bf-form-foot' },
          msg ? h('span', { className: 'bf-note' }, msg) : null,
          h(Btn, { variant: 'ghost', onClick: () => setDraft({ ...cfg.data.defaults }) }, '恢复默认'),
          h(Btn, { variant: 'primary', onClick: save }, '保存并生效'),
        ),
      )
    }

    /** 操作台「实时」tab（§1.5）：状态/秒表/阶段/统计/配额 + 按 kind 配色的事件流（自动滚底） */
    function LivePane({ live, ov }) {
      const d = live?.data || LIVE_EMPTY
      const mode = live?.mode || 'poll'
      const err = live?.error || ''
      const elapsed = useElapsed(d.running, d.startedAt, d.elapsedMs)
      const [autoScroll, setAutoScroll] = React.useState(true)
      const bodyRef = React.useRef(null)
      const events = d.events || []
      const stats = d.stats || {}
      const q = d.quota || null
      const toolTotal = Object.values(stats.tools || {}).reduce((n, v) => n + (Number(v) || 0), 0)
      const acts = stats.actions || {}
      const shown = d.running ? events : events.slice(-80) // 空闲时保留上一轮尾部供回看
      const onRun = async () => {
        try { await apiPost('/run') } catch { /* 失败靠下一轮轮询反映真实状态 */ }
        ov?.refresh?.()
        live?.refresh?.()
      }
      const onStop = async () => {
        try { await apiPost('/stop') } catch { /* 忽略 */ }
        ov?.refresh?.()
        live?.refresh?.() // 中止后立刻拉一次，留在实时页看到结束状态
      }

      // 自动滚底：新事件到达就滚到最后；用户手动上滚时 onScroll 关掉自动滚动
      React.useEffect(() => {
        const el = bodyRef.current
        if (!el || !autoScroll) return
        el.scrollTop = el.scrollHeight
      }, [events.length, autoScroll, d.running])

      const onScroll = () => {
        const el = bodyRef.current
        if (!el) return
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        if (!nearBottom && autoScroll) setAutoScroll(false)
      }
      const toggleAuto = (v) => {
        setAutoScroll(v)
        if (v && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
      }

      return h('div', null,
        h('div', { className: 'bf-panel-tools' },
          h(Pill, { tone: d.running ? 'ok' : 'off' }, d.running ? '运行中' : '空闲'),
          h('span', { className: 'bf-live-clock' }, fmtDur(elapsed)),
          h('span', { className: 'bf-live-meta' }, `阶段 ${d.phase?.label || '思考'}`),
          mode === 'poll' ? h(Chip, { kind: 'warn' }, '降级轮询') : null,
          h('div', { className: 'bf-live-actions' },
            h('span', { className: 'bf-note' }, '自动滚动'),
            h(Switch, { checked: autoScroll, label: '自动滚动', onChange: toggleAuto }),
            h(Btn, { small: true, variant: 'danger', disabled: !d.running, onClick: onStop }, T.stop),
            h(Btn, { small: true, variant: 'primary', disabled: d.running, onClick: onRun }, T.run),
          ),
        ),
        h('div', { className: 'bf-live-chips' },
          h(Chip, null, `工具 ${toolTotal}`),
          h(Chip, null, `赞 ${acts.like || 0}`),
          h(Chip, null, `评 ${acts.comment || 0}`),
          h(Chip, null, `动态 ${acts.dynamic || 0}`),
          h(Chip, null, `回复 ${acts.reply || 0}`),
          stats.errors ? h(Chip, { kind: 'warn' }, `错误 ${stats.errors}`) : null,
          q
            ? h('span', { className: 'bf-live-meta' },
                `配额 挑 ${q.picked ?? 0}/${q.limits?.perDay ?? 0}`
                + ` · 评 ${q.comments ?? 0}/${q.limits?.commentsPerDay ?? 0}`
                + ` · 赞 ${q.likes ?? 0}/${q.limits?.likesPerDay ?? 0}`
                + ` · 动态 ${q.dynamics ?? 0}/${q.limits?.dynamicsPerDay ?? 0}`)
            : null,
        ),
        h('div', { className: 'bf-live-body', ref: bodyRef, onScroll },
          shown.length
            ? shown.map((e, i) => h(LiveLine, { key: e?.seq != null ? e.seq : i, e }))
            : h('div', { className: 'bf-live-empty' },
                d.running
                  ? '等待第一条事件…（工具调用 / 推理 / 宿主日志都会出现在这里）'
                  : d.lastCode != null
                    ? '空闲中 · 上一轮已结束，事件已清空'
                    : '空闲中 · 点「跑一轮」开始值班'),
        ),
        h('div', { className: 'bf-live-foot' },
          h('span', null, `事件 ${events.length}`),
          !d.running && d.lastCode != null
            ? h('span', null, `上一轮退出码 ${d.lastCode}${d.lastDurationMs ? ` · 耗时 ${fmtDur(d.lastDurationMs)}` : ''}`)
            : null,
          !d.running && events.length ? h('span', null, '显示上一轮尾部') : null,
          err ? h('span', { className: 'bf-live-err' }, err) : null,
        ),
      )
    }

    function LogPane() {
      const log = usePoll(React.useCallback(() => apiGet('/log?tail=200'), []), 5000)
      const [openRaw, setOpenRaw] = React.useState(false)
      const events = log.data?.events || []
      return h('div', null,
        h('div', { className: 'bf-panel-tools' },
          h(Btn, { small: true, onClick: () => navigator.clipboard?.writeText(log.data?.path || '') }, '复制路径'),
          h('span', { className: 'bf-note' }, log.data?.path || '')),
        h(Card, null,
          h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '宿主事件'),
            h('span', { className: 'bf-card-note' }, '结构化，异常标红')),
          h('div', { className: 'bf-log-events' },
            events.length ? events.slice(-40).map((line, i) => {
              const t = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(line)
              const msg = t ? line.slice(t[0].length) : line
              const err = /失败|错误|异常|error/i.test(msg)
              return h('div', { className: `bf-log-line${err ? ' err' : ''}`, key: i },
                h('span', { className: 'bf-log-t' }, t ? `${hhmm(t[1])}:${new Date(t[1]).toTimeString().slice(6, 8)}` : ''),
                h('span', { className: 'bf-log-msg' }, msg),
              )
            }) : h('div', { className: 'bf-note' }, '（还没有宿主事件）'),
          ),
        ),
        h('details', { className: 'bf-group', open: openRaw, onToggle: (e) => setOpenRaw(e.currentTarget.open) },
          h('summary', null, '子进程原文（含模型推理文本，默认收起）'),
          h('pre', { className: 'bf-raw' }, log.data?.raw || ''),
        ),
      )
    }

    /** seen.md 的动作文本 → chips（赞过+评论过 → [赞][评论]） */
    function actionChips(action) {
      const a = String(action || '').trim()
      const chips = []
      const push = (kind, label) => chips.push(h(Chip, { key: `${label}${chips.length}`, kind }, label))
      if (!a || a === '—') { push('', '—'); return chips }
      if (a.includes('跳过')) { push('', a); return chips }
      if (a.includes('赞')) push('', '赞')
      if (a.includes('评论')) push('cmt', '评论')
      if (a.includes('动态') || a.includes('分享')) push('rep', '动态')
      if (a.includes('回复')) push('rep', '回复')
      if (!chips.length) push('', a)
      return chips
    }

    function SeenPane() {
      const seen = usePoll(React.useCallback(() => apiGet('/seen'), []), 30000)
      const [q, setQ] = React.useState('')
      const rows = (seen.data?.rows || []).filter((r) =>
        !q || r.bvid.includes(q) || (r.title || '').includes(q))
      return h('div', null,
        h('div', { className: 'bf-panel-tools' },
          h('input', { className: 'bf-search', placeholder: '搜索 BV 号或标题', value: q, onChange: (e) => setQ(e.target.value) }),
          h('span', { className: 'bf-card-note', style: { alignSelf: 'center' } }, `共 ${rows.length} 条 · 这是「这个号看过什么」的唯一账本`)),
        h(Card, null, rows.length
          ? h('table', { className: 'bf-grid' },
              h('thead', null, h('tr', null, ['日期', 'BV 号', '动作', '标题'].map((t) => h('th', { key: t }, t)))),
              h('tbody', null, rows.map((r, i) => h('tr', { key: i },
                h('td', null, `${(r.date || '').slice(5)}${r.time ? ' ' + r.time : ''}`),
                h('td', { className: 'bv' }, r.bvid || '—'),
                h('td', null, actionChips(r.action)),
                h('td', null, r.title || '—')))))
          : h('div', { className: 'bf-note' }, seen.data?.raw ? '解析失败，见原文' : '还没有账本记录')),
      )
    }

    function ArtifactsPane() {
      const list = usePoll(React.useCallback(() => apiGet('/reports'), []), 60000)
      const [day, setDay] = React.useState('')
      const doc = usePoll(React.useCallback(() => apiGet(`/report?day=${encodeURIComponent(day)}`), [day]), 60000)
      const days = list.data?.days || []
      const digests = list.data?.digests || []
      const overlay = !!list.data?.overlay
      React.useEffect(() => { if (!day && days.length) setDay(days[0]) }, [days, day])
      const item = (key, name, meta, sel, onClick) => h('button', {
        key, className: 'bf-artifact-item', 'aria-selected': String(sel), onClick,
      }, h('span', { className: 'name' }, name), meta ? h('span', { className: 'meta' }, meta) : null)
      return h('div', { className: 'bf-split' },
        h(Card, { className: 'bf-artifacts', style: { padding: 8 } },
          h('div', { className: 'bf-artifact-list' },
            h('div', { className: 'bf-card-note', style: { padding: '2px 10px 6px' } }, '日报'),
            days.map((d) => item(d, `${d}.md`, '', d === day, () => setDay(d))),
            digests.length ? h('div', { className: 'bf-card-note', style: { padding: '10px 10px 6px' } }, '月度归档') : null,
            digests.map((d) => item(`d-${d}`, `digest/${d}.md`, '归档', d === day, () => setDay(d))),
            overlay ? item('overlay', 'headless-overlay.yml', '诊断', day === 'overlay', () => setDay('overlay')) : null,
          ),
        ),
        h('pre', { className: 'bf-doc' }, doc.data?.text || '（空）'),
      )
    }

    function ConsoleView({ ov, pane, setPane, live }) {
      return h('div', null,
        h(Tabs, {
          items: [['config', '配置'], ['live', T.live], ['log', '日志'], ['seen', '判重表'], ['artifacts', '产物']],
          value: pane, onChange: setPane,
        }),
        pane === 'config' ? h(ConfigPane, { ov })
          : pane === 'live' ? h(LivePane, { live, ov })
          : pane === 'log' ? h(LogPane, null)
          : pane === 'seen' ? h(SeenPane, null)
          : h(ArtifactsPane, null),
      )
    }

    /* ═══════════════════════ §6 页面 ═══════════════════════ */

    /**
     * 控制台页面。view（看板/操作台）与 pane（操作台 tab）提升到这里，
     * 这样看板「跑一轮」成功后 / LiveCard「打开实时」能直接切到「实时」。
     * props.initialView / props.initialPane / props.live 仅用于渲染冒烟测试注入初始状态。
     */
    function ConsolePage(props) {
      const [view, setView] = React.useState(props?.initialView || 'dashboard')
      const [pane, setPane] = React.useState(props?.initialPane || 'config')
      const [loginOpen, setLoginOpen] = React.useState(false)
      const ov = useOverview()
      const running = !!ov.data?.round?.running
      const act = useActivity(running)
      const acct = useAccount()
      const liveState = useLive()
      const live = props?.live || liveState
      const openLive = React.useCallback(() => {
        setView('console'); setPane('live'); liveState.refresh?.()
      }, [liveState.refresh])
      React.useEffect(() => {
        const open = () => setLoginOpen(true)
        window.addEventListener('bf-login', open)
        return () => window.removeEventListener('bf-login', open)
      }, [])
      const onLoggedIn = React.useCallback(() => {
        setLoginOpen(false)
        ov.refresh(); act.refresh(); acct.refresh()
      }, [ov, act, acct])
      const refreshAll = () => { ov.refresh(); act.refresh(); acct.refresh(); live?.refresh?.() }
      const account = acct.data
      return h('div', { className: 'bf-console' },
        h('div', { className: 'bf-page' },
          h('header', { className: 'bf-page-head' },
            h('div', null,
              h('h1', { className: 'bf-page-title' }, T.title),
              h('p', { className: 'bf-page-sub' }, T.subtitle),
            ),
            h('div', { className: 'bf-head-tools' },
              h(Pill, { tone: account?.loggedIn ? 'ok' : 'warn' },
                account === null ? '检查登录…' : account?.loggedIn ? '登录有效' : '未登录'),
              h(Btn, { small: true, variant: 'ghost', onClick: refreshAll }, T.refresh),
            ),
          ),
          h('div', { className: 'bf-segmented', role: 'tablist', 'aria-label': '子页' },
            ['dashboard', 'console'].map((k) =>
              h('button', {
                key: k,
                role: 'tab',
                'aria-selected': String(view === k),
                onClick: () => setView(k),
              }, k === 'dashboard' ? T.dashboard : T.console)),
          ),
          view === 'dashboard'
            ? h(Dashboard, { ov, act, acct, live, onOpenLive: openLive })
            : h(ConsoleView, { ov, pane, setPane, live }),
        ),
        loginOpen ? h(LoginModal, { onClose: () => setLoginOpen(false), onLoggedIn }) : null,
      )
    }

    /* ─── 设置页瘦身版（§2.3：顶部安装自检 + 一行说明 + 打开控制台） ─── */

    let ctxLayout = null

    function SettingsEntry() {
      const acct = useAccount()
      const diag = useDiagnose()
      const a = acct.data || {}
      return h('div', { className: 'bf-console', style: { padding: 16 } },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '安装自检'),
            h('span', { className: 'bf-card-note' }, '检查插件依赖、MCP 连接、登录与模型是否就绪'),
          ),
          h(DiagnosePanel, {
            report: diag.report, loading: diag.loading, error: diag.error, onRun: diag.run, compact: true,
          }),
        ),
        h('p', null, 'B站分身已经把控制台搬到左侧栏：账号、值班、配额与每条视频的活动生命周期都在那里。'),
        h('p', { className: 'bf-note' }, a.loggedIn ? `当前账号：${a.uname}（UID ${a.mid}）` : '当前未登录'),
        h(Btn, {
          variant: 'primary',
          onClick: () => { try { ctxLayout?.selectPanel?.(PANEL_ID) } catch { /* 老版本宿主没有该 API */ } },
        }, '打开控制台'),
      )
    }

    /* ═══════════════════════ §7 注册 ═══════════════════════ */

    /* 图标：ownerProps { size, active }；B站粉/蓝只用于侧栏图标（§9.3） */
    function PanelIcon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' },
        h('rect', { x: 2.5, y: 5.5, width: 11, height: 9, rx: 2.4, fill: '#fb7299' }),
        h('rect', { x: 10.5, y: 9.5, width: 11, height: 9, rx: 2.4, fill: '#23ade5', fillOpacity: .92 }),
        h('path', { d: 'M5 3.2l2 1.8M11 3.2l-2 1.8', stroke: '#fb7299', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M13.6 7.2l2 1.8M19.6 7.2l-2 1.8', stroke: '#23ade5', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { cx: 6.2, cy: 9.6, r: .95, fill: '#fff' }),
        h('circle', { cx: 9.8, cy: 9.6, r: .95, fill: '#fff' }),
        h('circle', { cx: 14, cy: 13.6, r: .9, fill: '#fff' }),
        h('circle', { cx: 17.6, cy: 13.6, r: .9, fill: '#fff' }),
      )
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctxLayout = ctx.get?.('layout') ?? ctx.layout ?? ctxLayout
        ensureStyle()
        // 每个注册独立兜底：一个槽位失败不影响其余（import/注册失败不能拖垮整条插件）
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 15,                       // 插件(0) < 自动化任务(10) < 本页(15) < 上下文(20)
            label: () => T.title,            // thunk：每次投影重新读取，便于以后接 locale
          }, PanelIcon))
        } catch (e) { console.error('[bili-fenshen] 注册侧栏图标失败：', e) }
        try {
          // ⭐ 写法对齐 dsh-context（从安装包源码核实）：inject 效果回调直接返回 register 的 disposer（普通回调，非生成器）
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,                 // 页面内部不声明子槽位（tab 自绘）
          }, ConsolePage))
        } catch (e) { console.error('[bili-fenshen] 注册 main 面板失败：', e) }
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: PANEL_ID, order: 35, label: T.title,
          }, SettingsEntry))
        } catch (e) { console.error('[bili-fenshen] 注册设置页入口失败：', e) }
      },
    }
  },
})
