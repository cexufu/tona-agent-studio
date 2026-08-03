# TONA Harness 架构与治理规则

本文记录当前代码实际执行的规则，而不是未来设想。界面采用武侠风命名，底层协议使用稳定的英文 ID，避免展示名变化影响兼容性。

## 产品入口

| 界面名称 | 实际职责 |
| --- | --- |
| 问剑台 | 直接安排任务与运行 Skill |
| 布阵台 | 快速配置模型、Agent 与飞书入口 |
| 内功堂 | 模型供应商与成本 |
| 群侠谱 | Agent Profile、Skill、Tool、Memory、Runtime、委派和飞书绑定 |
| 武学阁 | Skill 创建、测试、预检和发布 |
| 神兵坊 | Tool Manifest、联网配置与工作区 Policy |
| 藏经阁 | 工作区文件、版本和 artifact |
| 飞鸽驿 | 飞书应用、机器人与 OAuth 状态 |
| 江湖令 | PAOVRD、Subagent、提醒和日历任务 |
| 行迹录 | 运行、模型与工具审计 |

## Agent Profile

每个 Agent 独立保存：

- 身份：名称、职责、目标、表达风格、边界和输出格式；
- 模型：供应商、模型、温度；
- Skill 绑定：启用状态和优先级；
- Tool Policy：显式允许的 Tool ID；
- Memory Policy：core、semantic、task、episodic、short-term、范围和保留时间；
- Runtime Policy：步骤、工具调用、模型调用、重规划和时长上限；
- Delegation Policy：是否可委派、可调用谁、允许谁调用、最大深度、并发和总数；
- Channel Binding：一个飞书机器人绑定一个 Agent。

旧 Agent 保存或加载时自动迁移到 Profile v2。Tool ID 和 API 保持向后兼容。

## Tool Contract 1.0

每个真实 Tool 对外同时暴露统一 Manifest：

- id、version、owner、lifecycle、status、kind；
- name、category；
- description.summary、whenToUse、whenNotToUse；
- inputSchema、outputSchema；
- policy.operationRisk：read / compute / write / send / destructive；
- policy.sideEffectScope：none / workspace / external；
- requiredScopes、confirmation、network；
- concurrency、timeout、retry、idempotency、rateLimit；
- executable。

Capability 只用于规划，Tool 才能直接执行。status 不是 ready 或 executable 不是 true 时不能执行。

执行顺序固定为：查找 Tool → Policy 编译 → 工作区和风险授权 → 输入 Schema → 限流与幂等 → 超时/重试执行 → 输出 Schema → artifact_id 校验 → 审计回执。

## Policy Kernel

Policy 由 Platform、Workspace、Agent、Task 四层显式策略与 Tool Contract 合并。规则如下：

1. deny 优先于 confirm，confirm 优先于 allow；
2. 任意层明确 deny Tool、网络或外部写入，最终都不能被下层放宽；
3. Agent Tool 白名单是硬边界；
4. Tool requiredScopes 必须全部满足；
5. Tool 未声明 network=allow 时默认无网络；
6. sideEffectScope=external 默认需要确认；Workspace 可改为 deny；
7. sideEffectScope=workspace 的文件产物不视为外部写入；
8. confirmation=before_execute 必须携带本次确认；
9. 超时、内存、输出量和并发取所有层中最严格的有效上限；
10. Policy 决策和 reasonCode 写入 Tool 审计。

神兵坊可设置工作区网络策略与外部写入策略。外部写入的“允许”仍不能绕过 Tool 自己的 before_execute 要求。

## Plugin Host 与扩展能力

所有可执行工具由 universal Plugin Host 注册，再转换为 Tool Contract。当前正式插件包括网页、确定性计算、工作区文件、PDF、混合记忆、新 Python 和远程隔离执行器。插件 ID、版本和 scope 会写入 Tool Manifest；执行回执包含 pluginId、traceId、parentInvocationId 和质量门结果。

- PDF 只在当前 workspace 本地读取嵌入文本；扫描件明确转交 OCR/Unstructured；
- 长期记忆按 workspace 隔离，写入和删除需要确认，检索综合词法、可选语义、时间和重要性；
- R、SQL、Unstructured、远程浏览器和 MCP 只通过 TONA_EXECUTOR_URL 调用；
- 远程浏览器与 MCP 视为外部副作用，执行前必须确认；
- Plugin Hook 和质量门失败时关闭式失败，不把未经验证的结果当作成功。
## Python 隔离计算

Tool ID 为 code.python.run。没有配置执行器时状态为 setup_required，不伪装成可用。

输入仅接受代码和当前工作区 inputArtifactIds。服务器用 artifact_id 查找文件，不接受宿主路径。Docker 模式下：

- 每次调用新建并自动删除容器；
- 网络关闭，根文件系统只读；
- drop all capabilities，启用 no-new-privileges；
- 限制 CPU、内存、进程数、时长和输出；
- /job/input 只读，/job/output 可写；
- /tmp 是独立、限量、noexec 的 tmpfs；
- 用户代码以 python -I 执行；
- 输出文件回存藏经阁并生成 artifact_id；
- stdout/stderr 截断并进入结构化回执。

生产平台不能运行 sibling container 时使用 TONA_PYTHON_RUNNER_URL 对接外部隔离服务。严禁在 Studio Web 进程里直接 exec Python。

## Subagent 与 A2A

协议版本为 tona-a2a/1.0。请求包含 trace/span、父子 Agent、intent、payload、outputSchema、deadline 和 idempotencyKey。

委派规则：

1. 父 Agent 必须 canDelegate；
2. 目标必须在父 callableAgentIds 中；
3. 子 Agent 的 callableByAgentIds 必须接受父 Agent；
4. 深度最大 2，默认 1；
5. 单父并发默认 2、最大 4；单任务子 Agent 默认 4、最大 8；
6. 子工具集是父白名单、子白名单和任务工具集的交集；
7. 子 Agent 不获得 external side-effect Tool；外部写入由父 Agent 提案和确认；
8. 父子共享模型、工具、时长和子 Agent 预算；
9. 相同 idempotencyKey 复用已有子任务；
10. 子任务状态写入江湖令，并记录 parentTaskId、traceId、Agent、输出、artifact 和 metrics；
11. 取消父任务会取消尚未终止的子任务；
12. 子 Agent 只返回摘要、结构化输出、artifact 和 action proposal，不把隐藏推理写入上下文。

PAOVRD Act 阶段可以选择 tool、delegate、ask_user 或 finish。delegate 结果作为 subagent.run Observation，再进入 Verify 和 Deliver。

## Skill Contract

Skill 包含版本和四态：draft、tested、published、deprecated。

- draft：可编辑，不自动激活；
- tested：至少成功完成一次 Studio 测试；
- published：可被 Agent 自动选择；
- deprecated：停用且不再激活。

合同字段包括 triggerExamples、whenToUse、whenNotToUse、requiredInputs、requiredCapabilities、optionalCapabilities、inputGuide、steps、outputContract、qualityChecklist 和 runtimeInstructions。

激活时先检查 Agent 是否绑定，再排除 draft/deprecated 和 whenNotToUse，最后按关键词、示例和 whenToUse 评分。发布前预检名称、描述、步骤、Tool ID 和 Agent 授权；硬错误阻断发布，软缺口作为 warning。Skill 只能指导决策，不能证明 Tool 存在或动作成功。

## 飞书个人 OAuth 与长回复

个人授权绑定到具体 Agent 的飞书机器人。OAuth state 带 workspace、bot、request、scope、过期时间和 nonce，并使用 TONA_OAUTH_STATE_KEY 签名；access token 与 refresh token 使用工作区密钥加密落盘。个人 OAuth 不能替代飞书管理员应用权限。

长回复按 20 行和 3500 字符双上限拆成有序消息，标题带分片序号，避免截断首尾内容。
## 飞书与任务状态

飞书群聊默认只有真实 @ 才触发回复；未 @ 的消息只可进入受控上下文。一个飞书 App 机器人绑定一个 Agent，按工作区和 App ID 路由。

外部写入、发送、日历和文档动作必须遵循 Tool Contract 与 Policy；确认只授权本次参数，不是永久授权。缺权限时保留任务断点并请求权限，不声称已完成。

江湖令统一展示 PAOVRD、Subagent、scheduled_reminder 和 calendar_plan。父子任务按 parentTaskId 展示，常见状态包括 running、waiting_confirmation、waiting_input、partial、completed、completed_with_limits、failed、cancelled、timed_out 和 refused。

## 部署

主服务可独立运行；Python 是可选的隔离工作节点。

- TONA_OAUTH_STATE_KEY：飞书个人 OAuth state 签名；
- TONA_EXECUTOR_URL / TONA_EXECUTOR_TOKEN：R、SQL、Unstructured、浏览器和 MCP 隔离服务；
- TONA_PYTHON_DOCKER_IMAGE：本机或可运行 Docker 的私有部署；
- TONA_PYTHON_RUNNER_URL：外部隔离服务；
- TONA_PYTHON_RUNNER_TOKEN：Runner Bearer Token；
- TONA_SECRETS_KEY：工作区密钥加密；
- DATA_DIR：持久化数据目录。

发布前至少运行 npm run check 和 npm test。Python Runner 镜像说明位于 python-runner/README.md。