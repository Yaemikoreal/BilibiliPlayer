# 账本/概览性能基准（node v24.14.0，200 次采样 p95）

> 由 `node scripts/bench-ledger.mjs` 生成，口径见脚本头部注释。

## 1k 行（1000 事件 / 105 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 1.97 | 2.8 |
| 现状 | buildOverview（已是数组，纯计算） | 0.65 | 1.13 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 2.79 | 3.67 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 1.89 | 2.95 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.03 | 0.09 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 0.67 | 1.12 |
| 方案 | reader 增量读（追加 100 条后） | 3.94 | 5.03 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）

## 10k 行（10000 事件 / 1071 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 11.5 | 14.38 |
| 现状 | buildOverview（已是数组，纯计算） | 2.31 | 3.35 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 20.79 | 23.09 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 13.81 | 15.54 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.07 | 0.11 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 4.48 | 5.04 |
| 方案 | reader 增量读（追加 100 条后） | 6.77 | 7.84 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）

## 100k 行（100000 事件 / 10877 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 164.22 | 172.39 |
| 现状 | buildOverview（已是数组，纯计算） | 4.17 | 4.68 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 169.65 | 186.81 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 124.5 | 149.48 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.07 | 0.08 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 4.17 | 5.02 |
| 方案 | reader 增量读（追加 100 条后） | 28.81 | 30.92 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）
