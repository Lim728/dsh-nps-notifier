# DSH NPS Builtin

DeepSeek Harness／DSH 的会话状态转发插件，用于将 DSH 状态发送给 NPS CLI／NotchPeninsula，在灵动岛显示。

插件名称：DSH NPS Builtin / @deepseek-ai/dsh-host-nps-notifier

GitHub 仓库：[https://github.com/Lim728/dsh-nps-notifier](https://github.com/Lim728/dsh-nps-notifier)

这是社区维护的集成项目，不代表 DeepSeek 官方发布或背书。本包不包含或更新 NPS.Plugin.AiCliNotifier；同工具显示优先级与提醒诊断属于 NPS 配套能力。

发布标签：v0.1.0-preview.1（Pre-release），不同于保留的组件版本 0.2.1-rc.2。

## 适用范围

本包面向包含配套接口的 DSH 构建，作为 DSH 安装包的内置组件加载。不能承诺任意官方 DSH 版本兼容，也不能仅凭版本号相同判断兼容。

当前组件版本为 0.2.1-rc.2，来自已配套更新的 DSH 构建。本包不包含完整 DSH 安装程序、宿主配套更新或 NPS 插件，不是可单独激活的 DSH bundle。用户应安装发布方提供的兼容 DSH 整包，无需另装外部适配器。

## 工作方式

插件在 DSH 内部加载，订阅会话和任务事件，通过本机 NPS HTTP 接口转发状态：

    DSH 内部事件 → 内置插件 → POST http://127.0.0.1:17877/notify

DSH Web 默认地址为 http://127.0.0.1:3080。3080 是用户访问 Web 的地址；插件不轮询网页判断任务状态。插件还读取 NPS /state 的必要字段，核对 finished 展示期及恢复条件。

NPS CLI／NotchPeninsula 通过另行安装的 NPS.Plugin.AiCliNotifier 接收事件，负责状态分组、Widget、轮播、动画和提醒。本插件只负责转发，不负责灵动岛绘制。

## 安装前置

- 已安装与所用 DSH 版本兼容的 Node.js；当前构建声明为 ^22.19.0 或 >=24.0.0。
- 已安装并运行包含配套接口和内置插件注册的 DSH。
- 已安装并运行 NPS CLI／NotchPeninsula。
- NPS 已另行安装并启用 NPS.Plugin.AiCliNotifier，其本机 HTTP 接口可用。

DSH 官方仓库：https://github.com/deepseek-ai/deepseek-harness

官方提供的 Web 启动方式：

    npx @deepseek-ai/dsh web

默认 Web 地址为 http://127.0.0.1:3080。此命令用于启动官方 DSH，不代表任意官方发行版已包含本插件或本次恢复会话接口；请以兼容整包的安装说明为准。

## 安装与连接

1. 安装发布方提供的兼容 DSH 整包；本组件由其插件机制注册加载。
2. 安装 NPS 和 NPS.Plugin.AiCliNotifier，确认本机 HTTP 接口开启。
3. 默认 NPS 端口为 17877；如实际端口不同，通过 DSH 插件已有 port 配置对齐。
4. 正常启动 DSH 和 NPS，打开一个普通空闲会话；满足安全就绪条件后显示“运行中”。
5. 使用自然任务检查“正在制作 → 已完成”；完成展示期结束且确实空闲后恢复“运行中”。

在当前 npm 整包布局中，本组件对应：

    <DSH 安装根目录>/node_modules/@deepseek-ai/dsh-host-nps-notifier/

发布方将 plugin/ 的内容纳入该包目录，并保留兼容 Web bundle 的依赖与插件注册；最终用户不需要手工复制这些文件。其他整包布局由发行方确认，不能直接假定路径相同。

若 DSH 已启用本插件，不要再安装第二份转发入口。旧适配器与内置插件不得同时转发。本包不提供独立 .tgz bundle，也不提供未经验证的独立安装命令。

恢复会话功能依赖兼容的 DSH 前端、会话后端及审批服务，不能仅复制 runtime 文件获得完整功能。桌面端若使用独立后端或安装目录，需单独确认兼容性。

## 状态与行为

- 新建会话保留首次就绪保护；后台进程启动或端口在线不等于交互会话就绪。
- 用户明确打开已有空闲普通会话后，只有通过同一 agent/session 实例、初始化完成、idle、无排队、权威审批状态无待决及 whenIdle() 后复核，才可上报蓝色 running／运行中。
- 自动恢复、列表预览、后台预加载、子任务及端口在线本身不会取得恢复资格。
- running 获得成功 ACK 后，启用 15 秒独立空闲心跳。
- 新任务开始立即撤销空闲资格，转发 working／正在制作；符合条件的执行中任务使用独立工作心跳。
- 仅配对且符合发送条件的成功结束转发 finished／已完成。展示期结束后，重新确认空闲及状态归属，再恢复 running。
- 配对且 working 已获 ACK 的 error 转发“出错”；aborted 转发 closed／已关闭并进入终态锁。error／closed 不因重新空闲自动恢复 running。
- 关闭页面只撤销恢复资格，不关闭真实后端会话，不伪造 closed。
- DSH waiting_approval 尚未接入 NPS；blocked、max-tokens 及未知结束原因不冒充成功或错误。

NPS 通用状态模型还支持 waitingapproval 和 idle，不代表 DSH 已实现对应映射。使用具备显示过滤功能的 AiCliNotifier 时，同一工具存在 working 或仍在 finished 保留期内，会隐藏 running 空闲展示；不关闭真实会话或停止必要心跳。

转发跟随 DSH 生命周期运行。诊断记录的时间、条数和大小限制只约束记录，不停止转发或心跳，也不重置 source、去重、终态锁或恢复资格。用户无需创建轮次目录或手动续轮。卸载、关闭或转发失联时清理相应运行资格与待发请求。

## 当前配置与验收边界

- 当前 NPS 配置：finished 保留 10 秒，error 保留 30 秒。这不是所有部署的固定规则；finished 恢复读取 NPS 实际展示期，不硬编码 10 秒。
- 恢复 running、空闲心跳、working 接管、finished 展示及恢复已完成主链路实机验收。
- aborted → closed 转发及终态锁已有实机证据；取消完整交互尚未全部验收。
- error 红色圆点与 450ms 快速呼吸规则保留，但自然触发整轮 error 的视觉表现、重复 error 提醒去重尚未完成实机验收。
- 审批、关闭页面和重新打开时的终态锁保护仍有未实机覆盖场景；DSH waiting_approval 尚未接入 NPS。
- 此前 DSH 漏接问题仍未结案。
- PostReminder 接口成功不等于屏幕实际可见，提醒诊断不能证明像素级呈现；顶部提醒仍需人工确认。

## 隐私与排障

转发仅使用必要身份、轮次、序号、时间及固定状态／原因，不传递聊天正文、命令、输出、路径或错误原文。本发布包不含会话数据、凭证或运行记录。

未显示状态时，依次确认插件挂载与握手、已确认的交互会话、新任务事件与转发 ACK、NPS 对应 source，以及 Widget 的分组和显示优先级。不要回放历史或伪造状态来填补缺失显示。

兼容要求、依赖、回滚和校验说明见 [docs/README.md](docs/README.md)。

## 文件校验

checksums.sha256 覆盖除其自身以外的全部发布文件，使用相对路径和 SHA256。校验清单不能包含自身最终哈希；该文件的大小和 SHA256 在交付报告中单列。
