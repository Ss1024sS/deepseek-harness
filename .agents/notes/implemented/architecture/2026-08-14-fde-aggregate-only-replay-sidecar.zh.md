# Agent Note: FDE 仅聚合回放 sidecar

Status: implemented

[English](2026-08-14-fde-aggregate-only-replay-sidecar.md) | 中文

## 问题

FDE 需要一个无密钥实验，证明官方 DeepSeek Harness 运行时能够消费仅聚合的事实文档，且不会收到源数据行、文件、工具、网络访问权限、云端凭据或 FDE 变更权限。有效结果必须绑定精确的本地运行时，将一个请求与一条持久事件序列关联，并在 JSON-RPC 输出含糊时失败关闭；绕过官方运行时的 mock 无法证明这些性质。

## 决策

`fde-sidecar/` 随附一个仅支持 macOS 的一次性回放实验，并固定到上游 commit `47f943859bef60e4160492346772ded9b24f765a`。stdin 只接受一个精确的 schema-v1 请求包装层，其中仅包含 `outgoingDigest` 和封闭的 `effiengine.fde-harness-aggregate-facts` payload。payload 可以是精确的现有 `fde.aggregate-facts.v1` profile，也可以是精确的 P2-L1 `fde.aggregate-facts.v2` profile。摘要覆盖递归按键排序的规范 payload 字节，且只有这些 payload 字节进入 Harness 提示词。

V2 保留聚合的 `plan`、`counts`、`acceptance`、`findings` 和 `evidence` 事实，并且只新增 `contentPrivacy`：固定标量枚举及其后的九个固定、有序 `{code,countBucket}` 对。计数只使用封闭的粗粒度桶 `ZERO`、`ONE`、`TWO_TO_FIVE` 和 `SIX_PLUS`，绝不使用精确计数；`PRIVATE_KEY_MATERIAL` 和 `CREDENTIAL_ASSIGNMENT` 必须为 `ZERO`，因为 FDE 本地门会在创建出站数据之前阻断它们。V2 语义固定两类证据，并声明原始文本、遮盖文本和 token map 均不存在。每一层的精确键校验都不为源文本或遮盖文本、预览片段、offset、token 值或 map、源摘要或复核摘要，以及自由格式 prompt 留下 schema 位置。sidecar 是准入门，不是清洗器：它会拒绝不安全结构，而不是转换该结构。

每次公共调用都会创建新的私有运行根目录和一个官方 stdio JSON-RPC 运行时。start 调用会创建新的持久化会话；P2-L2b resume 调用会依据[可见会话续传决策](2026-08-14-fde-visible-session-continuation.md)，在下一条 prompt 之前显式恢复该会话。本地有界客户端限制输入、帧、总输出、stderr、assistant 文本、初始化、轮次时间和清理；summary 和 action 文本分别限制为 500 和 300 个 Unicode code point。它拒绝未知通知或事件、工具活动、重复响应、多个 assistant 结果、尾随的不完整帧，以及无法与单个会话和消息关联的任何结果。

启动器在启动 `/usr/bin/sandbox-exec` 之前验证规范 manifest（元数据清单）和一份无软链接的生成 carrier；它从不读取 stdin。carrier 由仓库的 hoisted `pnpm deploy` 路线从最小闭合部署 manifest 生成。它的规范闭包逐个记录普通文件的相对路径、POSIX 权限、大小和 SHA-256；启动时会拒绝缺失、多余、链接、类型错误、权限漂移或内容变更。沙箱内的适配器是首个读取或验证 payload 字节的进程。

一份 deny-default Seatbelt profile 覆盖适配器和官方运行时子进程，因为 macOS 拒绝嵌套应用沙箱。manifest 固定适配器模板；启动器使用固定的 sidecar、carrier、Node、运行目录和会话目录将其展开。一个一次性 256 位 nonce 将私有证明文件与这些根目录、manifest、适配器模板和展开后的有效 profile 绑定。内部入口重新计算该生成 profile 的摘要，消费证明，并在读取 stdin 之前确认已拒绝一次已知的宿主读取。该 profile 禁止网络，也禁止读写 sidecar 资产、carrier 和私有根目录之外的宿主路径。它只允许 exec 固定的 Node 二进制文件，因此运行时会继承在同一策略内重新 exec 该二进制文件的能力，但无法 exec 未固定的二进制文件。所有子进程都保留在调用方拥有的进程组中。

完成需要官方 `shutdown`、进程 close 与 stdio EOF、空的尾随帧缓冲区，以及对一份已完成 JSONL 会话日志的回读。start 要求持久事件序列在类型闭集、基数、顺序和规范字节上与有界协议序列完全匹配。resume 还要求已批准前缀保持相同，在旧计数处存在一个官方恢复 seed 标记，且新的持久后缀与有界协议序列匹配。仅存在于持久日志的工具、原始 reasoning、未知事件，或额外的 user、assistant 或轮次事件都会失败关闭。回执只是建议性无密钥回放证据：它报告未执行云端推理、未配置云端提供方、工具数为零、FDE 变更数为零，并为 manifest、适配器模板、展开后的有效 profile、运行时闭包、运行时入口和 sidecar 报告彼此独立的 `sha256:` 摘要。

## 验证

sidecar 专用测试套件通过官方回放运行时，用公共 CLI（命令行界面）执行 v1 和 v2，验证规范请求准入、相同输入的会话隔离和仅 payload 持久化，证明已拒绝宿主读写、网络和未固定 exec，并拒绝从外部注入的内部标记。它的两轮场景会退出第一个运行时，在第二个进程中恢复会话，并解析一个只存在于先前可见聚合 payload 中的值；同一场景还验证前缀未变、序号与轮次连续、恢复标记、工具数为零、`providerContinuationDigest: null` 以及不存在原始 reasoning。过期游标、cwd、序号、轮次、原始 reasoning 及 thinking/signature 反例都会失败关闭。V2 反例会在创建会话之前拒绝原始文本或遮盖文本、token map 和值、自由格式 prompt、预览片段、offset、源摘要、未知字段、重排或缺失的隐私 finding、无效桶，以及非零硬阻断桶。其他反例会在证明创建后更改生成 profile，也会更改 carrier 中一个传递 JS 文件；后者必须在创建会话前使公共 CLI 失败。全新 carrier 重建必须重现规范闭包。即使有效响应已经出现，仅存在于持久日志的工具和 assistant 事件、尾随的未知通知、重复响应或不完整最终帧仍会导致失败。该套件是实验专用检查，不属于仓库默认 CI 清单。

## 考虑过的替代方案

**使用上游 `HarnessClient`。** 已否决，因为其开放式流处理不提供本实验所需的绝对时限、帧、字节、stderr、assistant 文本和歧义限制。

**重用 daemon 或在 `session/prompt` 内推断恢复。** 已否决，因为重叠请求和隐式 create-or-resume 行为无法提供精确的所有权区间。P2-L2b 只允许在新进程内依据调用方提供的持久游标，显式、顺序地恢复会话。

**应用嵌套的适配器和运行时 Seatbelt profile。** 已否决，因为 macOS 会在该进程树中拒绝嵌套沙箱应用。一份实际强制执行的 profile 比为从未运行的第二份 profile 发布摘要更准确。

**信任内部环境标记。** 已否决，因为公共调用方可以预先填入继承环境。除了标记以外，内部路径还要求启动器创建的一次性证明和真实拒绝检查。

**让 v2 字段可选或可扩展。** 已否决，因为字段缺失会产生歧义，而不断扩展的对象会形成未来的文本偷渡缝隙。

**用 map 表示隐私 finding。** 已否决，因为固定数组顺序是跨仓库规范字节契约的一部分，也会让 finding 缺失或重复成为明确失败。

**发送精确 finding 计数。** 已否决，因为模型只需要粗粒度暴露桶，而精确计数会增加本可避免的披露。

**携带遮盖文本或可逆 token。** 已否决，因为遮盖文本仍然包含客户内容，而 token 恢复只属于本地隐私网关。

**在本实验中将详细业务数据发送给云端模型。** 已否决，因为无密钥聚合回放用于验证组合与约束，而不是验证 DLP、抗重标识性、云端模型质量或生产隐私策略。

## 后果

该实验到达官方插件组合运行时和持久化会话路径，同时使回执权限保持狭窄，且强制执行声明如实。它的代价是每轮使用一棵进程树；可见聚合会话可以跨显式的顺序轮次延续，但不会重用运行时进程。它仅支持已测试的 macOS Seatbelt 边界，并且允许被包含的运行时在相同限制下仅重新 exec 固定的 Node 二进制文件。生成的 carrier 是本地实验输入，不是客户分发产物；第三方许可审查、产物签名和分发打包仍是独立发布检查。

支持 v2 不会扩大运行时权限或能力，但固定顺序、枚举和规范字节会形成 FDE 到 Harness 协同版本治理责任。粗粒度桶以降低诊断细节为代价减少披露。sidecar 仍不执行 DLP：不安全内容必须由本地隐私网关阻断，并由精确准入再次拒绝。

本决策不交付提供方专属的不透明 continuation、原始提供方 reasoning 保留、云端推理、隐私网关、token 恢复、多用户授权、Linux 或容器约束、FDE 集成或部署、浏览器验收、腾讯部署、生产保留策略或模型质量证据。任何上述能力都需要自身的实现和发布证据。
