# 安装包集成、连接与回滚说明

## 发布形态

这是随兼容 DSH 安装包内置的组件目录，不是独立 DSH bundle，也不是完整 DSH 安装包。没有 dsh.bundle 激活声明或独立 cordis.patch.yml；不应把安装普通 npm 依赖等同于插件已启用。

当前整包通过 Web bundle 对 @deepseek-ai/dsh-host-nps-notifier 的依赖和 id=nps-notifier 的插件注册加载 lib/index.js，port 默认为 17877。保留 Windows 启用条件和已有防重复挂载保护。不要并行启用旧适配器。

DSH 官方插件机制参考：https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish

## 兼容配套

同一版本号不能证明恢复会话接口齐备。兼容整包必须包含主动打开交互关联、session/restored-ready、权威待决审批查询，以及以下配套模块的实现：

- dsh-api-session-controller/lib/index.js
- dsh-api-session-controller/lib/client.js
- dsh-api-session-controller/lib/typert.host.js
- dsh-api-session-controller/lib/typert.remote-client.js
- dsh-api-remotes/lib/client.js
- dsh-client-ui-workspace/lib/client.js
- dsh-user-approval/lib/index.js

这些文件属于 DSH 宿主配套，不包含在本插件包中。发行方应提供成套兼容构建，不指导用户把单个脚本拷入任意官方安装目录。桌面端独立后端须单独核对。

## 依赖与文件范围

plugin/package.json 保留包名、ESM 入口、类型入口、package.json 导出、peerDependencies 和 dependencies。包名不能随目录名称任意改写，入口使用它定位运行模块。

发布清单使用当前已安装产物解析后的依赖版本，移除仅供开发的 devDependencies、未打包的 ./src/* 导出、开发脚本、仓库定位字段以及公开发布配置；没有改动任何运行代码。此包不会执行 npm 发布。

- @deepseek-ai/cordis：~4.0.5，与宿主共享实例。
- @deepseek-ai/cordis-plugin-loader：~1.0.6。
- @deepseek-ai/dsh-agent、dsh-app-boot、dsh-cmdline：0.2.1-rc.2 兼容宿主依赖。
- @deepseek-ai/schemastery：~3.18.5。

由兼容 DSH 的安装机制解析依赖，不随本包复制 node_modules 或工作区符号链接，不另装重复 Cordis 实例。

lib/index.js、两个 .d.ts 和全部 11 个 runtime/*.mjs 原样复制。诊断模块是直接导入的运行依赖，不能因“不发布日志”而删除。类型声明末尾的 sourceMappingURL 属于原构建元数据；映射文件不影响运行，本包不包含它们。

排除 src、tests、夹具、tsbuildinfo、source maps、临时文件、日志、备份、会话数据、凭证及 node_modules。LICENSE 随包保留。

## 连接与记录

插件订阅 DSH 内部事件；3080 是默认 Web 地址，不是轮询采集接口。NPS 的 /notify 接收固定状态，/state 提供恢复判断所需字段。默认只连接本机 17877，可通过已有 port 配置对齐。

插件在当前 DSH profile 下管理 nps-notifier 记录目录。默认 profile 位于 $DSH_HOME/profiles/web；未自定义 DSH_HOME 时通常在用户 .dsh 目录。不要把现场 profile 配置或运行记录纳入发布包。

记录器按有限文件、条数、大小与时间窗口轮换；这些限制不结束转发生命周期。日志失败不应作为任务结束或关闭会话的依据。分享现场记录前仍应检查和脱敏。

## 发布方集成与用户升级

1. 核对兼容整包及插件注册，确认没有重复适配器。
2. 逐文件校验本包，再将 plugin/ 内容纳入整包对应包目录。
3. 保留包根 LICENSE；若重新分发组件，应随分发保留许可文本。
4. 将依赖解析、配套后端和前端纳入整包验证，不让用户手动续轮。
5. 用户升级前备份原 DSH 安装版本、相关插件文件及 profile 配置；保持凭证和私有配置不公开。
6. 按兼容整包说明升级 DSH。加载新代码需要重新加载相应 DSH 服务；Web 客户端需刷新，独立桌面端另行核对。先确认没有执行中的任务，避免中断任务。
7. 本包不替换 NPS DLL 或配置；DSH 组件升级本身不要求重启 NPS。

本次发布整理不会执行上述安装、服务重载或通知操作。

## 验收与故障排查

只使用自然任务，分别核对内部事件、转发 ACK、NPS source 和实际显示。HTTP 成功不能代替界面可见性确认。

重点包括恢复 running、空闲心跳、新任务接管、finished 保留及恢复。未自然覆盖的 error、审批、取消完整交互、关闭页面和终态锁重新打开，保持未实机验收。不能因本包文件校验通过就升级其验收结论。

未显示时先查挂载／握手和当前会话资格，再查事件／ACK，最后查 NPS 分组与宿主可见条件。不要制造通知、回放历史或把 Web 端口在线当作 running 证据。

## 回滚

使用升级前的匹配版本整包和插件备份恢复；涉及配套接口时，前端、后端及插件应一起恢复，不能混用不兼容版本。保留现场记录，不清理真实会话。

恢复后重新加载对应 DSH 服务并刷新相连 Web 页面；独立桌面端按其安装位置恢复。不要同时保留两个启用的转发入口。无需因本插件回滚而替换 NPS 插件或重启 NPS。

## 校验格式

checksums.sha256 每行格式为“SHA256、两个空格、相对文件路径”，路径使用正斜杠。它覆盖本包全部其他文件。自身哈希只在包外交付报告记录，避免自引用。
