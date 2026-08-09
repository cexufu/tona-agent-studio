# OpenWorker 兼容内核

TONA AI Studio 现在把 OpenWorker 作为任务执行内核。TONA 保留线上产品层：账号与工作区、Agent 身份、Skill 中心、飞书机器人、任务中心和 Render 常驻服务；OpenWorker 接管会话、计划、Todo、工具调用、文件、终端、审批与中断。

## 运行结构

```text
浏览器 / 飞书
      |
TONA Gateway + Studio (Node.js)
      |
OpenWorker Adapter (REST + WebSocket + Inbox)
      |
OpenWorker Server (Python, loopback or remote)
      |
模型 / 文件工作区 / 终端工具
```

生产环境默认使用 `embedded`：同一个 Render Docker 服务启动 OpenWorker，并只监听 `127.0.0.1:7360`。TONA 对外暴露经过鉴权和权限收敛的 Studio API，不把 OpenWorker 原始端口暴露到公网。

也可以使用 `remote`，把 TONA 接到用户已有的 OpenWorker 服务。远程地址必须使用 HTTP(S)，凭证通过 `X-OpenWorker-Token` 和 WebSocket 子协议传递，页面只返回掩码。

## 映射规则

- TONA Agent 的名称、角色、风格、目标、边界和输出格式会组成 OpenWorker 的身份上下文。
- 每个 Agent 可选择 `cowork`、`code` 或 `chat` Worker，以及 `discuss`、`plan`、`interactive` 或 `auto` 模式。
- TONA Skill 在使用前同步为 OpenWorker Skill；步骤、输入说明、输出契约和质检项被转换为 Skill instructions。
- 飞书聊天、线程、机器人和发起人组成稳定的 OpenWorker session id，同一会话可以跨轮继续。
- OpenWorker 的 `permission_required`、`plan_proposed` 和 `question_requested` 会转成 TONA 任务状态与飞书审批/问答。
- 工具开始、结束、失败和最终输出会写回江湖令（任务中心），便于线上查看执行轨迹。

## 终端与安全边界

线上工作台只提交任务和展示结果，不提供无约束的浏览器 Shell。真正的命令由 OpenWorker `code`/`cowork` Agent 在配置的工作区内执行，并继续受 OpenWorker 权限审批约束。默认 `interactive` 模式；写文件、命令执行和外部动作按 OpenWorker 的 Inbox 请求由用户逐次确认。

OpenWorker API token 必须使用 Render secret 或环境变量，不应提交到仓库。生产工作区和状态存放在 `/var/data/openworker` 持久磁盘。远程模式建议使用 HTTPS 和独立长随机 token。内嵌模式默认把当前 Agent 使用的 TONA Provider 凭证写入 OpenWorker 自己的 SecretStore，从而复用已有模型配置；远程模式默认关闭该同步，避免把模型 Key 发送给外部 Worker，只有用户显式开启后才同步。

## Render 配置

`render.yaml` 已切换到 Docker runtime，并设置：

```text
OPENWORKER_MODE=embedded
OPENWORKER_ENABLED=true
OPENWORKER_API_TOKEN=<Render generated secret>
OPENWORKER_DEFAULT_MODE=interactive
OPENWORKER_STATE_DIR=/var/data/openworker/state
OPENWORKER_WORKSPACE=/var/data/openworker/workspace
```

Docker 镜像固定安装官方 OpenWorker commit `01b6f83b3927e02912dda84bb392942c13ca70d1`，避免上游更新在无人值守部署时突然改变协议。升级时应先修改 pin，再运行兼容测试和完整回归。

## 回退与远程接入

- 临时回退旧 Runtime：设置 `OPENWORKER_ENABLED=false` 或 `OPENWORKER_MODE=disabled`，Agent 也可单独选择 `legacy`。
- 接入已有 Worker：设置 `OPENWORKER_MODE=remote`、`OPENWORKER_URL=https://...`、`OPENWORKER_API_TOKEN=...`。
- 本地开发默认不自动启动 OpenWorker；显式设置上述变量后再启动即可。

## 验证

```powershell
npm.cmd run check
npm.cmd test
npm.cmd audit --omit=dev
```

Studio 的“行走台”可测试内核连接、同步 Skill、查看会话并提交在线任务。飞书端通过任务卡确认危险操作；任务被中断、失败或达到运行上限时，应查看任务中的停止阶段、已完成工具、未完成事项和继续建议。
