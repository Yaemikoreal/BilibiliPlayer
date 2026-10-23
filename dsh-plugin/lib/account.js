/** 账号简况（设计文档 §8 /account）。宿主直连 B站只读接口，失败一律降级。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const REL = (uid) => `https://api.bilibili.com/x/relation/stat?vmid=${uid}`

export function normalizeAccount(nav, rel) {
  const d = nav?.data || {}
  const loggedIn = nav?.code === 0 && d.isLogin === true
  if (!loggedIn) return { loggedIn: false }
  return {
    loggedIn: true,
    uname: String(d.uname || ''),
    mid: String(d.mid || ''),
    face: String(d.face || ''),
    level: Number(d.level_info?.current_level) || 0,
    coins: Number(d.money) || 0,
    vip: d.vipStatus === 1,
    fans: Number(rel?.data?.follower) || 0,
    following: Number(rel?.data?.following) || 0,
  }
}

export async function fetchAccount(cred, fetchImpl = fetch) {
  if (!cred?.sessdata) return { loggedIn: false }
  const cookie = `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`
  const headers = { 'User-Agent': UA, Cookie: cookie, Referer: 'https://www.bilibili.com/' }
  const nav = await fetchImpl(NAV, { headers }).then((r) => r.json()).catch(() => null)
  const mid = nav?.data?.mid
  const rel = mid ? await fetchImpl(REL(mid), { headers }).then((r) => r.json()).catch(() => null) : null
  return normalizeAccount(nav, rel)
}
