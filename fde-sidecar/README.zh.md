# FDE 仅聚合 Harness sidecar P1 / P2-L1 准入 / P2-L2b 可见续传

[English](README.md) | 中文

这是一个仅支持 macOS、固定 commit、基于官方 DeepSeek Harness JSON-RPC 运行时的无密钥回放实验。它不是云模型集成，也不是 FDE 部署。

## 精确的每轮单进程约定

FDE 为每一轮启动一个全新进程。第一轮创建 Session：

```sh
node <lab>/fde-sidecar/sidecar.mjs --start-session-root <absent-private-leaf>
```

`<absent-private-leaf>` 必须是现有私有父目录下一个全新的高熵路径。sidecar 以独占方式创建权限为 `0700` 的叶目录；叶目录已存在时失败关闭。后续 P2-L2b 轮次使用前一份回执的规范持久游标恢复该确切 Session：

```sh
node <lab>/fde-sidecar/sidecar.mjs \
  --resume-session-root <existing-private-root> \
  --expected-event-count <positive-integer> \
  --expected-event-digest sha256:<64hex> \
  --expected-session-identity-digest sha256:<64hex>
```

Resume 只接受封闭的 P2-L1 v2 payload。在启动官方运行时之前，沙箱内适配器会检查 Session 文件头身份摘要、cwd、连续事件序号、已完成轮次序列、事件类型闭集、工具数为零、不存在原始 reasoning，以及精确的预期前缀计数与摘要。公共启动器会在任何 Session 创建、读取或运行时工作之前取得跨进程独占锁，并一直持有到沙箱子进程及 stdio 完全关闭；并发锁或遗留锁会在任何持久写入前返回 `SESSION_BUSY`。每次调用仍只读取一行 UTF-8 JSON 后接 EOF，写出一行回执或稳定错误码后退出。本协议没有 daemon、`session/prompt` 内的隐式 resume、project id、review id、browser token 或 approval token。

包装层保持 schema v1，并且键集合精确如下：

```json
{"schemaVersion":1,"kind":"effiengine.fde-harness-sidecar-request","outgoingDigest":"sha256:<64hex>","payload":{"schemaVersion":1,"kind":"effiengine.fde-harness-aggregate-facts","profile":"fde.aggregate-facts.v1","semantics":{},"facts":{}}}
```

Payload 可以是现有的精确 `fde.aggregate-facts.v1`，也可以是 P2-L1 的精确 `fde.aggregate-facts.v2`。V2 保留每一项 v1 聚合事实，并且只在 `facts.contentPrivacy` 下新增以下模型可见分类摘要：

```json
{
  "sourceKind": "PASTED_PLAIN_TEXT",
  "policy": "fde.local-content.v1",
  "decision": "AGGREGATE_ONLY",
  "residualText": "EXCLUDED_UNCLASSIFIED",
  "findings": [
    {"code": "PRIVATE_KEY_MATERIAL", "countBucket": "ZERO"},
    {"code": "CREDENTIAL_ASSIGNMENT", "countBucket": "ZERO"},
    {"code": "PRC_ID_NUMBER", "countBucket": "ZERO"},
    {"code": "BANK_CARD_NUMBER", "countBucket": "ZERO"},
    {"code": "EMAIL_ADDRESS", "countBucket": "ZERO"},
    {"code": "PRC_MOBILE_NUMBER", "countBucket": "ZERO"},
    {"code": "URL", "countBucket": "ZERO"},
    {"code": "IP_ADDRESS", "countBucket": "ZERO"},
    {"code": "UNCLASSIFIED_TEXT", "countBucket": "ZERO"}
  ]
}
```

九个 finding code 及其顺序固定。`countBucket` 只能是 `ZERO`、`ONE`、`TWO_TO_FIVE` 或 `SIX_PLUS`；私钥与凭据赋值桶必须为 `ZERO`，因为本地网关会在创建出站数据之前阻断它们。V2 semantics 还把有序 evidence class 固定为 `STATIC_COMPILER_PROJECTION` 和 `DETERMINISTIC_LOCAL_CLASSIFICATION`，并把 `rawTextIncluded`、`redactedTextIncluded` 和 `tokenMapIncluded` 固定为 `false`。

Schema 没有可容纳原文、遮盖文本、预览片段、offset、token 值或 map、源摘要或复核摘要，以及自由格式 prompt 的位置。该 sidecar 验证这一封闭聚合约定；它不执行 DLP，也不会把不安全 payload 变安全。

`outgoingDigest` 必须等于对 payload 递归按键排序后所得紧凑 UTF-8 规范字节的 SHA-256。Harness prompt 只接收这些规范 payload 字节。因此，v2 封闭的 `contentPrivacy` 桶会进入 Session，而包装层、摘要、project、review、stage 和 approval 元数据绝不会进入。

成功结果为 `effiengine.fde-harness-advice-receipt`。它固定为 `ADVISORY_ONLY`、`KEYLESS_REPLAY`、`DENY_ALL_ENFORCED`、工具数为零、云端推理数为零，并且不执行 FDE 变更。运行时证据通过不同的 `sha256:` 字段分别绑定 manifest、适配器模板、展开后的有效 profile、规范运行时闭包、运行时入口和 sidecar。续传证据区分 `STARTED` 与 `RESUMED`，绑定稳定的规范 Session 文件头身份摘要、先前和完成后的规范事件计数与摘要、最后序号及已完成轮次，并把 `providerContinuationDigest` 固定为 `null`、`rawReasoningPersisted` 固定为 `false`；start 游标使用空字节的真实 SHA-256，而不是全零哨兵。不存在 `runtimeProfileDigest`：macOS 将一份展开后的适配器 profile 应用于完整子进程树，报告第二份 profile 会错误暗示存在第二个强制执行边界。失败结果只有：

```json
{"schemaVersion":1,"kind":"effiengine.fde-harness-sidecar-error","error":{"code":"<closed-code>"}}
```

错误不会回显 stderr、路径、token 或 payload。

## 实际执行的安全边界

- 沙箱外启动器首先以独占创建方式生成仅属主可访问的同级锁文件，验证其普通文件身份，并在沙箱子进程完整生命周期内保持文件描述符打开。此后它才验证规范 manifest 和每一项固定摘要、创建默认拒绝 profile，并启动 `/usr/bin/sandbox-exec`；它始终不读取、解析或验证 stdin。正常释放会先验证锁路径仍指向同一 device/inode 再删除。崩溃可能留下遗留锁，该锁会按设计以 `SESSION_BUSY` 失败关闭，且绝不会自动回收。
- 沙箱内适配器是第一个读取 payload 字节的进程。macOS 拒绝嵌套 `sandbox_init`，因此适配器与官方运行时共享一个默认拒绝 Seatbelt 边界。运行时是同一进程组中的子进程，不会脱离。
- 启动器向内部入口提供一个一次性 256 位 nonce，并将它绑定到私有运行证明文件、Session 根目录、运行根目录、预期续传游标、manifest 摘要、适配器模板摘要、展开后的 profile 摘要、锁路径、继承 FD 编号及锁 device/inode。沙箱内入口会独立比较路径与继承 FD 元数据、计算 `adapter.generated.sb` 的摘要、消费该证明，并在读取 stdin 前验证一个已知宿主文件已被拒绝。任何继承了任一内部环境变量的公共调用都会失败关闭。
- 适配器只可 fork 和 exec manifest 固定的 Node 二进制文件。运行时继承该许可，因此只能在同一策略内重新 exec 同一 Node 二进制文件；它不能 exec `/bin/sh` 或其他二进制文件。进程树只能读取 sidecar 资产、生成的 carrier 及其私有运行／Session 根目录，只能写入这些私有根目录，并且没有网络权限。
- 运行时 `cwd` 是不含 `.env` 的只读 bootstrap 目录；`DSH_CORDIS_CONFIG` 被显式指定。这封闭了通用 runner 的 cwd `.env` 覆盖路径。
- 有界客户端是本地代码，而不是上游 `HarnessClient`：单帧 64 KiB、最多 128 帧、stdout 总量 512 KiB、stderr 32 KiB、assistant 文本 16 KiB、每条 summary 500 个 Unicode code point、每项 action 300 个、初始化 5 秒、轮次绝对时限 15 秒、清理 3 秒。
- 未知通知／事件、重复响应、工具事件、含糊或多个 assistant 输出、越界、超时、shutdown 失败、尾随不完整输出或持久化不匹配都会失败关闭。运行时客户端与外层启动器都等待进程 close 和 stdio EOF，而不只等待子进程退出。
- 只有在官方 `shutdown`、进程 close 与 stdio EOF，以及完整 JSONL 事件序列回读之后才会返回回执。start 要求持久序列的规范字节等于有界协议事件序列。resume 还要求规范 Session 文件头身份和先前批准的前缀保持相同、旧计数位置恰有一个官方 `session/end-seed` 标记，并且新后缀等于有界协议事件序列。仅存在于持久日志的工具、未知事件、原始 reasoning，或额外的 user／assistant／turn 事件都会失败关闭。

Seatbelt 为受约束进程树提供纵深防御。它不能防御已经以同一 macOS 用户身份运行的其他恶意进程，也不能防御沙箱外 FDE 启动器被攻破。

## 固定的新 clone 闭包

本实验基于上游 commit `47f943859bef60e4160492346772ded9b24f765a`。仓库固定 `pnpm@11.7.0`；不得替换为 `npx` 或全局 pnpm。

```sh
git fetch origin lab/fde-context-capsule-p2l2b
git checkout --detach origin/lab/fde-context-capsule-p2l2b
test "$(git merge-base 47f943859bef60e4160492346772ded9b24f765a HEAD)" = 47f943859bef60e4160492346772ded9b24f765a
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm use 22.22.0
test "$(node --version)" = v22.22.0
test "$(corepack pnpm --version)" = 11.7.0
corepack pnpm install --frozen-lockfile
corepack pnpm run build:lib
node fde-sidecar/build-runtime-closure.mjs
node_modules/.bin/vitest run --config fde-sidecar/vitest.config.mjs
```

构建使用仓库官方 `pnpm deploy --legacy --prod --node-linker=hoisted` carrier 路线，并收窄到该固定组装可达的 60 个工作区包。它实体化链接、移除非运行时资产、断开工作区硬链接，并生成 `runtime-closure.json`。规范闭包按相对路径、POSIX mode、大小和 SHA-256 列出每个普通文件。启动会在创建沙箱或运行时之前拒绝软链接、不支持的文件类型、mode 或内容漂移、缺失文件及任何额外文件。

`runtime-manifest.json` 是没有自哈希的规范 JSON。`node.path` 和所有产物路径都相对于 manifest 的父目录解析。调用方必须单独固定完整 manifest 的 SHA-256；在同一次启动中计算并批准它不构成批准边界。`runtime-carrier/` 是生成且被忽略的目录，而其规范闭包进入版本控制，因此全新构建必须重现已批准字节。

## 已验证／未验证

专用测试会通过公共 CLI 执行真实 v1 和 v2 回放，验证规范请求准入、固定 manifest／Node、全新随机 Session、shutdown 后的精确 JSONL 持久化、payload 首次读取位置、一次性启动证明、外部标记注入拒绝、缺失叶目录的所有权，以及 Seatbelt 对宿主读写、网络和未固定 exec 的拒绝。真实 P2-L2b 测试会完成第一轮，让一个第二进程在持有继承锁 FD 时暂停，证明并发失败方返回 `SESSION_BUSY` 且持久日志逐字节不变，再以全新进程完成第二、三轮的可见历史重建。它证明旧前缀未变、事件序列与轮次连续、稳定 Session 身份保持一致，且不存在提供方 continuation。过期计数／摘要／身份、被替换的文件头 id 或创建时间、重命名根目录身份、cwd、序号、轮次、原始 reasoning、thinking／signature、工具和未知事件反例都会失败关闭。SDK 测试还会拒绝初始化前的 prompt／resume、重复初始化，以及对 prompt 已创建 Session 的 resume。V2 反例会在创建 Session 之前拒绝原文或遮盖文本、token map 和值、自由格式 prompt、预览片段、offset、源摘要、未知字段、重排或缺失的隐私 finding、无效桶以及非零硬阻断桶。测试还会拒绝继承锁身份漂移、证明创建后发生变化的有效 profile，以及 Session 创建前 carrier 中一个被修改的传递 JS 文件。仅存在于持久日志的工具和 assistant 反例，以及尾随未知、重复和不完整 JSON-RPC 输出，仍然失败。这些测试不通过仓库默认 CI 清单运行。

未验证或未交付：提供方专属的不透明 continuation、原始提供方 reasoning 保留、模型切换、压缩、保留／删除自动化、Linux／容器约束、云端提供方、凭据、DLP／token vault、模型质量、多用户授权、FDE 部署、腾讯部署、浏览器验收或生产保留策略。P1 carrier 是本地实验输入，不是客户分发产物；第三方许可审查、产物签名和分发打包仍是独立发布检查。以云端适配器替换回放需要独立的隐私网关与发布检查；本实验不作此类声明。
