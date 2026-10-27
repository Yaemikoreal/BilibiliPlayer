/**
 * dsh-bili-fenshen —— Client 半部（单文件控制台）
 *
 * 注册：sidebar.panellist（图标）+ main（控制台页面）+ settings.section（瘦身版）
 * 结构（设计文档 §10）：
 *   §0 常量（PANEL_ID / 文案表 T / 轮询间隔）
 *   §1 CSS（宿主 --dsw-* token 映射为局部变量 + demo 组件样式，bf- 前缀）
 *   §2 数据层（apiGet/apiPost/usePoll + useModels/useLive/useDiagnose：SSE 优先、降级轮询、visibility 暂停）
 *   §3 基础组件（Btn/Switch/Num/Chip/Pill/Card/Group/Row/ChipsInput/Select/Banner/EmptyState/DiagnosePanel/LoginModal）
 *   §4 活动（ActivityPage/ActivityCard/StageRail/Markdown/SeenPage/ReportsPage/LivePage/LiveLine）
 *   §5 页面数据源（useOverview/useActivity/useAccount/usePersona/useLive/useModels/useDiagnose）
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
        --border-l3:var(--dsw-alias-border-l3);
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
        --input:var(--dsw-alias-bg-layer-3);
        --label-primary-foreground:var(--dsw-alias-label-primary-foreground);
        --switch-thumb:var(--dsw-alias-switch-thumb);
        --settings-card-fill:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));
        --settings-card-stroke:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));
        --focus-ring:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
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
        font-size:14px; line-height:22px;
      }
      /* 页面滚动根（对齐宿主插件页：宿主不给 padding/滚动，页面自己滚） */
      .bf-root{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--bg-base)}
      /* 设置面板里的 section（宿主 settings 面板内部滚动，不要再套一层 height/overflow） */
      .bf-settings-section{display:flex;flex-direction:column;gap:12px;max-width:760px}
      .bf-settings-title{font-size:18px;line-height:26px;font-weight:600;color:var(--label-primary)}
      .bf-settings-desc{font-size:13px;line-height:20px;color:var(--label-tertiary)}
      .bf-console, .bf-console *{box-sizing:border-box}
      .bf-console :focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
      .bf-console button:focus:not(:focus-visible){outline:none}
      .bf-console .bf-pill,.bf-console .bf-chip,.bf-console .bf-chipbtn,.bf-console .bf-switch,.bf-console .bf-avatar,.bf-console .bf-dot,.bf-console .bf-lv{border-radius:999px;corner-shape:round}
      @media (prefers-reduced-motion:reduce){.bf-console *{transition:none!important;animation:none!important}}
      .bf-console .bf-scroll{scrollbar-width:thin}
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
        display:inline-flex;gap:2px;padding:4px;background:var(--interactive-hover);
        border-radius:var(--r-md);margin-bottom:18px;
      }
      .bf-segmented button{
        border:0;background:transparent;color:var(--label-secondary);cursor:pointer;
        height:28px;padding:0 16px;border-radius:var(--r-sm);font-size:13px;line-height:20px;
        transition:background var(--dur) var(--ease),color var(--dur) var(--ease);
      }
      .bf-segmented button:hover{color:var(--label-primary)}
      .bf-segmented button[aria-selected="true"]{
        background:var(--bg-layer-1);color:var(--label-primary);
        box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.06));
      }

      /* ───────── generic card ───────── */
      .bf-card{
        border:.5px solid var(--border-l2);border-radius:var(--r-lg);
        background:var(--bg-layer-1);padding:14px 16px;
      }
      .bf-card + .bf-card{margin-top:10px}
      .bf-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
      .bf-card-title{font-size:14px;line-height:20px;font-weight:500;color:var(--label-primary)}
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
        display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:0;
        font-size:12px;line-height:18px;font-weight:400;
        border-radius:999px;color:var(--label-secondary);background:var(--bg-layer-2);
      }
      .bf-dot{width:6px;height:6px;border-radius:50%;flex:0 0 6px;display:inline-block}
      .bf-dot.ok{background:var(--success)}
      .bf-dot.warn{background:var(--warn)}
      .bf-dot.off{background:var(--idle)}

      /* ───────── buttons ───────── */
      .bf-btn{
        display:inline-flex;align-items:center;justify-content:center;gap:4px;
        height:32px;padding:0 12px;border-radius:var(--r-md);cursor:pointer;
        border:.5px solid var(--border-l3);background:transparent;color:var(--label-primary);
        font-size:13px;line-height:20px;
        transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease),opacity var(--dur) var(--ease);
      }
      .bf-btn:hover{background:var(--interactive-hover)}
      .bf-btn:active{background:var(--interactive-active)}
      .bf-btn.primary{background:var(--brand-primary);color:var(--label-primary-foreground);border-color:transparent}
      .bf-btn.primary:hover{background:var(--brand-hover)}
      .bf-btn.ghost{border-color:transparent;color:var(--label-secondary)}
      .bf-btn.ghost:hover{color:var(--label-primary);background:var(--interactive-hover)}
      .bf-btn.small{height:28px;padding:0 10px;border-radius:var(--r-sm);font-size:12px;line-height:18px}
      .bf-btn:disabled{opacity:.4;cursor:not-allowed}
      .bf-btn.danger{color:var(--error);border-color:color-mix(in srgb, var(--error) 30%, transparent)}
      .bf-btn.danger:hover{background:var(--interactive-hover)}
      .bf-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:var(--r-sm);background:transparent;color:var(--label-secondary)}
      .bf-iconbtn:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-iconbtn:disabled{opacity:.4}

      /* ───────── switch ───────── */
      .bf-switch{
        position:relative;display:inline-flex;margin:0;width:36px;height:20px;border-radius:999px;corner-shape:round;border:0;padding:2px;cursor:pointer;
        background:var(--border-l3);transition:background var(--dur) var(--ease);flex:none;
      }
      .bf-switch::after{
        content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;corner-shape:round;
        background:var(--switch-thumb);
        transition:transform var(--dur) var(--ease);
      }
      .bf-switch[aria-checked="true"]{background:var(--brand-primary)}
      .bf-switch[aria-checked="true"]::after{transform:translateX(16px);background:var(--label-primary-foreground)}
      .bf-switch:disabled{opacity:.5;cursor:default}

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
        font-size:11px;line-height:17px;padding:1px 8px;border:0;border-radius:999px;font-weight:500;
        color:var(--label-secondary);background:var(--bg-layer-2);
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
        font-size:13px;line-height:20px;color:var(--label-primary);
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
      details.bf-group > summary::after{content:"›";margin-left:auto;color:var(--label-caption);transition:transform var(--dur) var(--ease)}
      details.bf-group[open] > summary::after{transform:rotate(90deg)}
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
      .bf-empty{padding:24px 0;text-align:center;color:var(--label-tertiary);background:none;border:0}
      .bf-empty-title{font-size:14px;line-height:22px;font-weight:500;color:var(--label-secondary);margin-bottom:6px}

      /* ───────── banners ───────── */
      .bf-banner{
        display:flex;gap:10px;align-items:center;padding:10px 12px;border-radius:var(--r-md);
        font-size:12px;line-height:18px;margin-bottom:10px;border:0;flex-wrap:wrap;color:var(--label-secondary);
      }
      .bf-banner.warn{background:var(--warn-3)}
      .bf-banner.error{background:color-mix(in srgb, var(--error) 8%, var(--bg-layer-1));border-radius:var(--r-lg);padding:8px 10px;color:var(--error)}
      .bf-banner .bf-btn{margin-left:auto;flex:0 0 auto}

      /* ───────── 操作台 ───────── */
      .bf-ctabs{display:flex;gap:22px;border-bottom:.5px solid var(--border-l2);margin:2px 0 18px}
      .bf-ctabs button{
        border:0;background:transparent;cursor:pointer;padding:7px 1px 9px;position:relative;
        font-size:13px;line-height:20px;color:var(--label-tertiary);
        transition:color var(--dur) var(--ease);
      }
      .bf-ctabs button:hover{color:var(--label-primary)}
      .bf-ctabs button[aria-selected="true"]{color:var(--label-primary)}
      .bf-ctabs button[aria-selected="true"]::after{
        content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--label-primary);
      }
      .bf-panel-tools{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}

      .bf-form-group + .bf-form-group{margin-top:18px;padding-top:18px;border-top:.5px solid var(--border-l1)}
      .bf-group-title{font-size:13px;font-weight:500;margin:0 0 10px;color:var(--label-primary)}
      .bf-row{display:flex;align-items:center;gap:12px;padding:7px 0;min-height:34px}
      .bf-row-label{flex:0 0 132px;font-size:13px;color:var(--label-secondary)}
      .bf-row-help{font-size:11px;line-height:16px;color:var(--label-caption);margin-top:2px;font-weight:400}
      .bf-row-body{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .bf-num{
        display:inline-flex;align-items:center;border:.5px solid var(--border-l4);border-radius:var(--r-md);
        overflow:hidden;background:var(--input);height:34px;
      }
      .bf-num button{
        width:28px;height:100%;border:0;background:transparent;color:var(--label-secondary);cursor:pointer;font-size:14px;
      }
      .bf-num button:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-num input{
        width:44px;height:100%;border:0;background:transparent;color:var(--label-primary);
        text-align:center;font-size:13px;font-variant-numeric:tabular-nums;outline:none;
      }
      .bf-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .bf-tag{
        display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:0;border-radius:999px;corner-shape:round;
        background:var(--bg-layer-2);font-size:11px;line-height:17px;font-weight:500;color:var(--label-secondary);
      }
      .bf-tag button{border:0;background:transparent;color:var(--label-caption);cursor:pointer;padding:0 2px;border-radius:var(--r-xs)}
      .bf-tag button:hover{color:var(--label-primary);background:var(--interactive-hover)}
      .bf-tag-add{
        height:26px;padding:0 9px;border:.5px dashed var(--border-l4);border-radius:var(--r-sm);
        background:transparent;color:var(--label-tertiary);font-size:12px;cursor:pointer;
      }
      .bf-tag-add:hover{color:var(--label-primary);border-color:var(--label-caption)}
      .bf-console textarea{
        width:100%;min-height:76px;resize:vertical;padding:8px 12px;border-radius:var(--r-md);
        border:.5px solid var(--border-l4);background:var(--input);color:var(--label-primary);
        font-family:var(--font-text);font-size:13px;line-height:20px;outline:none;
      }
      .bf-console textarea:focus-visible{border-color:var(--business);outline:2px solid var(--focus-ring);outline-offset:2px}
      .bf-console textarea::placeholder,.bf-search::placeholder{color:var(--label-caption)}
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
        height:34px;min-width:180px;max-width:280px;padding:0 12px;border-radius:var(--r-md);
        border:.5px solid var(--border-l4);background:var(--input);color:var(--label-primary);
        font-size:13px;line-height:20px;outline:none;cursor:pointer;
      }
      .bf-select:focus-visible{border-color:var(--business);outline:2px solid var(--focus-ring);outline-offset:2px}
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
        height:34px;padding:0 12px;border-radius:var(--r-md);border:.5px solid var(--border-l4);
        background:var(--input);color:var(--label-primary);font-size:13px;line-height:20px;outline:none;width:220px;
      }
      .bf-search:focus-visible{border-color:var(--business);outline:2px solid var(--focus-ring);outline-offset:2px}

      /* ───────── artifacts ───────── */
      .bf-artifact-list{display:flex;flex-direction:column;gap:2px}
      .bf-artifact-item{
        display:flex;align-items:center;gap:10px;min-height:34px;padding:6px 8px;border-radius:var(--r-md);
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


      /* ───────── 人设工作室（8 页签） ───────── */
      .bf-pf-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}
      .bf-pf-budget{display:grid;grid-template-columns:96px minmax(0,1fr) 76px;gap:10px;align-items:center;padding:5px 0}
      .bf-pf-budget .bf-bar{margin-top:0}
      .bf-pf-num{font-family:var(--font-code);font-size:11px;color:var(--label-caption);text-align:right;font-variant-numeric:tabular-nums}
      .bf-pf-sub{font-size:12px;line-height:18px;color:var(--label-caption);margin-top:6px}
      .bf-pf-section{display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:.5px solid var(--border-l2);font-size:13px;line-height:20px;color:var(--label-secondary)}
      .bf-pf-section:last-child{border-bottom:0}
      .bf-pf-section .n{margin-left:auto;font-family:var(--font-code);font-size:11px;color:var(--label-caption)}
      .bf-buckets{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
      .bf-bucket{border:.5px solid var(--border-l2);border-radius:var(--r-md);background:var(--bg-layer-1);padding:9px 11px;text-align:left;cursor:pointer;min-width:0}
      .bf-bucket:hover{background:var(--interactive-hover)}
      .bf-bucket[aria-pressed="true"]{border-color:var(--business);background:var(--business-0)}
      .bf-bucket b{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500}
      .bf-bucket .m{font-size:11px;line-height:14px;color:var(--label-caption);margin-top:3px;font-variant-numeric:tabular-nums}
      .bf-console textarea.bf-json{width:100%;min-height:320px;font-family:var(--font-code);font-size:12px;line-height:18px;padding:10px 12px;border-radius:var(--r-md);border:.5px solid var(--border-l4);background:var(--input);color:var(--label-primary);resize:vertical;outline:none}
      .bf-console textarea.bf-json:focus-visible{border-color:var(--business);outline:2px solid var(--focus-ring);outline-offset:2px}
      .bf-sandbox-note{max-width:640px;font-size:13px;line-height:20px;color:var(--label-secondary)}

      /* ───────── 旧人设面板（待删除） ───────── */
      .bf-pf{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}
      .bf-pf .bf-card + .bf-card{margin-top:10px}
      .bf-pf-bar-row{display:grid;grid-template-columns:104px 1fr 84px;gap:10px;align-items:center;padding:5px 0}
      .bf-pf-bar-row .bf-bar{margin-top:0}
      .bf-pf-num{font-family:var(--font-code);font-size:11px;color:var(--label-tertiary);text-align:right;font-variant-numeric:tabular-nums}
      .bf-bar i.warn{background:var(--warn)}
      .bf-bar i.over{background:var(--error)}
      .bf-pf-kv{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .bf-dot.err{background:var(--error)}


      /* ═════════ v3 全局壳（DSH 原生风格：无插件自绘侧栏，只有页面顶栏 + 页签） ═════════ */
      .bf-shell-inner{width:100%;max-width:960px;margin:0 auto;padding:28px clamp(24px,4vw,48px) 48px}
      [data-platform="darwin"] .bf-shell-inner{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
      @media (max-width:680px){.bf-shell-inner{padding:20px 16px 40px}}
      .bf-app-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:10px}
      .bf-app-title{font-size:20px;line-height:28px;font-weight:500;color:var(--label-primary)}
      .bf-app-sub{font-size:13px;line-height:20px;color:var(--label-secondary);margin-top:2px}
      .bf-app-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .bf-status-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px}
      .bf-nav{display:flex;gap:22px;border-bottom:.5px solid var(--border-l2);margin:10px 0 18px;overflow-x:auto;scrollbar-width:none}
      .bf-nav::-webkit-scrollbar{display:none}
      .bf-nav button{position:relative;border:0;background:none;padding:7px 1px 9px;font-size:13px;line-height:20px;color:var(--label-tertiary);white-space:nowrap;cursor:pointer}
      .bf-nav button:hover{color:var(--label-primary)}
      .bf-nav button[aria-selected="true"]{color:var(--label-primary)}
      .bf-nav button[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--label-primary)}
      .bf-nav .bf-nav-count{margin-left:6px;font-size:11px;line-height:16px;padding:0 5px;border-radius:999px;background:var(--bg-module-platform);border:.5px solid var(--border-l1);color:var(--label-tertiary);font-variant-numeric:tabular-nums}
      .bf-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;align-items:start}
      .bf-grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;align-items:start}
      .bf-grid-5{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;align-items:start}
      .bf-sec{margin-top:14px}
      .bf-metric{border:.5px solid var(--border-l2);border-radius:var(--r-md);background:var(--bg-layer-1);padding:12px 14px 12px;min-width:0}
      .bf-metric-label{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--label-tertiary);white-space:nowrap}
      .bf-metric-value{display:flex;align-items:baseline;gap:4px;margin-top:5px;font-size:20px;line-height:28px;font-weight:500;color:var(--label-primary);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
      .bf-metric-value small{font-size:12px;font-weight:400;color:var(--label-caption)}
      .bf-metric-foot{font-size:12px;line-height:18px;color:var(--label-caption);margin-top:2px;font-variant-numeric:tabular-nums}
      .bf-kv-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:.5px solid var(--border-l2)}
      .bf-kv-row:last-child{border-bottom:0}
      .bf-kv-k{font-size:12px;line-height:18px;color:var(--label-tertiary);flex:0 0 auto;white-space:nowrap}
      .bf-kv-v{font-size:13px;line-height:20px;color:var(--label-primary);text-align:right;min-width:0;overflow-wrap:anywhere}
      .bf-spark{display:flex;gap:8px;padding-top:4px}
      .bf-spark-col{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end}
      .bf-spark-bars{height:54px;display:flex;align-items:flex-end;gap:2px}
      .bf-spark-b{flex:1;border-radius:2px 2px 0 0;background:var(--business);opacity:.85;min-height:2px}
      .bf-spark-b.like{background:var(--bili-pink)}
      .bf-spark-l{font-size:11px;line-height:15px;color:var(--label-caption);text-align:center;margin-top:4px;white-space:nowrap;overflow:hidden}
      .bf-mini-list{display:flex;flex-direction:column}
      .bf-mini-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:.5px solid var(--border-l2)}
      .bf-mini-row:last-child{border-bottom:0}
      .bf-mini-time{flex:0 0 78px;padding-top:1px}
      .bf-mini-time b{display:block;font-size:12px;line-height:17px;color:var(--label-secondary);font-variant-numeric:tabular-nums}
      .bf-mini-time span{display:block;font-size:11px;line-height:15px;color:var(--label-caption)}
      .bf-mini-main{min-width:0;flex:1}
      .bf-mini-title{font-size:13px;line-height:19px;color:var(--label-primary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
      .bf-mini-meta{display:flex;gap:4px;flex-wrap:wrap;margin-top:5px}
      .bf-health{display:flex;flex-direction:column}
      .bf-health-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:.5px solid var(--border-l1)}
      .bf-health-row:last-child{border-bottom:0}
      .bf-health-row .bf-note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bf-subtabs{display:flex;gap:22px;border-bottom:.5px solid var(--border-l2);margin:0 0 14px}
      .bf-subtabs button{position:relative;border:0;background:none;padding:7px 1px 9px;font-size:13px;line-height:20px;color:var(--label-tertiary);cursor:pointer}
      .bf-subtabs button:hover{color:var(--label-primary)}
      .bf-subtabs button[aria-selected="true"]{color:var(--label-primary)}
      .bf-subtabs button[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--label-primary)}
      @media (max-width:900px){
        .bf-shell-inner{padding:18px 16px 40px}
        .bf-grid-5{grid-template-columns:repeat(3,1fr)}
        .bf-app-actions{width:100%;margin-left:0}
      }




      /* ───────── 设置页（宿主设置卡 / 字段 stacked / 显式保存条） ───────── */
      .bf-config{display:flex;flex-direction:column;gap:12px}
      .bf-form-group{background:var(--settings-card-fill);border:.5px solid var(--settings-card-stroke);border-radius:var(--r-xl);padding:16px 18px;margin:0}
      .bf-form-group + .bf-form-group{margin-top:0;padding-top:16px;border-top:0}
      .bf-group-title{font-size:14px;line-height:20px;font-weight:500;margin:0 0 4px;color:var(--label-primary)}
      .bf-row{display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:12px 0;border-top:.5px solid var(--border-l2);min-height:0}
      .bf-row:first-of-type{border-top:0}
      .bf-row-label{flex:none;font-size:13px;line-height:20px;font-weight:500;color:var(--label-secondary)}
      .bf-row-help{font-size:12px;line-height:18px;color:var(--label-secondary);font-weight:400;margin-top:0}
      .bf-row-body{flex:none;display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;width:100%}
      .bf-row-body > .bf-search{max-width:460px;width:100%}
      .bf-savebar{position:sticky;bottom:12px;z-index:5;display:flex;align-items:center;gap:10px;padding:10px 14px;margin-top:2px;
        border:.5px solid var(--border-l2);border-radius:var(--r-md);background:var(--bg-layer-1);box-shadow:var(--dsw-elevation-soft,0 2px 8px rgba(0,0,0,.08))}
      .bf-savebar .bf-note{margin-right:auto}
      .bf-savebar-dot{width:6px;height:6px;border-radius:999px;background:var(--warn);flex:0 0 6px}

      /* ───────── v3 列表 / 表格 / Markdown（宿主列表行规格） ───────── */
      table.bf-grid{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}
      table.bf-grid th{position:sticky;top:0;z-index:1;background:var(--bg-layer-1);text-align:left;font-weight:500;font-size:12px;line-height:18px;color:var(--label-tertiary);padding:8px 10px;border-bottom:.5px solid var(--border-l2);white-space:nowrap}
      table.bf-grid td{padding:8px 10px;border-bottom:.5px solid var(--border-l2);color:var(--label-secondary);vertical-align:top;line-height:20px;overflow-wrap:anywhere}
      table.bf-grid td .bf-btn{white-space:nowrap}
      table.bf-grid tbody tr:hover td{background:var(--interactive-hover)}
      table.bf-grid tr:last-child td{border-bottom:0}
      table.bf-grid td.bv{font-family:var(--font-code);font-size:11px;color:var(--label-tertiary);white-space:nowrap}
      .bf-tbl-wrap{max-height:620px;overflow:auto}
      .bf-split2{display:grid;grid-template-columns:236px minmax(0,1fr);gap:14px;align-items:start}
      @media (max-width:900px){.bf-split2{grid-template-columns:1fr}}
      .bf-list{display:flex;flex-direction:column;gap:2px;padding:6px}
      .bf-list-btn{display:flex;align-items:center;gap:8px;min-height:34px;padding:6px 8px;border:0;border-radius:var(--r-md);background:transparent;color:var(--label-secondary);font-size:13px;line-height:20px;text-align:left;width:100%;cursor:pointer}
      .bf-list-btn:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-list-btn[aria-current="true"]{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-list-btn .l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bf-list-btn .m{margin-left:auto;font-size:11px;line-height:14px;color:var(--label-caption);white-space:nowrap;flex:0 0 auto}
      .bf-list-sep{font-size:11px;line-height:14px;color:var(--label-caption);padding:10px 8px 4px;margin-top:4px;border-top:.5px solid var(--border-l2)}
      .bf-md{font-size:14px;line-height:22px;color:var(--label-secondary);max-width:780px}
      .bf-md h1{font-size:18px;line-height:26px;font-weight:600;color:var(--label-primary);margin:0 0 10px;padding-bottom:8px;border-bottom:.5px solid var(--border-l2)}
      .bf-md h2{font-size:16px;line-height:24px;font-weight:500;color:var(--label-primary);margin:22px 0 8px}
      .bf-md h3{font-size:14px;line-height:22px;font-weight:500;color:var(--label-primary);margin:16px 0 6px}
      .bf-md p{margin:0 0 10px}
      .bf-md strong{color:var(--label-primary);font-weight:500}
      .bf-md code{background:var(--bg-layer-2);border-radius:4px;padding:1px 5px;font-family:var(--font-code);font-size:12px;color:var(--label-primary)}
      .bf-md ul{margin:0 0 10px;padding-left:2px;display:flex;flex-direction:column;gap:2px}
      .bf-md li{position:relative;padding-left:14px}
      .bf-md li::before{content:"";position:absolute;left:2px;top:10px;width:4px;height:4px;border-radius:999px;background:var(--label-caption)}
      .bf-md a{color:var(--business);text-decoration:none;overflow-wrap:anywhere}
      .bf-md a:hover{text-decoration:underline}
      .bf-md blockquote{margin:8px 0 12px;padding:2px 0 2px 12px;border-left:2px solid var(--border-l2);color:var(--label-tertiary)}
      .bf-md hr{border:0;border-top:.5px solid var(--border-l2);margin:18px 0}
      .bf-md pre{background:var(--bg-layer-2);border-radius:var(--r-md);padding:10px 12px;overflow:auto;font-size:12px;line-height:18px;margin:0 0 12px}
      .bf-md pre code{background:none;padding:0;font-size:12px}

      /* ───────── v3 活动页（按视频 / 时间线） ───────── */
      .bf-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border:.5px solid var(--border-l2);border-radius:var(--r-md);background:var(--bg-layer-1);margin-bottom:14px}
      .bf-chipbtn{height:24px;padding:0 10px;border-radius:999px;corner-shape:round;border:0;background:var(--bg-layer-2);color:var(--label-secondary);font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
      .bf-chipbtn:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-chipbtn[aria-pressed="true"]{background:var(--interactive-hover);color:var(--label-primary);box-shadow:inset 0 0 0 1px var(--border-l3)}
      .bf-daysep{display:flex;align-items:center;gap:10px;margin:22px 0 10px;font-size:12px;line-height:18px;color:var(--label-tertiary)}
      .bf-daysep::after{content:"";flex:1;height:.5px;background:var(--border-l2)}
      .bf-evt{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:.5px solid var(--border-l1)}
      .bf-evt:last-child{border-bottom:0}
      .bf-evt-type{flex:0 0 88px}
      .bf-evt-main{flex:1;min-width:0}
      .bf-evt-title{font-size:13px;line-height:19px;color:var(--label-primary);overflow-wrap:anywhere}
      .bf-evt-meta{font-size:12px;line-height:17px;color:var(--label-caption);margin-top:2px;overflow-wrap:anywhere}
      .bf-evt-time{flex:0 0 auto;font-family:var(--font-code);font-size:11px;color:var(--label-caption);white-space:nowrap;padding-top:1px}
      .bf-empty-inline{padding:26px 14px;text-align:center;font-size:13px;line-height:19px;color:var(--label-tertiary)}
      .bf-stat-line{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--label-caption);margin-bottom:10px}
      .bf-stat-line b{color:var(--label-primary);font-weight:500;font-variant-numeric:tabular-nums}

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
        position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42));backdrop-filter:var(--dsw-mask-blur,none);
        display:grid;place-items:center;z-index:9999;padding:max(24px,1.5rem) 24px;
      }
      .bf-modal{
        width:min(380px,100%);background:var(--bg-layer-2);border:0;border-radius:var(--r-xl);
        padding:22px 24px 24px;text-align:center;box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.22));
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
    const apiPut = (path, body) => fetch(`/api/bili-fenshen${path}`, {
      method: 'PUT',
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
    // 人设健康度（概览卡 + 人设页共用；30s 足够，保存/切预设后手动 refresh）
    const usePersona = () => usePoll(React.useCallback(() => apiGet('/persona'), []), 30000)

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
        items.push({ tone: 'error', text: '找不到 dsh CLI，值班轮跑不起来 —— 到「设置 → 运行环境」填写 dshBin。' })
      }
      if (round && round.lastCode != null && round.lastCode !== 0) {
        items.push({ tone: 'error', text: `上一轮退出码 ${round.lastCode}（${round.lastWhy || '未知来源'}）—— 到「设置 → 宿主日志」看尾部。` })
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


    /* ─── v3 概览：DSH 原生风格的只读面板（全部数据来自已有端点） ─── */

    const dayKeyOf = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')

    /** 把 /activity 的 days→rounds→items→events 拍平成一维事件（带上视频元信息） */
    const flattenActivityEvents = (actData) => {
      const out = []
      for (const day of (actData?.days || [])) {
        for (const round of (day.rounds || [])) {
          for (const item of (round.items || [])) {
            for (const e of (item.events || [])) {
              out.push({ ...e, bvid: item.bvid || e.bvid || '', title: item.title || '', author: item.author || '' })
            }
          }
        }
      }
      return out
    }

    const recentRounds = (actData) => {
      const rows = []
      for (const day of (actData?.days || [])) {
        for (const r of (day.rounds || [])) rows.push({ day: day.date, ...r })
      }
      return rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    }

    const roundActionCounts = (round) => {
      const n = { view: 0, like: 0, comment: 0, reply: 0, dynamic: 0 }
      for (const it of (round?.items || [])) {
        const s = it.stage || {}
        if (s.viewed) n.view++
        if (s.liked) n.like++
        if (s.commented) n.comment++
        if (s.replies) n.reply += s.replies
        if (s.dynamic) n.dynamic++
      }
      return n
    }

    /** 近 7 天存在感：只统计能本地验证的 inbound（like-in / reply-in）与自己发出的评论 */
    const presenceFrom = (actData, now = Date.now()) => {
      const events = flattenActivityEvents(actData)
      const days = []
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now - i * 86400_000)
        days.push({ date: dayKeyOf(d), likes: 0, replies: 0 })
      }
      const byDay = new Map(days.map((d) => [d.date, d]))
      const within = (e) => {
        const t = Date.parse(e?.t || '')
        return Number.isFinite(t) && now - t < 7 * 86400_000 && t <= now + 60_000
      }
      const recent = events.filter(within)
      for (const e of recent) {
        const k = String(e.t || '').slice(0, 10)
        const row = byDay.get(k)
        if (!row) continue
        if (e.type === 'like-in') row.likes++
        if (e.type === 'reply-in') row.replies++
      }
      const latest = events
        .filter((e) => e.type === 'comment' && e.text)
        .sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')))[0] || null
      return {
        likes7d: recent.filter((e) => e.type === 'like-in').length,
        replies7d: recent.filter((e) => e.type === 'reply-in').length,
        comments7d: recent.filter((e) => e.type === 'comment').length,
        trend: days,
        latest,
      }
    }

    const Metric = ({ label, value, unit, foot, bar, tone }) =>
      h('div', { className: 'bf-metric' },
        h('div', { className: 'bf-metric-label' }, label),
        h('div', { className: 'bf-metric-value' }, String(value ?? '—'), unit ? h('small', null, unit) : null),
        foot ? h('div', { className: 'bf-metric-foot' }, foot) : null,
        bar == null ? null : h('div', { className: 'bf-bar' }, h('i', { className: tone || '', style: { width: bar } })),
      )

    const HEALTH_TONE = { pass: 'ok', warn: 'warn', fail: 'err' }

    function OverviewPage({ ov, act, acct, live, persona, onRun, onStop, onToggle, onLogin, onGo }) {
      const data = ov.data || {}
      const duty = data.duty || {}
      const round = data.round || {}
      const quota = data.quota || {}
      const limits = quota.limits || {}
      const account = acct.data || {}
      const presence = presenceFrom(act.data)
      const rounds = recentRounds(act.data)
      const today = dayKeyOf()
      const roundsToday = rounds.filter((r) => r.day === today).length
      const p = persona.data || {}
      const ph = p.health || {}
      const pact = p.active || {}
      const preset = (p.presets || []).find((x) => x.id === pact.presetId) || null
      const l0checks = ((ph.l0 || {}).checks) || []
      const l0pass = l0checks.filter((c) => c.level === 'pass').length
      const legacy = ph.mode === 'legacy'
      const health = data.health || {}
      const model = data.model || {}
      const healthItems = [
        { id: 'cred', label: 'B站登录凭证', status: health.cred ? 'pass' : 'warn', detail: health.cred ? '凭证文件存在（未联网校验）' : '没有凭证文件，先扫码登录' },
        { id: 'cli', label: 'dsh CLI', status: health.cli ? 'pass' : 'warn', detail: health.cli || '未找到（可在设置里指定 dshBin）' },
        { id: 'route', label: '控制台路由', status: health.routeOk ? 'pass' : 'fail', detail: health.routeOk ? '已挂载 /api/bili-fenshen' : '未挂载' },
        { id: 'ledger', label: '账本', status: data.ledgerFile ? 'pass' : 'warn', detail: data.ledgerFile || '—' },
        { id: 'model', label: '模型', status: (model.provider || model.name) ? 'pass' : 'warn', detail: [model.provider, model.name, model.reasoningEffort].filter(Boolean).join(' / ') || '跟随当前会话默认' },
      ]
      const quotaTiles = [
        ['挑中', quota.picked, limits.perDay, '今天刷过 / 挑中的视频'],
        ['评论', quota.comments, limits.commentsPerDay, '公开文字，最重'],
        ['点赞', quota.likes, limits.likesPerDay, '最低成本的存在感'],
        ['动态', quota.dynamics, limits.dynamicsPerDay, '分享 + 短评'],
        ['跟进回复', quota.replies, limits.repliesPerRound, '每轮上限（收到回复后）'],
      ]

      const dutyCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '值班状态'),
          h('span', { className: 'bf-card-note' }, duty.autoDuty ? '自动值班已开' : '自动值班已关'),
        ),
        h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '状态'), h('span', { className: 'bf-kv-v' }, round.running ? '运行中' : '空闲')),
        h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '自动值班'), h('span', { className: 'bf-kv-v' }, h(Switch, { checked: !!duty.autoDuty, label: '自动值班', onChange: onToggle }))),
        h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '时间窗'), h('span', { className: 'bf-kv-v' }, [duty.windows?.noon ? '中午 12:00 – 14:00' : '', duty.windows?.night ? '晚间 18:00 – 次日 09:00' : ''].filter(Boolean).join(' · ') || '未开启')),
        h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '下一轮'), h('span', { className: 'bf-kv-v' }, duty.autoDuty ? (duty.nextWindowLabel || '—') : '自动已关，不触发')),
        h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '上次值班'), h('span', { className: 'bf-kv-v' }, round.lastRunAt ? hhmm(round.lastRunAt) + ' · ' + fmtDur(round.lastDurationMs) : '—')),
        h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '今日轮次'), h('span', { className: 'bf-kv-v' }, roundsToday + ' 轮')),
        h('div', { className: 'bf-card-foot' },
          h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('reports') }, '上一轮日报'),
          h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('activity') }, '全部活动'),
          h(Btn, { small: true, variant: round.running ? 'danger' : 'primary', onClick: round.running ? onStop : onRun }, round.running ? T.stop : T.run),
        ),
      )

      const accountCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '当前账号'),
          h('span', { className: 'bf-card-note' }, account.loggedIn ? '凭证有效（未联网复核）' : '未登录'),
        ),
        h('div', { className: 'bf-account' },
          h('div', { className: 'bf-avatar' }, account.face ? h('img', { src: account.face, alt: '' }) : (account.uname || 'B').slice(0, 1)),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'bf-account-name' }, account.uname || '未登录', account.vip ? h('span', { className: 'bf-lv' }, '大会员') : null),
            h('div', { className: 'bf-account-meta' }, account.mid ? 'UID ' + account.mid : '—'),
          ),
          h('div', { style: { marginLeft: 'auto', textAlign: 'right' } },
            h('div', { className: 'bf-note' }, '粉丝 / 硬币'),
            h('div', { style: { fontSize: 12.5 } }, fmtNum(account.fans || 0) + ' / ' + fmtNum(account.coins || 0)),
          ),
        ),
        h('div', { className: 'bf-card-foot' },
          h('span', { className: 'bf-note' }, '等级 ' + (account.level == null ? '—' : 'LV' + account.level)),
          h(Btn, { small: true, variant: 'ghost', onClick: onLogin }, account.loggedIn ? '重新登录' : '扫码登录'),
        ),
      )

      const presenceCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '存在感（近 7 天）'),
          h('span', { className: 'bf-card-note' }, '收到点赞 / 被回复 / 发出的评论'),
        ),
        h('div', { className: 'bf-grid-3', style: { gridTemplateColumns: 'repeat(3, minmax(0,1fr))' } },
          h(Metric, { label: '收到点赞', value: fmtNum(presence.likes7d), foot: '正向证据才算可见' }),
          h(Metric, { label: '被回复', value: fmtNum(presence.replies7d), foot: '来自通知流' }),
          h(Metric, { label: '发出的评论', value: fmtNum(presence.comments7d), foot: '最近 7 天' }),
        ),
        (presence.likes7d + presence.replies7d) > 0
          ? h('div', { style: { marginTop: 14 } },
              h('div', { className: 'bf-note', style: { marginBottom: 4 } }, '每日分布'),
              h('div', { className: 'bf-spark' }, presence.trend.map((d) => {
                const max = Math.max(1, ...presence.trend.map((x) => x.likes + x.replies))
                return h('div', { className: 'bf-spark-col', key: d.date, title: d.date + ' · 收赞 ' + d.likes + ' / 被回复 ' + d.replies },
                  h('div', { className: 'bf-spark-bars' },
                    h('div', { className: 'bf-spark-b like', style: { height: Math.max(2, Math.round(d.likes / max * 50)) } }),
                    h('div', { className: 'bf-spark-b', style: { height: Math.max(2, Math.round(d.replies / max * 50)) } }),
                  ),
                  h('div', { className: 'bf-spark-l' }, d.date.slice(5)),
                )
              })),
            )
          : h('div', { className: 'bf-note', style: { marginTop: 12, padding: '8px 10px', background: 'var(--bg-module-platform)', borderRadius: 'var(--r-sm)' } },
              '近 7 天没有收到点赞或回复（正向证据为 0）；已发出的评论会等下一轮发后复核。'),
        presence.latest ? h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '.5px solid var(--border-l1)' } },
          h('div', { className: 'bf-note' }, '最近一条评论' + (presence.latest.title ? ' · ' + presence.latest.title : '')),
          h('div', { className: 'bf-quote' }, presence.latest.text),
          h('div', { className: 'bf-note' }, hhmm(presence.latest.t) + (presence.latest.bvid ? ' · ' + presence.latest.bvid : '')),
        ) : null,
      )

      const recentCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '最近活动'),
          h('span', { className: 'bf-card-note' }, (act.data?.days || []).length + ' 天 · ' + rounds.length + ' 轮'),
          h('span', { style: { marginLeft: 'auto' } }, h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('activity') }, '全部活动')),
        ),
        rounds.length ? h('div', { className: 'bf-mini-list' }, rounds.slice(0, 3).map((r) => {
          const n = roundActionCounts(r)
          const titles = (r.items || []).map((i) => i.title).filter(Boolean).slice(0, 2)
          return h('div', { className: 'bf-mini-row', key: r.id || r.startedAt },
            h('div', { className: 'bf-mini-time' }, h('b', null, hhmm(r.startedAt) || '—'), h('span', null, r.day ? r.day.slice(5) : '')),
            h('div', { className: 'bf-mini-main' },
              h('div', { className: 'bf-mini-title' }, titles.join(' · ') || '（无标题记录）'),
              h('div', { className: 'bf-mini-meta' },
                h(Chip, null, '看 ' + n.view), h(Chip, null, '赞 ' + n.like), h(Chip, { kind: 'cmt' }, '评 ' + n.comment),
                n.reply ? h(Chip, { kind: 'rep' }, '回复 ' + n.reply) : null, n.dynamic ? h(Chip, { kind: 'warn' }, '动态 ' + n.dynamic) : null,
              ),
            ),
          )
        })) : h('div', { className: 'bf-empty-inline' }, '还没有活动记录；跑一轮后这里会出现每一轮的挑中与动作。'),
      )

      const personaCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '当前人设'),
          h('span', { className: 'bf-card-note' }, (pact.presetId || '—') + (preset?.version ? '@' + preset.version : '') + (legacy ? ' · legacy 生效' : '')),
          h('span', { style: { marginLeft: 'auto' } }, h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('persona') }, '人设工作室')),
        ),
        h('div', null,
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, preset?.name || (legacy ? '旧格式人设（markdown）' : '未加载')),
          h('div', { className: 'bf-note', style: { marginTop: 2 } }, preset?.oneLiner || ph.detail || ''),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
            h(Pill, { tone: legacy ? 'warn' : 'ok' }, legacy ? 'legacy 直通' : '卡生效'),
            l0checks.length ? h(Chip, { kind: l0pass === l0checks.length ? 'rep' : 'warn' }, 'L0 ' + l0pass + '/' + l0checks.length) : null,
            h(Chip, null, '来源 ' + (ph.source || pact.mode || '—')),
            h(Chip, null, '语料 ' + ((p.bank || {}).total ?? 0) + ' 条'),
          ),
          legacy ? h('div', { className: 'bf-note', style: { marginTop: 8, color: 'var(--warn)' } }, '配置里填了 personaPrompt：本轮走 legacy 直通，人设卡不生效。') : null,
        ),
      )

      const healthCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '本地检查'),
          h('span', { className: 'bf-card-note' }, '不联网 · 来自配置与本地进程'),
          h('span', { style: { marginLeft: 'auto' } }, h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('settings') }, '完整诊断')),
        ),
        h('div', { className: 'bf-health' }, healthItems.map((it) =>
          h('div', { className: 'bf-health-row', key: it.id },
            h(Pill, { tone: HEALTH_TONE[it.status] || 'off' }, it.status === 'pass' ? '通过' : it.status === 'warn' ? '注意' : '失败'),
            h('span', { style: { fontSize: 12.5, minWidth: 96 } }, it.label),
            h('span', { className: 'bf-note', title: it.detail }, it.detail),
          ),
        )),
      )

      return h('div', null,
        h(Banner, { health: data.health, account, round, onLogin }),
        h('div', { className: 'bf-grid-2' }, dutyCard, accountCard),
        h('div', { className: 'bf-sec bf-grid-5' }, quotaTiles.map(([label, used, limit, foot]) => {
          const ratio = limit > 0 ? Math.round(((used || 0) / limit) * 100) : 0
          return h(Metric, {
            key: label, label, value: used ?? 0, unit: '/ ' + (limit ?? 0), foot,
            bar: Math.min(100, ratio) + '%', tone: ratio >= 100 ? 'over' : ratio >= 80 ? 'warn' : '',
          })
        })),
        h('div', { className: 'bf-sec bf-grid-2' }, presenceCard, recentCard),
        h('div', { className: 'bf-sec bf-grid-2' }, personaCard, healthCard),
        h('div', { className: 'bf-note', style: { marginTop: 18, paddingTop: 12, borderTop: '.5px solid var(--border-l2)' } },
          '数据快照：账本 ' + (data.ledgerFile || '—') + ' · 家目录 ' + (data.home || '—') + ' · 概览每 3s 刷新，人设 30s 刷新。'),
      )
    }

    function SettingsPage({ ov, initial }) {
      const [sub, setSub] = React.useState('config')
      return h('div', null,
        h('div', { className: 'bf-subtabs', role: 'tablist', 'aria-label': '设置子页' },
          [['config', '配置'], ['log', '宿主日志']].map(([k, label]) =>
            h('button', { key: k, role: 'tab', 'aria-selected': String(sub === k), onClick: () => setSub(k) }, label)),
        ),
        sub === 'config' ? h(ConfigPane, { ov, initial }) : h(LogPane, null),
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


    /* ─── v3 活动页：按视频 / 时间线双视图 + 类型筛选 + 搜索 ─── */

    const ACT_FILTERS = [['all', '全部'], ['view', '看过'], ['like', '点赞'], ['comment', '评论'], ['reply-in', '收到回复'], ['like-in', '收到点赞'], ['dynamic', '动态'], ['skip', '跳过']]
    const EVENT_LABEL = { view: '看过', like: '点赞', comment: '评论', 'reply-in': '收到回复', 'reply-out': '跟进回复', 'like-in': '收到点赞', dynamic: '动态', skip: '跳过', note: '备注' }
    const EVENT_CHIP_KIND = { like: 'warn', comment: 'cmt', 'reply-in': 'rep', 'reply-out': 'rep', 'like-in': 'rep', dynamic: 'warn' }

    function ActivityPage({ data, onRun, onLogin }) {
      const [view, setView] = React.useState('video')
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const days = data?.days || []
      if (!days.length) return h(EmptyState, { onRun, onLogin })
      const rows = []
      for (const day of days) {
        for (const round of (day.rounds || [])) {
          for (const item of (round.items || [])) rows.push({ day: day.date, round, item })
        }
      }
      const hasEvent = (item, type) => (item.events || []).some((e) => e.type === type)
      const q = query.trim().toLowerCase()
      const shown = rows.filter(({ item }) => {
        if (filter !== 'all' && !hasEvent(item, filter)) return false
        if (!q) return true
        return [item.title, item.bvid, item.author].some((x) => String(x || '').toLowerCase().includes(q))
      })
      const counts = {}
      for (const [k] of ACT_FILTERS) counts[k] = k === 'all' ? rows.length : rows.filter(({ item }) => hasEvent(item, k)).length

      const toolbar = h('div', { className: 'bf-toolbar' },
        h('div', { className: 'bf-segmented', role: 'tablist', 'aria-label': '活动视图' },
          [['video', '按视频'], ['timeline', '时间线']].map(([k, label]) =>
            h('button', { key: k, role: 'tab', 'aria-selected': String(view === k), onClick: () => setView(k) }, label)),
        ),
        h('span', { style: { width: 1, height: 18, background: 'var(--border-l2)' } }),
        ACT_FILTERS.map(([k, label]) => h('button', {
          key: k, className: 'bf-chipbtn', 'aria-pressed': String(filter === k), onClick: () => setFilter(k),
        }, label + ' ' + counts[k])),
        h('input', {
          className: 'bf-search', style: { marginLeft: 'auto', width: 210 }, placeholder: '搜标题 / BV / UP',
          value: query, onChange: (e) => setQuery(e.target.value),
        }),
      )

      const totalEvents = rows.reduce((n, { item }) => n + (item.events || []).length, 0)
      const statsBar = h('div', { className: 'bf-stat-line' },
        h('span', null, '视频 ', h('b', null, String(rows.length))),
        h('span', null, '事件 ', h('b', null, String(totalEvents))),
        h('span', null, '天数 ', h('b', null, String(days.length))),
        h('span', { style: { marginLeft: 'auto' } }, '筛选后 ', h('b', null, String(shown.length)), ' 个视频'),
      )

      let body = null
      if (!shown.length) {
        body = h('div', { className: 'bf-empty-inline' }, rows.length ? '没有匹配的活动；换个筛选条件或清空搜索。' : '账本里还没有活动记录。')
      } else if (view === 'video') {
        const byDay = new Map()
        for (const x of shown) {
          if (!byDay.has(x.day)) byDay.set(x.day, [])
          byDay.get(x.day).push(x)
        }
        body = [...byDay.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0]))).map(([day, list]) => {
          const byRound = new Map()
          for (const x of list) {
            const key = x.round.id || x.round.startedAt || 'round'
            if (!byRound.has(key)) byRound.set(key, { round: x.round, items: [] })
            byRound.get(key).items.push(x.item)
          }
          return h('div', { key: day },
            h('div', { className: 'bf-daysep' }, day + ' · ' + list.length + ' 条视频'),
            [...byRound.values()].map((g) => {
              const normal = g.items.filter((it) => !it.skipped)
              const skipped = g.items.filter((it) => it.skipped)
              return h('div', { key: g.round.id || g.round.startedAt },
                h('div', { className: 'bf-round-head' },
                  h('span', { className: 'bf-round-time' }, (hhmm(g.round.startedAt) || '—') + ' 这一轮'),
                  h('span', { className: 'bf-round-src' }, g.round.sourceLabel ? '来源：' + g.round.sourceLabel : ''),
                ),
                normal.map((item) => h(ActivityCard, { key: item.bvid, item })),
                skipped.length ? h('details', { className: 'bf-group' },
                  h('summary', null, '跳过 ' + skipped.length + ' 条'),
                  h('ul', { className: 'bf-skip-list' }, skipped.map((s) => h('li', { className: 'bf-skip-item', key: s.bvid },
                    h('span', { className: 'bf-bvid' }, s.bvid),
                    h('span', { className: 'bf-skip-title' }, s.title || s.bvid),
                    h('span', { className: 'bf-skip-reason' }, (s.skipped || {}).reason || ''),
                  ))),
                ) : null,
              )
            }),
          )
        })
      } else {
        const flat = []
        for (const { item } of shown) {
          for (const e of (item.events || [])) flat.push({ e, item })
        }
        flat.sort((a, b) => String(b.e.t || '').localeCompare(String(a.e.t || '')))
        let lastDay = ''
        body = flat.map(({ e, item }, i) => {
          const day = String(e.t || '').slice(0, 10)
          const sep = day !== lastDay ? h('div', { className: 'bf-daysep', key: 'd-' + day + '-' + i }, day) : null
          lastDay = day
          const label = EVENT_LABEL[e.type] || e.type
          const detail = e.type === 'reply-in'
            ? (e.from ? e.from + '：' : '') + (e.text || '')
            : e.type === 'reply-out'
              ? '我：' + (e.text || '')
              : e.type === 'skip' ? '跳过：' + (e.reason || '') : (e.text || '')
          return h(React.Fragment, { key: 'e-' + i },
            sep,
            h('div', { className: 'bf-evt' },
              h('div', { className: 'bf-evt-type' }, h(Chip, { kind: EVENT_CHIP_KIND[e.type] || '' }, label)),
              h('div', { className: 'bf-evt-main' },
                h('div', { className: 'bf-evt-title' }, item.title || item.bvid || detail || '—'),
                h('div', { className: 'bf-evt-meta' }, (item.bvid ? item.bvid : '') + (detail && detail !== item.title ? ' · ' + String(detail).slice(0, 90) : '')),
              ),
              h('div', { className: 'bf-evt-time' }, hhmm(e.t) || ''),
            ),
          )
        })
      }

      return h('div', null, toolbar, statsBar, body)
    }

    /* ─── 实时运行：事件行（LivePage 用） ─── */

    const liveClock = (iso) => {
      try { return new Date(iso).toTimeString().slice(0, 8) } catch { return '' }
    }

    /** 一行实时事件：时间 + kind/tool 标签 + 正文（配色由 CSS 按 kind 决定） */
    function LiveLine({ e }) {
      const kind = e?.kind || 'text'
      const text = String(e?.text || '')
      const kindLabel = e?.tool && !text.startsWith('→') ? e.tool : (LIVE_KIND_CN[kind] || '')
      return h('div', { className: 'bf-live-line ' + kind },
        h('span', { className: 'bf-live-t' }, liveClock(e?.t)),
        h('span', { className: 'bf-live-kind' }, kindLabel),
        h('span', { className: 'bf-live-text' }, text),
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

    function ConfigPane({ ov, initial }) {
      const cfg = usePoll(React.useCallback(() => apiGet('/config'), []), 30000)
      // initial 仅用于渲染冒烟 / SSR 截图；真实运行时 hook 有数据就优先
      const cfgData = cfg.data || initial || null
      const models = useModels()
      const diag = useDiagnose()
      const [draft, setDraft] = React.useState(initial ? { ...initial.values } : null)
      React.useEffect(() => { if (cfgData && !draft) setDraft({ ...cfgData.values }) }, [cfgData, draft])
      const [msg, setMsg] = React.useState('')
      if (!draft) return h('div', { className: 'bf-note' }, '加载中…')

      const setPatch = (patch) => setDraft((prev) => ({ ...(prev || {}), ...patch }))
      const set = (k, v) => setPatch({ [k]: v })
      const save = async () => {
        const patch = {}
        for (const k of Object.keys(draft)) {
          if (JSON.stringify(draft[k]) !== JSON.stringify(cfgData?.values?.[k])) patch[k] = draft[k]
        }
        if (!Object.keys(patch).length) { setMsg('没有改动'); return }
        const r = await apiPost('/config', patch)
        setMsg(r.ok ? '已保存并生效' : `保存失败：${r.error}`)
        cfg.refresh()
        models.refresh?.()
      }
      // 脏字段：用于保存条（显式保存，不即时生效）
      const dirtyKeys = Object.keys(draft).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfgData?.values?.[k]))
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
      return h('div', { className: 'bf-config' },
        h('div', { className: 'bf-settings-desc' }, '修改后点底部「保存并生效」；保存会写入 profile 覆盖层并热生效。'),
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
        h('div', { className: 'bf-savebar' },
          dirtyKeys.length
            ? h(React.Fragment, null, h('span', { className: 'bf-savebar-dot' }), h('span', { className: 'bf-note' }, dirtyKeys.length + ' 处修改未保存'))
            : h('span', { className: 'bf-note' }, msg || '与持久化配置一致'),
          h(Btn, { variant: 'ghost', onClick: () => setDraft({ ...cfgData.defaults }) }, '恢复默认'),
          h(Btn, { variant: 'primary', onClick: save }, '保存并生效'),
        ),
      )
    }



    /* ─── v3 判重表 / 日报（DSH 列表行 + 原生 Markdown 渲染，不用 dangerouslySetInnerHTML） ─── */

    const MD_TICK = String.fromCharCode(96)
    const MD_INLINE = new RegExp('\\*\\*([^*]+)\\*\\*|' + MD_TICK + '([^' + MD_TICK + ']+)' + MD_TICK + '|\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)|(https?:\\/\\/[^\\s<)]+)', 'g')

    function mdInline(text, base) {
      const out = []
      let last = 0
      MD_INLINE.lastIndex = 0
      let m
      while ((m = MD_INLINE.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index))
        if (m[1] != null) out.push(h('strong', { key: base + '-b' + m.index }, m[1]))
        else if (m[2] != null) out.push(h('code', { key: base + '-c' + m.index }, m[2]))
        else if (m[3] != null) out.push(h('a', { key: base + '-a' + m.index, href: m[4], target: '_blank', rel: 'noreferrer' }, m[3]))
        else if (m[5] != null) out.push(h('a', { key: base + '-u' + m.index, href: m[5], target: '_blank', rel: 'noreferrer' }, m[5]))
        last = m.index + m[0].length
      }
      if (last < text.length) out.push(text.slice(last))
      return out
    }

    function Markdown({ text }) {
      const blocks = []
      let para = []
      let list = null
      let code = null
      let ki = 0
      const flushPara = () => {
        if (!para.length) return
        const children = []
        para.forEach((ln, i) => {
          if (i) children.push(h('br', { key: 'br' + i }))
          children.push(...mdInline(ln, 'p' + ki + '-' + i))
        })
        blocks.push(h('p', { key: 'p' + (ki++) }, children))
        para = []
      }
      const flushList = () => { if (list) { blocks.push(h('ul', { key: 'ul' + (ki++) }, list.map((x, i) => h('li', { key: i }, mdInline(x, 'li' + ki + '-' + i))))); list = null } }
      const flushCode = () => { if (code) { blocks.push(h('pre', { key: 'pre' + (ki++) }, h('code', null, code.join('\n')))); code = null } }
      for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.replace(/\s+$/, '')
        const fence = line.trim().slice(0, 3) === MD_TICK + MD_TICK + MD_TICK
        if (fence) { flushPara(); flushList(); if (code) flushCode(); else code = []; continue }
        if (code) { code.push(raw); continue }
        if (!line.trim()) { flushPara(); flushList(); continue }
        const hm = /^(#{1,3})\s+(.*)$/.exec(line)
        if (hm) { flushPara(); flushList(); const lvl = hm[1].length; blocks.push(h('h' + lvl, { key: 'h' + (ki++) }, mdInline(hm[2], 'h' + ki))); continue }
        if (/^-{3,}\s*$/.test(line)) { flushPara(); flushList(); blocks.push(h('hr', { key: 'hr' + (ki++) })); continue }
        const qm = /^>\s?(.*)$/.exec(line)
        if (qm) { flushPara(); flushList(); blocks.push(h('blockquote', { key: 'q' + (ki++) }, mdInline(qm[1], 'q' + ki))); continue }
        const li = /^[-*]\s+(.*)$/.exec(line)
        if (li) { flushPara(); if (!list) list = []; list.push(li[1]); continue }
        flushList(); para.push(line)
      }
      flushPara(); flushList(); flushCode()
      return h('div', { className: 'bf-md' }, blocks)
    }

    const SEEN_ACT = (action) => {
      const s = String(action || '')
      const out = []
      if (/跳过/.test(s)) out.push(h(Chip, { key: 'skip' }, '跳过'))
      else {
        if (/看过/.test(s)) out.push(h(Chip, { key: 'v' }, '看过'))
        if (/赞/.test(s)) out.push(h(Chip, { key: 'l', kind: 'warn' }, '赞'))
        if (/评论/.test(s)) out.push(h(Chip, { key: 'c', kind: 'cmt' }, '评论'))
        if (/动态|分享/.test(s)) out.push(h(Chip, { key: 'd', kind: 'warn' }, '动态'))
        if (/回复/.test(s)) out.push(h(Chip, { key: 'r', kind: 'rep' }, '回复'))
        if (!out.length) out.push(h(Chip, { key: 'x' }, s || '—'))
      }
      return h('span', { title: s }, out)
    }

    function SeenPage({ initial }) {
      const seen = usePoll(React.useCallback(() => apiGet('/seen'), []), 15000)
      const [q, setQ] = React.useState('')
      const all = (seen.data || initial || {}).rows || []
      const notes = all.filter((r) => !r.bvid).length
      const rows = all.filter((r) => r.bvid)
      const query = q.trim().toLowerCase()
      const shown = rows.filter((r) => !query || [r.bvid, r.title, r.action].some((x) => String(x || '').toLowerCase().includes(query)))
      const hasTime = rows.some((r) => r.time)
      const dates = rows.map((r) => r.date).filter(Boolean).sort()
      const toolbar = h('div', { className: 'bf-toolbar' },
        h('span', { className: 'bf-note' }, '视频 ' + rows.length + ' 条' + (notes ? ' · 已折叠 ' + notes + ' 条值班备注' : '') + (dates.length ? ' · ' + dates[0] + ' → ' + dates[dates.length - 1] : '')),
        h('input', { className: 'bf-search', style: { marginLeft: 'auto', width: 220 }, placeholder: '搜 BV / 标题 / 动作', value: q, onChange: (e) => setQ(e.target.value) }),
      )
      const table = shown.length
        ? h('div', { className: 'bf-tbl-wrap' }, h('table', { className: 'bf-grid' },
            h('thead', null, h('tr', null,
              h('th', { style: { width: 96 } }, '日期'),
              hasTime ? h('th', { style: { width: 64 } }, '时间') : null,
              h('th', { style: { width: 126 } }, 'BV 号'),
              h('th', { style: { width: 140 } }, '动作'),
              h('th', null, '标题'),
            )),
            h('tbody', null, shown.map((r, i) => h('tr', { key: r.bvid + '-' + i },
              h('td', { className: 'mono', style: { fontSize: 11 } }, r.date || ''),
              hasTime ? h('td', { className: 'mono', style: { fontSize: 11, color: 'var(--label-caption)' } }, r.time || '—') : null,
              h('td', { className: 'bv' }, r.bvid || '—'),
              h('td', null, SEEN_ACT(r.action)),
              h('td', null, r.title || '—'),
            ))),
          ))
        : h('div', { className: 'bf-empty-inline' }, rows.length ? '没有匹配的记录；换个关键词。' : '判重表还是空的：每轮值班会把看过的 BV 追加进 seen.md，跨轮判重靠它。')
      return h('div', null, toolbar, h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '看过什么'),
          h('span', { className: 'bf-card-note' }, shown.length + ' / ' + rows.length + ' 行'),
          h('span', { style: { marginLeft: 'auto' } }, h(Btn, { small: true, variant: 'ghost', onClick: () => seen.refresh() }, T.refresh)),
        ),
        table,
      ))
    }

    function ReportsPage({ initial }) {
      const listHook = usePoll(React.useCallback(() => apiGet('/reports'), []), 60000)
      const list = listHook.data || (initial || {}).list || {}
      const days = list.days || []
      const digests = list.digests || []
      const hasOverlay = !!list.overlay
      const first = days[0] || (hasOverlay ? 'overlay' : null)
      const [day, setDay] = React.useState((initial || {}).day || null)
      const current = day || first
      const docHook = usePoll(React.useCallback(() => apiGet('/report?day=' + encodeURIComponent(current || 'overlay')), [current]), 60000)
      const text = docHook.data?.text != null ? docHook.data.text : ((initial || {}).text || '')
      const item = (key, label, meta, iconText) => h('button', {
        key, className: 'bf-list-btn', 'aria-current': String(current === key), onClick: () => setDay(key),
      }, h('span', { style: { fontFamily: 'var(--font-code)', fontSize: 12, flex: '0 0 auto' } }, iconText || '·'), h('span', { className: 'l' }, label), meta ? h('span', { className: 'm' }, meta) : null)
      const left = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '报告'),
          h('span', { className: 'bf-card-note' }, (days.length + digests.length + (hasOverlay ? 1 : 0)) + ' 个文件'),
        ),
        h('div', { className: 'bf-list' },
          days.map((d) => item(d, d + '.md', '日报')),
          digests.length ? h('div', { className: 'bf-list-sep' }, '月度归档') : null,
          digests.map((d) => item(d, 'digest/' + d + '.md', '归档')),
          hasOverlay ? item('overlay', 'headless-overlay.yml', '诊断') : null,
          !days.length && !digests.length && !hasOverlay ? h('div', { className: 'bf-empty-inline' }, '还没有日报') : null,
        ),
      )
      const title = current === 'overlay' ? 'headless-overlay.yml' : '日报 ' + (current || '—')
      const right = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, title),
          h('span', { className: 'bf-card-note' }, text ? 'UTF-8 · ' + text.length + ' 字符' : ''),
          h('span', { style: { marginLeft: 'auto' } }, h(Btn, { small: true, variant: 'ghost', onClick: () => docHook.refresh() }, T.refresh)),
        ),
        text ? h(Markdown, { text }) : h('div', { className: 'bf-empty-inline' }, '这份报告没有正文（或快照未包含内容）。'),
      )
      return h('div', { className: 'bf-split2' }, left, right)
    }

    /* ─── v3 实时页：空闲态 / 运行态（阶段轨 + 统计 + 可筛选事件流） ─── */

    const LIVE_PHASES = [['think', '思考'], ['find', '找内容'], ['watch', '看内容'], ['act', '发言']]
    const LIVE_KINDS = [['all', '全部'], ['host', '宿主'], ['tool', '工具'], ['reasoning', '推理'], ['text', '输出'], ['state', '状态'], ['error', '错误']]

    function LivePage({ live, ov, onRun, onStop }) {
      const d = live?.data || LIVE_EMPTY
      const mode = live?.mode || 'poll'
      const err = live?.error || ''
      const elapsed = useElapsed(d.running, d.startedAt, d.elapsedMs)
      const [filter, setFilter] = React.useState('all')
      const [autoScroll, setAutoScroll] = React.useState(true)
      const bodyRef = React.useRef(null)
      const events = d.events || []
      const shown = filter === 'all' ? events : events.filter((e) => (e.kind || 'text') === filter)
      const stats = d.stats || {}
      const q = d.quota || null
      const acts = stats.actions || {}
      const toolTotal = Object.values(stats.tools || {}).reduce((n, v) => n + (Number(v) || 0), 0)
      const phaseKey = d.phase?.key || 'think'
      const phaseIdx = Math.max(0, LIVE_PHASES.findIndex(([k]) => k === phaseKey))

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

      if (!d.running) {
        return h('div', null,
          h(Card, null,
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, '当前空闲'),
              h('span', { className: 'bf-card-note' }, d.lastRunAt ? '上次值班 ' + hhmm(d.lastRunAt) : '还没有跑过'),
              h('span', { style: { marginLeft: 'auto' } }, h(Btn, { small: true, variant: 'primary', onClick: onRun }, '跑一轮')),
            ),
            h('div', { className: 'bf-grid-3', style: { gridTemplateColumns: 'repeat(3, minmax(0,1fr))' } },
              h(Metric, { label: '上一轮退出码', value: d.lastCode == null ? '—' : String(d.lastCode), foot: d.lastCode ? '失败，去宿主日志看尾部' : '正常退出' }),
              h(Metric, { label: '上一轮耗时', value: fmtDur(d.lastDurationMs), foot: '子进程总时长' }),
              h(Metric, { label: '当前模式', value: mode === 'sse' ? 'SSE' : '轮询', foot: mode === 'sse' ? '事件实时推送' : 'EventSource 不可用，降级 1s 轮询' }),
            ),
            h('div', { className: 'bf-note', style: { marginTop: 12 } },
              '空闲时这一页不轮询；跑一轮后，工具调用 / 推理 / 宿主日志会实时出现在这里。'),
            err ? h('div', { className: 'bf-note', style: { color: 'var(--error)', marginTop: 6 } }, '实时流错误：' + err) : null,
          ),
          h('div', { style: { marginTop: 14 } }, h(EmptyState, { onRun })),
        )
      }

      const statusCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '本轮运行'),
          h('span', { className: 'bf-card-note' }, d.why ? '来源 ' + d.why : '手动 / 定时'),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
            h(Pill, { tone: 'ok' }, '运行中'),
            mode === 'poll' ? h(Chip, { kind: 'warn' }, '降级轮询') : null,
            h(Btn, { small: true, variant: 'danger', onClick: onStop }, T.stop),
          ),
        ),
        h('div', { className: 'bf-kv-row' },
          h('span', { className: 'bf-kv-k' }, '已运行'),
          h('span', { className: 'bf-kv-v', style: { fontFamily: 'var(--font-code)', fontSize: 16, fontWeight: 500 } }, fmtDur(elapsed)),
        ),
        h('div', { className: 'bf-kv-row' },
          h('span', { className: 'bf-kv-k' }, '当前阶段'),
          h('span', { className: 'bf-kv-v' }, d.phase?.label || '思考'),
        ),
        h('div', { className: 'bf-kv-row' },
          h('span', { className: 'bf-kv-k' }, '工具调用'),
          h('span', { className: 'bf-kv-v' }, String(toolTotal) + ' 次'),
        ),
        h('div', { className: 'bf-kv-row' },
          h('span', { className: 'bf-kv-k' }, '动作'),
          h('span', { className: 'bf-kv-v' }, '赞 ' + (acts.like || 0) + ' · 评 ' + (acts.comment || 0) + ' · 动态 ' + (acts.dynamic || 0) + ' · 回复 ' + (acts.reply || 0)),
        ),
        q ? h('div', { className: 'bf-kv-row' },
          h('span', { className: 'bf-kv-k' }, '本轮配额'),
          h('span', { className: 'bf-kv-v' }, '挑 ' + (q.picked ?? 0) + '/' + (q.limits?.perDay ?? 0) + ' · 评 ' + (q.comments ?? 0) + '/' + (q.limits?.commentsPerDay ?? 0) + ' · 赞 ' + (q.likes ?? 0) + '/' + (q.limits?.likesPerDay ?? 0)),
        ) : null,
        h('div', { className: 'bf-stages', style: { gridTemplateColumns: 'repeat(' + LIVE_PHASES.length + ',1fr)', marginTop: 12, marginBottom: 0 } },
          LIVE_PHASES.map(([k, label], i) => h('div', { key: k, className: 'bf-stage' + (i <= phaseIdx ? ' done' : '') },
            h('b'), h('span', null, label), h('em', null, i < phaseIdx ? '完成' : i === phaseIdx ? '进行中' : '等待'),
          )),
        ),
      )

      const kinds = LIVE_KINDS.map(([k]) => k)
      const streamCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '事件流'),
          h('span', { className: 'bf-card-note' }, events.length + ' 条 · 显示 ' + shown.length),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
            h('span', { className: 'bf-note' }, '自动滚动'),
            h(Switch, { checked: autoScroll, label: '自动滚动', onChange: toggleAuto }),
          ),
        ),
        h('div', { className: 'bf-toolbar', style: { marginBottom: 10, padding: 0, border: 0, background: 'transparent' } },
          LIVE_KINDS.map(([k, label]) => h('button', {
            key: k, className: 'bf-chipbtn', 'aria-pressed': String(filter === k), onClick: () => setFilter(k),
          }, label + (k === 'all' ? ' ' + events.length : ' ' + events.filter((e) => (e.kind || 'text') === k).length))),
        ),
        h('div', { className: 'bf-live-body', ref: bodyRef, onScroll },
          shown.length
            ? shown.map((e, i) => h(LiveLine, { key: e?.seq != null ? e.seq : i, e }))
            : h('div', { className: 'bf-live-empty' }, '等待第一条事件…（工具调用 / 推理 / 宿主日志都会出现在这里）'),
        ),
        h('div', { className: 'bf-live-foot' },
          h('span', null, '事件 ' + events.length + ' · 筛选后 ' + shown.length),
          stats.errors ? h('span', { style: { color: 'var(--warn)' } }, '错误 ' + stats.errors) : null,
          h('span', null, '真实实现：SSE 优先，断线降级轮询'),
          err ? h('span', { className: 'bf-live-err' }, err) : null,
        ),
      )

      return h('div', null, statusCard, h('div', { className: 'bf-sec' }, streamCard))
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

    /* ───────── 人设工作室（只读页签：卡 / 五块预算 / L0 / 今日状态 / 编译预览 + 预设切换） ─────────
     * 数据全部来自宿主既有端点：GET /persona（健康度/预设/语料库统计）+ GET /persona/preview（编译产物/L0/状态）。
     * 编辑、版本快照、A/B、试写沙盒属后续里程碑（设计 §9 / P4），这里刻意不放写入口——避免把"能改"错当成"已验证"。
     */
    const PF_BLOCK_LABEL = { core: 'P1 常驻核心', lore: 'P2 见闻索引', state: 'P3 今日状态', samples: 'P4 语料样本', tail: 'P5 最后一公里' }
    const PF_DEBT_LABEL = { question: '疑问', reaction: '纯反应', emoji: '带表情', experience: '个人经历' }
    const PF_MODE = {
      card: { tone: 'ok', text: '卡（生效）' },
      legacy: { tone: 'warn', text: 'legacy 直通' },
      missing: { tone: 'err', text: '人设缺失' },
    }

    /** initial 仅用于渲染冒烟测试注入数据（SSR 不执行 effect，usePoll 恒为 null） */

    /* ─── v3 人设工作室：8 页签（真实数据 + 预设切换 + 卡 JSON 保存/版本回滚） ─── */

    const PERSONA_TABS = [['card', '卡片'], ['preview', '编译预览'], ['quality', '质量 / L0'], ['bank', '语料库'], ['lore', '见闻库'], ['state', '今日状态'], ['version', '版本对比'], ['sandbox', '试写沙盒']]

    function PersonaPage({ persona, initial, initialTab }) {
      const prevHook = usePoll(React.useCallback(() => apiGet('/persona/preview'), []), 60000)
      const exprHook = usePoll(React.useCallback(() => apiGet('/persona/expression'), []), 60000)
      const loreHook = usePoll(React.useCallback(() => apiGet('/persona/lore'), []), 60000)
      const versHook = usePoll(React.useCallback(() => apiGet('/persona/versions'), []), 30000)
      const [tab, setTab] = React.useState(initialTab || 'card')
      const [bucket, setBucket] = React.useState('')
      const [loreId, setLoreId] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [jsonDraft, setJsonDraft] = React.useState(null)
      const [jsonErr, setJsonErr] = React.useState('')
      // 语料库 / 见闻库编辑态：''=非编辑；'new'=新增；否则=正在编辑的条目 id
      const [bankEditId, setBankEditId] = React.useState('')
      const [bankDraft, setBankDraft] = React.useState(null)
      // 见闻：loreDraft=编辑现有条目（keys/oneLine/body）；loreNew=新增表单
      const [loreDraft, setLoreDraft] = React.useState(null)
      const [loreNew, setLoreNew] = React.useState(null)

      const d = (persona && persona.data) || (initial && initial.persona) || {}
      const health = d.health || {}
      const act = d.active || {}
      const presets = d.presets || []
      const card = d.card || (initial && initial.card) || null
      const pvRaw = prevHook.data || (initial && initial.preview) || null
      const pv = pvRaw && pvRaw.ok === true ? pvRaw : null
      const pvText = pv && typeof pv.text === 'string' ? pv.text : ''
      const stats = pv?.stats || null
      const per = Array.isArray(stats?.per) ? stats.per : []
      const l0 = pv?.l0 || health.l0 || null
      const st = pv?.state || null
      const exprData = exprHook.data || (initial && initial.expression) || null
      const loreData = loreHook.data || (initial && initial.lore) || null
      const versData = versHook.data || (initial && initial.versions) || null
      const mode = health.mode || 'missing'
      const M = { card: { tone: 'ok', text: '卡（生效）' }, legacy: { tone: 'warn', text: 'legacy 直通' }, missing: { tone: 'err', text: '人设缺失' } }
      const modeInfo = M[mode] || M.missing
      const activeId = act.presetId || (health.detail || '').split('@')[0] || ''
      const cur = presets.find((p) => p.id === activeId) || null
      const legacy = mode === 'legacy'
      const err = (persona && persona.error) || prevHook.error || ''
      const l0checks = Array.isArray(l0?.checks) ? l0.checks : []
      const l0pass = l0checks.filter((c) => c.level === 'pass').length
      const buckets = (exprData && exprData.buckets) || {}
      const bucketKeys = Object.keys(buckets)
      const curBucket = bucketKeys.includes(bucket) ? bucket : (bucketKeys.includes('question') ? 'question' : (bucketKeys[0] || ''))
      const loreEntries = (loreData && loreData.entries) || []
      const curLore = loreEntries.find((x) => x.id === loreId) || loreEntries[0] || null
      const versions = (versData && versData.versions) || []

      const refreshAll = () => {
        if (persona && persona.refresh) persona.refresh()
        prevHook.refresh(); exprHook.refresh(); loreHook.refresh(); versHook.refresh()
      }
      const switchPreset = async (id) => {
        setBusy(id); setMsg('')
        try {
          const r = await apiPost('/persona/preset?id=' + encodeURIComponent(id))
          setMsg(r.ok ? '已切换到预设 ' + id : '切换失败：' + (r.error || '未知'))
          if (r.ok) refreshAll()
        } catch (e) { setMsg('切换失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const saveCard = async () => {
        setJsonErr(''); setMsg('')
        let parsed = null
        try { parsed = JSON.parse(jsonDraft == null ? JSON.stringify(card) : jsonDraft) } catch (e) {
          setJsonErr('JSON 解析失败：' + String(e?.message ?? e)); return
        }
        setBusy('save')
        try {
          const r = await apiPut('/persona', { card: parsed })
          if (!r.ok) {
            setJsonErr((r.errors || []).map((x) => (x.path ? x.path + '：' : '') + x.msg).join('；') || r.error || '保存失败')
          } else {
            setMsg('已保存并生效' + (r.warnings && r.warnings.length ? '（' + r.warnings.length + ' 条提醒）' : ''))
            refreshAll()
          }
        } catch (e) { setJsonErr('保存失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const restore = async (name) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('回滚到 ' + name + '？当前卡会先存一份新快照。')) return
        setBusy(name); setMsg('')
        try {
          const r = await apiPost('/persona/versions/restore', { name })
          setMsg(r.ok ? '已回滚到 ' + name : '回滚失败：' + (r.error || '未知'))
          if (r.ok) refreshAll()
        } catch (e) { setMsg('回滚失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      /* ── 语料库编辑（写路径：POST /persona/expression；首次编辑自动物化用户副本） ── */
      const bankStartAdd = () => { setBankEditId('new'); setBankDraft({ text: '', source: '', heat: 0, status: 'active' }) }
      const bankStartEdit = (e0) => { setBankEditId(e0.id); setBankDraft({ text: e0.text, source: e0.source || '', heat: e0.heat || 0 }) }
      const bankSave = async () => {
        setBusy('bankSave'); setMsg('')
        try {
          const p = bankEditId === 'new'
            ? { action: 'add', form: curBucket, text: bankDraft.text, source: bankDraft.source, heat: Number(bankDraft.heat) || 0, status: bankDraft.status || 'active' }
            : { action: 'edit', form: curBucket, id: bankEditId, text: bankDraft.text, source: bankDraft.source, heat: Number(bankDraft.heat) || 0 }
          const r = await apiPost('/persona/expression', p)
          if (!r.ok) setMsg('语料保存失败：' + (r.error || '未知'))
          else { setMsg('语料库已更新'); setBankEditId(''); setBankDraft(null); refreshAll() }
        } catch (e) { setMsg('语料保存失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const bankToggle = async (e0) => {
        setBusy('bt-' + e0.id); setMsg('')
        try {
          const r = await apiPost('/persona/expression', { action: 'status', form: curBucket, id: e0.id, status: e0.status === 'active' ? 'candidate' : 'active' })
          if (!r.ok) setMsg('切换失败：' + (r.error || '未知'))
          else refreshAll()
        } catch (e) { setMsg('切换失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const bankRemove = async (e0) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('删除这条语料？')) return
        setBusy('br-' + e0.id); setMsg('')
        try {
          const r = await apiPost('/persona/expression', { action: 'remove', form: curBucket, id: e0.id })
          if (!r.ok) setMsg('删除失败：' + (r.error || '未知'))
          else { setMsg('已删除'); refreshAll() }
        } catch (e) { setMsg('删除失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      /* ── 见闻库编辑（索引：POST /persona/lore 走整卡快照；正文：PUT /persona/lore） ── */
      const loreStartEdit = () => {
        if (!curLore) return
        setLoreNew(null)
        setLoreDraft({ keys: (curLore.keys || []).join(', '), oneLine: curLore.oneLine || '', body: curLore.body || '' })
      }
      const loreStartAdd = () => { setLoreDraft(null); setLoreNew({ id: '', keys: '', oneLine: '', body: '' }) }
      const loreSave = async () => {
        setBusy('loreSave'); setMsg('')
        try {
          if (loreNew) {
            const r = await apiPost('/persona/lore', { action: 'add', id: loreNew.id, keys: loreNew.keys, oneLine: loreNew.oneLine })
            if (!r.ok) { setMsg('新增失败：' + (r.error || '未知')); return }
            if (String(loreNew.body || '').trim()) {
              const r2 = await apiPut('/persona/lore', { id: String(loreNew.id).trim(), body: loreNew.body })
              if (!r2.ok) { setMsg('索引已建，但正文保存失败：' + (r2.error || '未知')); refreshAll(); return }
            }
            setMsg('见闻已新增'); setLoreNew(null); refreshAll(); return
          }
          if (!curLore || !loreDraft) return
          const r = await apiPost('/persona/lore', { action: 'edit', id: curLore.id, keys: loreDraft.keys, oneLine: loreDraft.oneLine })
          if (!r.ok) { setMsg('索引保存失败：' + (r.error || '未知')); return }
          const r2 = await apiPut('/persona/lore', { id: curLore.id, body: loreDraft.body })
          if (!r2.ok) { setMsg('索引已存，但正文保存失败：' + (r2.error || '未知')); refreshAll(); return }
          setMsg('见闻已保存'); setLoreDraft(null); refreshAll()
        } catch (e) { setMsg('保存失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const loreRemove = async (id) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('删除见闻「' + id + '」？（索引删掉；已落盘的正文文件保留）')) return
        setBusy('lr-' + id); setMsg('')
        try {
          const r = await apiPost('/persona/lore', { action: 'remove', id })
          if (!r.ok) setMsg('删除失败：' + (r.error || '未知'))
          else { setMsg('已删除'); setLoreId(''); setLoreDraft(null); refreshAll() }
        } catch (e) { setMsg('删除失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      const header = h('div', null,
        h('div', { className: 'bf-pf-head' },
          h(Pill, { tone: modeInfo.tone }, modeInfo.text),
          h('span', { className: 'bf-note' }, health.detail || '还没有人设信息'),
          h('span', { className: 'bf-note bf-mono', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 } }, (d.cardSource && d.cardSource.path) || health.path || ''),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
            msg ? h('span', { className: 'bf-note' }, msg) : null,
            h(Btn, { small: true, variant: 'ghost', onClick: refreshAll }, T.refresh),
          ),
        ),
        h('div', { className: 'bf-pf-head' },
          h(Chip, { kind: l0checks.length && l0pass === l0checks.length ? 'rep' : 'warn' }, 'L0 ' + l0pass + '/' + (l0checks.length || 6)),
          h(Chip, null, '人设 ' + ((stats && stats.total) || 0) + '/' + ((stats && stats.totalMax) || 3000) + ' 字符'),
          h(Chip, null, '整轮 prompt ' + ((pv && pv.text && pv.text.length) || 0) + ' 字符'),
          h(Chip, null, '语料 ' + ((d.bank && d.bank.total) || 0) + ' 条'),
          h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' } },
            presets.map((p) => h(Btn, {
              key: p.id, small: true,
              variant: p.id === activeId ? 'primary' : 'ghost',
              disabled: !!busy || (!legacy && p.id === activeId),
              onClick: () => switchPreset(p.id),
            }, p.id === activeId ? (p.name || p.id) + '（生效）' : (p.name || p.id))),
          ),
        ),
      )

      const tabs = h('div', { className: 'bf-subtabs', role: 'tablist', 'aria-label': '人设工作室页签' },
        PERSONA_TABS.map(([k, label]) => h('button', { key: k, role: 'tab', 'aria-selected': String(tab === k), onClick: () => setTab(k) }, label)),
      )

      const budgetCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '五块预算'),
          h('span', { className: 'bf-card-note' }, stats ? '合计 ' + stats.total + ' / ' + stats.totalMax : '等待编译数据'),
        ),
        per.length
          ? per.map((x) => h('div', { className: 'bf-pf-budget', key: x.name },
              h('span', { className: 'bf-note' }, PF_BLOCK_LABEL[x.name] || x.name),
              h('div', { className: 'bf-bar' }, h('i', { className: x.len > x.max ? 'over' : x.len > x.max * 0.9 ? 'warn' : '', style: { width: Math.min(100, Math.round((x.len / (x.max || 1)) * 100)) + '%' } })),
              h('span', { className: 'bf-pf-num' }, x.len + '/' + x.max),
            ))
          : h('div', { className: 'bf-note' }, '暂无编译数据'),
      )

      const cardTab = h('div', { className: 'bf-grid-2' },
        h('div', null,
          h(Card, null,
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, legacy ? '人设卡（当前未生效）' : '人设卡'),
              h('span', { className: 'bf-card-note' }, card ? (card.id + '@' + card.version + ' · ' + (card.license || '')) : '未加载'),
            ),
            card
              ? h('div', null,
                  h('div', { style: { fontSize: 13, lineHeight: '20px' } }, card.identity && card.identity.oneLiner || ''),
                  h('div', { className: 'bf-pf-sub' }, (card.identity && card.identity.background) || ''),
                  [['identity', '身份'], ['voice', '口吻'], ['mindset', '心态'], ['taste', '品味'], ['stance', '立场'], ['redlines', '红线'], ['canon', '被问到'], ['loreIndex', '见闻索引'], ['samples', '示例']]
                    .map(([k, label]) => {
                      const val = card[k]
                      const txt = JSON.stringify(val, null, 2) || ''
                      return h('details', { className: 'bf-group', key: k, style: { marginTop: 8 } },
                        h('summary', null, label + ' · ' + (JSON.stringify(val) || '').length + ' 字符'),
                        h('pre', { className: 'bf-doc', style: { marginTop: 8 } }, txt),
                      )
                    }),
                )
              : h('div', { className: 'bf-note' }, '人设卡未加载；检查 active.json / preset。'),
          ),
        ),
        h('div', null,
          budgetCard,
          h(Card, null,
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, '高级编辑（JSON）'),
              h('span', { className: 'bf-card-note' }, '保存后写入用户卡并留版本快照'),
            ),
            h('textarea', {
              className: 'bf-json',
              'aria-label': '人设卡 JSON',
              value: jsonDraft == null ? JSON.stringify(card || {}, null, 2) : jsonDraft,
              onChange: (e) => setJsonDraft(e.target.value),
            }),
            jsonErr ? h('div', { className: 'bf-note', style: { color: 'var(--error)', marginTop: 8 } }, jsonErr) : null,
            h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
              h(Btn, { variant: 'primary', disabled: !card, onClick: saveCard }, '保存并生效'),
              h(Btn, { variant: 'ghost', onClick: () => { setJsonDraft(null); setJsonErr('') }, disabled: jsonDraft == null }, '重置为当前卡'),
            ),
            h('div', { className: 'bf-pf-sub' }, '保存会校验 schema + L0 前六条（红线三件套/禁止句/手段表/词频/矛盾/示例），失败返回字段级错误。'),
          ),
        ),
      )

      const previewTab = h('div', { className: 'bf-grid-2' },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '编译产物（真实输出）'),
            h('span', { className: 'bf-card-note' }, pvText ? pvText.length + ' 字符 · ' + (pv.tag || '') : '暂无'),
          ),
          pvText ? h('div', null,
            h('div', { className: 'bf-note', style: { marginBottom: 8 } }, '前段在章程之前、后段在整轮 prompt 末尾；这个文本就是本轮真正会注入的内容。'),
            h('pre', { className: 'bf-doc', style: { maxHeight: 520 } }, pvText),
            (pv.notes || []).map((n, i) => h('div', { className: 'bf-note', key: i, style: { marginTop: 4 } }, '· ' + n)),
          ) : h('div', { className: 'bf-note' }, '暂无编译结果'),
        ),
        h('div', null, budgetCard),
      )

      const qualityTab = h('div', null,
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, 'L0 六条'),
            h('span', { className: 'bf-card-note' }, l0 ? (l0.ok ? '全部通过' : '有未通过项') : '暂无'),
          ),
          l0checks.length
            ? h('table', { className: 'bf-grid' },
                h('thead', null, h('tr', null, ['判据', '结果', '明细'].map((t) => h('th', { key: t }, t)))),
                h('tbody', null, l0checks.map((c) => h('tr', { key: c.id },
                  h('td', null, c.name),
                  h('td', null, h(Chip, { kind: c.level === 'pass' ? 'rep' : c.level === 'warn' ? 'warn' : '' }, c.level === 'pass' ? '通过' : c.level === 'warn' ? '警示' : '未过')),
                  h('td', null, c.detail || ''),
                ))),
              )
            : h('div', { className: 'bf-note' }, '暂无 L0 结果'),
        ),
        h('div', { className: 'bf-sec' }, h(Card, null,
          h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '编译提醒')),
          (pv && pv.notes && pv.notes.length) ? pv.notes.map((n, i) => h('div', { className: 'bf-note', key: i }, '· ' + n)) : h('div', { className: 'bf-note' }, '无'),
        )),
      )

      const bankEntries = (buckets[curBucket] || [])
      const bankTab = h('div', null,
        h('div', { className: 'bf-buckets' },
          bucketKeys.map((k) => h('button', {
            key: k, className: 'bf-bucket', 'aria-pressed': String(k === curBucket), onClick: () => setBucket(k),
          }, h('b', null, k, h('span', { style: { marginLeft: 'auto' } }, (buckets[k] || []).filter((e) => e.status === 'active').length + '/' + (buckets[k] || []).length)),
             h('div', { className: 'm' }, (buckets[k] || []).length >= 20 ? '够用（≥20）' : '不足 20 条 · 待扩'))),
        ),
        h('div', { className: 'bf-sec' }, h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '桶：' + curBucket),
            h('span', { className: 'bf-card-note' }, bankEntries.length + ' 条 · 逐字真实、带 source'),
            h('span', { style: { marginLeft: 'auto' } },
              h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: bankStartAdd }, '＋ 新增')),
          ),
          bankEditId === 'new' && bankDraft ? h('div', { style: { padding: '9px 0', borderBottom: '.5px solid var(--border-l2)' } },
            h('textarea', { className: 'bf-textarea', style: { minHeight: 60 }, value: bankDraft.text, placeholder: '逐字语料（它是素材库：录入真人说的话，注入时只学手感）', onChange: (e) => setBankDraft({ ...bankDraft, text: e.target.value }) }),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
              h('input', { className: 'bf-search', style: { flex: 1 }, value: bankDraft.source, placeholder: '来源（可选）', onChange: (e) => setBankDraft({ ...bankDraft, source: e.target.value }) }),
              h('input', { className: 'bf-search', style: { width: 76 }, value: String(bankDraft.heat ?? 0), title: 'heat 越大被抽中概率越低', onChange: (e) => setBankDraft({ ...bankDraft, heat: Number(e.target.value) || 0 }) }),
              h(Btn, { small: true, disabled: !!busy || !String(bankDraft.text || '').trim(), onClick: bankSave }, '保存'),
              h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => { setBankEditId(''); setBankDraft(null) } }, '取消'),
            ),
          ) : null,
          bankEntries.length
            ? bankEntries.map((e, i) => h('div', { key: e.id || i, style: { padding: '9px 0', borderBottom: '.5px solid var(--border-l2)' } },
                bankEditId === e.id && bankDraft ? h('div', null,
                  h('textarea', { className: 'bf-textarea', style: { minHeight: 60 }, value: bankDraft.text, onChange: (ev) => setBankDraft({ ...bankDraft, text: ev.target.value }) }),
                  h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                    h('input', { className: 'bf-search', style: { flex: 1 }, value: bankDraft.source, placeholder: '来源', onChange: (ev) => setBankDraft({ ...bankDraft, source: ev.target.value }) }),
                    h('input', { className: 'bf-search', style: { width: 76 }, value: String(bankDraft.heat ?? 0), onChange: (ev) => setBankDraft({ ...bankDraft, heat: Number(ev.target.value) || 0 }) }),
                    h(Btn, { small: true, disabled: !!busy, onClick: bankSave }, '保存'),
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => { setBankEditId(''); setBankDraft(null) } }, '取消'),
                  ),
                ) : h('div', null,
                  h('div', { style: { fontSize: 13, lineHeight: '20px' } }, e.text),
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 } },
                    h('span', { className: 'bf-note' }, (e.source || '') + ' · len ' + (e.len || 0) + ' · ' + (e.status || '') + ' · heat ' + (e.heat || 0)),
                    h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 4 } },
                      h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankToggle(e) }, e.status === 'active' ? '停用' : '启用'),
                      h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankStartEdit(e) }, '改'),
                      h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankRemove(e) }, '删'),
                    ),
                  ),
                ),
              ))
            : h('div', { className: 'bf-note' }, '这个桶还是空的。'),
        )),
      )

      const loreTab = h('div', { className: 'bf-grid-2' },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '索引（常驻 prompt）'),
            h('span', { className: 'bf-card-note' }, loreEntries.length + ' 条'),
            h('span', { style: { marginLeft: 'auto' } },
              h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: loreStartAdd }, '＋ 新增')),
          ),
          loreNew ? h('div', { style: { padding: '9px 0', borderBottom: '.5px solid var(--border-l2)' } },
            h('input', { className: 'bf-search', style: { width: '100%' }, value: loreNew.id, placeholder: 'id（字母数字-连字符，如 night-market）', onChange: (e) => setLoreNew({ ...loreNew, id: e.target.value }) }),
            h('input', { className: 'bf-search', style: { width: '100%', marginTop: 6 }, value: loreNew.keys, placeholder: '触发词，逗号分隔（命中才读正文）', onChange: (e) => setLoreNew({ ...loreNew, keys: e.target.value }) }),
            h('input', { className: 'bf-search', style: { width: '100%', marginTop: 6 }, value: loreNew.oneLine, placeholder: '一行摘要（会注入 prompt，≤40 字）', onChange: (e) => setLoreNew({ ...loreNew, oneLine: e.target.value }) }),
            h('textarea', { className: 'bf-textarea', style: { minHeight: 80, marginTop: 6 }, value: loreNew.body, placeholder: '正文（可选；不注入，agent 命中后自己来读）', onChange: (e) => setLoreNew({ ...loreNew, body: e.target.value }) }),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
              h(Btn, { small: true, disabled: !!busy || !String(loreNew.id || '').trim(), onClick: loreSave }, '创建'),
              h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => setLoreNew(null) }, '取消'),
            ),
          ) : null,
          loreEntries.length
            ? loreEntries.map((e) => h('div', { key: e.id, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 0', borderBottom: '.5px solid var(--border-l2)' } },
                h('button', {
                  className: 'bf-list-btn', style: { flex: 1, minWidth: 0 }, 'aria-current': String((curLore || {}).id === e.id), onClick: () => { setLoreId(e.id); setLoreDraft(null) },
                }, h('span', { className: 'l' }, e.id), h('span', { className: 'm' }, e.usedToday ? '今天用过' : '可用')),
                h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => loreRemove(e.id) }, '删'),
              ))
            : h('div', { className: 'bf-note' }, '卡里还没有 loreIndex。'),
        ),
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '正文（不注入，命中才读）'),
            h('span', { className: 'bf-card-note' }, curLore ? curLore.chars + ' 字符' : ''),
            curLore && !loreDraft && !loreNew ? h('span', { style: { marginLeft: 'auto' } },
              h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: loreStartEdit }, '编辑')) : null,
          ),
          curLore && loreDraft ? h('div', null,
            h('input', { className: 'bf-search', style: { width: '100%' }, value: loreDraft.keys, placeholder: '触发词，逗号分隔', onChange: (e) => setLoreDraft({ ...loreDraft, keys: e.target.value }) }),
            h('input', { className: 'bf-search', style: { width: '100%', marginTop: 6 }, value: loreDraft.oneLine, placeholder: '一行摘要（≤40 字，会注入 prompt）', onChange: (e) => setLoreDraft({ ...loreDraft, oneLine: e.target.value }) }),
            h('textarea', { className: 'bf-textarea', style: { minHeight: 220, marginTop: 6 }, value: loreDraft.body, onChange: (e) => setLoreDraft({ ...loreDraft, body: e.target.value }) }),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
              h(Btn, { small: true, disabled: !!busy, onClick: loreSave }, '保存'),
              h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => setLoreDraft(null) }, '取消'),
            ),
          ) : curLore ? h('div', null,
            h('div', { className: 'bf-note', style: { marginBottom: 6 } }, '键：' + (curLore.keys || []).join(' / ')),
            h('div', { className: 'bf-pf-sub', style: { marginBottom: 8 } }, curLore.oneLine),
            h('pre', { className: 'bf-doc', style: { maxHeight: 360 } }, curLore.body || '（正文文件缺失）'),
          ) : h('div', { className: 'bf-note' }, '选一条见闻看正文。'),
        ),
      )

      const debtKeys = st && st.recent && st.recent.debt ? Object.keys(PF_DEBT_LABEL).filter((k) => st.recent.debt[k]) : []
      const stateTab = h('div', null,
        h('div', { className: 'bf-grid-5' },
          h(Metric, { label: '日期', value: (st && st.date) || '—', foot: 'mood seed 固定' }),
          h(Metric, { label: '今天的心情', value: (st && st.mood && st.mood.label) || '—', foot: '精力 ' + ((st && st.mood && st.mood.energy) ?? '—') + ' · 耐心 ' + ((st && st.mood && st.mood.patience) ?? '—') }),
          h(Metric, { label: '时段', value: (st && st.timeOfDay && st.timeOfDay.label) || '—', foot: '上限 ' + ((st && st.timeOfDay && st.timeOfDay.maxChars) ?? '—') + ' 字' }),
          h(Metric, { label: '沉默计数', value: String((st && st.skipStreak) ?? 0), foot: '连续没接上话' }),
        ),
        h('div', { className: 'bf-grid-2', style: { marginTop: 14 } },
          h(Card, null,
            h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '最近说过（注入 P3）')),
            st && Array.isArray(st.recent && st.recent.comments) && st.recent.comments.length
              ? st.recent.comments.map((c, i) => h('div', { key: i, style: { padding: '7px 0', borderBottom: '.5px solid var(--border-l2)' } }, h('span', null, (i + 1) + '. ' + String(c.text || '')), h('span', { style: { marginLeft: 8 } }, h(Chip, null, c.form || ''))))
              : h('div', { className: 'bf-note' }, '还没有已发评论。'),
          ),
          h(Card, null,
            h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '欠账'), h('span', { className: 'bf-card-note' }, '宿主算，模型不用数')),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              debtKeys.map((k) => h(Chip, { kind: 'warn', key: k }, '欠 ' + PF_DEBT_LABEL[k])),
              st && st.recent && st.recent.debt && st.recent.debt.judgeHeavy ? h(Chip, { kind: 'warn' }, '判断收尾偏多') : null,
              !debtKeys.length && !(st && st.recent && st.recent.debt && st.recent.debt.judgeHeavy) ? h(Chip, { kind: 'rep' }, '无欠账') : null,
            ),
            h('div', { className: 'bf-pf-sub' }, '最近 5 条形态：' + ((st && st.recent && st.recent.forms5 && st.recent.forms5.join(' / ')) || '—')),
          ),
        ),
      )

      const versionTab = h('div', { className: 'bf-grid-2' },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '版本快照'),
            h('span', { className: 'bf-card-note' }, versions.length + ' 份 · 保留最近 20 份'),
          ),
          versions.length
            ? h('table', { className: 'bf-grid' },
                h('thead', null, h('tr', null, ['快照', '时间', ''].map((t, i) => h('th', { key: i }, t)))),
                h('tbody', null, versions.map((v) => h('tr', { key: v.name },
                  h('td', { className: 'mono', style: { fontSize: 11 } }, v.name),
                  h('td', { className: 'mono', style: { fontSize: 11 } }, new Date(v.mtime).toLocaleString()),
                  h('td', null, h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => restore(v.name) }, '回滚')),
                ))),
              )
            : h('div', { className: 'bf-note' }, '还没有版本快照；保存卡或回滚后会出现。'),
        ),
        h(Card, null,
          h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '当前来源')),
          h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '模式'), h('span', { className: 'bf-kv-v' }, mode)),
          h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, 'active'), h('span', { className: 'bf-kv-v' }, JSON.stringify(act))),
          h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '卡来源'), h('span', { className: 'bf-kv-v' }, (d.cardSource && d.cardSource.source) || health.source || '—')),
          h('div', { className: 'bf-kv-row' }, h('span', { className: 'bf-kv-k' }, '路径'), h('span', { className: 'bf-kv-v mono', title: (d.cardSource && d.cardSource.path) || health.path }, (d.cardSource && d.cardSource.path) || health.path || '—')),
          h('div', { className: 'bf-note', style: { marginTop: 10 } }, '回滚 = 把所选快照写回用户卡（会先再存一份新快照）；legacy 模式下改 active.json 不影响本轮注入。'),
        ),
      )

      const sandboxTab = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '试写沙盒'),
          h('span', { className: 'bf-card-note' }, '需要模型调用 · 本版未接'),
        ),
        h('div', { className: 'bf-sandbox-note' },
          '设计里沙盒给一个视频标题 + 简介，按当前人设生成 3 条候选评论，再过一遍 lint（不发布、不消耗账号行为配额）。',
          h('br'), '落地需要：① host 提供 LLM 调用与配额保护；② POST /persona/sandbox 端点；③ 与质量门共用同一套 lint。',
          h('br'), '当前版本先保留入口与说明，避免误以为已能生成。',
        ),
        h('div', { style: { marginTop: 12 } }, h(Btn, { variant: 'primary', disabled: true }, '按当前人设写 3 条（未接）')),
      )

      const body = tab === 'card' ? cardTab
        : tab === 'preview' ? previewTab
        : tab === 'quality' ? qualityTab
        : tab === 'bank' ? bankTab
        : tab === 'lore' ? loreTab
        : tab === 'state' ? stateTab
        : tab === 'version' ? versionTab
        : sandboxTab

      return h('div', null,
        header,
        legacy ? h('div', { className: 'bf-banner warn' }, h('span', null, '配置里填了 personaPrompt：本轮走 legacy 直通，本页的卡与编译预览不生效；切预设只改 active.json，不会覆盖配置。')) : null,
        mode === 'missing' ? h('div', { className: 'bf-banner error' }, h('span', null, '人设卡读不到：' + (health.detail || '未知原因') + '，可切一个内置预设恢复。')) : null,
        err ? h('div', { className: 'bf-banner error' }, h('span', null, '读取失败：' + err)) : null,
        tabs,
        body,
      )
    }

    /* ═══════════════════════ §6 页面 ═══════════════════════ */

    /**
     * 控制台页面（v3 · DSH 原生风格）：
     * - 不再自绘侧栏（宿主已有 rail），只有页面顶栏 + 一行页签 + 内容区；
     * - 7 页：概览 / 实时 / 活动 / 日报 / 判重表 / 人设工作室 / 设置（设置内含宿主日志子页）；
     * - props.initialTab / props.initialData 仅供渲染冒烟测试注入初始状态。
     */
    function ConsolePage(props) {
      const [tab, setTab] = React.useState(props?.initialTab || 'overview')
      const [loginOpen, setLoginOpen] = React.useState(false)
      const ovRaw = useOverview()
      const running = !!ovRaw.data?.round?.running
      const actRaw = useActivity(running)
      const acctRaw = useAccount()
      const personaRaw = usePersona()
      const liveState = useLive()
      // props.initialData 仅用于渲染冒烟 / SSR 截图（真实运行时 hook 一旦有数据就优先）
      const init = props?.initialData || null
      const pick = (hook, data) => (hook.data ? hook : data ? { ...hook, data } : hook)
      const ov = pick(ovRaw, init?.ov)
      const act = pick(actRaw, init?.act)
      const acct = pick(acctRaw, init?.acct)
      const persona = pick(personaRaw, init?.persona)
      const live = props?.live || liveState
      const onToggle = React.useCallback(async (v) => {
        await apiPost('/duty', { autoDuty: v })
        ov.refresh()
      }, [ov.refresh])
      const onRun = React.useCallback(async () => {
        let r = null
        try { r = await apiPost('/run') } catch { /* 失败靠下一轮轮询反映真实状态 */ }
        ov.refresh()
        liveState.refresh?.()
        if (r?.started || r?.ok) setTab('live')
      }, [ov.refresh, liveState.refresh])
      const onStop = React.useCallback(async () => {
        try { await apiPost('/stop') } catch { /* 忽略 */ }
        ov.refresh()
        liveState.refresh?.()
      }, [ov.refresh, liveState.refresh])
      const onLogin = React.useCallback(() => { window.dispatchEvent(new CustomEvent('bf-login')) }, [])
      React.useEffect(() => {
        const open = () => setLoginOpen(true)
        window.addEventListener('bf-login', open)
        return () => window.removeEventListener('bf-login', open)
      }, [])
      const onLoggedIn = React.useCallback(() => {
        setLoginOpen(false)
        ov.refresh(); act.refresh(); acct.refresh(); persona.refresh()
      }, [ov, act, acct, persona])
      const refreshAll = () => { ov.refresh(); act.refresh(); acct.refresh(); persona.refresh(); live?.refresh?.() }
      const account = acct.data
      const data = ov.data || {}
      const duty = data.duty || {}
      const round = data.round || {}
      const loginPill = account === null
        ? h(Pill, { tone: 'off' }, '检查登录…')
        : account?.loggedIn ? h(Pill, { tone: 'ok' }, '登录有效') : h(Pill, { tone: 'warn' }, '未登录')
      const navTabs = [
        ['overview', '概览'], ['live', '实时'], ['activity', '活动 · 生命周期'],
        ['reports', '日报'], ['seen', '判重表'], ['persona', '人设工作室'], ['settings', '设置'],
      ]
      return h('div', { className: 'bf-console bf-root' },
        h('div', { className: 'bf-shell-inner' },
          h('header', { className: 'bf-app-head' },
            h('div', null,
              h('h1', { className: 'bf-app-title' }, T.title),
              h('p', { className: 'bf-app-sub' }, T.subtitle),
            ),
            h('div', { className: 'bf-app-actions' },
              loginPill,
              account?.loggedIn === false ? h(Btn, { small: true, variant: 'ghost', onClick: onLogin }, T.login) : null,
              h(Btn, { small: true, variant: 'ghost', onClick: refreshAll }, T.refresh),
              h(Btn, { small: true, variant: round.running ? 'danger' : 'primary', disabled: false, onClick: round.running ? onStop : onRun }, round.running ? T.stop : T.run),
            ),
          ),
          h('div', { className: 'bf-status-row' },
            h(Pill, { tone: duty.autoDuty ? 'ok' : 'off' }, duty.autoDuty ? '自动值班开' : '自动值班关'),
            h(Chip, null, '下一轮 ' + (duty.autoDuty ? (duty.nextWindowLabel || '—') : '自动已关')),
            round.running ? h(Pill, { tone: 'ok' }, '本轮运行中') : h(Chip, null, '空闲'),
            round.lastCode != null && round.lastCode !== 0 ? h(Pill, { tone: 'err' }, '上轮退出码 ' + round.lastCode) : null,
          ),
          h('nav', { className: 'bf-nav', role: 'tablist', 'aria-label': '控制台页面' },
            navTabs.map(([k, label]) =>
              h('button', { key: k, role: 'tab', 'aria-selected': String(tab === k), onClick: () => setTab(k) }, label)),
          ),
          tab === 'overview'
            ? h(OverviewPage, { ov, act, acct, live, persona, onRun, onStop, onToggle, onLogin, onGo: setTab })
            : tab === 'live'
              ? h(LivePage, { live, ov, onRun, onStop })
              : tab === 'activity'
                ? h(ActivityPage, { data: act.data, onRun, onLogin })
                : tab === 'reports'
                  ? h(ReportsPage, { initial: props?.initialData?.reports })
                  : tab === 'seen'
                    ? h(SeenPage, { initial: props?.initialData?.seen })
                    : tab === 'persona'
                      ? h(PersonaPage, { persona, initial: props?.initialData?.personaPage || props?.persona, initialTab: props?.initialPersonaTab })
                      : h(SettingsPage, { ov, initial: props?.initialData?.config }),
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
      return h('div', { className: 'bf-console bf-settings-section' },
        h('div', null,
          h('div', { className: 'bf-settings-title' }, 'B站分身'),
          h('div', { className: 'bf-settings-desc' }, '让小号在B站保持存在感；安装自检、账号与完整控制台都在这里进入。'),
        ),
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '安装自检'),
            h('span', { className: 'bf-card-note' }, '检查插件依赖、MCP 连接、登录与模型是否就绪'),
          ),
          h(DiagnosePanel, {
            report: diag.report, loading: diag.loading, error: diag.error, onRun: diag.run, compact: true,
          }),
        ),
        h('div', { className: 'bf-note' }, a.loggedIn ? '当前账号：' + a.uname + '（UID ' + a.mid + '）' : '当前未登录'),
        h('div', { style: { marginTop: 4 } },
          h(Btn, {
            variant: 'primary',
            onClick: () => { try { ctxLayout?.selectPanel?.(PANEL_ID) } catch { /* 老版本宿主没有该 API */ } },
          }, '打开控制台'),
        ),
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
