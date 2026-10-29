# 账本/概览性能基准（node v24.14.0，200 次采样 p95）

> 由 `node scripts/bench-ledger.mjs` 生成，口径见脚本头部注释。

## 1k 行（1000 事件 / 105 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 2.72 | 3.74 |
| 现状 | buildOverview（已是数组，纯计算） | 0.9 | 1.46 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 3.44 | 4.67 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 2.29 | 3.32 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.03 | 0.09 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 0.74 | 1.4 |
| 方案 | reader 增量读（追加 100 条后） | 4.67 | 5.76 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）

## 10k 行（10000 事件 / 1071 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 13.88 | 20.63 |
| 现状 | buildOverview（已是数组，纯计算） | 24.29 | 26.36 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 43.7 | 48.24 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 15.01 | 17.5 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.08 | 0.11 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 24.69 | 27.3 |
| 方案 | reader 增量读（追加 100 条后） | 7.47 | 8.47 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）

## 100k 行（100000 事件 / 10877 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 173.52 | 182.29 |
| 现状 | buildOverview（已是数组，纯计算） | 2291.64 | 2554.13 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 2588.96 | 2728.68 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 126.59 | 170.31 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.11 | 0.14 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 2522.6 | 2634.66 |
| 方案 | reader 增量读（追加 100 条后） | 28.75 | 32.42 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）
