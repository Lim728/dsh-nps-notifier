# DSH 当前会话名称同步

实现由三个部分组成：

- `runtime/selection-controller.mjs` 读取 `ctx.sessionTitle.get(session)?.title`，监听标题及会话选择变化，按当前插件实例生成与状态转发一致的匿名 source。
- `scripts/patch-dsh-selection.mjs` 为兼容 DSH 0.2.1-rc.2 添加展示专用的选择关联。它复用已认证的 Remote 流，在导航、恢复、焦点变化及重连时发出 `api-session/presentation`；独立于只由明确打开授予资格的 `api-session/interaction`。后台恢复的关联优先级低于前台选择。关闭页面或切换时释放关联。
- NPS 配套插件负责接收 `POST /dsh-selection`，按 source 更新会话名称。它属于 [NPS-Cli 项目](https://github.com/Lim728/NPS-Cli)，不随本仓库发布。本仓库只提供 DSH 侧发送器、配套 DSH 接口补丁与隔离测试；下载的 NPS 参考源码、DLL 和本机测试资料不提交到此仓库。

每个实例的更新带递增 revision，迟到的旧选择不能覆盖新名称。传输最多一个在途请求和一个最新待发送快照，超时 500ms；失败后重试当前快照，活跃选择每 15 秒续期。NPS 的展示关联在 45 秒失联后失效，不会让任务续命。最多 64 个页面关联、8 个 DSH 实例；标题最多 256 UTF-8 字节，不进入本插件诊断。

未命名会话使用 `DSH` 标签。选择从未取得任务状态资格的会话，不会伪造 running；error、closed 及已过期完成状态不会因为选择或改名复活。NPS 的正常文字宽度降级仍适用。

## NPS 对接契约

请求体恰好包含以下四个字段：

```json
{
  "instance": "0123456789abcdef",
  "revision": 1,
  "source": "dsh:0123456789abcdef:0123456789abcdef0123456789abcdef",
  "sessionTitle": "修复登录问题"
}
```

`instance` 为 16 位小写十六进制标识。`source` 必须与同一插件实例的状态通道完全一致，格式为 `dsh:<instance>:<32 位身份摘要>`。`revision` 为同一实例内递增的正安全整数；NPS 应拒绝旧版本和同版本的冲突内容，允许相同请求幂等重试。释放选择时发送 `source: null`、`sessionTitle: ""`。成功响应必须包含匹配的 `instance`、`revision` 和 `ok: true`；发送器不会把任意 HTTP 200 当作成功。

接收端应限制标题为 256 UTF-8 字节，拒绝控制字符、未知字段和重复字段。标题属于显示元数据，与 `/notify` 中通知标题 `title`、工具名称 `displayName` 分开；可写入既有会话的 `SessionTitle`，再沿现有快照与布局刷新流程绘制。

接收名称不能修改 `status`、`taskId`、`EventTime`、`LastSeenUtc` 或 `TerminalSinceUtc`，不能创建任务、续任务心跳、重置保留期或触发重复提醒。发送器最多持有 64 个页面关联；接收端可限制为 8 个 DSH 实例，并使展示关联在 45 秒失联后失效。

当前选择不等于允许删除其他任务的显示。NPS 应单独审查选择优先级与过滤策略，保留其他工具及必要任务状态的可见性，不得把会话 B 的名称配到会话 A 的状态上。

## 构建和安装

1. 按主 README 构建插件、运行测试。
2. 在受支持的 DSH 安装中找到包含 `dsh-api-session-controller` 的 `@deepseek-ai` 目录。先执行只读预检：

       node scripts/patch-dsh-selection.mjs <DSH 的 @deepseek-ai 目录>

3. 确认没有正在执行的 DSH 任务并退出 DSH。传入一个新的备份目录执行补丁，然后将本项目 `runtime/*.mjs` 复制到同一安装中的 `dsh-host-nps-notifier/runtime`：

       node scripts/patch-dsh-selection.mjs <DSH 的 @deepseek-ai 目录> <备份目录>

   补丁先在内存中验证全部六个文件形状，遇到未知构建会拒绝操作；已安装同版补丁可以重复执行。它修改的是配套发行文件，发行方重新构建宿主时应把同等改动应用到原始类型和源码并重新生成 Remote codecs。

4. 由 NPS 维护方在其正式源码中接入上述契约，验证既有 Codex、Claude、状态分组、轮播、提醒和保留期。构建、更新与回滚遵循 NPS 项目自己的流程；本仓库的构建或安装不会更新 NPS，也不提供 NPS DLL。

5. 确认 NPS 端已提供兼容接口后，重新加载 DSH 并刷新已有网页。此补丁仅面向已验证的配套构建；升级 DSH 后需重新检查兼容性。独立 Desktop 后端尚未验收。

## 验证

`pnpm test` 包含选择、改名、去重、乱序、失联、清理以及真实 Loader/子进程/隔离 HTTP 链路测试。设置 `DSH_SELECTION_PACKAGES` 为兼容宿主的包目录还能验证配套导航类和严格 Remote codecs；测试只在内存中准备补丁，不修改安装文件。

NPS 的 `/state` 返回 `dshSelections`（当前有效展示关联）和每个会话的 `sessionTitle`；`widget.groups[].currentLabel` 可与网页选中名称比对。正文、命令和路径不参与名称同步。打开两个空闲聊天来回切换，再改名，名称应同步；状态和提醒次数不应因改名发生变化。

## 回滚

退出 DSH 后，把补丁备份目录中的六个文件按原相对路径恢复到 `@deepseek-ai` 目录；同时恢复原 notifier runtime。恢复原 NPS DLL 后重新加载 NPS。备份中包含本机旧发行文件，不应提交到源码仓库。
