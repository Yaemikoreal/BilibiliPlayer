/**
 * dsh-bili-fenshen —— Client 半部（设置页一节：B站分身）
 *
 * 挂载：window.__ModuleLoader__.load 自注册 → settings.section slot。
 * 数据源：/api/bili-fenshen/*（host 路由）。
 * 贴合 DSH 主题：容器用宿主 CSS 变量（--dsh-*），不自带配色；组件内联样式随 unmount 移除。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-fenshen',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const fetchJson = async (path, opts) => {
      const res = await fetch(path, opts);
      return res.json();
    };

    function Panel() {
      const [status, setStatus] = React.useState(null);
      const [report, setReport] = React.useState('');
      const [log, setLog] = React.useState('');
      const [tab, setTab] = React.useState('report');
      const [busy, setBusy] = React.useState(false);
      const [credExists, setCredExists] = React.useState(null);
      const [qrUrl, setQrUrl] = React.useState('');
      const [qrImage, setQrImage] = React.useState('');
      const [loginState, setLoginState] = React.useState('');

      const load = React.useCallback(async () => {
        try {
          const [st, rep, lg, cred] = await Promise.all([
            fetchJson('/api/bili-fenshen/status'),
            fetchJson('/api/bili-fenshen/report'),
            fetchJson('/api/bili-fenshen/log'),
            fetchJson('/api/bili-fenshen/cred'),
          ]);
          setStatus(st);
          setReport(rep.text || '');
          setLog(lg.text || '');
          setCredExists(!!cred.exists);
        } catch (e) { /* 网络抖动，下一轮刷新 */ }
      }, []);

      React.useEffect(() => {
        load();
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
      }, [load]);

      // 扫码轮询：scanned/waiting 时 2 秒一查；ok/expired 时停
      React.useEffect(() => {
        if (!qrUrl) return undefined;
        const t = setInterval(async () => {
          try {
            const r = await fetchJson('/api/bili-fenshen/login/poll');
            setLoginState(r.state === 'waiting' ? '等待扫码…' : r.state === 'scanned' ? '已扫码，请在手机上点确认' : r.state === 'ok' ? '✅ 登录成功' : r.state === 'expired' ? '二维码已过期，请重新生成' : (r.message || r.state));
            if (r.state === 'ok' || r.state === 'expired') { setQrUrl(''); load(); }
          } catch { /* 下一轮再试 */ }
        }, 2000);
        return () => clearInterval(t);
      }, [qrUrl, load]);

      const startLogin = async () => {
        setLoginState('生成二维码…');
        try {
          const r = await fetchJson('/api/bili-fenshen/login/start', { method: 'POST' });
          if (r.ok) {
            setQrUrl(r.url);
            setQrImage(r.qrImage || '');
            setLoginState('等待扫码…');
          } else setLoginState('失败：' + (r.error || '未知'));
        } catch (e) { setLoginState('失败：' + String(e)); }
      };

      const runNow = async () => {
        setBusy(true);
        try { await fetchJson('/api/bili-fenshen/run', { method: 'POST' }); await load(); }
        finally { setBusy(false); }
      };

      const card = { border: '1px solid var(--dsh-border, rgba(128,128,128,.25))', borderRadius: 8, padding: '10px 12px', marginBottom: 10 };
      const btn = { padding: '6px 14px', borderRadius: 6, cursor: 'pointer' };
      const mono = { whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, maxHeight: 320, overflow: 'auto' };

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'B站分身 · 状态'),
          !status ? h('div', null, '加载中…') :
            h('div', { style: { fontSize: 13, lineHeight: 1.8 } },
              h('div', null, '值班：', status.autoDuty ? '自动（窗口巡检）' : '手动模式'),
              h('div', null, 'dsh CLI：', status.dutyCli ? '✓ 已找到' : '✗ 未找到'),
              h('div', null, '进行中：', status.running ? '有' : '无'),
              h('div', null, '今日：挑中 ', status.today?.picked ?? 0, ' / 评论 ', status.today?.comments ?? 0,
                ' / 点赞 ', status.today?.likes ?? 0, ' / 动态 ', status.today?.dynamics ?? 0),
              h('div', null, '最近一轮：', status.lastRunAt || '（还没跑过）'),
            ),
          h('button', { style: btn, disabled: busy, onClick: runNow },
            busy ? '已触发，看日志…' : '▶ 现在跑一轮'),
        ),
        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '小号登录'),
          h('div', { style: { fontSize: 13, marginBottom: 8 } },
            credExists === null ? '检查中…' : credExists ? '✅ 已有登录凭证（bili_credential.json）' : '未登录 —— 用小号扫码（手机确认时选「记住我 / 长期」）'),
          !qrUrl
            ? h('button', { style: btn, onClick: startLogin }, '生成登录二维码')
            : h('div', null,
                h('img', {
                  src: qrImage || ('https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=' + encodeURIComponent(qrUrl)),
                  alt: '登录二维码', width: 220, height: 220,
                  style: { borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,.25))' },
                }),
                h('div', { style: { fontSize: 13, marginTop: 8 } }, loginState),
                h('button', { style: { ...btn, marginTop: 8 }, onClick: startLogin }, '重新生成'),
              ),
        ),
        h('div', null,
          ['report', 'log'].map((t) =>
            h('button', {
              key: t,
              style: { ...btn, marginRight: 8, fontWeight: tab === t ? 700 : 400 },
              onClick: () => setTab(t),
            }, t === 'report' ? '今日日报' : '运行日志')),
        ),
        tab === 'report'
          ? h('div', { style: { ...card, ...mono } }, report || '（今天还没有报告）')
          : h('div', { style: { ...card, ...mono } }, log || '（日志为空）'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'bili-fenshen', order: 35, label: 'B站分身',
        }, Panel));
      },
    };
  },
});
