# Agent Note: FDE 可见 Session 续传

Status: implemented

[English](2026-08-14-fde-visible-session-continuation.md) | 中文

## 问题

[仅聚合回放 sidecar](2026-08-14-fde-aggregate-only-replay-sidecar.md)证明了一轮受约束的建议性执行，但 FDE 任务还需要后续进程从已批准的模型可见历史继续，同时不能信任环境中的 Session 目录、保留原始 reasoning，或把提供方专属 continuation 偷渡进提供方中立记录。重用 daemon 会削弱单进程所有权和完全停稳；在 `session/prompt` 内静默选择创建或恢复，则会让过期调用方与有效续传无法区分。

## 决策

P2-L2b 保持每轮使用一个全新的运行时进程，并且只允许显式、串行地延续 P2-L1 v2 可见 capsule。sidecar 公共 CLI 将 `--start-session-root` 与 `--resume-session-root` 分开；resume 要求提供前一份回执中的正事件数、`sha256:` 规范事件摘要及规范 Session 文件头身份摘要。在任何 Session 创建、读取或运行时工作之前，启动器会独占创建仅属主可访问的同级锁文件，把继承 FD 及 device/inode 身份绑定进启动证明，并持有到子进程 close 与 stdio EOF。并发锁或遗留锁会在持久变更前以 `SESSION_BUSY` 失败；遗留锁绝不会自动回收。包装层和 v2 聚合 payload 均不变，v1 仍只允许 start。

SDK JSON-RPC 服务器只接受一次成功的 `initialize`；初始化前的 prompt 或 resume 以及任何重复初始化都会失败，因此活动路由不能被静默替换。它将 `session/resume` 作为独立操作公开：该操作位于初始化之后、该进程对该 Session 的第一次 prompt 之前。它调用官方 `ctx.agents.resume`，拒绝已经打开或由 prompt 创建的 Session 及精确 cwd 不匹配，并返回持久前缀计数及下一个实时序号。sidecar 会在调用运行时之前验证已存文件头身份、cwd、连续序号、已完成轮次序列、事件类型闭集、工具数为零，以及不存在原始 reasoning。随后它要求服务器游标在已批准前缀和下一条协议事件之间精确放置一个官方 `session/end-seed` 事件。

完成回执记录 `STARTED` 或 `RESUMED`、稳定 Session 身份摘要、先前及最终的规范事件计数与摘要、最后序号、已完成轮次、工具调用数为零、`providerContinuationDigest: null` 和 `rawReasoningPersisted: false`。空的先前前缀使用空字节的真实 SHA-256，而不是全零哨兵。只有在规范文件头身份与旧事件前缀保持相同、一个 seed 标记占据旧计数位置、新的持久后缀等于有界协议序列，且精确多完成一轮时，resume 才成功。任何过期游标，或被替换的 id、创建时间、root／cwd、序号、轮次、工具、原始 reasoning、thinking、signature、未知事件或额外 assistant/user 事件都会失败关闭。

提供方中立的可见历史与提供方专属的不透明 continuation 在物理上分离：该无密钥组装只挂载含规范聚合 payload 和已验证建议的 JSONL Session。它不挂载提供方 continuation 存储，不接受 continuation token，也不保留原始 reasoning。未来云端提供方需要独立的不透明存储与回执约定；它不得把不透明字节或原始 reasoning 放入本 Session。

## 验证

公共 CLI 测试会启动 v2 第一轮，然后启动一个 resume 进程，并在其锁出现后暂不提供 stdin。并发进程会返回 `SESSION_BUSY`，同时 JSONL 字节保持完全相同。持锁进程随后完成第二轮，第三个全新进程再完成第三轮；回放响应只有通过先前可见历史才能解析所需值。测试会比较完整旧前缀、连续序号、两个 seed 标记、三轮及其规范用户 payload、稳定 Session 身份和最终可续传性。独立反例会在运行时之前拒绝过期计数／摘要／身份、被替换的文件头 id 和创建时间、重命名根目录及被替换的 id／cwd、锁 FD 身份漂移、序号、轮次、reasoning-delta、thinking/signature 和 request-header reasoning。

## 考虑过的替代方案

**让所有轮次停留在一个 daemon。** 已否决，因为进程所有权、输出限制、完全停稳以及请求到日志的关联都会依赖共享可变运行时状态。

**让 `session/prompt` 隐式创建或恢复。** 已否决，因为过期或误写的 Session id 可能在没有明确调用方决策和已批准前缀游标的情况下选中历史。

**在可见 Session 中持久化提供方 continuation。** 已否决，因为提供方 token 与原始 reasoning 不是提供方中立的模型可见上下文，并且可能携带未披露的客户数据或模型私有数据。

**用静态回放答案证明续传。** 已否决，因为即使没有恢复任何历史，同一输出仍可能成功。动态回放匹配使先前可见上下文成为必要条件。

## 后果

FDE 可以跨进程重启证明三轮提供方中立的可见续传，同时每轮保留一棵 Seatbelt 进程树、零网络、零工具、无密钥回放和仅建议权限。调用方必须保留并传入完整回执游标，而启动器会强制同一 Session 只有单写执行，不再信任调用方自行串行化。在另行规定压缩策略之前，规范可见历史会持续增长。

本决策不实现提供方专属的不透明 continuation、云端推理、模型切换、压缩、保留或删除自动化、多用户授权或 FDE 部署。`providerContinuationDigest: null` 是本组装中已断言的缺失状态，不是以后静默加入提供方状态的占位符。
