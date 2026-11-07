# Validation boundaries

## Standalone offline validation

Validated with Node.js 24.11.0, pnpm 11.7.0, TypeScript 6.0.3 and tsdown 0.22.2 from locked public-registry dependencies, outside the DSH monorepo.

| Suite | Passed assertions | Failed | Skipped |
|---|---:|---:|---:|
| restored-ready | 61 | 0 | 0 |
| finished-resume | 274 | 0 | 0 |
| permanent-lifecycle | 3075 | 0 | 0 |
| packaged Loader + child IPC + isolated HTTP stub | 33 | 0 | 0 |
| reception-capture | 28 | 0 | 0 |
| Total | 3471 | 0 | 0 |

Counts are test assertions, not separate natural tasks. Four network-guarded suites report zero forbidden I/O attempts. The Loader suite reports zero real NPS requests; its HTTP traffic is isolated to the test stub. Its legacy-adapter rejection and duplicate-owner warnings are expected negative cases, not skipped tests.

The runtime implementation and existing test bodies were copied without logic changes. Source packaging adds build/test/release scripts and documentation, not new status behavior. The rebuilt ESM entry matches the previously approved binary hash. The initial Release retains the approved runtime artifacts and declarations.

## Existing manual acceptance

User-observed restored running, idle heartbeats, working takeover, finished retention and return to running passed. A paired aborted → closed transfer and terminal lock have evidence. Working heartbeats sustained a natural task beyond 45 seconds without reactivating its terminal status afterward.

These are historical acceptance results, not tests repeated during release preparation. No DSH/NPS restart, deployment or real notification was performed for packaging.

## Not fully validated live

- Naturally triggered whole-turn error, red 450ms breathing and repeated-error reminder deduplication.
- Approval mapping (not implemented for DSH), full cancellation interaction, page close and all terminal-lock reopen scenarios.
- The earlier intermittent missed-event report remains open.
- Reminder interface success does not prove visible pixels. Top reminders require human confirmation.
- Compatibility with arbitrary official DSH builds, other Node/platform combinations and independent Desktop backends is not established.

Current NPS retention of finished=10s and error=30s is configuration, not a universal protocol. This plugin reads actual retention metadata for finished recovery. NPS display filtering and reminder diagnostics are companion features not contained in this release.

## 当前会话名称同步（2026-11-06）

- 六组 Node.js 回归通过，包括选择控制器的标题、切换、乱序、重试、失联、后台页面优先级，以及真实 Loader/子进程和隔离 HTTP 链路。
- 配套 DSH 导航类和 Host/Client 严格 Remote codecs 已对本机兼容构建做内存补丁验证。
- NPS 配套源码编译通过；现有离线回归及新增的选择、改名、生命周期隔离和无重复提醒检查通过。真实进程分类检查在离线模式下跳过。
- 实机使用 DSH 网页切换命名会话，已核对 NPS `/state` 中的当前选择、会话标题和 source 一致，并仍保持 running。Widget 标签已通过本机接口观察到 `DSH · 会话名称 运行中`。
- 改名通过自动化回归覆盖；未修改已有用户会话的名称，未发送模型任务。灵动岛像素呈现与 Comet 内的手动改名未作视觉验收，不能把接口结果当作截图证据。

NPS 端检查属于跨项目的本机验证。本仓库只提交 DSH 侧实现、接口契约和隔离测试，不分发下载的 NPS 参考源码、Codex 修复、DLL 或现场记录。独立 DSH Desktop 后端仍未验收。
