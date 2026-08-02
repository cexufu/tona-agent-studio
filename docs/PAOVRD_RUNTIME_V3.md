# TONA PAOVRD Runtime v3

PAOVRD is TONA's bounded agent execution loop:

`Plan -> Act -> Observe -> Verify -> Replan -> Deliver`

It turns a model reply into a durable, auditable task without forcing ordinary chat through a slow agent loop.

## Routing

- Ordinary conversation keeps the existing single-response path.
- Explicit reminders, Feishu documents, calendar requests, permissions, and multi-agent collaboration keep their specialized handlers.
- Tasks that require search, calculation, file or URL reading, structured data work, artifact generation, or explicit multi-step execution enter PAOVRD.
- Feishu group messages still require a real `@` mention before any response or action.

## State machine

Every task is stored in the workspace database under `settings.assistantTasks` with `type: "paovrd"`.

| Phase | Responsibility | Durable output |
| --- | --- | --- |
| Plan | Define short steps and testable completion criteria | `plan` |
| Act | Select one registered tool, ask for input, or finish | `steps`, `pendingAction` |
| Observe | Store the actual tool receipt or error | `observations` |
| Verify | Judge evidence against completion criteria | `verification` |
| Replan | Revise remaining work when evidence is insufficient | revised `plan` |
| Deliver | Produce a concise Chinese result with evidence and limitations | `finalAnswer` |

The runtime stores short operational rationales only. It does not request or persist hidden chain-of-thought.

## Safety and control

- Only tools registered as `status: ready` and `executable: true` can be selected.
- Read-only tools can run automatically.
- Write or execute tools pause at `waiting_confirmation` and send a Feishu card showing the exact tool, risk, reason, and arguments.
- Approval is valid only for the current task and argument fingerprint. A changed call requires a new confirmation.
- Missing required information pauses at `waiting_input`. The requester's next `@` message in the same chat resumes that task.
- Duplicate tool calls and repeated no-progress observations are stopped.
- Tasks have step, tool-call, model-call, replan, and wall-clock budgets.
- If a budget is exhausted, the runtime delivers verified partial results and names unfinished work.

## Durability

The plan, observations, verification, trace, and counters are persisted after each phase. A task left in `running` for more than one minute is eligible for scheduler recovery after a process restart. The tool runtime receives an idempotency key derived from task, step, and tool ID.

## Tool Registry contract

The PAOVRD runtime has no hard-coded business tools. It consumes `executableToolCatalog()` and invokes tools through `executeTool()`.

The parallel Tools workstream can add a capability without changing PAOVRD when the tool:

1. Has a unique ID and JSON input/output schemas.
2. Declares `risk` as `read`, `write`, or `execute`.
3. Is registered as `ready` and executable.
4. Returns a structured receipt with evidence, sources, or artifact identifiers.
5. Uses runtime policy for validation, timeout, retries, rate limits, workspace isolation, audit, and idempotency.

## Observability

`GET /api/assistant-tasks` returns the latest workspace PAOVRD tasks with status, phase, counters, verification, and a sanitized trace. Tool inputs and secrets are deliberately omitted.

Default statuses are `running`, `waiting_confirmation`, `waiting_input`, `completed`, `completed_with_limits`, `failed`, and `cancelled`.

## Current boundary

PAOVRD can only be as capable as the registered tools. Planned tools such as sandboxed Python or PDF parsing are not exposed until their executors and policies are ready. Specialized Feishu write flows continue using their existing confirmation handlers until they are migrated into standard Tool Registry adapters.
