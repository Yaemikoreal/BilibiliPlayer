# 账本/概览性能基准（node v24.14.0，200 次采样 p95）

> 由 `node scripts/bench-ledger.mjs` 生成，口径见脚本头部注释。

## 1k 行（1000 事件 / 105 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 2.06 | 2.79 |
| 现状 | buildOverview（已是数组，纯计算） | 0.72 | 1.3 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 3.01 | 4.29 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 2.05 | 3 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.03 | 0.08 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 0.71 | 1.19 |
| 方案 | reader 增量读（追加 100 条后） | 4.04 | 5.57 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）

## 10k 行（10000 事件 / 1071 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 12.01 | 14.78 |
| 现状 | buildOverview（已是数组，纯计算） | 8.92 | 9.75 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 28.03 | 31.17 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 14.97 | 16.45 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.08 | 0.1 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 9.07 | 10.86 |
| 方案 | reader 增量读（追加 100 条后） | 6.9 | 8.96 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）

## 100k 行（100000 事件 / 10877 KB）

| 组 | 场景 | p50 (ms) | p95 (ms) |
|---|---|---:|---:|
| 现状 | readEvents（全量读，现状） | 181.4 | 190.87 |
| 现状 | buildOverview（已是数组，纯计算） | 92.9 | 99.17 |
| 现状 | readEvents + buildOverview（一次概览的现状全流程） | 288.14 | 342.88 |
| 方案 | reader 冷读（新实例首读，等价进程重启） | 122.92 | 163.34 |
| 方案 | reader 稳态读（文件没变 ⇒ 0 次读盘） | 0.1 | 0.12 |
| 方案 | reader 稳态读 + buildOverview（每帧重算的全流程） | 92.28 | 97.06 |
| 方案 | reader 增量读（追加 100 条后） | 29.16 | 30.92 |

读盘账：500 次稳态 read() ⇒ cacheHits 500 / bytesRead +0 B（累计 fullReads 1 / incrementalReads 0 / fallbacks 0）
