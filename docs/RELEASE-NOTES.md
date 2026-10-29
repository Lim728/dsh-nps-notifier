# v0.1.0-preview.1 — DSH 会话状态转发与安全空闲恢复

首次社区预览发布。不是 DeepSeek 官方发布或背书，也不向 DeepSeek npm scope 发布。

## 本插件能力

- 恢复会话安全就绪：明确打开普通会话并完成同实例、空闲、排队及权威审批复核后取得 running 资格。
- running ACK 后启用 15 秒独立空闲心跳；任务开始立即撤销空闲资格。
- 保留 working 心跳及配对的 finished/error/aborted 转发。
- finished 实际展示期结束后，复核 NPS 状态与会话空闲，再恢复 running。
- error/closed 保持终态锁，不因 idle 自动恢复。
- 转发跟随 DSH 生命周期；诊断轮换不停止转发或重置状态资格。

## NPS 配套能力，不在本附件内

配套 AiCliNotifier 新增同工具 working/finished 期间隐藏 running 的显示优先级，以及提醒诊断。两者属于 NPS 侧实现；本插件附件不包含这些代码，安装本包不会更新 NPS。

## 兼容性

面向 DSH 0.2.1-rc.2 及配套交互、恢复就绪和审批接口。相同版本号不证明接口齐备，不保证兼容任意官方 DSH 版本。此 ZIP 是兼容安装包的内置组件，不是独立 bundle 或完整 DSH 安装程序。

## 验收边界

恢复 running、空闲心跳、working 接管、finished 保留及恢复已完成主链路实机验收；aborted → closed 转发和终态锁已有实机证据。

DSH waiting_approval 尚未接入。自然整轮 error 红色闪灯、重复 error 提醒去重、审批、取消完整交互、关闭页面及部分终态锁场景仍未全部实机验收。此前漏接问题仍未结案。

finished 10 秒、error 30 秒为当前 NPS 配置。恢复读取实际展示期；提醒接口成功不能证明屏幕实际可见。

## 附件

- DSH-NPS-Builtin-v0.1.0-preview.1.zip
- checksums.sha256：ZIP 内除清单自身外的文件哈希，与包内清单一致。
- release-checksums.sha256：ZIP 和独立 checksums.sha256 的哈希；不包含自身哈希。

请先校验下载附件，再校验解压文件。源码构建与验收结果见 [构建说明](https://github.com/Lim728/dsh-nps-notifier/blob/v0.1.0-preview.1/docs/BUILDING.md) 和 [验收记录](https://github.com/Lim728/dsh-nps-notifier/blob/v0.1.0-preview.1/docs/VALIDATION.md)。
