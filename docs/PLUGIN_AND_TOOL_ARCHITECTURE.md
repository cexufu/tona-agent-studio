# TONA Plugin and Tool Architecture

TONA exposes operational capabilities to every Agent and every account through a universal Plugin Host. An Agent's role changes expertise and communication style; it does not silently add or remove baseline tools.

## Plugin contract

Every plugin declares:

- a stable namespaced ID and semantic version;
- `scope: universal`;
- one or more schema-validated tools;
- optional lifecycle hooks (`beforeTool`, `afterTool`, `onToolError`);
- explicit risk, timeout, retry, idempotency, and rate-limit policy per tool.

The Host rejects duplicate plugin IDs, duplicate tool IDs, invalid versions, and non-universal manifests. Runtime responses expose a public plugin catalog and attach `pluginId`, `traceId`, and optional `parentInvocationId` to every execution envelope.

## Quality gates and traceability

Tool execution follows this order:

1. validate workspace and risk approval;
2. validate input schema;
3. run lifecycle hooks and the deterministic handler;
4. validate output schema and artifact IDs;
5. run tool quality gates;
6. emit a traceable result envelope and redacted audit event.

Quality gates fail closed with `TOOL_QUALITY_GATE_FAILED`. Audit records do not contain tool input or secrets.

## Hybrid memory

The `tona.memory` plugin provides `memory_remember`, `memory_search`, and `memory_forget`.

- Data is stored inside the active workspace and survives server restarts.
- Writes and deletes are risk `write` and require confirmation.
- Search is risk `read` and ranks lexical relevance, optional semantic similarity, recency, and user-assigned importance.
- One workspace cannot address another workspace's memory store.

The local fallback works without an embedding service. A deployment may provide `semanticMemorySearch` in the execution context to add vector similarity without changing the tool contract.

## Execution and document plugins

Python, R, SQL, browser automation, MCP, and Unstructured document parsing must run behind separately isolated executors. They must not execute arbitrary code or browser sessions inside the public Node web process. Production adapters must enforce:

- per-workspace credentials and network policy;
- CPU, memory, wall-clock, output-size, and artifact limits;
- disposable sandboxes with no platform filesystem or secret access;
- write confirmation for external mutations;
- trace propagation and artifact provenance.

This boundary is required before those tools can move from `planned` or `configuration_required` to `ready`.
