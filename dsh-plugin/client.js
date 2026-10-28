/**
 * dsh-bili-fenshen —— Client 半部（单文件控制台 · v4）
 *
 * 注册：sidebar.panellist（图标）+ main（控制台页面）+ settings.section（瘦身版）
 * 结构：
 *   §0 常量 / 文案
 *   §1 CSS（宿主 --dsw-* token 映射 + bf- 组件样式；只两档卡片材质、两档导航）
 *   §2 数据层（apiGet/apiPost/apiPut · usePoll · useRealtime · useLive · useElapsed · 格式化）
 *   §3 基础组件（PageHeader/Pill/Tag/Card/Row/…/DiagnosePanel/LoginModal）
 *   §4 活动（StageRail/ReplyThread/ActivityCard/Markdown/SeenView/ActivityPage）
 *   §5 日报（ReportsPage）
 *   §6 人设（PersonaPage：3 子页签）
 *   §7 设置（SettingsPage：3 组 + ConfigPane + LogPane）
 *   §8 概览（OverviewPage：状态条/今日产出/接话/运行详情/配额/存在感/人设+健康）
 *   §9 页面壳（ConsolePage：5 页签）
 *   §10 注册
 *
 * 设计定稿：docs/analysis/2026-10-28-design-v4.md
 * 约束：不 require 任何 @deepseek-ai/dsh-client-* 包；只读宿主 --dsw-* token，不自造 hex（B 站粉/蓝仅图标/头像）。
 * 兼容：新字段全部 ??/|| 兜住；老 /overview 字段仍在；SSE 不可用时降级轮询。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-fenshen',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ═══════════════════════ §0 常量 ═══════════════════════ */

    const PANEL_ID = 'bili-fenshen'
    const TAG_ID = 'dsh-bili-fenshen/console.css'
    const API = '/api/bili-fenshen'

    const T = {
      title: 'B站分身',
      subtitle: '让小号在B站保持存在感 · 先发后报，可随时接管',
      refresh: '刷新',
      run: '跑一轮',
      stop: '中止',
      login: '扫码登录',
      reopen: '重新扫码',
    }

    const SRC_LABEL = { hot: '热门', search: '搜索', follow: '订阅' }
    const GRADE_TEXT = { worth: '值得看', ok: '可以看', meh: '不值当' }

    const LIVE_MAX_EVENTS = 300
    const LIVE_KIND_CN = { host: '宿主', tool: '工具', reasoning: '推理', error: '错误', text: '输出', state: '状态' }
    const DIAG_ICON = { pass: '✓', warn: '!', fail: '✗' }

    /** 一级页签（v4：7 → 5）。live / seen 已降级为页内块，不再是页签。 */
    const TABS = [
      ['overview', '概览'],
      ['activity', '活动'],
      ['reports', '日报'],
      ['persona', '人设'],
      ['settings', '设置'],
    ]
    /** 旧 props.initialTab 兼容（渲染冒烟与外部深链可能还在用） */
    const TAB_ALIAS = { live: 'overview', seen: 'activity' }

    const PAGE_TITLE = { overview: '概览', activity: '活动', reports: '日报', persona: '人设', settings: '设置' }
    const PAGE_INTRO = {
      overview: T.subtitle,
      activity: '它看过什么、说过什么；每条视频从刷到到跟进回复的链路都在这里。',
      reports: '每一轮的过程记录：日报、月度归档与 headless overlay。',
      persona: '这个号是谁、说话像不像它；换预设、改素材、看编译质量。',
      settings: '怎么调它：节奏、配额、内容源、禁令、模型与运行环境。',
    }

    /* ═══════════════════════ §1 CSS ═══════════════════════
     * token 全部来自宿主（--dsw-*），切成局部变量使用。
     * 白名单（宿主规范）：字号 11/12/13/14/16/18/20/24；行高 14/18/20/22/24/26/28/32；
     *                   圆角 4/8/12/16/20/28/999/50%；控件高 24/28/32/34/36。
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
        --label-dimmed:var(--dsw-alias-label-dimmed);
        --brand-primary:var(--dsw-alias-brand-primary);
        --brand-hover:var(--dsw-alias-button-primary-hover);
        --primary-fg:var(--dsw-alias-label-primary-foreground);
        --interactive-hover:var(--dsw-alias-interactive-bg-hover);
        --interactive-active:var(--dsw-alias-interactive-bg-active);
        --selector:var(--dsw-specific-selector);
        --input:var(--dsw-alias-bg-layer-3);
        --switch-thumb:var(--dsw-alias-switch-thumb);
        --settings-card-fill:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));
        --settings-card-stroke:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));
        --focus-ring:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
        --success:var(--dsw-alias-state-success-primary);
        --success-3:var(--dsw-alias-state-success-tertiary);
        --warn:var(--dsw-alias-state-warn-primary);
        --warn-3:var(--dsw-alias-state-warn-tertiary);
        --error:var(--dsw-alias-state-error-primary);
        --idle:var(--dsw-alias-state-idle-primary);
        --business:var(--dsw-alias-state-business-primary);
        --biz-0:color-mix(in srgb, var(--business) 10%, transparent);
        --ok-0:color-mix(in srgb, var(--success) 10%, transparent);
        --warn-0:color-mix(in srgb, var(--warn) 12%, transparent);
        --err-0:color-mix(in srgb, var(--error) 8%, transparent);
        --bubble:color-mix(in srgb, var(--business) 10%, var(--bg-layer-1));
        --bili-pink:#fb7299;
        --bili-blue:#23ade5;
        --font-code:"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,monospace;
        --ease:cubic-bezier(.4,0,.2,1); --dur:.2s;
        color:var(--label-primary);
        font-size:14px; line-height:22px;
      }
      .bf-console, .bf-console *{box-sizing:border-box}
      .bf-console :focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
      .bf-console button{font:inherit;color:inherit}
      @media (prefers-reduced-motion:reduce){.bf-console *{transition:none!important;animation:none!important}}

      /* ── 壳层：页面自己滚（宿主 main 槽不给 padding / 滚动） ── */
      .bf-root{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--bg-base)}
      .bf-page{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;
        align-items:center;gap:32px;padding:0 clamp(24px,4vw,48px) 48px;color:var(--label-primary)}
      .bf-page>*{width:100%;max-width:960px}
      .bf-page-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;
        gap:16px;padding-top:28px}
      .bf-page-title{margin:0;font-size:20px;line-height:28px;font-weight:500}
      .bf-page-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--label-tertiary);max-width:640px}
      .bf-page-toolbar{display:flex;flex:none;align-items:center;justify-content:flex-end;gap:8px;white-space:nowrap}
      .bf-pagemain{display:flex;flex-direction:column;gap:16px;min-width:0}
      .bf-pagebody{display:flex;flex-direction:column;gap:10px;min-width:0}
      @media (max-width:680px){.bf-page{padding:0 16px 40px;gap:24px}.bf-page-head{padding-top:20px}}

      /* ── 页签（宿主下划线规格：gap 22 / pad 7-1-9 / 13-20 / 2px 下划线） ── */
      .bf-tabs{display:flex;align-items:flex-end;gap:22px;margin:0;
        border-bottom:.5px solid var(--border-l2);overflow-x:auto;scrollbar-width:none}
      .bf-tabs::-webkit-scrollbar{display:none}
      .bf-tabs button{position:relative;border:0;background:none;cursor:pointer;border-radius:4px;
        padding:7px 1px 9px;font-size:13px;line-height:20px;color:var(--label-tertiary);white-space:nowrap}
      .bf-tabs button:hover{color:var(--label-primary)}
      .bf-tabs button[aria-selected="true"]{color:var(--label-primary)}
      .bf-tabs button[aria-selected="true"]::after,
      .bf-tabs button:focus-visible::after{content:"";position:absolute;left:0;right:0;bottom:-1px;
        height:2px;border-radius:2px 2px 0 0;background:var(--label-primary)}

      /* ── 分段控件（二级视图切换） ── */
      .bf-seg{display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;
        border-radius:12px;background:var(--interactive-hover);justify-self:start}
      .bf-seg button{height:28px;padding:0 16px;border:0;border-radius:8px;background:transparent;
        color:var(--label-secondary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap}
      .bf-seg button:hover{color:var(--label-primary)}
      .bf-seg button[aria-selected="true"]{color:var(--label-primary);background:var(--bg-layer-1);
        box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.06))}
      .bf-seg button:focus-visible{outline-offset:-2px}

      /* ── 卡片：只两档（内容卡 16 / 设置卡 20） ── */
      .bf-card{border:.5px solid var(--border-l2);border-radius:16px;background:var(--bg-layer-1);padding:14px 16px}
      .bf-card+.bf-card{margin-top:10px}
      .bf-card.bf-card-p0{border-color:var(--settings-card-stroke);background:var(--settings-card-fill)}
      .bf-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;min-height:20px;flex-wrap:wrap}
      .bf-card-title{font-size:14px;line-height:20px;font-weight:500;color:var(--label-primary)}
      .bf-card-note{font-size:12px;line-height:18px;color:var(--label-tertiary);font-variant-numeric:tabular-nums}
      .bf-card-head .bf-sp{flex:1}
      .bf-card-foot{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;
        border-top:.5px solid var(--border-l2);flex-wrap:wrap}
      .bf-card-foot .bf-note{margin-right:auto}
      .bf-scard{border:.5px solid var(--settings-card-stroke);border-radius:20px;
        background:var(--settings-card-fill);padding:16px 18px}
      .bf-scard+.bf-scard{margin-top:10px}

      /* ── 文本 ── */
      .bf-note{font-size:12px;line-height:18px;color:var(--label-tertiary)}
      .bf-note.st{color:var(--label-secondary)}
      .bf-mono{font-family:var(--font-code);font-size:11px;line-height:14px;color:var(--label-tertiary)}
      .bf-strong{font-weight:500;color:var(--label-primary)}

      /* ── 按钮 ── */
      .bf-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;
        padding:0 12px;border-radius:12px;cursor:pointer;border:.5px solid var(--border-l3);
        background:transparent;color:var(--label-primary);font-size:13px;line-height:20px;
        transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease),opacity var(--dur) var(--ease)}
      .bf-btn:hover:not(:disabled){background:var(--interactive-hover)}
      .bf-btn:active:not(:disabled){background:var(--interactive-active)}
      .bf-btn.primary{background:var(--brand-primary);color:var(--primary-fg);border-color:transparent}
      .bf-btn.primary:hover:not(:disabled){background:var(--brand-hover)}
      .bf-btn.ghost{border-color:transparent;color:var(--label-secondary)}
      .bf-btn.ghost:hover:not(:disabled){color:var(--label-primary);background:var(--interactive-hover)}
      .bf-btn.small{height:28px;padding:0 10px;border-radius:8px;font-size:12px;line-height:18px}
      .bf-btn:disabled{opacity:.4;cursor:not-allowed}
      .bf-btn.danger{color:var(--error);border-color:color-mix(in srgb, var(--error) 30%, transparent)}
      .bf-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
        padding:0;border:0;border-radius:8px;background:transparent;color:var(--label-secondary);cursor:pointer}
      .bf-iconbtn:hover:not(:disabled){background:var(--interactive-hover);color:var(--label-primary)}
      .bf-iconbtn:disabled{opacity:.4;cursor:default}

      /* ── 开关 / 步进 / 输入族 ── */
      .bf-switch{position:relative;display:inline-flex;margin:0;width:36px;height:20px;border-radius:999px;
        corner-shape:round;border:0;padding:2px;cursor:pointer;background:var(--border-l3);
        transition:background var(--dur) var(--ease);flex:none}
      .bf-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;
        border-radius:999px;corner-shape:round;background:var(--switch-thumb);
        transition:transform var(--dur) var(--ease)}
      .bf-switch[aria-checked="true"]{background:var(--brand-primary)}
      .bf-switch[aria-checked="true"]::after{transform:translateX(16px);background:var(--primary-fg)}
      .bf-switch:disabled{opacity:.5;cursor:default}
      .bf-num{display:inline-flex;align-items:center;border:.5px solid var(--border-l4);border-radius:12px;
        overflow:hidden;background:var(--input);height:34px}
      .bf-num button{width:28px;height:100%;border:0;background:transparent;color:var(--label-secondary);
        cursor:pointer;font-size:14px;line-height:20px}
      .bf-num button:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-num input{width:44px;height:100%;border:0;background:transparent;color:var(--label-primary);
        text-align:center;font-size:13px;line-height:20px;font-variant-numeric:tabular-nums;outline:none}
      .bf-num:focus-within{border-color:var(--business)}
      .bf-input,.bf-select,.bf-search{box-sizing:border-box;height:34px;padding:0 12px;border-radius:12px;
        border:.5px solid var(--border-l4);background:var(--input);color:var(--label-primary);
        font-size:13px;line-height:20px;outline:none;font-family:inherit}
      .bf-input::placeholder,.bf-search::placeholder{color:var(--label-dimmed)}
      .bf-input:focus-visible,.bf-select:focus-visible{border-color:var(--business)}
      .bf-select:disabled{opacity:.5;cursor:not-allowed}
      .bf-select{cursor:pointer;padding-right:8px}
      .bf-select option{background:var(--bg-layer-1);color:var(--label-primary)}
      .bf-searchwrap{position:relative;display:flex;align-items:center}
      .bf-searchwrap .bf-search-icon{position:absolute;left:11px;color:var(--label-tertiary);pointer-events:none;
        font-size:11px;line-height:14px}
      .bf-searchwrap .bf-search{height:36px;padding:0 34px 0 32px;background:var(--bg-layer-1);width:100%}
      .bf-searchwrap .bf-search:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb, var(--business) 18%, transparent)}
      .bf-console textarea{width:100%;min-height:76px;resize:vertical;padding:8px 12px;border-radius:12px;
        border:.5px solid var(--border-l4);background:var(--input);color:var(--label-primary);
        font-family:inherit;font-size:13px;line-height:20px;outline:none}
      .bf-console textarea::placeholder{color:var(--label-dimmed)}
      .bf-console textarea:focus-visible{border-color:var(--business)}
      .bf-console textarea.bf-json{min-height:320px;font-family:var(--font-code);font-size:12px;line-height:18px}

      /* ── 胶囊 / 标签 / 过滤 chip（宿主规格） ── */
      .bf-pill{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;
        border-radius:999px;corner-shape:round;font-size:12px;line-height:18px;font-weight:400;
        color:var(--label-secondary);background:var(--bg-layer-2)}
      .bf-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;flex:0 0 6px;display:inline-block}
      .bf-dot.ok{background:var(--success)}
      .bf-dot.warn{background:var(--warn)}
      .bf-dot.err{background:var(--error)}
      .bf-dot.off{background:var(--idle)}
      .bf-tag{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:0;border-radius:999px;
        corner-shape:round;font-size:11px;line-height:17px;font-weight:500;flex:0 0 auto;
        color:var(--label-tertiary);background:var(--bg-module-platform)}
      .bf-tag.cmt{background:var(--biz-0);color:var(--business)}
      .bf-tag.rep{background:var(--ok-0);color:var(--success)}
      .bf-tag.warn{background:var(--warn-0);color:var(--warn)}
      .bf-tag.err{background:var(--err-0);color:var(--error)}
      .bf-tag.like{background:var(--bg-layer-2);color:var(--label-secondary)}
      .bf-grade{border:0;border-radius:999px;corner-shape:round;padding:1px 8px;font-size:11px;
        line-height:17px;font-weight:500;flex:0 0 auto}
      .bf-grade.worth{background:var(--biz-0);color:var(--business)}
      .bf-grade.ok{background:var(--bg-module-platform);color:var(--label-secondary)}
      .bf-grade.meh{background:var(--bg-module-platform);color:var(--label-tertiary)}
      .bf-chipbtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;
        border-radius:999px;corner-shape:round;background:var(--bg-layer-2);color:var(--label-secondary);
        font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums}
      .bf-chipbtn:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-chipbtn[aria-pressed="true"]{color:var(--label-primary);background:var(--interactive-hover);
        box-shadow:inset 0 0 0 1px var(--border-l3)}

      /* ── 状态条（一行 pills） ── */
      .bf-statusline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;line-height:20px}
      .bf-fresh{font-size:12px;line-height:18px;color:var(--label-tertiary);font-variant-numeric:tabular-nums;
        display:inline-flex;align-items:center;gap:4px}
      .bf-fresh.warn{color:var(--warn)}
      .bf-fresh.err{color:var(--error)}

      /* ── 网格 / 指标 ── */
      .bf-grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;align-items:start}
      .bf-grid-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}
      .bf-grid-4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:start}
      .bf-grid-6{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;align-items:start}
      @media (max-width:680px){.bf-grid-3,.bf-grid-4,.bf-grid-6{grid-template-columns:repeat(2,minmax(0,1fr))}}
      .bf-metric{border:.5px solid var(--border-l2);border-radius:12px;background:var(--bg-layer-1);
        padding:12px 14px;min-width:0}
      .bf-metric-label{font-size:12px;line-height:18px;color:var(--label-tertiary);white-space:nowrap}
      .bf-metric-value{display:flex;align-items:baseline;gap:4px;margin-top:4px;font-size:20px;line-height:28px;
        font-weight:500;color:var(--label-primary);font-variant-numeric:tabular-nums}
      .bf-metric-value small{font-size:12px;line-height:18px;font-weight:400;color:var(--label-caption)}
      .bf-metric-foot{font-size:12px;line-height:18px;color:var(--label-caption);margin-top:2px;
        font-variant-numeric:tabular-nums}
      .bf-bar{height:3px;border-radius:999px;background:var(--border-l2);margin-top:8px;overflow:hidden}
      .bf-bar i{display:block;height:100%;border-radius:999px;background:var(--business)}
      .bf-bar i.warn{background:var(--warn)}
      .bf-bar i.over{background:var(--error)}

      /* ── 今日产出（数字带 + 最近说的） ── */
      .bf-today{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:13px;line-height:20px;
        color:var(--label-secondary)}
      .bf-today-item{display:inline-flex;align-items:baseline;gap:4px}
      .bf-today-n{font-size:16px;line-height:24px;font-weight:500;color:var(--label-primary);
        font-variant-numeric:tabular-nums}
      .bf-today-sep{color:var(--label-dimmed)}
      .bf-said{display:flex;flex-direction:column;gap:0}
      .bf-said-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-top:.5px solid var(--border-l2)}
      .bf-said-row:first-child{border-top:0;padding-top:0}
      .bf-said-main{flex:1;min-width:0}
      .bf-said-text{font-size:13px;line-height:20px;color:var(--label-primary);overflow-wrap:anywhere}
      .bf-said-meta{display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap}
      .bf-said-meta .bf-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}

      /* ── 运行详情（原实时页） ── */
      .bf-live-clock{font-family:var(--font-code);font-size:16px;line-height:24px;color:var(--label-primary);
        font-variant-numeric:tabular-nums}
      .bf-live-body{max-height:320px;overflow:auto;border:.5px solid var(--border-l1);border-radius:8px;
        background:var(--bg-module-platform);padding:8px 10px;font-family:var(--font-code);
        font-size:11px;line-height:18px;
        --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
        --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
      .bf-live-line{display:flex;gap:8px;padding:1px 0;word-break:break-word}
      .bf-live-t{flex:0 0 54px;color:var(--label-caption);font-variant-numeric:tabular-nums}
      .bf-live-kind{flex:0 0 auto;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:var(--label-tertiary)}
      .bf-live-text{flex:1;min-width:0;color:var(--label-secondary);white-space:pre-wrap}
      .bf-live-line.tool .bf-live-kind,.bf-live-line.tool .bf-live-text{color:var(--business)}
      .bf-live-line.reasoning .bf-live-text{color:var(--label-tertiary)}
      .bf-live-line.error .bf-live-kind,.bf-live-line.error .bf-live-text{color:var(--error)}
      .bf-live-line.host .bf-live-text{color:var(--label-secondary)}
      .bf-live-line.state .bf-live-text{color:var(--warn)}
      .bf-live-empty{padding:24px 12px;text-align:center;color:var(--label-tertiary);font-family:inherit;
        font-size:13px;line-height:20px}
      .bf-live-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;
        font-size:12px;line-height:18px;color:var(--label-caption)}
      .bf-live-foot .bf-live-err{color:var(--warn)}

      /* ── 阶段轨 ── */
      .bf-stages{display:grid;grid-template-columns:repeat(var(--n,6),1fr);margin:2px 0 10px}
      .bf-stage{position:relative;padding-top:14px;min-width:0}
      .bf-stage::before{content:"";position:absolute;top:4px;left:0;right:0;height:1px;background:var(--border-l2)}
      .bf-stage:first-child::before{left:5px}
      .bf-stage:last-child::before{right:calc(100% - 5px)}
      .bf-stage b{position:absolute;top:0;left:0;width:9px;height:9px;border-radius:50%;corner-shape:round;
        background:var(--bg-base);box-shadow:inset 0 0 0 1.5px var(--idle)}
      .bf-stage.done b{background:var(--business);box-shadow:none}
      .bf-stage span{display:block;font-size:11px;line-height:14px;color:var(--label-tertiary);white-space:nowrap}
      .bf-stage.done span{color:var(--label-secondary)}
      .bf-stage em{display:block;font-size:11px;line-height:14px;color:var(--label-caption);font-style:normal;
        font-variant-numeric:tabular-nums}

      /* ── 工具行 / 活动卡 ── */
      .bf-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .bf-tools .bf-sp{flex:1}
      .bf-daysep{display:flex;align-items:center;gap:10px;margin:16px 0 8px;font-size:12px;line-height:18px;
        color:var(--label-tertiary)}
      .bf-daysep::after{content:"";flex:1;height:.5px;background:var(--border-l2)}
      .bf-round-head{display:flex;align-items:baseline;gap:10px;margin:16px 0 8px;flex-wrap:wrap}
      .bf-round-time{font-size:13px;line-height:20px;font-weight:500;color:var(--label-primary);
        font-variant-numeric:tabular-nums}
      .bf-round-src{font-size:12px;line-height:18px;color:var(--label-tertiary)}
      details.bf-act{border:.5px solid var(--border-l2);border-radius:12px;background:var(--bg-layer-1)}
      details.bf-act+details.bf-act{margin-top:8px}
      details.bf-act>summary{list-style:none;cursor:pointer;padding:12px 14px;border-radius:12px;
        transition:background var(--dur) var(--ease)}
      details.bf-act>summary::-webkit-details-marker{display:none}
      details.bf-act>summary:hover{background:var(--interactive-hover)}
      details.bf-act[open]>summary{border-bottom:.5px solid var(--border-l2);border-radius:12px 12px 0 0}
      .bf-sum-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .bf-sum-row .bf-sp{flex:1}
      .bf-bvid{font-family:var(--font-code);font-size:11px;line-height:14px;color:var(--label-tertiary)}
      .bf-sum-title{font-size:13px;line-height:20px;color:var(--label-primary);font-weight:500;margin-top:4px;
        overflow-wrap:anywhere}
      .bf-sum-meta{font-size:12px;line-height:18px;color:var(--label-tertiary);overflow-wrap:anywhere}
      .bf-chev{color:var(--label-caption);transition:transform var(--dur) var(--ease);flex:0 0 12px}
      details[open]>summary .bf-chev{transform:rotate(90deg)}
      .bf-act-body{padding:12px 14px 14px}
      .bf-quote{font-size:13px;line-height:20px;color:var(--label-primary);padding:2px 0 2px 10px;
        border-left:2px solid var(--border-l2);margin:0 0 10px;overflow-wrap:anywhere}
      .bf-quote .bf-who{font-size:11px;line-height:14px;color:var(--label-tertiary);margin-right:6px}
      .bf-thread{margin:0 0 2px;padding-left:12px;border-left:1px solid var(--border-l2)}
      .bf-msg{display:flex;gap:8px;padding:6px 0;align-items:baseline;flex-wrap:wrap}
      .bf-msg+.bf-msg{border-top:.5px solid var(--border-l2)}
      .bf-msg-name{font-size:12px;line-height:18px;color:var(--label-secondary);flex:0 0 auto;font-weight:500}
      .bf-msg-time{font-size:11px;line-height:18px;color:var(--label-caption);flex:0 0 auto;
        font-variant-numeric:tabular-nums}
      .bf-msg-text{font-size:13px;line-height:20px;color:var(--label-primary);min-width:0;overflow-wrap:anywhere}
      .bf-msg.mine .bf-msg-text{background:var(--bubble);border-radius:8px;padding:2px 8px;margin:-2px 0}
      .bf-msg.mine .bf-msg-name{color:var(--business)}
      .bf-dyn{font-size:12px;line-height:18px;color:var(--label-secondary);margin:8px 0 0}
      .bf-act-foot{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:12px;line-height:18px;
        color:var(--label-tertiary);flex-wrap:wrap}
      .bf-link{color:var(--business);text-decoration:none;cursor:pointer;font-size:12px;line-height:18px}
      .bf-link:hover{text-decoration:underline}
      details.bf-group{margin-top:10px}
      details.bf-group>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;
        padding:8px 10px;border-radius:8px;color:var(--label-secondary);font-size:12px;line-height:18px;
        transition:background var(--dur) var(--ease)}
      details.bf-group>summary::-webkit-details-marker{display:none}
      details.bf-group>summary::after{content:"›";margin-left:auto;color:var(--label-caption);
        transition:transform var(--dur) var(--ease)}
      details.bf-group[open]>summary::after{transform:rotate(90deg)}
      details.bf-group>summary:hover{background:var(--interactive-hover)}
      details.bf-group[open]>summary{color:var(--label-primary)}
      .bf-skip-list{margin:6px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
      .bf-skip-item{display:flex;align-items:baseline;gap:8px;padding:8px 12px;border:.5px solid var(--border-l1);
        border-radius:8px;background:var(--bg-module-platform)}
      .bf-skip-item .bf-bvid{flex:0 0 auto}
      .bf-skip-title{font-size:12px;line-height:18px;color:var(--label-secondary);min-width:0;flex:1;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bf-skip-reason{font-size:11px;line-height:14px;color:var(--label-tertiary);flex:0 0 auto}

      /* ── 事件流（时间线视图） ── */
      .bf-evt{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:.5px solid var(--border-l1)}
      .bf-evt:last-child{border-bottom:0}
      .bf-evt-type{flex:0 0 84px}
      .bf-evt-main{flex:1;min-width:0}
      .bf-evt-title{font-size:13px;line-height:20px;color:var(--label-primary);overflow-wrap:anywhere}
      .bf-evt-meta{font-size:12px;line-height:18px;color:var(--label-caption);margin-top:2px;overflow-wrap:anywhere}
      .bf-evt-time{flex:0 0 auto;font-family:var(--font-code);font-size:11px;line-height:14px;
        color:var(--label-caption);white-space:nowrap;padding-top:2px}

      /* ── 表格（判重表 / L0 / 版本） ── */
      .bf-tbl-wrap{max-height:560px;overflow:auto;border-radius:12px;
        --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
        --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
      table.bf-grid{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}
      table.bf-grid th{position:sticky;top:0;z-index:1;background:var(--bg-layer-1);text-align:left;
        font-weight:500;font-size:12px;line-height:18px;color:var(--label-tertiary);padding:8px 10px;
        border-bottom:.5px solid var(--border-l2);white-space:nowrap}
      table.bf-grid td{padding:8px 10px;border-bottom:.5px solid var(--border-l2);color:var(--label-secondary);
        vertical-align:top;line-height:20px;overflow-wrap:anywhere}
      table.bf-grid tbody tr:hover td{background:var(--interactive-hover)}
      table.bf-grid tr:last-child td{border-bottom:0}
      table.bf-grid td.bv{font-family:var(--font-code);font-size:11px;line-height:14px;
        color:var(--label-tertiary);white-space:nowrap}
      table.bf-grid td.mono{font-family:var(--font-code);font-size:11px;line-height:14px;color:var(--label-tertiary)}

      /* ── 列表（日报左侧 / 见闻索引） ── */
      .bf-list{display:flex;flex-direction:column;gap:2px}
      .bf-list-btn{display:flex;align-items:center;gap:8px;min-height:34px;padding:6px 8px;border:0;
        border-radius:12px;background:transparent;color:var(--label-secondary);font-size:13px;line-height:20px;
        text-align:left;width:100%;cursor:pointer}
      .bf-list-btn:hover{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-list-btn[aria-current="true"]{background:var(--interactive-hover);color:var(--label-primary)}
      .bf-list-btn .l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bf-list-btn .m{margin-left:auto;font-size:11px;line-height:14px;color:var(--label-caption);
        white-space:nowrap;flex:0 0 auto}
      .bf-list-sep{font-size:11px;line-height:14px;color:var(--label-caption);padding:10px 8px 4px;
        margin-top:4px;border-top:.5px solid var(--border-l2)}
      .bf-split{display:grid;grid-template-columns:236px minmax(0,1fr);gap:10px;align-items:start}
      @media (max-width:900px){.bf-split{grid-template-columns:1fr}}

      /* ── Markdown ── */
      .bf-md{font-size:14px;line-height:22px;color:var(--label-secondary);max-width:780px}
      .bf-md h2.bf-md-h1{font-size:20px;line-height:28px;font-weight:500;color:var(--label-primary);margin:0 0 10px;
        padding-bottom:8px;border-bottom:.5px solid var(--border-l2)}
      .bf-md h2{font-size:16px;line-height:24px;font-weight:500;color:var(--label-primary);margin:20px 0 8px}
      .bf-md h3{font-size:14px;line-height:22px;font-weight:500;color:var(--label-primary);margin:16px 0 6px}
      .bf-md p{margin:0 0 10px}
      .bf-md strong{color:var(--label-primary);font-weight:500}
      .bf-md code{background:var(--bg-layer-2);border-radius:4px;padding:1px 5px;font-family:var(--font-code);
        font-size:12px;line-height:18px;color:var(--label-primary)}
      .bf-md ul{margin:0 0 10px;padding-left:2px;display:flex;flex-direction:column;gap:2px}
      .bf-md li{position:relative;padding-left:14px}
      .bf-md li::before{content:"";position:absolute;left:2px;top:10px;width:4px;height:4px;border-radius:50%;
        corner-shape:round;background:var(--label-caption)}
      .bf-md a{color:var(--business);text-decoration:none;overflow-wrap:anywhere}
      .bf-md a:hover{text-decoration:underline}
      .bf-md blockquote{margin:8px 0 12px;padding:2px 0 2px 12px;border-left:2px solid var(--border-l2);
        color:var(--label-tertiary)}
      .bf-md hr{border:0;border-top:.5px solid var(--border-l2);margin:16px 0}
      .bf-md pre{background:var(--bg-layer-2);border-radius:12px;padding:10px 12px;overflow:auto;
        font-size:12px;line-height:18px;margin:0 0 12px}
      .bf-md pre code{background:none;padding:0;font-size:12px}
      pre.bf-doc{margin:0;padding:12px 14px;border-radius:12px;border:.5px solid var(--border-l1);
        background:var(--bg-module-platform);font-family:var(--font-code);font-size:11px;line-height:18px;
        color:var(--label-secondary);white-space:pre-wrap;overflow:auto;
        --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}

      /* ── 人设 ── */
      .bf-pf-budget{display:grid;grid-template-columns:96px minmax(0,1fr) 72px;gap:10px;align-items:center;
        padding:4px 0}
      .bf-pf-budget .bf-bar{margin-top:0}
      .bf-pf-num{font-family:var(--font-code);font-size:11px;line-height:14px;color:var(--label-tertiary);
        text-align:right;font-variant-numeric:tabular-nums}
      .bf-pf-sub{font-size:12px;line-height:18px;color:var(--label-tertiary);margin-top:6px}
      .bf-buckets{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
      .bf-bucket{border:.5px solid var(--border-l2);border-radius:12px;background:var(--bg-layer-1);
        padding:9px 11px;text-align:left;cursor:pointer;min-width:0}
      .bf-bucket:hover{background:var(--interactive-hover)}
      .bf-bucket[aria-pressed="true"]{border-color:var(--business);background:var(--biz-0)}
      .bf-bucket b{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;font-weight:500}
      .bf-bucket .m{font-size:11px;line-height:14px;color:var(--label-caption);margin-top:2px;
        font-variant-numeric:tabular-nums}
      .bf-edit-box{padding:9px 0;border-top:.5px solid var(--border-l2)}
      .bf-edit-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center}
      .bf-sandbox-note{max-width:640px;font-size:13px;line-height:20px;color:var(--label-secondary)}

      /* ── 当前账号（概览顶部：头像 + 昵称/UID + 关键数字） ── */
      .bf-account{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
      .bf-avatar{width:44px;height:44px;border-radius:50%;flex:0 0 44px;display:grid;place-items:center;
        overflow:hidden;background:linear-gradient(135deg,var(--bili-pink),var(--bili-blue));color:#fff;
        font-size:17px;font-weight:600;line-height:1;box-shadow:0 0 0 1px var(--border-l2) inset}
      .bf-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
      .bf-account-main{min-width:0;flex:1 1 160px}
      .bf-account-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:15px;line-height:22px;
        font-weight:500;color:var(--label-primary)}
      .bf-account-name>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .bf-account-meta{margin-top:2px;font-size:12px;line-height:18px;color:var(--label-tertiary);
        font-family:var(--font-code);font-variant-numeric:tabular-nums}
      .bf-lv{font-size:10px;line-height:14px;padding:0 4px;border-radius:6px;background:var(--bg-module-platform);
        color:var(--label-secondary);border:.5px solid var(--border-l2);font-family:var(--font-code);flex:0 0 auto}
      .bf-acct-stats{display:flex;gap:18px;flex-wrap:wrap;margin-left:auto}
      .bf-acct-stat{min-width:52px;text-align:right}
      .bf-acct-stat-v{font-size:15px;line-height:22px;font-weight:500;color:var(--label-primary);
        font-variant-numeric:tabular-nums}
      .bf-acct-stat-k{font-size:11px;line-height:16px;color:var(--label-caption)}

      /* ── 设置（行式：label+说明左，控件右，行高 60） ── */
      .bf-config{display:flex;flex-direction:column;gap:10px}
      .bf-group-title{font-size:14px;line-height:20px;font-weight:500;margin:0 0 4px;color:var(--label-primary)}
      .bf-row{display:flex;align-items:flex-start;gap:16px;min-height:60px;padding:12px 0;
        border-top:.5px solid var(--border-l2)}
      .bf-row:first-of-type{border-top:0}
      .bf-row-main{flex:1;min-width:0}
      /* ⭐ 宽控件行改纵向堆叠：旧版 .bf-row-ctl.wide{width:100%} 在不可换行的 flex 里
         把 main 挤到 0 宽，中文标签于是变成「一字一行」的竖排。 */
      .bf-row-wide{flex-direction:column;align-items:stretch;gap:8px}
      .bf-row-wide .bf-row-ctl{max-width:100%;width:100%;justify-content:flex-start}
      .bf-row-label{font-size:13px;line-height:20px;font-weight:500;color:var(--label-primary)}
      .bf-row-help{font-size:12px;line-height:18px;color:var(--label-secondary);margin-top:2px}
      .bf-row-ctl{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;
        flex-wrap:wrap;max-width:60%}
      .bf-row-ctl .bf-select{min-width:180px}
      .bf-row-ctl .bf-input{width:280px;max-width:100%}
      .bf-row-ctl.wide{max-width:100%;width:100%;justify-content:flex-start}
      .bf-savebar{position:sticky;bottom:12px;z-index:5;display:flex;align-items:center;gap:10px;flex-wrap:wrap;
        padding:10px 14px;border:.5px solid var(--border-l2);border-radius:12px;background:var(--bg-layer-1);
        box-shadow:var(--dsw-elevation-soft,0 2px 8px rgba(0,0,0,.08))}
      .bf-savebar .bf-note{margin-right:auto}
      .bf-savebar-dot{width:6px;height:6px;border-radius:50%;corner-shape:round;background:var(--warn);flex:0 0 6px}
      .bf-tag-add{height:28px;padding:0 10px;border:.5px solid var(--border-l4);border-radius:8px;
        background:transparent;color:var(--label-tertiary);font-size:12px;line-height:18px;cursor:pointer}
      .bf-tag-add:hover{color:var(--label-primary);border-color:var(--label-caption)}
      .bf-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .bf-tag.bf-tag-edit{padding-right:2px}
      .bf-tag.bf-tag-edit button{border:0;background:transparent;color:var(--label-caption);cursor:pointer;
        padding:0 4px;border-radius:4px;font-size:11px;line-height:14px}
      .bf-tag.bf-tag-edit button:hover{color:var(--label-primary);background:var(--interactive-hover)}

      /* ── 日志 ── */
      .bf-log-events{display:flex;flex-direction:column}
      .bf-log-line{display:flex;gap:10px;padding:6px 0;font-size:12px;line-height:18px;
        border-bottom:.5px solid var(--border-l2)}
      .bf-log-line:last-child{border-bottom:0}
      .bf-log-t{font-family:var(--font-code);font-size:11px;line-height:18px;color:var(--label-caption);
        flex:0 0 74px;font-variant-numeric:tabular-nums}
      .bf-log-msg{color:var(--label-secondary);min-width:0;word-break:break-word}
      .bf-log-line.err .bf-log-msg{color:var(--error)}
      pre.bf-raw{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--bg-module-platform);
        border:.5px solid var(--border-l1);font-family:var(--font-code);font-size:11px;line-height:18px;
        color:var(--label-secondary);max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word}

      /* ── 诊断 ── */
      .bf-diag{display:flex;flex-direction:column;gap:8px;margin-top:6px}
      .bf-diag-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .bf-diag-summary{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;
        line-height:18px;color:var(--label-secondary)}
      .bf-diag-stat{font-family:var(--font-code);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
      .bf-diag-stat.pass{color:var(--success)}
      .bf-diag-stat.warn{color:var(--warn)}
      .bf-diag-stat.fail{color:var(--error)}
      .bf-diag-head .bf-btn{margin-left:auto}
      .bf-diag-list{display:flex;flex-direction:column;border-top:.5px solid var(--border-l2)}
      .bf-diag-item{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:.5px solid var(--border-l2)}
      .bf-diag-item:last-child{border-bottom:0}
      .bf-diag-icon{flex:0 0 14px;text-align:center;font-family:var(--font-code);font-size:12px;line-height:18px;
        font-weight:600}
      .bf-diag-item.pass .bf-diag-icon{color:var(--success)}
      .bf-diag-item.warn .bf-diag-icon{color:var(--warn)}
      .bf-diag-item.fail .bf-diag-icon{color:var(--error)}
      .bf-diag-label{flex:0 0 118px;font-size:12px;line-height:18px;color:var(--label-primary)}
      .bf-diag-body{flex:1;min-width:0}
      .bf-diag-detail{font-size:12px;line-height:18px;color:var(--label-secondary);word-break:break-word}
      .bf-diag-fix{font-size:11px;line-height:14px;color:var(--label-caption);margin-top:2px}
      .bf-diag-empty{font-size:12px;line-height:18px;color:var(--label-tertiary)}

      /* ── 存在感 / 健康 ── */
      .bf-spark{display:flex;gap:8px;padding-top:4px}
      .bf-spark-col{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:flex-end}
      .bf-spark-bars{height:48px;display:flex;align-items:flex-end;gap:2px}
      .bf-spark-b{flex:1;border-radius:4px 4px 0 0;background:var(--business);opacity:.85;min-height:2px}
      .bf-spark-l{font-size:11px;line-height:14px;color:var(--label-caption);text-align:center;margin-top:4px;
        white-space:nowrap;overflow:hidden}
      .bf-kv-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px;
        padding:6px 0;border-bottom:.5px solid var(--border-l2)}
      .bf-kv-row:last-child{border-bottom:0}
      .bf-kv-k{font-size:13px;line-height:20px;color:var(--label-tertiary);flex:0 0 auto;white-space:nowrap}
      .bf-kv-v{font-size:13px;line-height:20px;color:var(--label-primary);text-align:right;min-width:0;
        overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
      .bf-health{display:flex;flex-direction:column}

      /* ── 空态 / 横幅 ── */
      .bf-empty{border:0;border-radius:0;padding:24px 0;background:transparent;text-align:center;
        color:var(--label-tertiary);font-size:13px;line-height:20px}
      .bf-empty-title{margin:0 0 4px;font-size:14px;line-height:22px;font-weight:500;color:var(--label-secondary)}
      .bf-empty-actions{display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap}
      .bf-banner{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:12px;border:0;
        font-size:12px;line-height:18px;color:var(--label-secondary)}
      .bf-banner.warn{background:var(--warn-3)}
      .bf-banner.error{background:var(--err-0);border-radius:16px;padding:8px 10px;color:var(--error)}
      .bf-banner .bf-sp{flex:1}
      .bf-inline-err{font-size:12px;line-height:18px;color:var(--error)}

      /* ── 弹窗 ── */
      .bf-modal-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
        padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px;
        background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42));backdrop-filter:var(--dsw-mask-blur,none)}
      .bf-modal{width:min(380px,100%);max-height:100%;overflow:auto;border:0;text-align:left;
        border-radius:28px;background:var(--bg-layer-2);
        box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.22));padding:0 0 24px}
      .bf-modal-title{padding:22px 14px 12px 24px;font-size:16px;line-height:24px;font-weight:500;
        color:var(--label-primary)}
      .bf-modal img{width:220px;height:220px;margin:0 24px;border:0;border-radius:16px;
        background:var(--bg-layer-3);display:block}
      .bf-modal-state{padding:0 24px;margin:16px 0 0;font-size:14px;line-height:22px;color:var(--label-primary)}
      .bf-modal-actions{display:flex;gap:8px;justify-content:flex-end;padding:0 24px;margin-top:20px}
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

    const apiGet = (path) => fetch(`${API}${path}`).then((r) => r.json())
    const apiPost = (path, body) => fetch(`${API}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    }).then((r) => r.json())
    const apiPut = (path, body) => fetch(`${API}${path}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}',
    }).then((r) => r.json())

    /* ── W4-4：GET 30 秒复用（同一 key 30s 内不重复打；页面隐藏时暂停发新请求） ──
     * 人设页首屏要打 /persona、/persona/preview、/persona/expression、/persona/lore
     * 以及新增的 /persona/checkup、/persona/history 六个请求，而这六份数据都是分钟级变化。
     * 用一个极小的 TTL Map 兜住「同一 key 30s 内只打一次」：
     *   - 命中且未过期：直接返回缓存里的 promise（并发调用也只会打一次）；
     *   - 已过期但页面隐藏：返回旧 promise，**不发**新请求（人看不见时不占网络）；
     *   - 页面隐藏且没有缓存：返回 null（usePoll 保留「正在连接…」空态）；
     *   - 失败不缓存：删掉条目，下一次轮询自然重试。
     * 手动刷新（刷新人设数据）会先 resetGetCache() 绕过 TTL，点一下就能拿到最新值。
     */
    const GET_TTL_MS = 30000
    const GET_CACHE = new Map()
    const resetGetCache = () => GET_CACHE.clear()
    const isPageHidden = () => typeof document !== 'undefined' && document.hidden === true
    const cachedGet = (path, ttlMs = GET_TTL_MS) => {
      if (typeof path !== 'string' || !path) return Promise.resolve(null)
      const hit = GET_CACHE.get(path)
      const fresh = !!hit && (Date.now() - hit.at) < ttlMs
      if (fresh || isPageHidden()) return hit ? hit.promise : Promise.resolve(null)
      const promise = apiGet(path).then(
        (data) => data,
        (e) => {
          if (GET_CACHE.get(path)?.promise === promise) GET_CACHE.delete(path)
          throw e
        },
      )
      GET_CACHE.set(path, { at: Date.now(), promise })
      return promise
    }

    /* ─── 格式化 ─── */
    const fmtDur = (ms) => {
      const s = Math.round((Number(ms) || 0) / 1000)
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
    }
    const fmtNum = (n) => (Number(n) >= 10000 ? `${(Number(n) / 10000).toFixed(1)} 万` : String(Number(n) || 0))
    const fmtClock = (sec) => {
      const s = Math.max(0, Math.round(Number(sec) || 0))
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    const hhmm = (iso) => {
      try { return new Date(iso).toTimeString().slice(0, 5) } catch { return '' }
    }
    const hhmmss = (iso) => {
      try { return new Date(iso).toTimeString().slice(0, 8) } catch { return '' }
    }
    const dayKeyOf = (d) => {
      const x = d instanceof Date ? d : new Date(d == null ? Date.now() : d)
      if (Number.isNaN(x.getTime())) return ''
      return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0')
    }
    const agoText = (ageMs) => {
      const s = Math.max(0, Math.round((Number(ageMs) || 0) / 1000))
      if (s < 2) return '刚刚'
      if (s < 60) return `${s} 秒前`
      return `${Math.round(s / 60)} 分钟前`
    }

    /**
     * 通用轮询 hook（带 enabled 门控）：页签不可见时整套不启动。
     * 返回 { data, error, at, refresh }；at = 最后一次成功刷新时刻（ms）。
     */
    function usePoll(load, intervalMs, enabled = true) {
      const [state, setState] = React.useState({ data: null, error: '', at: 0 })
      const tick = React.useCallback(async () => {
        try {
          const v = await load()
          setState({ data: v, error: '', at: Date.now() })
        } catch (e) {
          setState((p) => ({ ...p, error: String(e?.message ?? e) }))
        }
      }, [load])
      React.useEffect(() => {
        if (!enabled) return undefined
        let alive = true
        let timer = null
        const run = async () => { if (alive) await tick() }
        const start = () => {
          run()
          if (timer) clearInterval(timer)
          timer = setInterval(run, intervalMs)
        }
        const onVis = () => {
          if (typeof document === 'undefined') return
          if (document.hidden) { if (timer) clearInterval(timer); timer = null }
          else start()
        }
        start()
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', onVis)
        }
        return () => {
          alive = false
          if (timer) clearInterval(timer)
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', onVis)
          }
        }
      }, [tick, intervalMs, enabled])
      return { data: state.data, error: state.error, at: state.at, refresh: tick }
    }

    /**
     * useRealtime —— 单一实时信封协调器（design §2.3）。
     *  - 主通道 SSE `/stream`：hello / overview / tick，seq 单调守卫；
     *  - 断流降级轮询 `/overview`（运行中 2s / 空闲 10s），AbortController + 请求序号防竞态；
     *  - 刷新触发：挂载 / visibilitychange 可见 / window.focus / 帧到达 / 显式 refresh()；
     *  - 暴露 { data, mode, ageMs, error, refresh }。
     *  - 轮询失败**不静默**：error 置位并显形（旧值保留但会挂黄/红徽标）。
     *  - opts.sse === false 时只轮询。
     */
    function useRealtime(initial, opts) {
      const useSse = !opts || opts.sse !== false
      const initSeq = Number(initial && initial.seq) || 0
      const [state, setState] = React.useState({
        data: initial || null,
        seq: initSeq,
        dataUpdatedAt: (initial && (initial.dataUpdatedAt || initial.serverTime)) || null,
        seenAt: initial ? Date.now() : 0,
        mode: useSse && typeof EventSource !== 'undefined' ? 'sse' : 'poll',
        error: '',
      })
      const [now, setNow] = React.useState(() => Date.now())
      const ref = React.useRef(null)
      if (ref.current === null) {
        ref.current = {
          seq: initSeq, seenAt: 0, running: !!(initial && initial.round && initial.round.running),
          alive: true, mode: useSse && typeof EventSource !== 'undefined' ? 'sse' : 'poll',
          es: null, timer: null, ac: null, reqId: 0,
          // ⭐ 是否已拿到过真实信封：首帧不做 seq 单调比较的前提（见 accept 注释）
          hasData: !!(initial && Object.keys(initial).length),
        }
      }

      // 走时：只为刷新「N 秒前」文案，不触发网络。
      React.useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 3000)
        return () => clearInterval(t)
      }, [])

      React.useEffect(() => {
        const r = ref.current
        r.alive = true
        const canSse = useSse && typeof EventSource !== 'undefined'

        const stopTimer = () => { if (r.timer) { clearTimeout(r.timer); r.timer = null } }
        const closeEs = () => { if (r.es) { try { r.es.close() } catch { /* 已断 */ } r.es = null } }

        const accept = (payload, modeHint) => {
          if (!payload || typeof payload !== 'object') return false
          const seq = Number(payload.seq)
          if (Number.isFinite(seq)) {
            // ⭐ 首帧不做单调比较：/stream 先发 hello(seq=hub.seq)，而首帧 overview
            //    在 hub 已有数据且不脏时用同一个 seq（view() 不自增），严格单调会把
            //    唯一一帧丢掉 —— 页面于是永远停在空数据态（红条/未找到都由此而来）。
            if (r.hasData && seq <= r.seq) return false
            r.seq = seq
          }
          r.hasData = true
          r.running = !!(payload.round && payload.round.running)
          r.seenAt = Date.now()
          setState((p) => ({
            data: payload,
            seq: Number.isFinite(seq) ? seq : p.seq,
            dataUpdatedAt: payload.dataUpdatedAt || payload.serverTime || p.dataUpdatedAt,
            seenAt: r.seenAt,
            mode: modeHint || p.mode,
            error: '',
          }))
          return true
        }

        /** tick 帧：只补运行中会变的三个字段，不做整包替换 */
        const applyTick = (frame) => {
          const seq = Number(frame && frame.seq)
          // ⭐ tick 帧的 seq 就是 hub 当前值（不推进），与 r.seq 相等是常态：
          //    这里只丢「比已知信封更旧」的 tick，否则运行中的秒表/阶段永远不刷新。
          if (Number.isFinite(seq) && r.hasData && seq < r.seq) return
          if (Number.isFinite(seq)) r.seq = Math.max(r.seq, seq)
          r.seenAt = Date.now()
          setState((p) => {
            if (!p.data) return p
            const d = p.data
            const rnd = frame.round || {}
            const nextRound = {
              ...d.round,
              elapsedMs: rnd.elapsedMs != null ? rnd.elapsedMs : d.round?.elapsedMs,
              phase: rnd.phase || d.round?.phase,
              stats: rnd.stats || d.round?.stats,
            }
            const nextQuota = {
              ...d.quota,
              perRound: (frame.quota && frame.quota.perRound) || d.quota?.perRound,
            }
            if (nextRound.running == null && d.round?.running != null) nextRound.running = d.round.running
            return { ...p, data: { ...d, round: nextRound, quota: nextQuota }, seq: r.seq, seenAt: r.seenAt, error: '' }
          })
        }

        /* ── 单次请求（轮询与手动 refresh 共用） ── */
        const fetchOnce = async () => {
          if (!r.alive) return
          const id = ++r.reqId
          try { if (r.ac) r.ac.abort() } catch { /* 忽略 */ }
          const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
          r.ac = ac
          try {
            const res = await fetch(`${API}/overview`, ac ? { signal: ac.signal } : undefined)
            const payload = await res.json()
            if (!r.alive || id !== r.reqId) return          // ← 晚到的旧响应丢弃
            if (!payload || payload.ok === false) {
              setState((p) => ({ ...p, error: (payload && payload.error) || '概览接口返回异常' }))
              return
            }
            accept(payload, 'poll')
          } catch (e) {
            if (e && (e.name === 'AbortError' || e.code === 20)) return
            if (!r.alive || id !== r.reqId) return
            setState((p) => ({ ...p, error: String((e && e.message) || e) }))
          }
        }

        const schedule = () => {
          stopTimer()
          if (!r.alive || r.mode !== 'poll') return
          if (typeof document !== 'undefined' && document.hidden) return
          r.timer = setTimeout(async () => { await fetchOnce(); schedule() }, r.running ? 2000 : 10000)
        }

        const startPoll = () => {
          r.mode = 'poll'
          closeEs()
          stopTimer()
          setState((p) => ({ ...p, mode: 'poll' }))
          fetchOnce().then(schedule)
        }

        const startSse = () => {
          if (!canSse) { startPoll(); return }
          let es = null
          try { es = new EventSource(`${API}/stream`) } catch { startPoll(); return }
          if (!es) { startPoll(); return }
          r.es = es
          r.mode = 'sse'
          setState((p) => ({ ...p, mode: 'sse' }))
          es.onmessage = (ev) => {
            if (!r.alive) return
            let msg = null
            try { msg = JSON.parse(ev && ev.data) } catch { return }
            if (!msg || typeof msg !== 'object') return
            if (msg.type === 'overview' && msg.data) {
              const merged = { ...msg.data }
              if (msg.seq != null) merged.seq = msg.seq
              if (msg.dataUpdatedAt) merged.dataUpdatedAt = msg.dataUpdatedAt
              accept(merged, 'sse')
            } else if (msg.type === 'hello') {
              const seq = Number(msg.seq)
              if (Number.isFinite(seq) && seq > r.seq) r.seq = seq
              r.seenAt = Date.now()
              setState((p) => ({ ...p, seenAt: r.seenAt, mode: 'sse' }))
            } else if (msg.type === 'tick') {
              applyTick(msg)
            }
          }
          es.onerror = () => {
            if (!r.alive) return
            startPoll()                      // 断流 → 关流 + 降级轮询（不静默）
          }
        }

        const onVis = () => {
          if (typeof document === 'undefined') return
          if (!document.hidden) fetchOnce()
        }
        const onFocus = () => fetchOnce()
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', onVis)
        }
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('focus', onFocus)
        }

        startSse()

        return () => {
          r.alive = false
          stopTimer()
          closeEs()
          try { if (r.ac) r.ac.abort() } catch { /* 忽略 */ }
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', onVis)
          }
          if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('focus', onFocus)
          }
        }
      }, [useSse])

      const refresh = React.useCallback(() => {
        const r = ref.current
        if (!r || !r.alive) return
        const id = ++r.reqId
        try { if (r.ac) r.ac.abort() } catch { /* 忽略 */ }
        const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
        r.ac = ac
        fetch(`${API}/overview`, ac ? { signal: ac.signal } : undefined)
          .then((res) => res.json())
          .then((payload) => {
            if (!r.alive || id !== r.reqId) return
            if (!payload || payload.ok === false) {
              setState((p) => ({ ...p, error: (payload && payload.error) || '概览接口返回异常' }))
              return
            }
            const seq = Number(payload.seq)
            // ⭐ 与 accept 同口径：已经有数据才严格单调，否则「点刷新也救不回来」
            if (Number.isFinite(seq) && r.hasData && seq <= r.seq) return
            if (Number.isFinite(seq)) r.seq = seq
            r.hasData = true
            r.running = !!(payload.round && payload.round.running)
            r.seenAt = Date.now()
            setState((p) => ({
              data: payload, seq: Number.isFinite(seq) ? seq : p.seq,
              dataUpdatedAt: payload.dataUpdatedAt || payload.serverTime || p.dataUpdatedAt,
              seenAt: r.seenAt, mode: p.mode, error: '',
            }))
          })
          .catch((e) => {
            if (e && (e.name === 'AbortError' || e.code === 20)) return
            if (!r.alive || id !== r.reqId) return
            setState((p) => ({ ...p, error: String((e && e.message) || e) }))
          })
      }, [])

      const ageMs = state.seenAt ? Math.max(0, now - state.seenAt) : 0
      return { data: state.data, mode: state.mode, ageMs, error: state.error, refresh }
    }

    /* ─── 实时事件流（/live/stream，SSE 优先，降级轮询）—— 给概览「运行详情」用 ─── */
    const LIVE_EMPTY = {
      running: false, roundId: null, startedAt: null, elapsedMs: 0, why: '',
      phase: { key: 'think', label: '思考' },
      stats: { events: 0, tools: {}, actions: { like: 0, comment: 0, dynamic: 0, reply: 0, proactive: 0, scan: 0 }, errors: 0 },
      quota: null, events: [], lastCode: null, lastDurationMs: null, lastRunAt: null,
    }
    const hasEventSource = () => typeof EventSource !== 'undefined'
    const pageHidden = () => typeof document !== 'undefined' && document.hidden === true

    function useLive(enabled = true) {
      const sse = hasEventSource()
      const [state, setState] = React.useState({ data: LIVE_EMPTY, mode: sse ? 'sse' : 'poll', error: '' })
      const refreshRef = React.useRef(() => {})
      React.useEffect(() => {
        if (!enabled) return undefined
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
          running: !!meta.running, roundId: meta.roundId ?? null, startedAt: meta.startedAt ?? null,
          elapsedMs: Number(meta.elapsedMs) || 0, why: meta.why || '',
          phase: meta.phase || { key: 'think', label: '思考' },
          stats: meta.stats || LIVE_EMPTY.stats, quota: meta.quota || null,
          lastCode: meta.lastCode ?? null, lastDurationMs: meta.lastDurationMs ?? null,
          lastRunAt: meta.lastRunAt ?? null, events: buf.slice(),
        })
        const publish = (patch) => { if (alive) setState((prev) => ({ ...prev, ...patch })) }
        const emit = (patch) => publish({ data: build(), ...(patch || {}) })

        const mergeFrames = (frames) => {
          if (!Array.isArray(frames) || !frames.length) return
          const seen = new Set()
          for (const e of buf) if (e && e.seq != null) seen.add(e.seq)
          let added = 0
          for (const f of frames) {
            if (!f || typeof f !== 'object') continue
            if (f.seq != null && seen.has(f.seq)) continue
            if (f.seq != null) seen.add(f.seq)
            buf.push(f); added++
          }
          if (!added) return
          buf.sort((a, b) => (Number(a?.seq) || 0) - (Number(b?.seq) || 0))
          if (buf.length > LIVE_MAX_EVENTS) buf = buf.slice(-LIVE_MAX_EVENTS)
        }
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
        const stopTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
        const schedulePoll = (delay) => {
          if (!alive || mode !== 'poll' || timer) return
          timer = setTimeout(() => { timer = null; pollOnce() }, delay)
        }
        const pollOnce = async () => {
          if (!alive || mode !== 'poll' || busy) return
          if (pageHidden()) return
          busy = true
          try {
            const raw = await apiGet(`/live?after=${cursor}`)
            if (!alive) return
            if (raw && raw.ok) { applyMeta(raw); emit({ error: '' }) }
            else publish({ error: raw?.error || '实时数据不可用' })
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
          try { es = new EventSource(`${API}/live/stream`) } catch { es = null }
          if (!es) { startPoll(); return }
          mode = 'sse'
          publish({ mode: 'sse' })
          es.onmessage = (ev) => {
            if (!alive) return
            let msg = null
            try { msg = JSON.parse(ev?.data) } catch { return }
            if (!msg || typeof msg !== 'object') return
            if (msg.type === 'snapshot' && msg.snapshot) { applyMeta(msg.snapshot); emit({ error: '' }) }
            else if (msg.type === 'event' && msg.frame) {
              mergeFrames([msg.frame])
              if (msg.frame.seq != null) cursor = Math.max(cursor, msg.frame.seq)
              if (msg.frame.kind === 'tool') running = true
              emit({ error: '' })
            }
          }
          es.onerror = () => {
            if (!alive) return
            try { es.close?.() } catch { /* 已断开 */ }
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
      }, [sse, enabled])
      const refresh = React.useCallback(() => { try { refreshRef.current?.() } catch { /* 忽略 */ } }, [])
      return { data: state.data, mode: state.mode, error: state.error, refresh }
    }

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

    const usePersona = (enabled = true) => usePoll(React.useCallback(() => cachedGet('/persona'), []), 30000, enabled)
    const useModels = (enabled = true) => usePoll(React.useCallback(() => apiGet('/models'), []), 60000, enabled)
    const useActivity = (running, enabled = true) =>
      usePoll(React.useCallback(() => apiGet('/activity'), []), running ? 3000 : 15000, enabled)

    function useDiagnose() {
      const [report, setReport] = React.useState(null)
      const [error, setError] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const run = React.useCallback(async () => {
        setLoading(true); setError('')
        try {
          const r = await apiPost('/diagnose')
          if (r && Array.isArray(r.items)) setReport(r)
          else { setReport(null); setError(r?.error || '返回格式不对') }
        } catch (e) { setError(String(e?.message ?? e)) } finally { setLoading(false) }
      }, [])
      return { report, loading, error, run }
    }

    /* ═══════════════════════ §3 基础组件 ═══════════════════════ */

    const Btn = ({ variant = 'default', small, children, ...rest }) =>
      h('button', {
        className: `bf-btn${variant === 'primary' ? ' primary' : variant === 'ghost' ? ' ghost' : variant === 'danger' ? ' danger' : ''}${small ? ' small' : ''}`,
        ...rest,
      }, children)

    const IconBtn = ({ label, children, ...rest }) =>
      h('button', { className: 'bf-iconbtn', 'aria-label': label, title: label, ...rest }, children)

    const Switch = ({ checked, onChange, label, disabled }) =>
      h('button', {
        className: 'bf-switch', role: 'switch', 'aria-checked': String(!!checked),
        'aria-label': label, disabled: !!disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
      })

    const Num = ({ value, onChange, min = 0, max = 999, label }) =>
      h('div', { className: 'bf-num' },
        h('button', { onClick: () => onChange(Math.max(min, Number(value) - 1)), 'aria-label': label ? label + ' 减少' : '减少' }, '−'),
        h('input', { value: Number(value) || 0, readOnly: true, 'aria-label': label || '数值' }),
        h('button', { onClick: () => onChange(Math.min(max, Number(value) + 1)), 'aria-label': label ? label + ' 增加' : '增加' }, '+'),
      )

    const Tag = ({ kind = '', children }) => h('span', { className: `bf-tag ${kind}`.trimEnd() }, children)
    const GradeBadge = ({ grade }) => h('span', { className: `bf-grade ${grade}` }, GRADE_TEXT[grade] || grade)
    const Pill = ({ tone = '', children }) =>
      h('span', { className: 'bf-pill' },
        tone ? h('i', { className: `bf-dot ${tone}`, 'aria-hidden': 'true' }) : null, children)
    const Card = ({ children, p0, className = '', style }) =>
      h('div', { className: `bf-card${p0 ? ' bf-card-p0' : ''} ${className}`.trimEnd(), style }, children)
    const SecCard = ({ children, className = '' }) => h('div', { className: `bf-scard ${className}`.trimEnd() }, children)

    const Sp = () => h('span', { className: 'bf-sp' })

    /* ── W7-2 发言门控：概览卡与人设页共用同一套归一化 ──
     * 契约 = GET /overview → round.speakGate：null | {mode,decision,reason,suggestedMaxComments,features}。
     * 三条纪律：① 数据可能整个没有（后端未接线 / 还没跑过带门控的轮）⇒ 返回 null，调用方渲染「暂无数据」；
     *          ② 字段半截 / 类型不对 ⇒ 逐个兜底，绝不抛错、绝不渲染 undefined；
     *          ③ mode 缺失或无法识别时按 observe 展示并**明确标注**，绝不谎称「已经在强制拦截」。 */
    const SPEAK_GATE_MODES = {
      off: { text: '已关闭', kind: 'like', note: '门控已关闭：本轮不记录节奏。' },
      observe: { text: '观察中 · 不拦', kind: 'warn', note: '观察档：只记录不强制，别当成已经在拦。' },
      enforce: { text: '强制', kind: 'cmt', note: '强制档：会按门控收紧本轮评论上限（配额仍是硬上限）。' },
    }
    const SPEAK_GATE_DECISIONS = {
      normal: { text: '正常', kind: 'rep' },
      throttle: { text: '收紧', kind: 'warn' },
      forced: { text: '放行', kind: 'cmt' },
    }
    const speakGateOf = (raw) => {
      if (!raw || typeof raw !== 'object') return null
      const rawMode = String(raw.mode || '')
      const rawDecision = String(raw.decision || '')
      // mode 缺失/无法识别 → 按 observe 展示（宁可保守说「不拦」，也不谎称在强制拦截）
      const mode = SPEAK_GATE_MODES[rawMode] ? rawMode : 'observe'
      const decision = SPEAK_GATE_DECISIONS[rawDecision] ? rawDecision : 'normal'
      const f = raw.features && typeof raw.features === 'object' ? raw.features : {}
      const intOf = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null)
      const recentWindow = intOf(f.recentWindow)
      const recentSpoke = intOf(f.recentSpoke)
      const gap = f.gapMinutes == null ? null : intOf(f.gapMinutes)
      const feat = []
      if (recentWindow != null && recentWindow > 0) {
        feat.push('近 ' + recentWindow + ' 个动作说了 ' + (recentSpoke == null ? 0 : recentSpoke) + ' 次')
      }
      if (gap == null) {
        if (recentWindow != null && recentWindow > 0) feat.push('还没发过言')
      } else feat.push('距上次 ' + gap + ' 分钟')
      return {
        mode, decision,
        modeText: SPEAK_GATE_MODES[mode].text,
        modeKind: SPEAK_GATE_MODES[mode].kind,
        modeNote: SPEAK_GATE_MODES[mode].note,
        modeKnown: !!SPEAK_GATE_MODES[rawMode],
        decisionText: SPEAK_GATE_DECISIONS[decision].text,
        decisionKind: SPEAK_GATE_DECISIONS[decision].kind,
        enforced: raw.enforced === true,
        reason: typeof raw.reason === 'string' ? raw.reason : '',
        suggestedMaxComments: intOf(raw.suggestedMaxComments) || 0,
        featText: feat.join(' · '),
      }
    }
    /** 门控两枚徽标（模式 + 判定）：概览卡与人设页共用，口径只写一次 */
    const SpeakGateTags = ({ gate }) => (gate
      ? h(React.Fragment, null,
          h(Tag, { kind: gate.modeKind }, gate.modeText),
          h(Tag, { kind: gate.decisionKind }, gate.decisionText))
      : null)

    /** 页头：唯一 h1 + 一句话 intro + 右侧 ≤2 个主操作 */
    function PageHeader({ title, intro, children }) {
      return h('header', { className: 'bf-page-head' },
        h('div', null,
          h('h1', { className: 'bf-page-title' }, title),
          intro ? h('p', { className: 'bf-page-intro' }, intro) : null,
        ),
        h('div', { className: 'bf-page-toolbar' }, children),
      )
    }

    /** 数据新鲜度徽标：>15s 黄、>60s 红，error 非空也显形（design §2.3） */
    function Freshness({ ageMs, mode, error, hasData }) {
      const age = Number(ageMs) || 0
      // ⭐ 一帧业务数据都没到过：说「正在连接」，不能说「数据 刚刚」（那是谎报新鲜度）
      if (!hasData && !error) {
        return h('span', { className: 'bf-fresh', 'data-freshness': '' },
          h('i', { className: 'bf-dot warn', 'aria-hidden': 'true' }),
          '正在连接…',
          mode === 'poll' ? h('span', { className: 'bf-note' }, ' · 轮询') : null,
        )
      }
      const tone = error ? 'err' : age > 60000 ? 'err' : age > 15000 ? 'warn' : ''
      const text = error
        ? '数据异常·正在重连'
        : age > 60000 ? `数据 ${Math.round(age / 60000)}m 前·正在重连`
          : age > 15000 ? `数据 ${Math.round(age / 1000)}s 前`
            : `数据 ${agoText(age)}`
      return h('span', { className: `bf-fresh ${tone}`.trimEnd(), 'data-freshness': '' },
        h('i', { className: `bf-dot ${tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : 'ok'}`, 'aria-hidden': 'true' }),
        text,
        mode === 'poll' ? h('span', { className: 'bf-note' }, ' · 轮询') : null,
        error ? h('span', { className: 'bf-note', title: error }, ' · ' + String(error).slice(0, 40)) : null,
      )
    }

    function Select({ value, onChange, options = [], disabled, label, width }) {
      return h('select', {
        className: 'bf-select', value: value ?? '', disabled: !!disabled, 'aria-label': label,
        style: width ? { width } : undefined,
        onChange: (e) => onChange(e.target.value),
      }, options.map(([v, text]) => h('option', { key: v, value: v }, text)))
    }

    function SearchInput({ value, onChange, placeholder, ariaLabel }) {
      return h('div', { className: 'bf-searchwrap' },
        h('span', { className: 'bf-search-icon', 'aria-hidden': 'true' }, '⌕'),
        h('input', {
          className: 'bf-search', value, placeholder, 'aria-label': ariaLabel || placeholder,
          onChange: (e) => onChange(e.target.value),
        }),
      )
    }

    /** 一键诊断面板 */
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
          onRun ? h(Btn, { small: true, variant: compact ? 'primary' : 'default', disabled: !!loading, onClick: onRun },
            loading ? '诊断中…' : '一键诊断') : null,
        ),
        error ? h('div', { className: 'bf-banner error' }, h('span', null, `诊断失败：${error}`)) : null,
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

    /** 设置卡（一档材质，里面是行式字段） */
    const Group = ({ title, note, children }) =>
      h(SecCard, null,
        h('h3', { className: 'bf-group-title' }, title),
        note ? h('div', { className: 'bf-note', style: { marginBottom: 4 } }, note) : null,
        children)

    /** 行式字段：label+说明 左，控件 右（行高 60）；wide = 控件独占一行（纵向堆叠） */
    const Row = ({ label, help, children, wide }) =>
      h('div', { className: `bf-row${wide ? ' bf-row-wide' : ''}` },
        h('div', { className: 'bf-row-main' },
          h('div', { className: 'bf-row-label' }, label),
          help ? h('div', { className: 'bf-row-help' }, help) : null,
        ),
        h('div', { className: `bf-row-ctl${wide ? ' wide' : ''}` }, children),
      )

    function ChipsInput({ values, onChange, placeholder }) {
      const [draft, setDraft] = React.useState('')
      const add = () => {
        const v = draft.trim()
        if (!v) return
        if (!values.includes(v)) onChange([...values, v])
        setDraft('')
      }
      return h('div', { className: 'bf-chips' },
        values.map((v) => h('span', { className: 'bf-tag bf-tag-edit', key: v }, v,
          h('button', { 'aria-label': `删除 ${v}`, onClick: () => onChange(values.filter((x) => x !== v)) }, '×'),
        )),
        h('input', {
          className: 'bf-tag-add', value: draft, placeholder: placeholder || '+ 添加',
          'aria-label': placeholder || '添加一项', style: { width: 96 },
          onChange: (e) => setDraft(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') add() },
          onBlur: add,
        }),
      )
    }

    function EmptyState({ title, text, children }) {
      return h('div', { className: 'bf-empty' },
        title ? h('div', { className: 'bf-empty-title' }, title) : null,
        text ? h('div', null, text) : null,
        children ? h('div', { className: 'bf-empty-actions' }, children) : null,
      )
    }

    /** 异常横幅：未登录 / 无 CLI / 上一轮退出码 ≠ 0（只在真有问题时出现） */
    function Banner({ health, account, round, onLogin }) {
      const items = []
      if (account && account.loggedIn === false) {
        items.push({ tone: 'warn', text: '未登录，点赞/评论/动态都会失败。', action: '扫码登录', onAction: onLogin })
      }
      // ⭐ 只有「确实拿到了健康信息」才判红：health 对象缺失（首帧未到/信封为空）
      //    不等于「探测失败」，否则页面一打开就假报「找不到 dsh CLI」。
      if (health && health.cli !== undefined && health.cli !== null && !health.cli) {
        items.push({ tone: 'error', text: '找不到 dsh CLI，值班轮跑不起来 —— 到「设置 → 运行环境」填写 dshBin。' })
      }
      if (round && round.lastCode != null && round.lastCode !== 0) {
        items.push({ tone: 'error', text: `上一轮退出码 ${round.lastCode}（${round.lastWhy || '未知来源'}）—— 到「设置 → 运行环境」看宿主日志尾部。` })
      }
      if (!items.length) return null
      return h('div', null, items.map((it, i) =>
        h('div', { className: `bf-banner ${it.tone}`, key: i, style: i ? { marginTop: 8 } : undefined },
          h('span', null, it.text),
          h(Sp),
          it.action ? h(Btn, { small: true, variant: 'ghost', onClick: it.onAction }, it.action) : null,
        )))
    }

    /** 扫码登录抽屉：Escape 关闭 + 初焦点 + 焦点陷阱 + 背景滚动锁 */
    function LoginModal({ onClose, onLoggedIn }) {
      const [st, setSt] = React.useState({ qrUrl: '', qrImage: '', state: '生成二维码…' })
      const boxRef = React.useRef(null)
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
        const body = typeof document !== 'undefined' ? document.body : null
        const prevOverflow = body && body.style ? body.style.overflow : undefined
        if (body && body.style) body.style.overflow = 'hidden'
        try { boxRef.current?.focus?.() } catch { /* 忽略 */ }
        const onKey = (e) => {
          if (e.key === 'Escape') { onClose?.(); return }
          if (e.key !== 'Tab' || !boxRef.current || !document.querySelectorAll) return
          const nodes = boxRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
          if (!nodes.length) return
          const first = nodes[0]
          const last = nodes[nodes.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          if (body && body.style) body.style.overflow = prevOverflow || ''
        }
      }, [onClose])
      return h('div', {
        className: 'bf-modal-mask',
        onClick: (e) => { if (e.target === e.currentTarget) onClose?.() },
      },
        h('div', {
          className: 'bf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '扫码登录B站',
          tabIndex: -1, ref: boxRef,
        },
          h('div', { className: 'bf-modal-title' }, '扫码登录小号'),
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

    /* ═══════════════════════ §4 活动 ═══════════════════════ */

    const ACT_VIEWS = [['life', '生命周期'], ['timeline', '时间线'], ['seen', '判重表']]
    /** 生命周期链路（v4 增加「扫描」一站） */
    const STAGES = [
      ['view', '刷到'], ['view', '看'], ['like', '赞'], ['comment', '评'],
      ['scan', '扫描'], ['reply-in', '被回复'], ['reply-out', '我回'],
    ]
    const ACT_FILTERS = [
      ['all', '全部'], ['view', '看过'], ['like', '点赞'], ['comment', '评论'],
      ['reply-scan', '接话扫描'], ['reply-in', '收到回复'], ['reply-out', '接话'],
      ['like-in', '收到点赞'], ['dynamic', '动态'],
    ]
    const EVENT_LABEL = {
      view: '看过', like: '点赞', comment: '评论', 'reply-in': '收到回复', 'reply-out': '跟进回复',
      'reply-scan': '接话扫描', 'like-in': '收到点赞', dynamic: '动态', skip: '跳过', note: '备注',
    }
    const EVENT_TAG_KIND = {
      like: 'like', comment: 'cmt', 'reply-in': 'rep', 'reply-out': 'rep', 'reply-scan': 'cmt',
      'like-in': 'rep', dynamic: 'like',
    }

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
      const n = { view: 0, like: 0, comment: 0, reply: 0, proactive: 0, scan: 0, dynamic: 0, skip: 0 }
      for (const it of (round?.items || [])) {
        const s = it.stage || {}
        if (s.viewed) n.view++
        if (s.liked) n.like++
        if (s.commented) n.comment++
        if (s.replies) n.reply += s.replies
        if (s.proactive) n.proactive += s.proactive
        if (s.scanned) n.scan++
        if (s.dynamic) n.dynamic++
        if (it.skipped) n.skip++
      }
      return n
    }
    /** 今天它说过的话（本地时区分桶，避免 UTC 漂移） */
    const todayComments = (actData, limit = 3) => {
      const today = dayKeyOf()
      return flattenActivityEvents(actData)
        .filter((e) => e.type === 'comment' && e.text && dayKeyOf(e.t) === today)
        .sort((a, b) => String(b.t || '').localeCompare(String(a.t || '')))
        .slice(0, limit)
    }

    const stampOf = (a, types) => types.map((t) => {
      const ev = (a.events || []).find((e) => e.type === t)
      return ev ? hhmm(ev.t) : ''
    })

    function StageRail({ activity }) {
      const s = activity.stage || {}
      const flags = [!!s.viewed, !!s.viewed, !!s.liked, !!s.commented, !!s.scanned, (s.replies || 0) > 0, !!s.repliedBack]
      const times = stampOf(activity, ['view', 'view', 'like', 'comment', 'reply-scan', 'reply-in', 'reply-out'])
      return h('div', { className: 'bf-stages', style: { '--n': STAGES.length } },
        STAGES.map(([, label], i) => h('div', {
          key: label, className: `bf-stage${flags[i] ? ' done' : ''}`,
        }, h('b'), h('span', null, label), h('em', null, times[i] || '—'))),
      )
    }

    function ReplyThread({ activity }) {
      const items = []
      for (const e of (activity.events || [])) {
        if (e.type === 'reply-in') items.push({ mine: false, who: e.from, t: e.t, text: e.text, rpid: e.rpid, pending: true })
        if (e.type === 'reply-out') {
          items.push({ mine: true, who: e.kind === 'proactive' ? '我（接话）' : '我', t: e.t, text: e.text, rpid: e.rpid })
        }
      }
      const answered = new Set((activity.events || []).filter((e) => e.type === 'reply-out').map((e) => e.parent))
      for (const it of items) if (it.pending && answered.has(it.rpid)) it.pending = false
      if (!items.length) return null
      return h('div', { className: 'bf-thread' },
        items.map((it, i) => h('div', { className: `bf-msg${it.mine ? ' mine' : ''}`, key: i },
          h('span', { className: 'bf-msg-name' }, it.who || '对方'),
          h('span', { className: 'bf-msg-time' }, hhmm(it.t)),
          h('span', { className: 'bf-msg-text' }, it.text),
          it.pending ? h(Tag, { kind: 'warn' }, '待跟进') : null,
        )),
      )
    }

    function ActivityCard({ item }) {
      const c = (item.events || []).find((e) => e.type === 'comment')
      const dyn = (item.events || []).find((e) => e.type === 'dynamic')
      const sc = (item.events || []).find((e) => e.type === 'reply-scan')
      const commentRpid = c?.rpid
      const replyRpid = (item.events || []).find((e) => e.type === 'reply-in')?.rpid
      const s = item.stage || {}
      const open = (s.replies || 0) > 0 || !!s.repliedBack || !!s.proactive
      return h('details', { className: 'bf-act', open },
        h('summary', null,
          h('div', { className: 'bf-sum-row' },
            h('span', { className: 'bf-bvid' }, item.bvid),
            item.grade ? h(GradeBadge, { grade: item.grade }) : null,
            s.liked ? h(Tag, { kind: 'like' }, '赞') : null,
            s.commented ? h(Tag, { kind: 'cmt' }, '评论') : null,
            s.proactive ? h(Tag, { kind: 'cmt' }, '接话 ' + s.proactive) : null,
            s.replies ? h(Tag, { kind: 'rep' }, `${s.replies} 回复`) : null,
            s.pendingReply ? h(Tag, { kind: 'warn' }, `${s.pendingReply} 未回`) : null,
            h(Sp),
            h('span', { className: 'bf-chev', 'aria-hidden': 'true' }, '›'),
          ),
          h('div', { className: 'bf-sum-title' }, item.title || item.bvid),
          h('div', { className: 'bf-sum-meta' },
            [item.author, item.views ? `${fmtNum(item.views)}播放` : '', item.duration ? fmtClock(item.duration) : '',
             item.source ? `来源 ${SRC_LABEL[item.source] || item.source}` : '']
              .filter(Boolean).join(' · ')),
        ),
        h('div', { className: 'bf-act-body' },
          h(StageRail, { activity: item }),
          sc ? h('div', { className: 'bf-note', style: { marginBottom: 8 } },
            `接话扫描：候选 ${(sc.candidates || []).length} · ${sc.decision === 'posted'
              ? '接了 rpid ' + (sc.postedRpid ?? sc.targetRpid ?? '—')
              : '不接'}${sc.reason ? '（' + sc.reason + '）' : ''}`) : null,
          c ? h('p', { className: 'bf-quote' }, h('span', { className: 'bf-who' }, `我 · ${hhmm(c.t)}`), c.text) : null,
          h(ReplyThread, { activity: item }),
          dyn ? h('div', { className: 'bf-dyn' }, `动态「${dyn.text || ''}」`) : null,
          h('div', { className: 'bf-act-foot' },
            (s.commented && !s.replies && !s.repliedBack) ? h('span', null, '还没有人回复') : null,
            h('a', {
              className: 'bf-link', href: `https://www.bilibili.com/video/${item.bvid}`,
              target: '_blank', rel: 'noreferrer',
            }, '打开视频'),
            h('span', { className: 'bf-mono' }, `评论 rpid ${commentRpid ?? '未取到'}`),
            replyRpid ? h('span', { className: 'bf-mono' }, `回复 rpid ${replyRpid}`) : null,
            item.flags?.fromReport ? h('span', { className: 'bf-note' }, '部分事件据报告回填') : null,
          ),
        ),
      )
    }

    /* ─── Markdown（自写渲染器，不用 dangerouslySetInnerHTML） ─── */
    const MD_TICK = String.fromCharCode(96)
    const MD_INLINE = new RegExp('\\*\\*([^*]+)\\*\\*|' + MD_TICK + '([^' + MD_TICK + ']+)' + MD_TICK
      + '|\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)|(https?:\\/\\/[^\\s<)]+)', 'g')

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
      const flushList = () => {
        if (list) {
          blocks.push(h('ul', { key: 'ul' + (ki++) }, list.map((x, i) => h('li', { key: i }, mdInline(x, 'li' + ki + '-' + i)))))
          list = null
        }
      }
      const flushCode = () => {
        if (code) { blocks.push(h('pre', { key: 'pre' + (ki++) }, h('code', null, code.join('\n')))); code = null }
      }
      for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.replace(/\s+$/, '')
        const fence = line.trim().slice(0, 3) === MD_TICK + MD_TICK + MD_TICK
        if (fence) { flushPara(); flushList(); if (code) flushCode(); else code = []; continue }
        if (code) { code.push(raw); continue }
        if (!line.trim()) { flushPara(); flushList(); continue }
        const hm = /^(#{1,3})\s+(.*)$/.exec(line)
        if (hm) {
          flushPara(); flushList()
          const lvl = hm[1].length
          // md 的 h1 渲染成 h2.bf-md-h1：保证「页面唯一 h1」= 页头标题
          if (lvl === 1) blocks.push(h('h2', { key: 'h' + (ki++), className: 'bf-md-h1' }, mdInline(hm[2], 'h' + ki)))
          else blocks.push(h('h' + lvl, { key: 'h' + (ki++) }, mdInline(hm[2], 'h' + ki)))
          continue
        }
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
      if (/跳过/.test(s)) out.push(h(Tag, { key: 'skip', kind: 'warn' }, '跳过'))
      else {
        if (/看过/.test(s)) out.push(h(Tag, { key: 'v', kind: 'like' }, '看过'))
        if (/赞/.test(s)) out.push(h(Tag, { key: 'l', kind: 'like' }, '赞'))
        if (/接话/.test(s)) out.push(h(Tag, { key: 'p', kind: 'cmt' }, '接话'))
        if (/评论/.test(s)) out.push(h(Tag, { key: 'c', kind: 'cmt' }, '评论'))
        if (/动态|分享/.test(s)) out.push(h(Tag, { key: 'd', kind: 'like' }, '动态'))
        if (/回复/.test(s)) out.push(h(Tag, { key: 'r', kind: 'rep' }, '回复'))
        if (!out.length) out.push(h(Tag, { key: 'x' }, s || '—'))
      }
      return h('span', { className: 'bf-chips', title: s }, out)
    }

    /** 判重表视图（原 SeenPage，改为活动页第 3 视图） */
    function SeenView({ initial }) {
      const seen = usePoll(React.useCallback(() => apiGet('/seen'), []), 15000)
      const [q, setQ] = React.useState('')
      const all = (seen.data || initial || {}).rows || []
      const notes = all.filter((r) => !r.bvid).length
      const rows = all.filter((r) => r.bvid)
      const query = q.trim().toLowerCase()
      const shown = rows.filter((r) => !query
        || [r.bvid, r.title, r.action].some((x) => String(x || '').toLowerCase().includes(query)))
      const hasTime = rows.some((r) => r.time)
      const dates = rows.map((r) => r.date).filter(Boolean).sort()
      const table = shown.length
        ? h('div', { className: 'bf-tbl-wrap' }, h('table', { className: 'bf-grid' },
            h('thead', null, h('tr', null,
              h('th', { style: { width: 96 } }, '日期'),
              hasTime ? h('th', { style: { width: 64 } }, '时间') : null,
              h('th', { style: { width: 126 } }, 'BV 号'),
              h('th', { style: { width: 150 } }, '动作'),
              h('th', null, '标题'),
            )),
            h('tbody', null, shown.map((r, i) => h('tr', { key: r.bvid + '-' + i },
              h('td', { className: 'mono' }, r.date || ''),
              hasTime ? h('td', { className: 'mono' }, r.time || '—') : null,
              h('td', { className: 'bv' }, r.bvid || '—'),
              h('td', null, SEEN_ACT(r.action)),
              h('td', null, r.title || '—'),
            ))),
          ))
        : h(EmptyState, {
            text: rows.length
              ? '没有匹配的记录；换个关键词。'
              : '判重表还是空的：每轮值班会把看过的 BV 追加进 seen.md，跨轮判重靠它。',
          })
      return h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '看过什么'),
          h('span', { className: 'bf-card-note' },
            '看过 ' + rows.length + ' 条' + (notes ? ' · 折叠 ' + notes + ' 条值班备注' : '') +
            (dates.length ? ' · ' + dates[0] + ' → ' + dates[dates.length - 1] : '')),
          h(Sp),
          h('div', { style: { width: 220 } }, h(SearchInput, { value: q, onChange: setQ, placeholder: '搜 BV / 标题 / 动作' })),
          h(Btn, { small: true, variant: 'ghost', onClick: () => seen.refresh() }, T.refresh),
        ),
        table,
      )
    }

    /** 活动页：3 视图（生命周期 / 时间线 / 判重表） + 类型筛选 + 搜索 */
    function ActivityPage({ data, view: viewProp, onView, initial, onRun, onLogin, fetchError }) {
      const [localView, setLocalView] = React.useState('life')
      const view = viewProp || localView
      const setView = (v) => { setLocalView(v); if (onView) onView(v) }
      const [filter, setFilter] = React.useState('all')
      const [query, setQuery] = React.useState('')
      const days = data?.days || []

      const head = h(PageHeader, { title: PAGE_TITLE.activity, intro: PAGE_INTRO.activity },
        h(IconBtn, { label: '刷新活动数据', onClick: () => onView && onView('refresh') }, '⟳'),
      )
      const viewSeg = h('div', { className: 'bf-seg', role: 'tablist', 'aria-label': '活动视图' },
        ACT_VIEWS.map(([k, label]) =>
          h('button', { key: k, role: 'tab', 'aria-selected': String(view === k), onClick: () => setView(k) }, label)))

      if (view === 'seen') {
        return h('div', null,
          head,
          h('div', { className: 'bf-pagemain' }, viewSeg,
            h('section', { role: 'tabpanel', 'aria-label': '判重表' }, h(SeenView, { initial: initial?.seen }))),
        )
      }

      const toolbar = h('div', { className: 'bf-tools' },
        viewSeg,
        h(Sp),
        h('div', { style: { width: 220 } }, h(SearchInput, { value: query, onChange: setQuery, placeholder: '搜标题 / BV / UP' })),
      )

      if (!days.length) {
        return h('div', null,
          head,
          h('div', { className: 'bf-pagemain' }, toolbar,
            fetchError ? h('div', { className: 'bf-banner error' }, h('span', null, '活动数据读取失败：' + fetchError)) : null,
            h(Card, null,
              h(EmptyState, {
                title: '还没有活动记录',
                text: '跑一轮值班，或先扫码登录小号 —— 每条视频的「刷到→看→赞→评→接话→被回复」都会在这里连成一条线。',
              }, h(Btn, { variant: 'primary', onClick: onRun }, T.run), h(Btn, { onClick: onLogin }, T.login)),
            ),
          ),
        )
      }

      const rows = []
      for (const day of days) {
        for (const round of (day.rounds || [])) {
          for (const item of (round.items || [])) rows.push({ day: day.date, round, item })
        }
      }
      const hasEvent = (item, type) => (item.events || []).some((e) => {
        if (type === 'reply-out') return e.type === 'reply-out' && e.kind === 'proactive'
        return e.type === type
      })
      const q = query.trim().toLowerCase()
      const shown = rows.filter(({ item }) => {
        if (filter !== 'all' && !hasEvent(item, filter)) return false
        if (!q) return true
        return [item.title, item.bvid, item.author].some((x) => String(x || '').toLowerCase().includes(q))
      })
      const counts = {}
      for (const [k] of ACT_FILTERS) {
        counts[k] = k === 'all' ? rows.length : rows.filter(({ item }) => hasEvent(item, k)).length
      }

      const filterRow = h('div', { className: 'bf-chips' },
        ACT_FILTERS.map(([k, label]) => h('button', {
          key: k, className: 'bf-chipbtn', 'aria-pressed': String(filter === k), onClick: () => setFilter(k),
        }, label + ' ' + counts[k])),
      )

      const totalEvents = rows.reduce((n, { item }) => n + (item.events || []).length, 0)
      const statsLine = h('div', { className: 'bf-note' },
        '视频 ' + rows.length + ' 个 · 事件 ' + totalEvents + ' 条 · 天数 ' + days.length +
        ' · 筛选后 ' + shown.length + ' 个视频')

      let body = null
      if (!shown.length) {
        body = h(Card, null, h(EmptyState, {
          text: rows.length ? '没有匹配的活动；换个筛选条件或清空搜索。' : '账本里还没有活动记录。',
        }))
      } else if (view === 'life') {
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
            h('div', { className: 'bf-daysep' }, day + ' · ' + list.length + ' 个视频'),
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
        body = h(Card, null, flat.map(({ e, item }, i) => {
          const day = e.t ? dayKeyOf(e.t) : ''   // 本地日：与服务器侧 groupByDay 同口径（UTC 切片在凌晨会差一天）
          const sep = day !== lastDay ? h('div', { className: 'bf-daysep', key: 'd-' + day + '-' + i }, day) : null
          lastDay = day
          const isProactive = e.type === 'reply-out' && e.kind === 'proactive'
          const label = isProactive ? '接话' : (EVENT_LABEL[e.type] || e.type)
          const detail = e.type === 'reply-in'
            ? (e.from ? e.from + '：' : '') + (e.text || '')
            : e.type === 'reply-out'
              ? (isProactive ? '我接话：' : '我：') + (e.text || '')
              : e.type === 'reply-scan'
                ? (e.decision === 'posted'
                    ? '接 rpid ' + (e.postedRpid ?? e.targetRpid ?? '—')
                    : '不接') + (e.reason ? '（' + e.reason + '）' : '') + ' · 候选 ' + ((e.candidates || []).length)
                : e.type === 'skip' ? '跳过：' + (e.reason || '') : (e.text || '')
          const tagKind = isProactive ? 'rep' : (EVENT_TAG_KIND[e.type] || '')
          return h(React.Fragment, { key: 'e-' + i },
            sep,
            h('div', { className: 'bf-evt' },
              h('div', { className: 'bf-evt-type' }, h(Tag, { kind: tagKind }, label)),
              h('div', { className: 'bf-evt-main' },
                h('div', { className: 'bf-evt-title' }, item.title || item.bvid || detail || '—'),
                h('div', { className: 'bf-evt-meta' },
                  (item.bvid ? item.bvid : '') + (detail && detail !== item.title ? ' · ' + String(detail).slice(0, 90) : '')),
              ),
              h('div', { className: 'bf-evt-time' }, hhmm(e.t) || ''),
            ),
          )
        }))
      }

      return h('div', null,
        head,
        h('div', { className: 'bf-pagemain' },
          toolbar,
          h(Card, null,
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, '筛选'),
              h('span', { className: 'bf-card-note' }, '类型与计数'),
              h(Sp),
            ),
            filterRow,
          ),
          statsLine,
          body,
        ),
      )
    }

    /* ═══════════════════════ §5 日报 ═══════════════════════ */

    function ReportsPage({ initial }) {
      const listHook = usePoll(React.useCallback(() => apiGet('/reports'), []), 60000)
      const list = listHook.data || (initial || {}).list || {}
      const days = list.days || []
      const digests = list.digests || []
      const hasOverlay = !!list.overlay
      const first = days[0] || (hasOverlay ? 'overlay' : null)
      const [day, setDay] = React.useState((initial || {}).day || null)
      const current = day || first
      const docHook = usePoll(
        React.useCallback(() => apiGet('/report?day=' + encodeURIComponent(current || 'overlay')), [current]),
        60000,
      )
      const text = docHook.data?.text != null ? docHook.data.text : ((initial || {}).text || '')
      const item = (key, label, meta, iconText) => h('button', {
        key, className: 'bf-list-btn', 'aria-current': String(current === key), onClick: () => setDay(key),
      }, h('span', { className: 'bf-mono', style: { flex: '0 0 auto' } }, iconText || '·'),
        h('span', { className: 'l' }, label), meta ? h('span', { className: 'm' }, meta) : null)

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
          !days.length && !digests.length && !hasOverlay ? h('div', { className: 'bf-note' }, '还没有日报') : null,
        ),
      )
      const title = current === 'overlay' ? 'headless-overlay.yml' : '日报 ' + (current || '—')
      const right = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, title),
          h('span', { className: 'bf-card-note' }, text ? text.length + ' 字符' : ''),
          h(Sp),
          h(Btn, { small: true, variant: 'ghost', onClick: () => docHook.refresh() }, T.refresh),
        ),
        text ? h(Markdown, { text }) : h(EmptyState, { text: '这份报告没有正文（或快照未包含内容）。' }),
      )

      return h('div', null,
        h(PageHeader, { title: PAGE_TITLE.reports, intro: PAGE_INTRO.reports },
          h(IconBtn, { label: '刷新报告', onClick: () => { listHook.refresh(); docHook.refresh() } }, '⟳'),
        ),
        h('div', { className: 'bf-pagemain' }, h('div', { className: 'bf-split' }, left, right)),
      )
    }

    /* ═══════════════════════ §6 人设（3 子页签） ═══════════════════════ */

    const PF_BLOCK_LABEL = { core: 'P1 常驻核心', lore: 'P2 见闻索引', state: 'P3 今日状态', samples: 'P4 语料样本', tail: 'P5 最后一公里' }
    const PF_DEBT_LABEL = { question: '疑问', reaction: '纯反应', emoji: '带表情', experience: '个人经历' }
    const PERSONA_TABS = [['card', '人设卡'], ['materials', '素材库'], ['preview-quality', '预览与质量']]
    const PF_TAB_ALIAS = {
      quality: 'preview-quality', preview: 'preview-quality', version: 'preview-quality',
      state: 'preview-quality', bank: 'materials', lore: 'materials',
    }
    /** W5 体检口径的中文展示（§8.2 基线：27 字 / 0.109 / 41.7% / 12.6%）。 */
    const PF_CHECKUP_VERDICT = {
      ok: { kind: 'rep', text: '像它' },
      warn: { kind: 'warn', text: '有偏离' },
      bad: { kind: 'err', text: '不像它了' },
    }
    const PF_HIT_LABEL = { lore: '见闻', canon: '被问到', expression: '语料' }
    const pctText = (x) => Math.round((Number(x) || 0) * 100) + '%'

    /**
     * 回滚出口：legacy 直通（旧 `personaPrompt`）。
     *
     * 这个字段原先在「设置 → 内容与禁令」里有一个编辑框 —— 但人设内容已经在本页有完整的
     * 卡 / 素材 / 版本编辑入口，同一个字段两处能改只会让人分不清哪边生效（2026-10-28 主人指正：
     * 「设置里那个没什么意义」）。所以设置页只管运行参数，这里只留**应急回滚**：
     *   - 填回一段正文 / 一个文件路径 ⇒ 本轮注入回到 v1（legacy 直通，行为一字不差）；
     *   - 清空 ⇒ 立刻回到人设卡链路。
     * 收起时不发请求（enabled=open），展开才读 /config；写完刷新人设页的取数。
     */
    function LegacyFallback({ legacy, onChanged }) {
      const [open, setOpen] = React.useState(!!legacy)   // legacy 生效时默认展开：这时它是本页唯一有用的东西
      const [text, setText] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const cfg = usePoll(React.useCallback(() => cachedGet('/config'), []), 30000, open)
      const cfgVals = (cfg.data && cfg.data.values) || null
      const cur = cfgVals && typeof cfgVals.personaPrompt === 'string' ? cfgVals.personaPrompt : ''
      const val = text == null ? cur : text
      const save = async (next) => {
        setBusy(true); setMsg('')
        try {
          const r = await apiPost('/config', { personaPrompt: next })
          if (r && r.ok) {
            setText(null)
            setMsg(next ? '已切到 legacy 直通（下一轮生效）' : '已清空：下一轮回人设卡')
            cfg.refresh()
            if (onChanged) onChanged()
          } else {
            const first = r && Array.isArray(r.errors) && r.errors[0]
            setMsg('保存失败：' + ((r && (r.error || (first && (first.msg || first.path)))) || '未知错误'))
          }
        } catch (e) { setMsg('保存失败：' + String(e && e.message != null ? e.message : e)) } finally { setBusy(false) }
      }
      return h('details', {
        className: 'bf-group', open,
        onToggle: (e) => {
          const o = !!(e && e.currentTarget && e.currentTarget.open)
          if (o !== open) setOpen(o)
        },
      },
        h('summary', null, '回滚出口：legacy 直通（旧 personaPrompt）'),
        h('div', { style: { marginTop: 8 } },
          h('div', { className: 'bf-note', style: { marginBottom: 8 } },
            '人设内容只在本页维护。这里留一个应急出口：卡链路整体不对劲时，把旧提示词填回来，'
            + '本轮注入就回到 v1 的做法（一字不差）；清空即回到人设卡。'),
          legacy ? h('div', { className: 'bf-banner warn', style: { marginBottom: 8 } },
            h('span', null, '当前生效中：legacy 直通。本页的人设卡与编译预览不生效。')) : null,
          h('textarea', {
            value: val, 'aria-label': '旧人设提示词（legacy）',
            placeholder: '一段正文，或一个文件路径（/绝对路径、~/…、Windows 盘符、preset:whale；填目录则读其中的 AGENTS.md）',
            onChange: (e) => setText(e.target.value),
          }),
          h('div', { className: 'bf-edit-actions' },
            h(Btn, { variant: 'primary', disabled: busy || val === cur, onClick: () => save(val) }, '保存并生效'),
            h(Btn, { variant: 'ghost', disabled: busy || !cur, onClick: () => save('') }, '清空：回到人设卡'),
            msg ? h('span', { className: 'bf-note' }, msg) : null,
          ),
        ),
      )
    }

    function PersonaPage({ persona, initial, initialTab, ov }) {
      const prevHook = usePoll(React.useCallback(() => cachedGet('/persona/preview'), []), 60000)
      const exprHook = usePoll(React.useCallback(() => cachedGet('/persona/expression'), []), 60000)
      const loreHook = usePoll(React.useCallback(() => cachedGet('/persona/lore'), []), 60000)
      const checkupHook = usePoll(React.useCallback(() => cachedGet('/persona/checkup'), []), 60000)
      const historyHook = usePoll(React.useCallback(() => cachedGet('/persona/history'), []), 60000)
      const versHook = usePoll(React.useCallback(() => apiGet('/persona/versions'), []), 30000)
      const [tab, setTab] = React.useState(PF_TAB_ALIAS[initialTab] || initialTab || 'card')
      const [bucket, setBucket] = React.useState('')
      const [loreId, setLoreId] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [jsonDraft, setJsonDraft] = React.useState(null)
      const [jsonErr, setJsonErr] = React.useState('')
      const [bankEditId, setBankEditId] = React.useState('')
      const [bankDraft, setBankDraft] = React.useState(null)
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
      const modeInfo = mode === 'card' ? { tone: 'ok', text: '卡（生效）' }
        : mode === 'legacy' ? { tone: 'warn', text: 'legacy 直通' } : { tone: 'err', text: '人设缺失' }
      const activeId = act.presetId || (health.detail || '').split('@')[0] || ''
      const cur = presets.find((p) => p.id === activeId) || null
      const legacy = mode === 'legacy'
      const err = (persona && persona.error) || prevHook.error || ''
      const l0checks = Array.isArray(l0?.checks) ? l0.checks : []
      const l0pass = l0checks.filter((c) => c.level === 'pass').length
      const buckets = (exprData && exprData.buckets) || {}
      const bucketKeys = Object.keys(buckets)
      const curBucket = bucketKeys.includes(bucket) ? bucket
        : (bucketKeys.includes('question') ? 'question' : (bucketKeys[0] || ''))
      const loreEntries = (loreData && loreData.entries) || []
      const curLore = loreEntries.find((x) => x.id === loreId && !x.disabled)
        || loreEntries.find((x) => !x.disabled) || loreEntries[0] || null
      const versions = (versData && versData.versions) || []
      // W5：页头一行 / 本轮注入读概览信封（由 ConsolePage 把 rt.data 传进来）；
      // 体检 / 换卡对比读两个新端点（未就绪时 initial 里没有，页面走「正在连接…」空态）。
      const ovd = ov || (initial && initial.ov) || null
      const ckRaw = checkupHook.data || (initial && initial.checkup) || null
      const ck = ckRaw && ckRaw.ok !== false ? ckRaw : null
      const histRaw = historyHook.data || (initial && initial.history) || null
      const hist = histRaw && histRaw.ok !== false ? histRaw : null
      const inject = (ovd && ovd.round && ovd.round.personaInject) || null
      const injectTag = (ovd && ovd.round && ovd.round.personaTag) || (inject && inject.personaTag) || ''
      // W7-2：同一个概览信封里的 round.speakGate，不新增请求（缺失时 injectGate = null ⇒ 渲染「暂无数据」）
      const injectGate = speakGateOf(ovd && ovd.round && ovd.round.speakGate)

      const refreshAll = () => {
        resetGetCache()   // 手动刷新要绕过 W4-4 的 30s 复用
        if (persona && persona.refresh) persona.refresh()
        prevHook.refresh(); exprHook.refresh(); loreHook.refresh(); versHook.refresh()
        checkupHook.refresh(); historyHook.refresh()
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
        if (typeof window !== 'undefined' && window.confirm
          && !window.confirm('回滚到 ' + name + '？当前卡会先存一份新快照。')) return
        setBusy(name); setMsg('')
        try {
          const r = await apiPost('/persona/versions/restore', { name })
          setMsg(r.ok ? '已回滚到 ' + name : '回滚失败：' + (r.error || '未知'))
          if (r.ok) refreshAll()
        } catch (e) { setMsg('回滚失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

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
          const r = await apiPost('/persona/expression', {
            action: 'status', form: curBucket, id: e0.id, status: e0.status === 'active' ? 'candidate' : 'active',
          })
          if (!r.ok) setMsg('切换失败：' + (r.error || '未知'))
          else refreshAll()
        } catch (e) { setMsg('切换失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const bankRemove = async (e0) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm('删除这条语料？（软删除，可在回收站恢复）')) return
        setBusy('br-' + e0.id); setMsg('')
        try {
          const r = await apiPost('/persona/expression', { action: 'remove', form: curBucket, id: e0.id })
          if (!r.ok) setMsg('删除失败：' + (r.error || '未知'))
          else { setMsg(r.soft === true ? '已移入回收站（可恢复）' : '已删除'); refreshAll() }
        } catch (e) { setMsg('删除失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      /* W3-3：软删除留痕 —— 回收站里的条目可以恢复；「彻底删除」单独二次确认。 */
      const bankRestore = async (e0) => {
        setBusy('brr-' + e0.id); setMsg('')
        try {
          const r = await apiPost('/persona/expression', { action: 'restore', form: curBucket, id: e0.id })
          setMsg(r.ok ? '已恢复' : '恢复失败：' + (r.error || '未知'))
          if (r.ok) refreshAll()
        } catch (e) { setMsg('恢复失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const bankPurge = async (e0) => {
        if (typeof window !== 'undefined' && window.confirm
          && !window.confirm('彻底删除这条语料？删除后不可恢复。')) return
        setBusy('brp-' + e0.id); setMsg('')
        try {
          const r = await apiPost('/persona/expression', { action: 'purge', form: curBucket, id: e0.id })
          setMsg(r.ok ? '已彻底删除' : '彻底删除失败：' + (r.error || '未知'))
          if (r.ok) refreshAll()
        } catch (e) { setMsg('彻底删除失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

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
        if (typeof window !== 'undefined' && window.confirm
          && !window.confirm('删除见闻「' + id + '」？（软删除，可在回收站恢复；已落盘的正文文件保留）')) return
        setBusy('lr-' + id); setMsg('')
        try {
          const r = await apiPost('/persona/lore', { action: 'remove', id })
          if (!r.ok) setMsg('删除失败：' + (r.error || '未知'))
          else { setMsg(r.soft === true ? '已移入回收站（可恢复）' : '已删除'); setLoreId(''); setLoreDraft(null); refreshAll() }
        } catch (e) { setMsg('删除失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const loreRestore = async (id) => {
        setBusy('lrr-' + id); setMsg('')
        try {
          const r = await apiPost('/persona/lore', { action: 'restore', id })
          setMsg(r.ok ? '已恢复' : '恢复失败：' + (r.error || '未知'))
          if (r.ok) refreshAll()
        } catch (e) { setMsg('恢复失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }
      const lorePurge = async (id) => {
        if (typeof window !== 'undefined' && window.confirm
          && !window.confirm('彻底删除见闻「' + id + '」？删除后不可恢复。')) return
        setBusy('lrp-' + id); setMsg('')
        try {
          const r = await apiPost('/persona/lore', { action: 'purge', id })
          setMsg(r.ok ? '已彻底删除' : '彻底删除失败：' + (r.error || '未知'))
          if (r.ok) { setLoreId(''); setLoreDraft(null); refreshAll() }
        } catch (e) { setMsg('彻底删除失败：' + String(e?.message ?? e)) } finally { setBusy('') }
      }

      const identity = (cur ? (cur.name || cur.id) : (card ? card.name : '未加载')) +
        (cur?.version ? ' @' + cur.version : '') + ' · ' + modeInfo.text +
        (l0checks.length ? ' · L0 ' + l0pass + '/' + l0checks.length : '') +
        (stats ? ' · ' + stats.total + '/' + stats.totalMax + ' 字符' : '')
      const head = h(PageHeader, {
        title: PAGE_TITLE.persona,
        // intro 只留一句话（这页能干什么）；「现在是谁/什么版本/多少字」是状态，挪到工具条，别把页头挤成两行
        intro: PAGE_INTRO.persona,
      },
        h('span', { className: 'bf-note' }, identity),
        msg ? h('span', { className: 'bf-note' }, msg) : null,
        h(IconBtn, { label: '刷新人设数据', onClick: refreshAll }, '⟳'),
      )

      const tabs = h('div', { className: 'bf-tabs', role: 'tablist', 'aria-label': '人设子页' },
        PERSONA_TABS.map(([k, label]) => h('button', {
          key: k, role: 'tab', 'aria-selected': String(tab === k), onClick: () => setTab(k),
        }, label)),
      )

      /* ═══ W5 人设页四个「回答」：页头一行 / 本轮实际注入 / 体检 / 换卡对比 ═══
       * 数据源：/persona + 概览 round.personaTag|personaInject（已有）；
       *        /persona/checkup + /persona/history（新端点，未就绪时 initial 里没有 ⇒ 空态）。
       * 每块都两态：「正在连接…」（首帧未到）/「暂无数据」（到了但没内容），不许谎报。 */

      /* ── ① 页头一行：这个号现在是谁 ── */
      const whoName = cur ? (cur.name || cur.id) : (card ? (card.name || card.id) : '')
      const whoVersion = cur?.version || card?.version || ''
      const whoNow = whoName ? whoName + (whoVersion ? ' @' + whoVersion : '') : ''
      const whoLine = h('div', {
        className: 'bf-tools', 'data-block': 'persona-who',
        style: {
          padding: '10px 14px', border: '.5px solid var(--border-l2)',
          borderRadius: 12, background: 'var(--bg-layer-1)',
        },
      },
        h('span', { className: 'bf-note' }, '现在是谁'),
        whoNow
          ? h('span', { className: 'bf-strong', style: { fontSize: 13, lineHeight: '20px' } }, whoNow)
          : h('span', { className: 'bf-note' }, '正在连接…'),
        whoNow ? h(Pill, { tone: mode === 'card' ? 'ok' : mode === 'legacy' ? 'warn' : 'err' }, modeInfo.text) : null,
        h(Sp),
        h('span', { className: 'bf-note' }, '上轮注入'),
        injectTag
          ? h('span', { className: 'bf-note st' }, injectTag)
          : h('span', { className: 'bf-note' }, ovd ? '暂无数据' : '正在连接…'),
        inject && Number(inject.totalMax)
          ? h('span', { className: 'bf-pf-num' },
              (Number(inject.total) || 0) + ' / ' + Number(inject.totalMax) + ' 字符')
          : null,
      )

      /* ── ② 本轮实际注入：五块进度条 + 命中见闻 + 降级徽标 ── */
      const injectLayers = inject && Array.isArray(inject.layers) ? inject.layers : []
      const injectHits = inject && Array.isArray(inject.hits) ? inject.hits : []
      const injectDegraded = inject && Array.isArray(inject.degraded) ? inject.degraded : []
      const injectNotes = inject && Array.isArray(inject.notes) ? inject.notes : []
      const injectCard = h('div', { 'data-block': 'persona-inject' },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '本轮实际注入'),
            h('span', { className: 'bf-card-note' },
              inject
                ? (injectTag || '未知') + ' · 合计 ' + (Number(inject.total) || 0)
                  + ' / ' + (Number(inject.totalMax) || 0) + ' 字符'
                : ovd ? '暂无数据' : '正在连接…'),
            h(Sp),
            inject && Number(inject.totalMax) && Number(inject.total) > Number(inject.totalMax)
              ? h(Tag, { kind: 'err' }, '超预算') : null,
          ),
          inject
            ? h('div', null,
                injectLayers.length
                  ? injectLayers.map((l) => h('div', { className: 'bf-pf-budget', key: l.name },
                      h('span', { className: 'bf-note' }, PF_BLOCK_LABEL[l.name] || l.name),
                      h('div', { className: 'bf-bar' }, h('i', {
                        className: Number(l.max) && Number(l.chars) > Number(l.max) ? 'over'
                          : Number(l.max) && Number(l.chars) > Number(l.max) * 0.9 ? 'warn' : '',
                        style: {
                          width: Math.min(100, Math.round(
                            ((Number(l.chars) || 0) / (Number(l.max) || 1)) * 100,
                          )) + '%',
                        },
                      })),
                      h('span', { className: 'bf-pf-num' }, (Number(l.chars) || 0) + '/' + (Number(l.max) || 0)),
                    ))
                  : h('div', { className: 'bf-note' }, '这轮没有分块统计（旧版账本事件）。'),
                h('div', { className: 'bf-tools', style: { marginTop: 10 } },
                  h('span', { className: 'bf-note' }, '命中'),
                  injectHits.length
                    ? injectHits.map((x, i) => h(Tag, { kind: 'cmt', key: i },
                        (PF_HIT_LABEL[(x && x.kind)] || (x && x.kind) || '') + ' ' + String((x && x.id) || '')))
                    : h('span', { className: 'bf-note' }, '无'),
                  h(Sp),
                  injectDegraded.length
                    ? injectDegraded.map((d0, i) => h(Tag, { kind: 'warn', key: i },
                        '降级 ' + String(d0 == null ? '' : d0)))
                    : h(Tag, { kind: 'rep' }, '无降级'),
                ),
                inject.guard
                  ? h('div', { className: 'bf-pf-sub' },
                      '守卫：' + (inject.guard.level || 'ok')
                      + (Number(inject.guard.len)
                        ? ' · ' + inject.guard.len + ' / 软线 ' + (inject.guard.softMax || '—')
                          + ' / 硬线 ' + (inject.guard.hardMax || '—')
                        : ''))
                  : null,
                injectNotes.length
                  ? h('div', { className: 'bf-pf-sub' },
                      injectNotes.map((n, i) => h('div', { key: i }, '· ' + String(n == null ? '' : n))))
                  : null,
              )
            : h('div', { className: 'bf-note' },
                ovd ? '这轮账本里还没有 persona-inject 记录（未走卡链路或还没跑完）。' : '正在连接…'),
          /* W7-2 发言门控一行：解释这轮为什么说 / 不说（与被注入的口径同源，不新增请求） */
          h('div', {
            className: 'bf-tools', 'data-block': 'persona-gate',
            style: { marginTop: 10, paddingTop: 8, borderTop: '.5px solid var(--border-l2)' },
          },
            h('span', { className: 'bf-note st' }, '发言门控'),
            injectGate
              ? h(React.Fragment, null,
                  h(SpeakGateTags, { gate: injectGate }),
                  injectGate.reason ? h('span', { className: 'bf-note' }, '· ' + injectGate.reason) : null,
                  injectGate.featText ? h('span', { className: 'bf-note' }, '· ' + injectGate.featText) : null,
                )
              : h('span', { className: 'bf-note' }, ovd ? '暂无数据' : '正在连接…'),
          ),
        ),
      )

      /* ── ③ 体检：说话还像它吗（近 N 条 vs 247 条基线） ── */
      const ckMetrics = (ck && ck.metrics) || null
      const ckN = Number(ck && ck.n) || 0
      const ckMetric = (k) => Number(ckMetrics && ckMetrics[k]) || 0
      // 至少有一个已知指标才算「有数据」；半截 metrics 按暂无数据处理，别渲染一排 0 假装体检过
      const ckHasMetrics = !!ckMetrics && ['medianChars', 'periodPerComment', 'emojiRatio', 'questionRatio', 'avoidHits']
        .some((k) => Number.isFinite(Number(ckMetrics[k])))
      const ckView = PF_CHECKUP_VERDICT[(ck && ck.verdict && ck.verdict.level) || 'ok'] || PF_CHECKUP_VERDICT.ok
      const ckSamples = (ck && Array.isArray(ck.samples) ? ck.samples : [])
        .filter((s0) => s0 && typeof s0 === 'object')
      const ckReasons = ck && ck.verdict && Array.isArray(ck.verdict.reasons) ? ck.verdict.reasons : []
      const checkupCard = h('div', { 'data-block': 'persona-checkup' },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '体检'),
            h('span', { className: 'bf-card-note' },
              ck && ckN
                ? '近 ' + ckN + ' 条 vs 247 条基线 · 窗口 ' + (Number(ck.windowDays) || 14) + ' 天'
                : ck ? '暂无数据' : '正在连接…'),
            h(Sp),
            ck && ckN ? h(Tag, { kind: ckView.kind }, ckView.text) : null,
          ),
          !ck || !ckN || !ckHasMetrics
            ? h('div', { className: 'bf-note' },
                ck ? '暂无数据' + (ckReasons[0] ? '：' + ckReasons[0] : '') : '正在连接…')
            : h('div', null,
                h('div', { className: 'bf-grid-4' },
                  h(Metric, { label: '中位字数', value: String(ckMetric('medianChars')) + ' 字', foot: '基线 27 字' }),
                  h(Metric, { label: '句号 / 条', value: ckMetric('periodPerComment').toFixed(3), foot: '基线 0.109' }),
                  h(Metric, { label: '表情占比', value: pctText(ckMetric('emojiRatio')), foot: '基线 41.7%' }),
                  h(Metric, { label: '问号占比', value: pctText(ckMetric('questionRatio')), foot: '基线 12.6%' }),
                ),
                h('div', { className: 'bf-tools', style: { marginTop: 8 } },
                  h('span', { className: 'bf-note' }, '禁用词命中 ' + pctText(ckMetric('avoidHits')) + '（基线 0）'),
                  h(Sp),
                  h('span', { className: 'bf-note' }, '样本 ' + ckN + ' 条'),
                ),
                ckReasons.length
                  ? h('div', { style: { marginTop: 8 } },
                      ckReasons.map((r, i) => h('div', { className: 'bf-note', key: i }, '· ' + r)))
                  : h('div', { className: 'bf-note', style: { marginTop: 8 } }, '各项指标都在基线附近。'),
                ckSamples.length
                  ? h('div', { style: { marginTop: 8 } }, ckSamples.slice(0, 5).map((s0, i) => h('div', {
                      key: (s0.bvid || '') + i,
                      style: { padding: '6px 0', borderTop: i ? '.5px solid var(--border-l2)' : 0 },
                    },
                      h('div', { style: { fontSize: 13, lineHeight: '20px' } }, (i + 1) + '. ' + String(s0.text || '')),
                      h('div', { className: 'bf-note' },
                        [s0.bvid || '', s0.t ? hhmm(s0.t) : ''].filter(Boolean).join(' · ')),
                    )))
                  : null,
              ),
        ),
      )

      /* ── ④ 换卡对比：改了卡有变好吗（按 personaTag 分组，各 3 条评论 + 赞） ── */
      const histTags = (hist && Array.isArray(hist.tags) ? hist.tags : [])
        .filter((g) => g && typeof g === 'object')
      const historyCard = h('div', { 'data-block': 'persona-history' },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '换卡对比'),
            h('span', { className: 'bf-card-note' },
              histTags.length
                ? histTags.length + ' 组人设 · 每组近 3 条评论 + 赞'
                : hist ? '暂无数据' : '正在连接…'),
          ),
          histTags.length
            ? h('div', { className: 'bf-grid-2' }, histTags.map((g) => h('div', {
                key: String(g.personaTag || ''),
                style: {
                  border: '.5px solid var(--border-l2)', borderRadius: 12,
                  padding: '10px 12px', background: 'var(--bg-layer-1)',
                },
              },
                h('div', { className: 'bf-tools' },
                  h('span', { className: 'bf-strong', style: { fontSize: 13, lineHeight: '20px' } },
                    String(g.personaTag || '未知')),
                  h(Sp),
                  h('span', { className: 'bf-note' },
                    (Number(g.rounds) || 0) + ' 轮 · 赞 ' + (Number(g.likes) || 0)),
                  g.lastAt ? h('span', { className: 'bf-note' }, hhmm(g.lastAt)) : null,
                ),
                (Array.isArray(g.samples) ? g.samples : []).filter((s0) => s0 && typeof s0 === 'object').length
                  ? (Array.isArray(g.samples) ? g.samples : [])
                      .filter((s0) => s0 && typeof s0 === 'object').map((s0, i) => h('div', {
                      key: i, style: { padding: '6px 0', borderTop: '.5px solid var(--border-l2)' },
                    },
                      h('div', { style: { fontSize: 13, lineHeight: '20px' } }, String(s0.text || '')),
                      h('div', { className: 'bf-note' }, (s0.bvid || '') + ' · 赞 ' + (Number(s0.likes) || 0)),
                    ))
                  : h('div', { className: 'bf-note', style: { marginTop: 6 } }, '这版人设还没有评论样本。'),
              )))
            : h('div', { className: 'bf-note' },
                hist ? '还没有 persona-inject 归因数据（跑过卡轮后出现）。' : '正在连接…'),
        ),
      )

      const budgetCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '五块预算'),
          h('span', { className: 'bf-card-note' }, stats ? '合计 ' + stats.total + ' / ' + stats.totalMax : '等待编译数据'),
        ),
        per.length
          ? per.map((x) => h('div', { className: 'bf-pf-budget', key: x.name },
              h('span', { className: 'bf-note' }, PF_BLOCK_LABEL[x.name] || x.name),
              h('div', { className: 'bf-bar' }, h('i', {
                className: x.len > x.max ? 'over' : x.len > x.max * 0.9 ? 'warn' : '',
                style: { width: Math.min(100, Math.round((x.len / (x.max || 1)) * 100)) + '%' },
              })),
              h('span', { className: 'bf-pf-num' }, x.len + '/' + x.max),
            ))
          : h('div', { className: 'bf-note' }, '暂无编译数据'),
      )

      /* ── ① 人设卡 ── */
      const presetCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '预设'),
          h('span', { className: 'bf-card-note' }, presets.length + ' 个内置 · 当前 ' + (activeId || '—')),
        ),
        h('div', { className: 'bf-list' }, presets.map((p) => h('div', {
          key: p.id,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '.5px solid var(--border-l2)' },
        },
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'bf-strong', style: { fontSize: 13, lineHeight: '20px' } },
              (p.name || p.id) + (p.version ? ' @' + p.version : '')),
            h('div', { className: 'bf-note' }, p.oneLiner || ''),
          ),
          p.id === activeId && !legacy
            ? h(Pill, { tone: 'ok' }, '生效中')
            : h(Btn, {
                small: true, variant: p.id === activeId ? 'ghost' : 'primary', disabled: !!busy,
                onClick: () => switchPreset(p.id),
              }, p.id === activeId ? '重新应用' : '应用'),
        ))),
        legacy ? h('div', { className: 'bf-note', style: { marginTop: 8 } },
          'legacy 模式下切预设只改 active.json，不影响本轮注入。') : null,
      )

      const cardTab = h('div', { className: 'bf-pagebody' },
        presetCard,
        h(Card, { p0: true },
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, legacy ? '人设卡（当前未生效）' : '人设卡'),
            h('span', { className: 'bf-card-note' },
              card ? (card.id + '@' + card.version + ' · ' + (card.license || '')) : '未加载'),
          ),
          card
            ? h('div', null,
                h('div', { style: { fontSize: 13, lineHeight: '20px' } }, card.identity && card.identity.oneLiner || ''),
                h('div', { className: 'bf-pf-sub' }, (card.identity && card.identity.background) || ''),
                [['identity', '身份'], ['voice', '口吻'], ['mindset', '心态'], ['taste', '品味'], ['stance', '立场'],
                 ['redlines', '红线'], ['canon', '被问到'], ['loreIndex', '见闻索引'], ['samples', '示例']]
                  .map(([k, label]) => {
                    const val = card[k]
                    const txt = JSON.stringify(val, null, 2) || ''
                    return h('details', { className: 'bf-group', key: k },
                      h('summary', null, label + ' · ' + (JSON.stringify(val) || '').length + ' 字符'),
                      h('pre', { className: 'bf-doc', style: { marginTop: 8, maxHeight: 240 } }, txt),
                    )
                  }),
              )
            : h('div', { className: 'bf-note' }, '人设卡未加载；检查 active.json / preset。'),
        ),
        budgetCard,
        h('details', { className: 'bf-group' },
          h('summary', null, '高级：JSON 编辑（保存写入用户卡并留版本快照）'),
          h('div', { style: { marginTop: 8 } },
            h('textarea', {
              className: 'bf-json', 'aria-label': '人设卡 JSON',
              value: jsonDraft == null ? JSON.stringify(card || {}, null, 2) : jsonDraft,
              onChange: (e) => setJsonDraft(e.target.value),
            }),
            jsonErr ? h('div', { className: 'bf-inline-err', style: { marginTop: 8 } }, jsonErr) : null,
            h('div', { className: 'bf-edit-actions' },
              h(Btn, { variant: 'primary', disabled: !card || !!busy, onClick: saveCard }, '保存并生效'),
              h(Btn, {
                variant: 'ghost', disabled: jsonDraft == null,
                onClick: () => { setJsonDraft(null); setJsonErr('') },
              }, '重置为当前卡'),
            ),
            h('div', { className: 'bf-pf-sub' },
              '保存会校验 schema + L0 前六条（红线三件套/禁止句/手段表/词频/矛盾/示例），失败返回字段级错误。'),
          ),
        ),
        h(LegacyFallback, { legacy, onChanged: refreshAll }),
      )

      /* ── ② 素材库（语料 + 见闻） ── */
      const bankEntries = (buckets[curBucket] || [])
      const bankDisabled = bankEntries.filter((e) => e.disabled === true)
      const bankCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '语料库'),
          h('span', { className: 'bf-card-note' },
            '逐字真实素材 · 注入时只学手感' + (bankDisabled.length ? ' · 回收站 ' + bankDisabled.length : '')),
          h(Sp),
          h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: bankStartAdd }, '＋ 新增'),
        ),
        bucketKeys.length ? h('div', { className: 'bf-buckets' },
          bucketKeys.map((k) => h('button', {
            key: k, className: 'bf-bucket', 'aria-pressed': String(k === curBucket), onClick: () => setBucket(k),
          }, h('b', null, k, h('span', { style: { marginLeft: 'auto' } },
            (buckets[k] || []).filter((e) => e.status === 'active').length + '/' + (buckets[k] || []).length)),
             h('div', { className: 'm' }, (buckets[k] || []).length >= 20 ? '够用（≥20）' : '不足 20 条 · 待扩'))),
        ) : h('div', { className: 'bf-note' }, '还没有表达库数据。'),
        h('div', { style: { marginTop: 10 } },
          h('div', { className: 'bf-note', style: { marginBottom: 6 } },
            '桶：' + (curBucket || '—') + ' · ' + bankEntries.length + ' 条'),
          bankEditId === 'new' && bankDraft ? h('div', { className: 'bf-edit-box' },
            h('textarea', {
              value: bankDraft.text, placeholder: '逐字语料（录入真人说的话）',
              'aria-label': '语料正文',
              onChange: (e) => setBankDraft({ ...bankDraft, text: e.target.value }),
            }),
            h('div', { className: 'bf-edit-actions' },
              h('input', {
                className: 'bf-input', style: { flex: 1, minWidth: 160 }, value: bankDraft.source,
                placeholder: '来源（可选）', 'aria-label': '来源',
                onChange: (e) => setBankDraft({ ...bankDraft, source: e.target.value }),
              }),
              h(Num, { value: Number(bankDraft.heat ?? 0), label: 'heat', onChange: (v) => setBankDraft({ ...bankDraft, heat: v }) }),
              h(Btn, { small: true, disabled: !!busy || !String(bankDraft.text || '').trim(), onClick: bankSave }, '保存'),
              h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => { setBankEditId(''); setBankDraft(null) } }, '取消'),
            ),
          ) : null,
          bankEntries.length
            ? bankEntries.map((e, i) => h('div', {
                key: e.id || i, style: { padding: '9px 0', borderTop: '.5px solid var(--border-l2)' },
              },
                e.disabled === true ? h('div', { style: { opacity: .55 } },
                  h('div', { style: { fontSize: 13, lineHeight: '20px', textDecoration: 'line-through' } }, e.text),
                  h('div', { className: 'bf-tools', style: { marginTop: 2 } },
                    h('span', { className: 'bf-note' }, (e.source || '') + ' · 已删除（回收站）'),
                    h(Sp),
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankRestore(e) }, '恢复'),
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankPurge(e) }, '彻底删除'),
                  ),
                ) : bankEditId === e.id && bankDraft ? h('div', null,
                  h('textarea', {
                    value: bankDraft.text, 'aria-label': '语料正文',
                    onChange: (ev) => setBankDraft({ ...bankDraft, text: ev.target.value }),
                  }),
                  h('div', { className: 'bf-edit-actions' },
                    h('input', {
                      className: 'bf-input', style: { flex: 1, minWidth: 160 }, value: bankDraft.source,
                      placeholder: '来源', 'aria-label': '来源',
                      onChange: (ev) => setBankDraft({ ...bankDraft, source: ev.target.value }),
                    }),
                    h(Num, { value: Number(bankDraft.heat ?? 0), label: 'heat', onChange: (v) => setBankDraft({ ...bankDraft, heat: v }) }),
                    h(Btn, { small: true, disabled: !!busy, onClick: bankSave }, '保存'),
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => { setBankEditId(''); setBankDraft(null) } }, '取消'),
                  ),
                ) : h('div', null,
                  h('div', { style: { fontSize: 13, lineHeight: '20px' } }, e.text),
                  h('div', { className: 'bf-tools', style: { marginTop: 2 } },
                    h('span', { className: 'bf-note' },
                      (e.source || '') + ' · len ' + (e.len || 0) + ' · ' + (e.status || '') + ' · heat ' + (e.heat || 0)),
                    h(Sp),
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankToggle(e) },
                      e.status === 'active' ? '停用' : '启用'),
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankStartEdit(e) }, '改'),
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => bankRemove(e) }, '删'),
                  ),
                ),
              ))
            : h('div', { className: 'bf-note' }, '这个桶还是空的。'),
        ),
      )

      const loreDisabled = loreEntries.filter((e) => e.disabled === true)
      const loreCard = h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '见闻库'),
          h('span', { className: 'bf-card-note' },
            loreEntries.length + ' 条 · 索引常驻，正文命中才读'
            + (loreDisabled.length ? ' · 回收站 ' + loreDisabled.length : '')),
          h(Sp),
          h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: loreStartAdd }, '＋ 新增'),
        ),
        h('div', { className: 'bf-split' },
          h('div', null,
            loreNew ? h('div', { className: 'bf-edit-box' },
              h('input', {
                className: 'bf-input', style: { width: '100%' }, value: loreNew.id,
                placeholder: 'id（字母数字-连字符，如 night-market）', 'aria-label': '见闻 id',
                onChange: (e) => setLoreNew({ ...loreNew, id: e.target.value }),
              }),
              h('input', {
                className: 'bf-input', style: { width: '100%', marginTop: 6 }, value: loreNew.keys,
                placeholder: '触发词，逗号分隔', 'aria-label': '触发词',
                onChange: (e) => setLoreNew({ ...loreNew, keys: e.target.value }),
              }),
              h('input', {
                className: 'bf-input', style: { width: '100%', marginTop: 6 }, value: loreNew.oneLine,
                placeholder: '一行摘要（≤40 字，会注入 prompt）', 'aria-label': '一行摘要',
                onChange: (e) => setLoreNew({ ...loreNew, oneLine: e.target.value }),
              }),
              h('textarea', {
                style: { marginTop: 6, minHeight: 80 }, value: loreNew.body,
                placeholder: '正文（可选；不注入）', 'aria-label': '见闻正文',
                onChange: (e) => setLoreNew({ ...loreNew, body: e.target.value }),
              }),
              h('div', { className: 'bf-edit-actions' },
                h(Btn, { small: true, disabled: !!busy || !String(loreNew.id || '').trim(), onClick: loreSave }, '创建'),
                h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => setLoreNew(null) }, '取消'),
              ),
            ) : null,
            loreEntries.length
              ? loreEntries.map((e) => h('div', {
                  key: e.id, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', opacity: e.disabled ? .55 : 1 },
                },
                  e.disabled === true ? h('div', {
                    className: 'bf-list-btn', style: { flex: 1, minWidth: 0, cursor: 'default' },
                  }, h('span', { className: 'l', style: { textDecoration: 'line-through' } }, e.id),
                     h('span', { className: 'm' }, '已删除')) : h('button', {
                    className: 'bf-list-btn', style: { flex: 1, minWidth: 0 },
                    'aria-current': String((curLore || {}).id === e.id),
                    onClick: () => { setLoreId(e.id); setLoreDraft(null) },
                  }, h('span', { className: 'l' }, e.id),
                     h('span', { className: 'm' }, e.usedToday ? '今天用过' : '可用')),
                  e.disabled === true
                    ? h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => loreRestore(e.id) }, '恢复')
                    : h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => loreRemove(e.id) }, '删'),
                  e.disabled === true
                    ? h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => lorePurge(e.id) }, '彻底删除')
                    : null,
                ))
              : h('div', { className: 'bf-note' }, '卡里还没有 loreIndex。'),
          ),
          h('div', null,
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, '正文（不注入，命中才读）'),
              h('span', { className: 'bf-card-note' }, curLore ? curLore.chars + ' 字符' : ''),
              h(Sp),
              curLore && !loreDraft && !loreNew
                ? h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: loreStartEdit }, '编辑') : null,
            ),
            curLore && loreDraft ? h('div', null,
              h('input', {
                className: 'bf-input', style: { width: '100%' }, value: loreDraft.keys,
                placeholder: '触发词，逗号分隔', 'aria-label': '触发词',
                onChange: (e) => setLoreDraft({ ...loreDraft, keys: e.target.value }),
              }),
              h('input', {
                className: 'bf-input', style: { width: '100%', marginTop: 6 }, value: loreDraft.oneLine,
                placeholder: '一行摘要（≤40 字，会注入 prompt）', 'aria-label': '一行摘要',
                onChange: (e) => setLoreDraft({ ...loreDraft, oneLine: e.target.value }),
              }),
              h('textarea', {
                style: { marginTop: 6, minHeight: 180 }, value: loreDraft.body, 'aria-label': '见闻正文',
                onChange: (e) => setLoreDraft({ ...loreDraft, body: e.target.value }),
              }),
              h('div', { className: 'bf-edit-actions' },
                h(Btn, { small: true, disabled: !!busy, onClick: loreSave }, '保存'),
                h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => setLoreDraft(null) }, '取消'),
              ),
            ) : curLore ? h('div', null,
              h('div', { className: 'bf-note', style: { marginBottom: 6 } }, '键：' + (curLore.keys || []).join(' / ')),
              h('div', { className: 'bf-pf-sub', style: { marginBottom: 8 } }, curLore.oneLine),
              h('pre', { className: 'bf-doc', style: { maxHeight: 360 } }, curLore.body || '（正文文件缺失）'),
            ) : h('div', { className: 'bf-note' }, '选一条见闻看正文。'),
          ),
        ),
      )

      const materialsTab = h('div', { className: 'bf-pagebody' }, bankCard, loreCard)

      /* ── ③ 预览与质量 ── */
      const debtKeys = st && st.recent && st.recent.debt
        ? Object.keys(PF_DEBT_LABEL).filter((k) => st.recent.debt[k]) : []
      const previewQualityTab = h('div', { className: 'bf-pagebody' },
        h('div', { className: 'bf-grid-2' },
          h(Card, { p0: true },
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, '编译产物'),
              h('span', { className: 'bf-card-note' }, pvText ? pvText.length + ' 字符 · ' + (pv.tag || '') : '暂无'),
            ),
            pvText
              ? h('div', null,
                  h('div', { className: 'bf-note', style: { marginBottom: 8 } },
                    '前段在章程之前、后段在整轮 prompt 末尾；这段文本就是本轮真正会注入的内容。'),
                  h('pre', { className: 'bf-doc', style: { maxHeight: 360 } }, pvText),
                  (pv.notes || []).map((n, i) => h('div', { className: 'bf-note', key: i, style: { marginTop: 4 } }, '· ' + n)),
                )
              : h('div', { className: 'bf-note' }, '暂无编译结果'),
          ),
          budgetCard,
        ),
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, 'L0 六条'),
            h('span', { className: 'bf-card-note' }, l0 ? (l0.ok ? '全部通过' : '有未通过项') : '暂无'),
            h(Sp),
            h(Tag, { kind: l0checks.length && l0pass === l0checks.length ? 'rep' : 'warn' },
              'L0 ' + l0pass + '/' + (l0checks.length || 6)),
          ),
          l0checks.length
            ? h('table', { className: 'bf-grid' },
                h('thead', null, h('tr', null, ['判据', '结果', '明细'].map((t) => h('th', { key: t }, t)))),
                h('tbody', null, l0checks.map((c) => h('tr', { key: c.id },
                  h('td', null, c.name),
                  h('td', null, h(Tag, { kind: c.level === 'pass' ? 'rep' : c.level === 'warn' ? 'warn' : 'err' },
                    c.level === 'pass' ? '通过' : c.level === 'warn' ? '警示' : '未过')),
                  h('td', null, c.detail || ''),
                ))),
              )
            : h('div', { className: 'bf-note' }, '暂无 L0 结果'),
        ),
        h('div', { className: 'bf-grid-4' },
          h(Metric, { label: '今日日期', value: (st && st.date) || '—', foot: 'mood seed 固定' }),
          h(Metric, {
            label: '心情', value: (st && st.mood && st.mood.label) || '—',
            foot: '精力 ' + ((st && st.mood && st.mood.energy) ?? '—'),
          }),
          h(Metric, {
            label: '时段', value: (st && st.timeOfDay && st.timeOfDay.label) || '—',
            foot: '上限 ' + ((st && st.timeOfDay && st.timeOfDay.maxChars) ?? '—') + ' 字',
          }),
          h(Metric, { label: '沉默计数', value: String((st && st.skipStreak) ?? 0), foot: '连续没接上话' }),
        ),
        h('div', { className: 'bf-grid-2' },
          h(Card, null,
            h('div', { className: 'bf-card-head' }, h('span', { className: 'bf-card-title' }, '最近说过（注入 P3）')),
            st && Array.isArray(st.recent && st.recent.comments) && st.recent.comments.length
              ? st.recent.comments.map((c, i) => h('div', {
                  key: i, style: { padding: '6px 0', borderTop: i ? '.5px solid var(--border-l2)' : 0 },
                },
                  h('span', { style: { fontSize: 13, lineHeight: '20px' } }, (i + 1) + '. ' + String(c.text || '')),
                  h('span', { style: { marginLeft: 8 } }, h(Tag, null, c.form || ''))))
              : h('div', { className: 'bf-note' }, '还没有已发评论。'),
          ),
          h(Card, null,
            h('div', { className: 'bf-card-head' },
              h('span', { className: 'bf-card-title' }, '欠账'),
              h('span', { className: 'bf-card-note' }, '宿主算，模型不用数'),
            ),
            h('div', { className: 'bf-chips' },
              debtKeys.map((k) => h(Tag, { kind: 'warn', key: k }, '欠 ' + PF_DEBT_LABEL[k])),
              st && st.recent && st.recent.debt && st.recent.debt.judgeHeavy
                ? h(Tag, { kind: 'warn' }, '判断收尾偏多') : null,
              !debtKeys.length && !(st && st.recent && st.recent.debt && st.recent.debt.judgeHeavy)
                ? h(Tag, { kind: 'rep' }, '无欠账') : null,
            ),
            h('div', { className: 'bf-pf-sub' },
              '最近 5 条形态：' + ((st && st.recent && st.recent.forms5 && st.recent.forms5.join(' / ')) || '—')),
          ),
        ),
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '版本快照'),
            h('span', { className: 'bf-card-note' }, versions.length + ' 份 · 保留最近 20 份'),
          ),
          versions.length
            ? h('div', { className: 'bf-tbl-wrap' }, h('table', { className: 'bf-grid' },
                h('thead', null, h('tr', null, ['快照', '时间', ''].map((t, i) => h('th', { key: i }, t)))),
                h('tbody', null, versions.map((v) => h('tr', { key: v.name },
                  h('td', { className: 'mono' }, v.name),
                  h('td', { className: 'mono' }, new Date(v.mtime).toLocaleString()),
                  h('td', null,
                    h(Btn, { small: true, variant: 'ghost', disabled: !!busy, onClick: () => restore(v.name) }, '回滚')),
                ))),
              ))
            : h('div', { className: 'bf-note' }, '还没有版本快照；保存卡或回滚后会出现。'),
        ),
        h('details', { className: 'bf-group' },
          h('summary', null, '试写沙盒（未接：需要 host 提供 LLM 调用与配额保护）'),
          h('div', { className: 'bf-sandbox-note', style: { marginTop: 8 } },
            '设计里沙盒给一个视频标题 + 简介，按当前人设生成 3 条候选评论，再过一遍 lint（不发布、不消耗账号行为配额）。',
            h('br'), '落地需要：① host 提供 LLM 调用与配额保护；② POST /persona/sandbox 端点；③ 与质量门共用同一套 lint。',
            h('br'), '当前版本先保留入口与说明，避免误以为已能生成。',
          ),
          h('div', { style: { marginTop: 12 } },
            h(Btn, { variant: 'primary', disabled: true }, '按当前人设写 3 条（未接）')),
        ),
      )

      const body = tab === 'card' ? cardTab : tab === 'materials' ? materialsTab : previewQualityTab

      return h('div', null,
        head,
        h('div', { className: 'bf-pagemain' },
          legacy ? h('div', { className: 'bf-banner warn' },
            h('span', null, '配置里填了 personaPrompt：本轮走 legacy 直通，本页的卡与编译预览不生效；切预设只改 active.json，不会覆盖配置。'
              + '要回到人设卡，去「人设卡 → 回滚出口」点「清空：回到人设卡」。')) : null,
          mode === 'missing' ? h('div', { className: 'bf-banner error' },
            h('span', null, '人设卡读不到：' + (health.detail || '未知原因') + '，可切一个内置预设恢复。')) : null,
          err ? h('div', { className: 'bf-banner error' }, h('span', null, '读取失败：' + err)) : null,
          whoLine,
          h('div', { className: 'bf-grid-2' }, injectCard, checkupCard),
          historyCard,
          tabs,
          h('section', { role: 'tabpanel', 'aria-label': (PERSONA_TABS.find(([k]) => k === tab) || [])[1] || '' }, body),
        ),
      )
    }

    /* ═══════════════════════ §7 设置（3 组 + 行式） ═══════════════════════ */

    const SET_SUBTABS = [['rules', '节奏与配额'], ['content', '内容与禁令'], ['env', '运行环境']]

    function SettingsPage({ ov, initial, initialSub }) {
      const [sub, setSub] = React.useState(SET_SUBTABS.some(([k]) => k === initialSub) ? initialSub : 'rules')
      return h('div', null,
        h(PageHeader, { title: PAGE_TITLE.settings, intro: PAGE_INTRO.settings }),
        h('div', { className: 'bf-pagemain' },
          h('div', { className: 'bf-tabs', role: 'tablist', 'aria-label': '设置分组' },
            SET_SUBTABS.map(([k, label]) => h('button', {
              key: k, role: 'tab', 'aria-selected': String(sub === k), onClick: () => setSub(k),
            }, label)),
          ),
          h('section', {
            role: 'tabpanel', 'aria-label': (SET_SUBTABS.find(([k]) => k === sub) || [])[1] || '',
          }, h(ConfigPane, { ov, initial, sub })),
        ),
      )
    }

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

      return h(Group, { title: '模型', note: '只影响值班轮（headless 会话），不影响当前对话。' },
        h(Row, {
          label: '当前生效',
          help: loading ? '加载中…' : (eff ? `${eff.provider || '—'} / ${eff.model || '—'}` : '取不到当前会话模型'),
        },
          eff ? h(Pill, { tone: 'ok' }, eff.mode === 'config' ? '插件配置' : '跟随默认') : null,
          eff?.reasoningEffort ? h(Tag, null, `推理 ${eff.reasoningEffort}`) : null,
          h(Btn, { small: true, variant: 'ghost', onClick: onFollow }, '跟随当前会话模型'),
        ),
        h(Row, { label: 'provider', help: '值班轮使用的模型供应商' },
          h(Select, {
            label: '值班轮 provider', value: provider, disabled: loading,
            onChange: (v) => onChange({ modelProvider: v, modelName: '' }), options: providerOptions,
          }),
        ),
        h(Row, {
          label: 'model',
          help: provider && !model ? 'provider 有值但 model 为空：保存后按跟随默认处理' : '留空 = 自动选',
        },
          h(Select, {
            label: '值班轮 model', value: model, disabled: loading || !provider,
            onChange: (v) => onChange({ modelName: v }), options: modelOptions,
          }),
        ),
        h(Row, { label: '推理强度', help: '留空 = 不改值班轮的推理强度' },
          h(Select, {
            label: '推理强度', value: draft.modelReasoningEffort || '', disabled: loading,
            onChange: (v) => onChange({ modelReasoningEffort: v }), options: effortOptions,
          }),
        ),
        warnings.length ? h('div', { className: 'bf-note', style: { marginTop: 6 } }, warnings.join('；')) : null,
      )
    }

    function ConfigPane({ ov, initial, sub = 'rules' }) {
      const cfg = usePoll(React.useCallback(() => apiGet('/config'), []), 30000)
      const cfgData = cfg.data || initial || null
      const models = useModels(sub === 'env')
      const diag = useDiagnose()
      /* 人设内容不归设置页管（唯一入口在「人设 → 人设卡 → 回滚出口」）：
       * personaPrompt **不进 draft**，所以设置页既不会显示它、也不会把它写回去
       * ——否则在本页点一次「恢复默认」就会静默清掉人设页设的回滚开关，且用户看不见。 */
      function noPersona(o) {
        const x = { ...(o || {}) }
        delete x.personaPrompt
        return x
      }
      const [draft, setDraft] = React.useState(initial ? noPersona(initial.values) : null)
      React.useEffect(() => { if (cfgData && !draft) setDraft(noPersona(cfgData.values)) }, [cfgData, draft])
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
      const dirtyKeys = Object.keys(draft).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfgData?.values?.[k]))
      const resetDefault = () => {
        if (typeof window !== 'undefined' && window.confirm
          && !window.confirm('恢复默认会把 ' + dirtyKeys.length + ' 处字段改回默认值（还没保存）。继续？')) return
        setDraft(noPersona(cfgData?.defaults))
      }
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

      const rulesGroup = h(Group, { title: '值班节奏' },
        h(Row, { label: '自动值班', help: '开启后在谷时窗口自动拉起一轮；关闭后只能手动触发' },
          h(Switch, { checked: !!draft.autoDuty, label: '自动值班', onChange: (v) => set('autoDuty', v) })),
        h(Row, { label: '中午窗口', help: '12:00 – 14:00' },
          h(Switch, { checked: !!draft.noon, label: '中午窗口', onChange: (v) => set('noon', v) })),
        h(Row, { label: '晚间窗口', help: '18:00 – 次日 09:00' },
          h(Switch, { checked: !!draft.night, label: '晚间窗口', onChange: (v) => set('night', v) })),
      )

      const quotaGroup = h(Group, { title: '配额', note: '0 = 关闭该项' },
        [['perDay', '每天挑中', '全天总量上限'],
         ['commentsPerDay', '每天评论', '公开文字，最重'],
         ['commentsPerRound', '每轮评论', '单轮上限'],
         ['likesPerDay', '每天点赞', '成本最低的存在感'],
         ['dynamicsPerDay', '每天动态', '分享 + 短评'],
         ['repliesPerRound', '每轮跟进回复', '收到回复后的回话'],
         ['replyOthersPerRound', '每轮主动接话', '楼中楼回复别人的评论；0 = 关']]
          .map(([k, label, help]) => h(Row, { key: k, label, help: help || undefined },
            h(Num, { value: Number(draft[k] ?? 0), label, onChange: (v) => set(k, v) }))),
      )

      const contentGroup = h(Group, { title: '内容源' },
        h(Row, { label: '指定 UP 主', help: 'UID，可留空；留空就靠下面的自动拉取', wide: true },
          h(ChipsInput, {
            values: (draft.followUids || []).map(String),
            onChange: (v) => set('followUids', v.map((x) => Number(x)).filter(Boolean)),
            placeholder: '+ 加 UID',
          })),
        h(Row, { label: '自动拉关注', help: '用 bili_followings 按「最常访问」拉常看的 UP 主' },
          h(Switch, { checked: draft.followAuto !== false, label: '自动拉关注', onChange: (v) => set('followAuto', v) })),
        h(Row, { label: '每轮抽查', help: '取「最常访问」前几个 UP 主的最新投稿；0 = 不抽查' },
          h(Num, { value: Number(draft.followPerRound ?? 8), label: '每轮抽查', onChange: (v) => set('followPerRound', v) })),
        h(Row, { label: '关键词', help: '其次搜索', wide: true },
          h(ChipsInput, { values: draft.keywords || [], onChange: (v) => set('keywords', v), placeholder: '+ 加关键词' })),
        h(Row, { label: '不看清单', help: 'BV号 / UP主（名或UID）/ 标题关键词；命中整条跳过', wide: true },
          h(ChipsInput, { values: draft.avoidList || [], onChange: (v) => set('avoidList', v), placeholder: '+ 加一条' })),
      )

      const banGroup = h(Group, { title: '禁令', note: '提示注入防御与「先落报告/账本」等保底纪律始终生效，不在开关范围。' },
        [['banPrivacy', '不透露隐私', '账号 / 路径 / 用户名 / 聊天内容不进评论与动态'],
         ['banImpersonation', '不冒充真实的人', '不模仿任何具体用户'],
         ['banControversy', '不碰争议话题', '立场 / 性别 / 地域 / 引战'],
         ['banRepeat', '同视频只评一次 / 不刷屏', '含动态不连发'],
         ['banReplyRefusal', '不接敏感请求', '写代码 / 做作品 / 承诺 / 贴隐私 / 无关请求']]
          .map(([k, label, help]) => h(Row, { key: k, label, help },
            h(Switch, { checked: draft[k] !== false, label, onChange: (v) => set(k, v) }))),
        h(Row, { label: '纯文本感想动态', help: '关闭后动态只发「分享视频 + 短评」' },
          h(Switch, { checked: draft.dynamicPureText !== false, label: '纯文本感想动态', onChange: (v) => set('dynamicPureText', v) })),
      )

      const growthGroup = h(Group, { title: '自生长' },
        h(Row, { label: '候选管道', help: '值班轮可用 bili_persona_note 沉淀新梗/新见闻，宿主质检后进候选区' },
          h(Switch, { checked: draft.growthEnable !== false, label: '候选管道', onChange: (v) => set('growthEnable', v) })),
        h(Row, { label: '每日自动转正', help: '0 = 只收候选，全部人工启用；转正的是最老的满分候选' },
          h(Num, { value: Number(draft.growthAutoPromote ?? 3), label: '每日自动转正', onChange: (v) => set('growthAutoPromote', v) })),
      )

      /* W7-2 发言门控 + 质量门转正（本轮新加的配置项，以前只能改配置文件）。
       * 纪律：观察中 ≠ 已经拦截 —— 文案必须和概览卡、人设页那一行保持一致，别让主人误以为开了就在拦。 */
      const qualityGateGroup = h(Group, { title: '人设 / 质量门' },
        h(Row, {
          label: '发言门控',
          help: '默认观察中：只记录、不拦（观察中 ≠ 已经拦截）；建议先跑三天看误杀率，再切强制',
        },
          h(Select, {
            label: '发言门控',
            value: draft.speakGateMode || 'observe',
            options: [
              ['off', '关闭（不记录节奏）'],
              ['observe', '观察中（只记录、不拦，推荐先跑三天）'],
              ['enforce', '强制（节奏太密时把本轮评论上限压到 1 条）'],
            ],
            onChange: (v) => set('speakGateMode', v),
          })),
        h(Row, {
          label: '只转正已确认的候选',
          help: '开启后只转正人工确认过（checked）的语料候选；关闭 = 按「每日自动转正」数自动推进',
        },
          h(Switch, {
            checked: draft.growthCheckedOnly === true, label: '只转正已确认的候选',
            onChange: (v) => set('growthCheckedOnly', v),
          })),
      )

      const cliPath = ov?.data?.health?.cli
      const envGroup = h(Group, { title: '运行环境' },
        h(Row, {
          label: 'dsh CLI',
          // ⭐ 三态：还没拿到信封 ≠ 没探测到（旧版两者都渲染成「未找到」，一打开就假报警）
          help: cliPath || (ov?.data?.health ? '值班轮会先自动探测' : '正在读取运行状态…'),
        },
          cliPath
            ? h(Pill, { tone: 'ok' }, '已探测')
            : ov?.data?.health
              ? h(Pill, { tone: 'warn' }, '未找到')
              : h(Pill, { tone: 'off' }, '检测中')),
        h(Row, { label: 'dshBin', help: '留空自动探测（…/@deepseek-ai/dsh/lib/bin.js）', wide: true },
          h('input', {
            className: 'bf-input', value: draft.dshBin || '', style: { width: '100%' },
            'aria-label': 'dshBin', placeholder: '留空自动探测',
            onChange: (e) => set('dshBin', e.target.value),
          })),
        h(Row, { label: 'headless profile', help: '值班轮用独立 profile，避免与桌面版抢锁' },
          h(Tag, null, draft.headlessProfile || 'headless')),
        h(Row, { label: '家目录', help: ov?.data?.home || '—' },
          h('span', { className: 'bf-mono' }, ov?.data?.home || '—')),
        h(Row, { label: '账本', help: ov?.data?.ledgerFile || '—' },
          h('span', { className: 'bf-mono' }, ov?.data?.ledgerFile || '—')),
        h(Row, { label: '安装自检', help: '检查 Python 依赖、MCP 连接、登录凭证与模型是否就绪', wide: true },
          h(DiagnosePanel, { report: diag.report, loading: diag.loading, error: diag.error, onRun: diag.run })),
      )

      const body = sub === 'rules'
        ? h('div', { className: 'bf-config' }, rulesGroup, quotaGroup)
        : sub === 'content'
          ? h('div', { className: 'bf-config' }, contentGroup, banGroup, growthGroup, qualityGateGroup,
              h('div', { className: 'bf-note', style: { marginTop: 12 } },
                '人设内容（身份 / 口吻 / 素材 / 回滚）统一在「人设」页维护；设置页只放运行参数与默认禁令。'))
          : h('div', { className: 'bf-config' },
              h(ModelFields, { draft, onChange: setPatch, models, onFollow: followDefault }),
              envGroup,
              h(Card, null,
                h('div', { className: 'bf-card-head' },
                  h('span', { className: 'bf-card-title' }, '宿主日志'),
                  h('span', { className: 'bf-card-note' }, '结构化，异常标红'),
                ),
                h(LogPane, { embedded: true }),
              ),
            )

      return h('div', { className: 'bf-config' },
        body,
        h('div', { className: 'bf-savebar' },
          dirtyKeys.length
            ? h(React.Fragment, null,
                h('span', { className: 'bf-savebar-dot' }),
                h('span', { className: 'bf-note' }, dirtyKeys.length + ' 处修改未保存'))
            : h('span', { className: 'bf-note' }, msg || '与持久化配置一致'),
          h(Btn, { variant: 'ghost', onClick: resetDefault }, '恢复默认'),
          h(Btn, { variant: 'primary', onClick: save }, '保存并生效'),
        ),
      )
    }

    function LogPane({ embedded }) {
      const log = usePoll(React.useCallback(() => apiGet('/log?tail=200'), []), 5000)
      const [openRaw, setOpenRaw] = React.useState(false)
      const events = log.data?.events || []
      const list = events.length
        ? events.slice(-40).map((line, i) => {
            const t = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/.exec(line)
            const msg = t ? line.slice(t[0].length) : line
            const err = /失败|错误|异常|error/i.test(msg)
            return h('div', { className: `bf-log-line${err ? ' err' : ''}`, key: i },
              h('span', { className: 'bf-log-t' }, t ? hhmmss(t[1]) : ''),
              h('span', { className: 'bf-log-msg' }, msg),
            )
          })
        : h('div', { className: 'bf-note' }, '（还没有宿主事件）')
      return h('div', null,
        h('div', { className: 'bf-tools', style: { marginBottom: 8 } },
          h('span', {
            className: 'bf-mono',
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
          }, log.data?.path || ''),
          h(Btn, {
            small: true, variant: 'ghost',
            onClick: () => navigator.clipboard?.writeText(log.data?.path || ''),
          }, '复制路径'),
        ),
        h('div', { className: 'bf-log-events' }, list),
        h('details', {
          className: 'bf-group', open: openRaw,
          onToggle: (e) => setOpenRaw(e.currentTarget.open),
        },
          h('summary', null, '子进程原文（含模型推理文本，默认收起）'),
          h('pre', { className: 'bf-raw' }, log.data?.raw || ''),
        ),
        embedded ? null : null,
      )
    }

    /* ═══════════════════════ §8 概览 ═══════════════════════ */

    const Metric = ({ label, value, unit, foot, bar, tone }) =>
      h('div', { className: 'bf-metric' },
        h('div', { className: 'bf-metric-label' }, label),
        h('div', { className: 'bf-metric-value' }, String(value ?? '—'), unit ? h('small', null, unit) : null),
        foot ? h('div', { className: 'bf-metric-foot' }, foot) : null,
        bar == null ? null : h('div', { className: 'bf-bar' }, h('i', { className: tone || '', style: { width: bar } })),
      )

    const HEALTH_KIND = { pass: 'rep', warn: 'warn', fail: 'err' }
    const LIVE_PHASES = [['think', '思考'], ['find', '找内容'], ['watch', '看内容'], ['act', '发言']]
    const LIVE_KINDS = [['all', '全部'], ['host', '宿主'], ['tool', '工具'], ['reasoning', '推理'],
      ['text', '输出'], ['state', '状态'], ['error', '错误']]

    const liveClock = (iso) => {
      try { return new Date(iso).toTimeString().slice(0, 8) } catch { return '' }
    }

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

    /**
     * 运行详情（原「实时」页并入概览）：
     *  - 运行中：阶段轨 + 秒表 + 工具/动作统计 + 事件流（可筛选、自动滚动、降级提示）；
     *  - 空闲：折叠成一行摘要 + [跑一轮]。
     */
    function RunningDetail({ live, round, onRun, onStop }) {
      const d = live?.data || LIVE_EMPTY
      const mode = live?.mode || 'poll'
      const err = live?.error || ''
      const running = !!(d.running || (round && round.running))
      const elapsed = useElapsed(running, d.startedAt, d.elapsedMs || (round && round.elapsedMs))
      const [filter, setFilter] = React.useState('all')
      const [autoScroll, setAutoScroll] = React.useState(true)
      const bodyRef = React.useRef(null)
      const events = d.events || []
      const shown = filter === 'all' ? events : events.filter((e) => (e.kind || 'text') === filter)
      const stats = d.stats || (round && round.stats) || {}
      const acts = stats.actions || {}
      const toolTotal = Object.values(stats.tools || {}).reduce((n, v) => n + (Number(v) || 0), 0)
      const phaseKey = (d.phase && d.phase.key) || (round && round.phase && round.phase.key) || 'think'
      const phaseLabel = (d.phase && d.phase.label) || (round && round.phase && round.phase.label) || '思考'
      const phaseIdx = Math.max(0, LIVE_PHASES.findIndex(([k]) => k === phaseKey))

      React.useEffect(() => {
        const el = bodyRef.current
        if (!el || !autoScroll || !running) return
        el.scrollTop = el.scrollHeight
      }, [events.length, autoScroll, running])

      const onScroll = () => {
        const el = bodyRef.current
        if (!el) return
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        if (!nearBottom && autoScroll) setAutoScroll(false)
      }

      if (!running) {
        const lr = round?.lastRound || null
        const c = lr?.counts || {}
        const lastAt = lr?.endedAt || round?.lastRunAt
        return h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '运行'),
            h('span', { className: 'bf-card-note' }, lastAt ? '上次 ' + hhmm(lastAt) : '还没跑过'),
            h(Sp),
            h(Btn, { small: true, variant: 'primary', onClick: onRun }, T.run),
          ),
          h('div', { className: 'bf-tools' },
            h(Pill, { tone: 'off' }, '空闲'),
            h('span', { className: 'bf-note' },
              lr
                ? `上一轮 看 ${c.views ?? 0} · 赞 ${c.likes ?? 0} · 评 ${c.comments ?? 0} · 接话 ${c.proactive ?? 0}` +
                  ` · 跳过 ${c.skips ?? 0} · 耗时 ${fmtDur(lr.durationMs)}`
                : '还没有跑过；点「跑一轮」开始。'),
            err ? h('span', { className: 'bf-note' }, '· 实时流：' + err) : null,
          ),
        )
      }

      return h(Card, { p0: true },
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '运行详情'),
          h(Pill, { tone: 'ok' }, '运行中'),
          mode === 'poll' ? h(Tag, { kind: 'warn' }, '降级轮询') : null,
          h('span', { className: 'bf-live-clock' }, fmtDur(elapsed)),
          h('span', { className: 'bf-card-note' }, '· ' + phaseLabel),
          h(Sp),
          h('span', { className: 'bf-note' }, '自动滚动'),
          h(Switch, { checked: autoScroll, label: '自动滚动', onChange: setAutoScroll }),
          h(Btn, { small: true, variant: 'danger', onClick: onStop }, T.stop),
        ),
        h('div', { className: 'bf-stages', style: { '--n': LIVE_PHASES.length, marginTop: 4 } },
          LIVE_PHASES.map(([k, label], i) => h('div', {
            key: k, className: 'bf-stage' + (i <= phaseIdx ? ' done' : ''),
          }, h('b'), h('span', null, label),
             h('em', null, i < phaseIdx ? '完成' : i === phaseIdx ? '进行中' : '等待'))),
        ),
        h('div', { className: 'bf-tools', style: { margin: '8px 0' } },
          h('span', { className: 'bf-note st' }, '事件流'),
          h('span', { className: 'bf-note' },
            `· 工具 ${toolTotal} 次 · 赞 ${acts.like || 0} · 评 ${acts.comment || 0}` +
            ` · 接话 ${acts.proactive || 0} · 扫描 ${acts.scan || 0} · 动态 ${acts.dynamic || 0}`),
          stats.errors ? h(Tag, { kind: 'err' }, '错误 ' + stats.errors) : null,
          h(Sp),
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
          err ? h('span', { className: 'bf-live-err' }, err) : null,
          h('span', null, 'SSE 优先，断线降级轮询'),
        ),
      )
    }

    /** 今日产出：数字带 + 最近 3 条它说过的话 */
    /** 当前账号：头像 + 昵称/UID + 关键数字（粉丝/关注/硬币/等级）+ 凭证状态与重新登录
     *  三态：还没拿到信封（loaded=false）→「读取中」；拿到但未登录 → 登录引导；已登录 → 资料。 */
    function AccountCard({ account, onLogin, loaded = true }) {
      const [faceOk, setFaceOk] = React.useState(true)
      const a = account || null
      const loggedIn = !!a && a.loggedIn !== false
      const uname = (a && a.uname) || ''
      const initial = (uname || 'B').slice(0, 1)
      const showFace = !!(loggedIn && a && a.face && faceOk)
      const stat = (v) => (v == null || v === '' ? '—' : (typeof v === 'number' ? fmtNum(v) : String(v)))
      const stats = [
        ['粉丝', a ? a.fans : null],
        ['关注', a ? a.following : null],
        ['硬币', a ? a.coins : null],
      ]
      const note = !loaded ? '读取中…'
        : !loggedIn ? '未登录'
          : a.stale ? '凭证有效（信息为缓存）' : '凭证有效'
      return h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '当前账号'),
          h('span', { className: 'bf-card-note' }, note),
          loggedIn && a.checkedAt
            ? h('span', { className: 'bf-card-note' }, '· 检查于 ' + hhmmss(a.checkedAt)) : null,
          h(Sp),
          h(Btn, { small: true, variant: 'ghost', onClick: onLogin }, loggedIn ? '重新登录' : '扫码登录'),
        ),
        h('div', { className: 'bf-account' },
          h('div', { className: 'bf-avatar', 'aria-hidden': 'true' },
            showFace
              ? h('img', {
                  src: a.face, alt: uname || '头像', referrerPolicy: 'no-referrer',
                  onError: () => setFaceOk(false),
                })
              : initial),
          h('div', { className: 'bf-account-main' },
            h('div', { className: 'bf-account-name' },
              h('span', null, loggedIn ? (uname || '已登录') : (loaded ? '未登录' : '读取中…')),
              loggedIn && a.vip ? h('span', { className: 'bf-lv' }, '大会员') : null,
              loggedIn && a.level != null ? h('span', { className: 'bf-lv' }, 'LV' + a.level) : null,
            ),
            h('div', { className: 'bf-account-meta' },
              loggedIn && a.mid ? 'UID ' + a.mid : 'UID —'),
          ),
          h('div', { className: 'bf-acct-stats' }, stats.map(([k, v]) => h('div', { className: 'bf-acct-stat', key: k },
            h('div', { className: 'bf-acct-stat-v' }, stat(v)),
            h('div', { className: 'bf-acct-stat-k' }, k),
          ))),
        ),
      )
    }

    function TodayCard({ quota, presence, act, onGo }) {
      const limits = quota.limits || {}
      const today = dayKeyOf()
      let views = null
      if (act && act.days) {
        views = flattenActivityEvents(act).filter((e) => e.type === 'view' && dayKeyOf(e.t) === today).length
      }
      const n = {
        views: views == null ? (quota.picked ?? 0) : views,
        likes: quota.likes ?? 0,
        comments: quota.comments ?? 0,
        proactive: quota.repliesProactive ?? 0,
        dynamics: quota.dynamics ?? 0,
      }
      const sep = () => h('span', { className: 'bf-today-sep' }, '·')
      const said = todayComments(act, 3)
      const latest = (presence && presence.latest) || quota.latest || null
      return h(Card, { p0: true },
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '今日产出'),
          h('span', { className: 'bf-card-note' }, today),
        ),
        h('div', { className: 'bf-today' },
          h('span', { className: 'bf-today-item' }, h('span', { className: 'bf-today-n' }, String(n.views)), '看'),
          sep(),
          h('span', { className: 'bf-today-item' }, h('span', { className: 'bf-today-n' }, String(n.likes)), '赞'),
          sep(),
          h('span', { className: 'bf-today-item' }, h('span', { className: 'bf-today-n' }, String(n.comments)), '评'),
          sep(),
          h('span', { className: 'bf-today-item' }, h('span', { className: 'bf-today-n' }, String(n.proactive)), '接话'),
          sep(),
          h('span', { className: 'bf-today-item' }, h('span', { className: 'bf-today-n' }, String(n.dynamics)), '动态'),
          limits.commentsPerDay ? h('span', { className: 'bf-note' }, '（评论上限 ' + limits.commentsPerDay + '）') : null,
        ),
        h('div', { className: 'bf-said', style: { marginTop: 12 } },
          said.length
            ? said.map((c, i) => h('div', { className: 'bf-said-row', key: i },
                h('div', { className: 'bf-said-main' },
                  h('div', { className: 'bf-said-text' }, c.text),
                  h('div', { className: 'bf-said-meta' },
                    h('span', { className: 'bf-note' }, (hhmm(c.t) || '') + (c.title ? ' · ' + c.title : '')),
                    c.bvid ? h('span', { className: 'bf-bvid' }, c.bvid) : null,
                  ),
                ),
              ))
            : h('div', { className: 'bf-note' }, latest
                ? '最近一条：' + latest.text
                : '今天还没有发过评论。跑一轮后，它说过的话会出现在这里。'),
        ),
        h('div', { className: 'bf-card-foot' },
          h('span', { className: 'bf-note' }, said.length ? '只显示今天最近 ' + said.length + ' 条' : ''),
          h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('activity') }, '全部活动'),
        ),
      )
    }

    /** 接话卡：今日 / 上轮扫描 / 接了几个 / 不接理由 / 未扫描红标 */
    function ProactiveCard({ quota, round, act, onGo }) {
      const scans = quota.replyScans ?? 0
      const posted = quota.repliesProactive ?? 0
      const skipped = quota.proactiveSkipped ?? 0
      const lr = round?.lastRound || null
      const lrc = lr?.counts || {}
      const lastScans = lrc.scans ?? null
      const lastProactive = lrc.proactive ?? null
      const missing = lr ? !!lr.proactiveMissing : false
      let lastScanEv = null
      if (act && act.days) {
        const evs = flattenActivityEvents(act).filter((e) => e.type === 'reply-scan' && e.t)
        evs.sort((a, b) => String(b.t).localeCompare(String(a.t)))
        lastScanEv = evs[0] || null
      }
      const reason = lastScanEv
        ? (lastScanEv.decision === 'posted'
            ? '接了 rpid ' + (lastScanEv.postedRpid ?? lastScanEv.targetRpid ?? '—')
            : '不接' + (lastScanEv.reason ? '（' + lastScanEv.reason + '）' : ''))
        : ''
      return h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '接话'),
          h('span', { className: 'bf-card-note' }, '每轮必须扫描，接不接自由'),
          h(Sp),
          missing ? h(Tag, { kind: 'err' }, '未扫描') : null,
          h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('activity') }, '看接话记录'),
        ),
        h('div', { className: 'bf-tools' },
          h('span', { className: 'bf-note st' }, '今日'),
          h('span', { className: 'bf-strong' }, '扫描 ' + scans + ' · 接 ' + posted + (skipped ? ' · 不接 ' + skipped : '')),
          h('span', { className: 'bf-note' }, '·'),
          h('span', { className: 'bf-note st' },
            lastScans == null ? '上轮：无记录' : '上轮：扫描 ' + lastScans + ' → 接 ' + (lastProactive ?? 0)),
          reason ? h('span', { className: 'bf-note' }, '· ' + reason) : null,
        ),
        missing
          ? h('div', { className: 'bf-banner error', style: { marginTop: 8 } },
              h('span', null, '上一轮有看视频但没有任何接话扫描记录 —— 检查 prompts/duty.md 的「接话扫描」纪律是否生效。'))
          : null,
      )
    }

    /** 配额：日累计 / 本轮 分栏，3×2 网格（不再有孤儿瓦片） */
    function QuotaCard({ quota }) {
      const limits = quota.limits || {}
      const per = quota.perRound || {}
      const cells = [
        ['挑中', quota.picked, per.picked, limits.perDay],
        ['评论', quota.comments, per.comments, limits.commentsPerDay],
        ['点赞', quota.likes, per.likes, limits.likesPerDay],
        ['动态', quota.dynamics, per.dynamics, limits.dynamicsPerDay],
        ['跟进回复', quota.replies, per.replies, limits.repliesPerRound],
        ['主动接话', quota.repliesProactive, per.proactive, limits.replyOthersPerRound],
      ]
      return h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '配额'),
          h('span', { className: 'bf-card-note' }, '今日累计 / 本轮已用 / 上限'),
          h(Sp),
          h('span', { className: 'bf-note' }, '接话扫描 ' + (quota.replyScans ?? 0) + ' 次'),
        ),
        h('div', { className: 'bf-grid-6' }, cells.map(([label, day, roundN, limit]) => {
          const used = Number(day) || 0
          const lim = Number(limit) || 0
          const ratio = lim > 0 ? Math.round((used / lim) * 100) : 0
          return h('div', { className: 'bf-metric', key: label },
            h('div', { className: 'bf-metric-label' }, label),
            h('div', { className: 'bf-metric-value' }, String(used), lim ? h('small', null, '/ ' + lim) : null),
            h('div', { className: 'bf-bar' }, h('i', {
              // 用满（=100%）是正常状态，只有超配才标红；旧版 1/1 也标红，看着像出错
              className: ratio > 100 ? 'over' : ratio >= 80 ? 'warn' : '',
              style: { width: Math.min(100, ratio) + '%' },
            })),
            h('div', { className: 'bf-metric-foot' }, '本轮 ' + (Number(roundN) || 0)),
          )
        })),
      )
    }

    /** 存在感（服务端算，available:false 时给说明而不是假 0） */
    function PresenceCard({ presence }) {
      const p = presence || {}
      const avail = p.available !== false
      const trend = Array.isArray(p.trend) ? p.trend : []
      const max = Math.max(1, ...trend.map((x) => Number(x.count) || 0))
      return h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '存在感（近 7 天）'),
          h('span', { className: 'bf-card-note' }, '收到点赞 / 被回复 / 发出的评论'),
        ),
        h('div', { className: 'bf-grid-3' },
          h(Metric, { label: '收到点赞', value: avail ? fmtNum(p.likes7d ?? 0) : '—', foot: avail ? '正向证据才算可见' : '无数据源' }),
          h(Metric, { label: '被回复', value: fmtNum(p.replies7d ?? 0), foot: '来自通知流' }),
          h(Metric, { label: '发出的评论', value: fmtNum(p.comments7d ?? 0), foot: '最近 7 天' }),
        ),
        !avail && p.note ? h('div', { className: 'bf-note', style: { marginTop: 10 } }, p.note) : null,
        avail && trend.length
          ? h('div', { style: { marginTop: 12 } },
              h('div', { className: 'bf-note', style: { marginBottom: 2 } }, '每日分布'),
              h('div', { className: 'bf-spark' }, trend.map((d) => h('div', {
                className: 'bf-spark-col', key: d.date, title: d.date + ' · ' + d.count,
              },
                h('div', { className: 'bf-spark-bars' },
                  h('div', {
                    className: 'bf-spark-b',
                    style: { height: Math.max(2, Math.round((Number(d.count) || 0) / max * 44)) },
                  })),
                h('div', { className: 'bf-spark-l' }, String(d.date || '').slice(5)),
              ))),
            )
          : null,
        p.latest ? h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '.5px solid var(--border-l2)' } },
          h('div', { className: 'bf-note' }, '最近一条评论' + (p.latest.title ? ' · ' + p.latest.title : '')),
          h('div', { className: 'bf-quote', style: { marginTop: 4 } }, p.latest.text),
          h('div', { className: 'bf-note' }, hhmm(p.latest.t) + (p.latest.bvid ? ' · ' + p.latest.bvid : '')),
        ) : null,
      )
    }

    /** 人设一句话 + 健康检查（各一行，可展开） */
    function PersonaHealthCard({ persona, health, model, onGo, loaded = true }) {
      const p = persona || {}
      const ph = p.health || {}
      const pact = p.active || {}
      const preset = (p.presets || []).find((x) => x.id === pact.presetId) || null
      const l0checks = ((ph.l0 || {}).checks) || []
      const legacy = ph.mode === 'legacy'
      const items = [
        {
          id: 'cred', label: 'B站登录凭证', status: health.cred ? 'pass' : 'warn',
          detail: health.cred ? '凭证文件存在（未联网校验）'
            : loaded ? '没有凭证文件，先扫码登录' : '读取中…',
        },
        {
          id: 'cli', label: 'dsh CLI', status: health.cli ? 'pass' : 'warn',
          detail: health.cli || (loaded ? '未找到（可在设置里指定 dshBin）' : '读取中…'),
        },
        {
          id: 'route', label: '控制台路由', status: health.routeOk ? 'pass' : 'fail',
          detail: health.routeOk ? '已挂载 /api/bili-fenshen' : '未挂载',
        },
        {
          id: 'model', label: '模型', status: (model.provider || model.name) ? 'pass' : 'warn',
          detail: [model.provider, model.name, model.reasoningEffort].filter(Boolean).join(' / ') || '跟随当前会话默认',
        },
      ]
      const bad = items.filter((x) => x.status !== 'pass').length
      return h(Card, null,
        h('div', { className: 'bf-card-head' },
          h('span', { className: 'bf-card-title' }, '人设与健康'),
          h('span', { className: 'bf-card-note' },
            !loaded ? '读取中…' : bad ? bad + ' 项需注意' : '全部正常'),
          h(Sp),
          h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('persona') }, '人设'),
          h(Btn, { small: true, variant: 'ghost', onClick: () => onGo('settings') }, '设置'),
        ),
        h('div', { className: 'bf-tools' },
          h(Pill, { tone: legacy ? 'warn' : 'ok' }, legacy ? 'legacy 直通' : '卡生效'),
          h('span', { className: 'bf-strong' }, preset?.name || (legacy ? '旧格式人设' : '未加载')),
          l0checks.length
            ? h(Tag, { kind: 'like' }, 'L0 ' + l0checks.filter((c) => c.level === 'pass').length + '/' + l0checks.length)
            : null,
          h(Tag, { kind: 'like' }, '语料 ' + ((p.bank || {}).total ?? 0) + ' 条'),
          h('span', { className: 'bf-note' },
            '· ' + items.filter((x) => x.status === 'pass').length + '/' + items.length + ' 检查通过'),
        ),
        h('details', { className: 'bf-group' },
          h('summary', null, '健康检查明细'),
          h('div', { className: 'bf-health', style: { marginTop: 6 } },
            items.map((it) => h('div', { className: 'bf-kv-row', key: it.id },
              h('span', { className: 'bf-kv-k' }, it.label),
              h('span', { className: 'bf-kv-v' },
                h(Tag, { kind: HEALTH_KIND[it.status] || 'warn' },
                  it.status === 'pass' ? '通过' : it.status === 'warn' ? '注意' : '失败'),
                h('span', { className: 'bf-note', style: { marginLeft: 8 }, title: it.detail }, it.detail),
              ),
            )),
          ),
        ),
      )
    }

    /** 发言门控卡：回答「这轮为什么说 / 不说」（W7-2）。两态：有数据 / 暂无数据。
     *  数据源就是概览信封的 round.speakGate（口径见 plan §8.5），缺失时退化为「暂无数据」而不是藏掉整块。
     *  注意后端口径 = currentAcc || lastRound：空闲时这条是**上一轮**的判定，别写成「本轮」。 */
    function SpeakGateCard({ gate, loaded, running }) {
      return h('div', { 'data-block': 'overview-speak-gate' },
        h(Card, null,
          h('div', { className: 'bf-card-head' },
            h('span', { className: 'bf-card-title' }, '发言门控'),
            h('span', { className: 'bf-card-note' },
              gate ? (running ? '本轮为什么说 / 不说' : '上一轮为什么说 / 不说') : loaded ? '暂无数据' : '正在连接…'),
            h(Sp),
            gate ? h(SpeakGateTags, { gate }) : null,
          ),
          gate
            ? h('div', null,
                gate.reason || gate.featText
                  ? h('div', { className: 'bf-pf-sub' }, [gate.reason, gate.featText].filter(Boolean).join(' · '))
                  : h('div', { className: 'bf-note' }, '后端没给理由（只拿到了模式与判定）。'),
                h('div', { className: 'bf-tools', style: { marginTop: 6 } },
                  h('span', { className: 'bf-note st' }, '判定'),
                  h('span', { className: 'bf-strong', style: { fontSize: 13, lineHeight: '20px' } }, gate.decisionText),
                  gate.decision === 'throttle' && gate.suggestedMaxComments
                    ? h('span', { className: 'bf-note' }, gate.mode === 'enforce'
                        ? '· 本轮评论上限压到 ' + gate.suggestedMaxComments + ' 条'
                        : '· 建议本轮最多 ' + gate.suggestedMaxComments + ' 条（不强制）')
                    : null,
                  gate.decision === 'forced'
                    ? h('span', { className: 'bf-note' }, '· 被回复 / 被 @ 直接放行，仍占配额') : null,
                ),
                h('div', { className: 'bf-note', style: { marginTop: 4 } }, gate.modeNote),
                gate.modeKnown === false
                  ? h('div', { className: 'bf-note' }, 'mode 字段缺失或无法识别，按观察档显示（不谎称在强制拦截）。')
                  : null,
              )
            : h('div', { className: 'bf-note' },
                loaded
                  ? '还没有门控数据：这一轮没跑过带门控的值班，或门控已关闭。'
                  : '正在连接…'),
        ),
      )
    }

    function OverviewPage({ rt, act, persona, live, onRun, onStop, onLogin, onGo }) {
      const data = (rt && rt.data) || {}
      // ⭐ 真正的信封一定有内容；空对象（首帧未到 / 失败兜底）不算「有数据」，
      //    否则会把未加载状态渲染成「未登录 / 未找到 / 数据 刚刚」这类假结论。
      const hasData = !!(rt && rt.data && Object.keys(rt.data).length > 0)
      const duty = data.duty || {}
      const round = data.round || {}
      const quota = data.quota || {}
      const account = data.account || null
      const health = data.health || {}
      const model = data.model || {}
      const presence = data.presence || null
      const inbox = data.inbox || null
      const running = !!round.running || !!(live && live.data && live.data.running)
      const nextLabel = duty.nextWindowLabel || round.nextWindowLabel || '—'
      const mode = (rt && rt.mode) || 'poll'
      const ageMs = (rt && rt.ageMs) || 0
      const err = (rt && rt.error) || ''
      const speakGate = speakGateOf(round.speakGate)

      const statusLine = h('div', { className: 'bf-statusline' },
        running ? h(Pill, { tone: 'ok' }, '运行中') : h(Pill, { tone: 'off' }, '空闲'),
        h(Pill, { tone: duty.autoDuty ? 'ok' : 'off' }, duty.autoDuty ? '自动值班开' : '自动值班关'),
        h(Pill, { tone: 'off' }, '下一轮 ' + (duty.autoDuty ? nextLabel : '自动已关')),
        account && account.loggedIn === false
          ? h(Pill, { tone: 'warn' }, '未登录')
          : h(Pill, { tone: 'ok' }, account ? (account.uname || '已登录') : '登录检查中'),
        inbox && Number(inbox.pendingReply) > 0 ? h(Pill, { tone: 'warn' }, '待回 ' + inbox.pendingReply) : null,
        h(Sp),
        h(Freshness, { ageMs, mode, error: err, hasData }),
      )

      return h('div', null,
        h(PageHeader, { title: PAGE_TITLE.overview, intro: PAGE_INTRO.overview },
          account && account.loggedIn === false
            ? h(Btn, { small: true, variant: 'ghost', onClick: onLogin }, T.login) : null,
          h(IconBtn, { label: '刷新', onClick: () => rt && rt.refresh() }, '⟳'),
          h(Btn, { variant: running ? 'danger' : 'primary', onClick: running ? onStop : onRun },
            running ? T.stop : T.run),
        ),
        h('div', { className: 'bf-pagemain' },
          h(Banner, { health, account, round, onLogin }),
          statusLine,
          h(AccountCard, { account, onLogin, loaded: hasData }),
          h(TodayCard, { quota, presence, act, onGo }),
          h(ProactiveCard, { quota, round, act, onGo }),
          h(SpeakGateCard, { gate: speakGate, loaded: hasData, running }),
          h(RunningDetail, { live, round, onRun, onStop }),
          h(QuotaCard, { quota }),
          h('div', { className: 'bf-grid-2' },
            h(PresenceCard, { presence }),
            h(PersonaHealthCard, { persona, health, model, onGo, loaded: hasData }),
          ),
          h('div', { className: 'bf-note', style: { paddingTop: 8, borderTop: '.5px solid var(--border-l2)' } },
            '数据来源：账本 ' + (data.ledgerFile || '—') + ' · 家目录 ' + (data.home || '—') +
            (account && account.stale ? ' · 账号信息为缓存值' : '')),
        ),
      )
    }

    /* ═══════════════════════ §9 页面壳（5 页签） ═══════════════════════ */

    function ConsolePage(props) {
      const initTab = props?.initialTab || 'overview'
      const [tab, setTab] = React.useState(TAB_ALIAS[initTab] || initTab)
      const [activityView, setActivityView] = React.useState(
        initTab === 'seen' ? 'seen' : (props?.initialView || 'life'),
      )
      const [loginOpen, setLoginOpen] = React.useState(false)
      const init = props?.initialData || null

      /* 实时信封：概览 + 账号 + 运行态（唯一数据源） */
      const rt = useRealtime(init?.ov)
      const data = rt.data || null
      const running = !!(data && data.round && data.round.running)
      /* 活动流：不在信封契约里，按页签门控轮询 */
      const actHook = useActivity(running, tab === 'overview' || tab === 'activity')
      const act = actHook.data ? actHook : (init?.act ? { ...actHook, data: init.act } : actHook)
      const personaHook = usePersona(tab === 'overview' || tab === 'persona')
      const persona = personaHook.data ? personaHook : (init?.persona ? { ...personaHook, data: init.persona } : personaHook)
      /* 事件流：只在概览页（运行详情）需要 */
      const liveHook = useLive(tab === 'overview')
      const live = props?.live || liveHook

      const onToggle = React.useCallback(async (v) => {
        try { await apiPost('/duty', { autoDuty: v }) } catch { /* 失败靠刷新反映 */ }
        rt.refresh()
      }, [rt.refresh])
      const onRun = React.useCallback(async () => {
        let r = null
        try { r = await apiPost('/run') } catch { /* 失败靠刷新反映 */ }
        rt.refresh()
        liveHook.refresh()
        if (r?.started || r?.ok) setTab('overview')
      }, [rt.refresh, liveHook.refresh])
      const onStop = React.useCallback(async () => {
        if (typeof window !== 'undefined' && window.confirm
          && !window.confirm('中止本轮值班？子进程会被杀掉，本轮不会留下完整报告。')) return
        try { await apiPost('/stop') } catch { /* 忽略 */ }
        rt.refresh()
        liveHook.refresh()
      }, [rt.refresh, liveHook.refresh])
      const onLogin = React.useCallback(() => { window.dispatchEvent(new CustomEvent('bf-login')) }, [])
      React.useEffect(() => {
        const open = () => setLoginOpen(true)
        window.addEventListener('bf-login', open)
        return () => window.removeEventListener('bf-login', open)
      }, [])
      const onLoggedIn = React.useCallback(() => {
        setLoginOpen(false)
        rt.refresh(); personaHook.refresh()
      }, [rt.refresh, personaHook.refresh])

      const onGo = React.useCallback((k) => {
        if (k === 'activity') { setActivityView('life'); setTab('activity'); return }
        if (k === 'seen') { setActivityView('seen'); setTab('activity'); return }
        setTab(k)
      }, [])

      /** 活动页的视图切换/刷新：'refresh' 是工具栏刷新按钮的特殊值 */
      const onActView = React.useCallback((v) => {
        if (v === 'refresh') { actHook.refresh(); return }
        setActivityView(v)
      }, [actHook.refresh])

      const body = tab === 'overview'
        ? h(OverviewPage, { rt, act, persona, live, onRun, onStop, onLogin, onGo })
        : tab === 'activity'
          ? h(ActivityPage, {
              data: act.data, view: activityView, onView: onActView,
              initial: init, onRun, onLogin, fetchError: actHook.error,
            })
          : tab === 'reports'
            ? h(ReportsPage, { initial: init?.reports })
            : tab === 'persona'
              ? h(PersonaPage, {
                  persona, initial: init?.personaPage || props?.persona,
                  initialTab: props?.initialPersonaTab,
                  ov: data,
                })
              : h(SettingsPage, { ov: { data }, initial: init?.config, initialSub: props?.initialSub })

      return h('div', { className: 'bf-console bf-root', 'data-tab': tab },
        h('div', { className: 'bf-page' },
          h('div', { className: 'bf-pagemain' },
            h('div', { className: 'bf-tabs', role: 'tablist', 'aria-label': '控制台页面' },
              TABS.map(([k, label]) => h('button', {
                key: k, role: 'tab', 'aria-selected': String(tab === k), id: 'bf-tab-' + k,
                'aria-controls': 'bf-panel-' + k, onClick: () => setTab(k),
              }, label)),
            ),
            h('section', {
              role: 'tabpanel', id: 'bf-panel-' + tab, 'aria-labelledby': 'bf-tab-' + tab,
              style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
            }, body),
          ),
        ),
        loginOpen ? h(LoginModal, { onClose: () => setLoginOpen(false), onLoggedIn }) : null,
      )
    }

    /* ─── 设置页瘦身版（settings.section：安装自检 + 打开控制台） ─── */

    let ctxLayout = null

    function SettingsEntry() {
      const rt = useRealtime(undefined, { sse: false })
      const diag = useDiagnose()
      const a = (rt.data && rt.data.account) || {}
      return h('div', { className: 'bf-console', style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 760 } },
        h('div', null,
          h('h2', { style: { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, 'B站分身'),
          h('div', { className: 'bf-note', style: { marginTop: 4 } },
            '让小号在B站保持存在感；安装自检、账号与完整控制台都在这里进入。'),
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
        h('div', { className: 'bf-tools' },
          h('span', { className: 'bf-note' },
            a.loggedIn ? '当前账号：' + (a.uname || '—') + '（UID ' + (a.mid || '—') + '）' : '当前未登录'),
          h(Sp),
          h(Btn, {
            variant: 'primary',
            onClick: () => { try { ctxLayout?.selectPanel?.(PANEL_ID) } catch { /* 老版本宿主没有该 API */ } },
          }, '打开控制台'),
        ),
      )
    }

    /* ═══════════════════════ §10 注册 ═══════════════════════ */

    /* 图标：ownerProps { size, active }；B站粉/蓝只用于侧栏图标 */
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

    const plugin = {
      inject: ['slots', 'layout'],
      apply(ctx) {
        ctxLayout = ctx.get?.('layout') ?? ctx.layout ?? ctxLayout
        ensureStyle()
        // 每个注册独立兜底：一个槽位失败不影响其余
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 15,
            label: () => T.title,
          }, PanelIcon))
        } catch (e) { console.error('[bili-fenshen] 注册侧栏图标失败：', e) }
        try {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: PANEL_ID,
          }, ConsolePage))
        } catch (e) { console.error('[bili-fenshen] 注册 main 面板失败：', e) }
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: PANEL_ID, order: 35, label: T.title,
          }, SettingsEntry))
        } catch (e) { console.error('[bili-fenshen] 注册设置页入口失败：', e) }
      },
    }
    // 测试钩子（render-smoke / 单测验证 W4-4 的 30s 复用）只在测试沙箱里暴露：
    // 生产包不带这个全局面（宿主只读 inject / apply，本来也不碰它）。
    if (globalThis.__BF_TEST__) plugin.__bfTest = { cachedGet, resetGetCache, GET_CACHE, GET_TTL_MS }
    return plugin
  },
})
