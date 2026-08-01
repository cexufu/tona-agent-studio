# TONA Universal Capability Runtime

## Why this exists

An Agent should not only generate a reply. It should decide whether a request needs information, an artifact, another participant, a scheduled action, or explicit authorization, then execute the chosen action through a controlled runtime.

This layer is shared by every Agent. Roles still define expertise and communication style, but they do not determine whether an Agent can search, create a document, schedule a reminder, or coordinate with another configured Agent.

## Architecture

```text
Feishu message
  -> relevance and intent planning
  -> structured capability plan
  -> policy and target validation
  -> confirmation or authorization when required
  -> deterministic executor
  -> Feishu receipt and audit event
```

The planner is provider-neutral. It asks the Agent model for strict JSON rather than relying on vendor-specific tool-call syntax, so the same execution layer can be used with OpenAI-compatible providers such as OpenAI, DeepSeek, Kimi, and Doubao.

## Capability levels

| Capability | Current state | Execution rule |
| --- | --- | --- |
| Web search and workspace reads | Ready | Read-only operations may run automatically and retain source metadata. |
| Feishu document creation | Ready | Requires an explicit or clearly reusable deliverable and requester confirmation. |
| One-time reminders and proactive messages | Ready | Requires a concrete future time and requester confirmation; tasks persist across service restarts. |
| Multi-Agent collaboration | Ready | Selects only relevant configured Feishu Agents, uses native mentions, and remains bounded. Explicit user role assignments override model planning. |
| Feishu calendar | Authorization required | The Agent may prepare and confirm a calendar action. Personal calendar writing still requires user OAuth. |
| Feishu Sheets and Bitable writes | Permission required | The planner may identify the need and request permission; a scoped executor is still required. |
| Feishu task management | Permission required | The planner may identify the need and request permission; a scoped executor is still required. |

## Planner contract

The planner can choose at most three material actions for one message. It must not invent targets, permissions, URLs, available tools, or successful execution. It may select another Agent only when that Agent is configured as a Feishu bot and has a distinct role relevant to the request.

Possible presentation modes are chat, card, document, and table. Presentation is chosen from the work product, not used as decoration: short answers stay in chat, confirmations use cards, durable long-form deliverables use documents, and structured comparisons may use tables.

## Safety and confirmation

- Read-only public search and file reads can execute without confirmation.
- Creating or modifying Feishu resources requires confirmation.
- Sending proactive messages or scheduling reminders requires confirmation.
- Only the original requester can confirm a reminder, and the original bot must process the callback.
- Collaboration has participant and round limits, deduplication, native Feishu mentions, and a final delivery mention to the requester.
- All model-selected actions are validated against allowlists before execution.
- Planner decisions and runtime tool calls are written to the tool audit log without storing API secrets.

## Reminder lifecycle

```text
planned -> pending_confirmation -> scheduled -> sending -> sent
                                      |             |
                                      |             -> scheduled (retry, maximum 3 attempts)
                                      -> cancelled
                                                    -> failed
```

The scheduler scans every workspace independently. A reminder is tied to its originating workspace, Feishu bot, chat, and requester. Restarting the service does not remove scheduled tasks.

## Separation of concepts

- **Agent**: identity, expertise, style, model, and role boundaries.
- **Tool**: a deterministic executable operation with validated input and an auditable result.
- **Universal capability**: planner-visible behavior that may combine tools, permissions, confirmation, and presentation.
- **Skill**: reusable domain workflow or knowledge, such as research review or report production.
- **Plugin**: an installable integration package that can register tools, authorization flows, and UI metadata.

Universal operational abilities belong in the Runtime rather than being duplicated in every role prompt. Skills may recommend tools, but only the Runtime is allowed to execute them.

## Next executors

1. Feishu OAuth for personal calendar read/write and free/busy checks.
2. Scoped Sheets and Bitable read/write operations with range previews and confirmation diffs.
3. Feishu task create, assign, update, and completion operations.
4. Contact and chat-directory resolution for safely mentioning or messaging people outside the current chat.
5. Recurring schedules with explicit timezone, end conditions, pause, edit, and delete controls.
