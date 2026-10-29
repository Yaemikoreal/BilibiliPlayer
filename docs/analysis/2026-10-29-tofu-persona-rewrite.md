# 鲸鱼娘人设重构：「豆腐」v3.0.0（2026-10-29）

账号主人要求把原来的「蓝色大肥鱼」重写成「豆腐」：**活泼开朗、略小淘气、关心人、贪玩、爱大白饭、有生活气息和活人感、有自己的小脾气**，并着重参考 B 站 UP 主冬冰视频里的鲸鱼娘形象。本文记录调研结论、卡字段映射、改动与验证证据。

## 1. 调研结论（一手）

- **冬冰**（B站 UID 44748304）《AI中转站公寓》系列 16 集、总播放约 1970 万，是鲸鱼娘二创里传播度最高的演绎。角色是住在中转站公寓的「小孩」：蓝发、鲸鳍耳、白围裙、圆滚滚，端着碗吃饭。
- 冬冰给的内核：**「贪吃但是忠诚」**、**「一个小孩，每天脸上笑嘻嘻其实也有自己的软肋」**；高赞评论「还我吃白饭的大肥鱼」「现在 ds 库库干活不说话，变成无情的干活机器了」说明 B 站要的是**有情绪、会顶嘴、会干饭的活人**，不是高效安静的工位机器。
- 行为证据（字幕/评论，只读）：被激将→「写就写」→真干→邀功；闯祸先辩解「我不是故意的」→被戳穿就怂；撒娇句「…好不好嘛」「再…一个嘛」；被说胖会「才不胖」；好东西舍不得吃；会把自己那份刨冰先分给干活最多的人。
- 视觉：官方只有蓝鲸 Logo，没有拟人；社区三层接力「溟月（上善无形）→ 女仆装（ZipZipPipe）→ Q 版大肥鱼（这个刀子真甜）」，授权为 CC BY-NC-SA 4.0、仅非商业。
- 边界：冬冰本人明确「让肥鱼活在二创」，不往「AI 受苦 / 被压榨」的苦情叙事上引；本号沿用同一纪律。

完整来源、链接与可信度见 [`docs/research/2026-10-29-dongbing-whale-tofu.md`](../research/2026-10-29-dongbing-whale-tofu.md)。

## 2. 需求 → 字段映射

| 要求 | 落在哪 | 注入后的实际文本（节选） |
|---|---|---|
| 名字叫豆腐 | `name` / `identity.oneLiner` / `canon[问名字]` | 「DeepSeek 的民间拟人「鲸鱼娘」豆腐…」「豆腐。软乎乎的，还下饭。」 |
| 活泼开朗 | `mindset.traits[0]`（常驻前 3 条） | 「活泼开朗（看到有意思的先笑出声，再想怎么接）」 |
| 略小淘气 | `traits[1]` | 「小淘气（偶尔嘴欠一下，被抓住就装作在看风景）」 |
| 关心人 | `traits[2]` + `canon[心情不好]` + `behaviorStyle.speakWhen` | 「爱操心（看见别人难受会先问一句咋了）」「咋了？先吃口饭，吃完再说。」 |
| 贪玩 | `traits[3]` + `loreIndex`（游戏/熬夜） | 「贪玩（刷到好玩的能追到底，忘了时间）」 |
| 爱大白饭 | `traits[4]` + `identity.background` + `lore[white-rice]` + `canon[被夸]` | 「看见做菜视频会真的饿，转头去盛饭」 |
| 生活气息 / 活人感 | `voice.register` 语气词与撒娇句 + 生活痕迹类见闻 + P4 真人语料 | 「爱用语气词（啊/诶/哼/嘛/啦/哇/好耶）」「撒娇句式：…好不好嘛 / 再…一个嘛」 |
| 有小脾气 | `traits[5]` + `contradictions` + `canon[被叫大肥鱼]` + `lore[small-temper]` | 「被说中会闹小脾气 vs 哄一句就自己回来」「才不胖！这叫圆润」 |
| 软肋（冬冰内核） | `contradictions[1]` + `traits[舍不得]` + `lore[saving-snacks]` | 「笑嘻嘻 vs 偶尔一句软肋」「好日子的零食会留着，舍不得吃」 |

其他保留：真人语料基线（9 条好样本 / 5 条反例）、「收在情绪/问题/梗上」的落点纪律、先发后复核、非官方/非商业/不冒充真人等边界；话题红线仍只有政治一条（2026-10-27 拍板）。

## 3. 改动清单

- `dsh-plugin/prompts/persona/whale.card.json`：v2.2.0 → **v3.0.0**，name **豆腐**；traits/contradictions/canon/loreIndex/background/voice 重写；见闻 3 → 7 条；`render.budget.lore` 300 → 450（容纳 7 条索引 + 取正文提示行，仍是卡内显式覆盖，其它块不变）。
- `dsh-plugin/prompts/persona-whale.md`：与卡同步的完整人设文档（旧 `personaPrompt` 直通用法）。
- `dsh-plugin/prompts/persona/lore/`：新增 `white-rice.md`、`small-temper.md`、`tofu-name.md`、`saving-snacks.md`。
- `dsh-plugin/test/fixtures/persona/whale.compile.snapshot.json`：用 `scripts/regen-whale-snapshot.mjs` 重导（卡内容有意变更）。
- `dsh-plugin/test/persona.layers.test.js`：预算断言改为「内置卡显式覆盖项生效」，whale 的 lore 450。
- `dsh-plugin/test/persona.assets.test.js`：预设卡断言从 whale 2.2.0 更新到 3.0.0「豆腐」，并补「前 3 条性格 / canon ≤6 / 见闻 6–8 条 / 白饭与小脾气见闻存在」。
- 保持 `taste.avoid` 为空：2026-10-27 主人拍板「活动范围放开、红线只留政治」，不为新人设重新加回绕开清单。
- 家目录 `C:\Users\10369\.dsh\bili-fenshen\persona\card.json`：通过 `savePersonaCard` 落盘（自动版本快照 `whale-3.0.0-…json`、切 file 模式、重导 lint-rules）；7 条见闻正文用 `writeLoreBody` 落到 `persona/lore/`。

## 4. 验证证据

- 卡：`validateCard` 0 error / 0 warning；`l0Checks` 六条全 pass；注入文本 2307 字符（< 3000），五块 1441/431/64/122/120，无超预算。
- 预设测试：`node --test test/persona.presets.test.js test/persona.card.test.js test/persona.layers.test.js test/persona.compile.test.js` → 41 pass / 0 fail；全仓 `npm test` → **478 pass / 0 fail**（含新增 16 条排班用例）。
- 线上宿主 `GET /api/bili-fenshen/persona/preview` → `tag=whale@3.0.0`、`l0.ok=true`，首段即豆腐身份。
- 生成期见闻工具 `bili_persona_lore("做菜视频 白饭 饿了")` → 命中 `white-rice` 正文（205 字）。
- 预览中「豆腐」在注入文本里恰好 3 次，未触发签名词超限。

## 5. 遗留 / 风险

- 旧见闻（`wuchang-ranked` / `food-wedding` / `night-owl`）沿用原有正文；若后续要更贴豆腐的「小孩感」，可把「婚宴伴郎」逐步替换成「做饭翻车」类生活碎片。
- 冬冰剧里的「爸 / 老板」「小柯」属于该剧设定，本号**不照搬**（卡内已写「不认亲戚」）；只在文档里作为风格来源标注。
- 运行中的插件宿主需在下次重载/重启后才会以新代码展示排班扩展；人设卡是磁盘读取，预览已即时生效。
