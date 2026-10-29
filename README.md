# DSH NPS Notifier

将 DeepSeek Harness／DSH 会话状态转发给 NPS CLI／NotchPeninsula，在灵动岛显示运行和任务状态。

这是社区维护的集成项目，面向包含配套接口的兼容 DSH 构建，不代表 DeepSeek 官方发布或背书。

GitHub 仓库：[https://github.com/Lim728/dsh-nps-notifier](https://github.com/Lim728/dsh-nps-notifier)

首版发布标签：v0.1.0-preview.1（Pre-release）。内置组件版本保留 0.2.1-rc.2，两者不是同一版本序列。

## 兼容范围

当前面向 **DSH 0.2.1-rc.2 加配套接口的构建**，不保证兼容任意官方 DSH 版本。仅版本号相同不足以证明兼容。

恢复会话需要明确打开普通会话的前端入口、后端交互关联、权威审批查询与相关生命周期接口。构建本插件不会生成这些宿主扩展；它们也不包含在本仓库的 Release 中。详见 [兼容说明](docs/COMPATIBILITY.md)。

Release 是供兼容 DSH 安装包集成的组件，不是完整 DSH 安装程序或独立安装 bundle。本仓库不承诺 stock DSH 下载后只复制插件即可获得全部功能。

## 工作方式

    DSH 内部会话／任务事件
              ↓
    DSH NPS Builtin
              ↓
    本机 NPS /notify
              ↓
    AiCliNotifier → 状态分组、Widget 与提醒

- DSH Web 默认地址：http://127.0.0.1:3080。
- NPS 默认状态接口：POST http://127.0.0.1:17877/notify。
- 插件订阅 DSH 内部事件，不轮询网页判断任务状态。
- 完成后恢复读取 NPS /state 中必要字段。
- NPS 需另行安装 NPS.Plugin.AiCliNotifier。

## 安装与连接

1. 安装兼容 Node.js，以及包含本插件和配套接口的 DSH 整包。
2. 安装 NPS CLI／NotchPeninsula，并启用 AiCliNotifier 的本机 HTTP 接口。
3. 确认插件 port 与 NPS 端口一致，默认 17877。
4. 正常启动两者，打开普通空闲会话，再用自然任务检查显示。

兼容 DSH 整包自动加载插件，用户无需另装外部适配器、创建轮次目录或手动续轮。旧适配器与内置插件不得同时转发。

DSH 官方仓库：https://github.com/deepseek-ai/deepseek-harness

官方 Web 启动命令是：

    npx @deepseek-ai/dsh web

此命令本身不保证取得本项目要求的配套构建。独立桌面端若使用不同后端或安装目录，需单独确认。发行方集成与回滚见 [安装说明](docs/INSTALLATION.md)。

## 状态行为

| DSH 情况 | 上报与保护 |
|---|---|
| 新建或恢复会话安全就绪 | running；ACK 后启用 15 秒空闲心跳 |
| 新任务开始 | working；立即撤销空闲资格 |
| 配对成功结束 | finished；实际保留期结束并复核后恢复 running |
| 配对 error | error；不因空闲自动恢复 |
| 配对 aborted | closed；进入终态锁 |
| blocked、max-tokens、未知结束原因 | 不冒充成功或错误 |

恢复资格要求同 agent/session 实例、初始化完成、idle、无排队、权威审批已同步且无待决，以及 whenIdle() 后复核。自动恢复、列表预览、后台预加载、子任务和端口在线本身不授予资格。关闭页面只撤销恢复资格，不关闭后端会话，不伪造 closed。

working 与 running 使用独立心跳资格。转发跟随 DSH 生命周期，诊断轮换不重置 source、去重、终态锁或恢复资格。NPS 暂不可达只影响发送，不阻塞 DSH；IPC 失联或卸载会安全停止相应转发资格，不回放过期事件。

NPS 支持 running、working、waitingapproval、idle、finished、error、closed 通用状态模型；DSH waiting_approval 尚未映射，不能据此认为本插件支持审批通知。

## NPS 配套显示能力

兼容 AiCliNotifier 在同工具存在 working 或 finished 仍处于保留期时隐藏 running 空闲展示；不合并 source、不关闭会话、不停止必要心跳。finished 展示期结束且确实空闲后可恢复 running。

同工具显示优先级及 reminderDiagnostics 属于 NPS 的 AiCliNotifier，本插件附件不包含这些实现。**安装本包不会更新 NPS。**

## 源码构建

Node.js：^22.19.0 或 >=24.0.0；包管理器：pnpm 11.7.0。

    pnpm install --frozen-lockfile --ignore-scripts
    pnpm run build
    pnpm test

独立构建不要求 DSH monorepo；依赖通过锁文件安装。运行完整恢复就绪功能仍要求兼容宿主。构建、离线网络隔离与发布文件校验见 [构建说明](docs/BUILDING.md)。

## 隐私

仅转发必要身份摘要、轮次、序号、时间与固定状态，不传递聊天正文、命令、输出、路径或错误原文。

诊断有容量限制；发布包不包含现场记录、会话数据或凭证。提交仓库前与打包后执行隐私扫描；扫描不是对任意秘密格式的绝对保证。

## 验收与已知限制

- 主链路恢复 running、空闲心跳、working 接管、finished 保留及恢复已实机验证。
- aborted → closed 转发及终态锁已有实机证据；取消完整交互未全部验收。
- DSH waiting_approval 尚未接入 NPS。
- error 红色 450ms 快速呼吸规则保留；自然整轮错误视觉验收及重复 error 提醒去重尚未完成。
- 审批、关闭页面及重新打开时的部分终态锁场景仍未实机覆盖。
- 此前 DSH 漏接问题仍未结案。
- finished 10 秒、error 30 秒是当前 NPS 配置，不是固定协议；恢复读取实际展示期。
- HTTP ACK 或 PostReminder 成功不等于屏幕可见；提醒诊断不能证明像素级呈现。

详细离线与实机边界见 [验收记录](docs/VALIDATION.md)。

## 许可证与来源

[MIT](LICENSE)。保留原有 Copyright (c) 2026 DeepSeek 及许可文本，不声称独占上游版权或官方背书。内部组件名沿用 @deepseek-ai/dsh-host-nps-notifier，以保持自定位；本项目不向该 npm scope 发布包。

源码仓库含实现与合成测试；Release 附件仅含运行文件、类型声明、许可证和说明。下载 ZIP 后先核对 release-checksums.sha256，再核对解压后的 checksums.sha256。
