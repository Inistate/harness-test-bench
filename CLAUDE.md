# Inistate TestBench — Full Plan

## Overview

TestBench is a benchmarking framework that runs multiple AI models against end-to-end Inistate workflow scenarios, measuring accuracy, latency, token usage, and cost per task. It uses OpenRouter as the model gateway and connects to the Inistate MCP server for real workflow execution.

---

## How OpenRouter Connects to the Inistate MCP Server

### The Core Concept

OpenRouter does **not** natively support MCP. Instead, we bridge the two:

```
OpenRouter (any model)
    ↑ tool call requests
TestBench Runner (Node.js)
    ↓ forwards via stdio
Inistate MCP Server (child process)
    ↓ HTTP
app02.apps.inistate.com API
```

### How It Works Step by Step

1. **Spawn MCP server as child process**

   ```
   node /path/to/inistate-mcp/build/index.js
   ```

   The MCP server communicates over stdio using JSON-RPC.

2. **List tools from MCP server**

   ```
   session.list_tools() → returns MCP tool definitions
   ```

   Each tool has a name, description, and inputSchema (JSON Schema format).

3. **Convert MCP tools → OpenRouter Agent SDK** `tool()` **format**

   ```
   MCP inputSchema (JSON Schema) → Zod schema
   MCP execute → forwards call to session.call_tool()
   ```

   The model sees OpenRouter-compatible tool definitions but every execution hits the real Inistate API.

4. **Model makes tool calls via OpenRouter**

   ```
   callModel({ model, messages, tools }) → model returns tool_calls
   ```

   The Agent SDK automatically executes the tools, feeds results back, and loops until done.

5. **Tool execution flows back to MCP**

   ```
   tool.execute(params) → session.call_tool(name, params) → Inistate API → result
   ```

### Why This Approach

- OpenRouter supports OpenAI-compatible function calling — any model that supports tool calling can use Inistate tools
- The MCP server handles auth, token refresh, normalization, and guardrails — TestBench gets all of that for free
- No duplicate implementation — same MCP server used in Claude Desktop is used here

### Auth Format

The Inistate MCP server uses `fsk` token format (not `Bearer`):

```
Authorization: fsk YOUR_TOKEN
```

The token is passed as `INISTATE_API_TOKEN` env var to the MCP child process.

---

## Architecture

> **Note:** The codebase is fully TypeScript. All source files are under `src/` and compiled to `dist/` via `tsc`.

```
src/
  index.ts                          ← CLI entry point (inquirer prompts)
  types.ts                          ← Shared TypeScript interfaces
  core/
    benchmark-runner.ts             ← Main benchmark loop
    llm-judge.ts                    ← LLM judge for schema-defined scenarios
    check-evaluator.ts              ← Evaluator for check-based assertions
    logger.ts                       ← Debug/info/warn/error logger gated by LOG_LEVEL
  bridges/
    mcp-bridge.ts                   ← Spawns MCP, converts tools, bridges calls
    api-bridge.ts                   ← Direct Inistate API calls (module CRUD)
  data/
    models.ts                       ← Model list (dynamic from OpenRouter + local fallback)
  display/
    results-visualiser.ts           ← CLI results visualiser
    results-analyser.ts             ← Cross-run results analysis
    merge-results.ts                ← Merge multiple result files
  scenarios/
    invoice-workflow.ts             ← Invoice approval end-to-end scenario
    cascading-smoke-test.ts         ← All-tools cascading smoke test
    smoke-all-tools-independent.ts  ← All-tools independent smoke test
    recruitment-interview.ts        ← Cross-module recruitment interview scenario
    scenario-builder.ts             ← Chat-based scenario builder (LLM-assisted)
    scenario-creator.ts             ← Scenario creation utilities
    generated/                      ← JSON scenario schemas created via builder
results/                            ← JSON output per run (gitignored)
plan.md                             ← This file
```

---

## Components

### 1. Scenarios

Each scenario is a self-contained end-to-end workflow. The key pattern:

- **Global** `setup` — runs once per model × run and creates shared run-level resources such as modules
- **Per-task** `setup` — seeds an isolated dataset for that task
- `system` — constant system prompt across all models
- `tasks` — array of tasks, each with `prompt`, `evaluate`, optional `setup`, `verify`, and `teardown`
- `evaluate` — checks tool calls and response immediately after the agent finishes
- `verify` — calls the real API after evaluate to confirm state was actually written correctly
- **Per-task** `teardown` — always runs after the task attempt, including setup/model/verify failures, and removes task data
- **Global** `teardown` — runs after each model × run and removes shared resources plus any orphaned task data

```typescript
const scenario: Scenario<MyAssets> = {
  id: "my_scenario",
  name: "My Scenario",
  description: "What this tests",

  setup: async (bridge, workspaceId) => {
    // Create run-level modules/resources.
    return { workspaceId, entryId: 0 };
  },

  system: (assets) => `You are an AI assistant. Workspace ${assets.workspaceId} is active.`,

  tasks: [
    {
      id: "task_1",
      name: "Do something",
      setup: async (bridge, assets) => {
        // Seed this task's independent data and mutate assets.
        assets.entryId = await createEntry(bridge, assets.workspaceId);
      },
      prompt: (assets) => `Do something with entry ${assets.entryId}`,
      evaluate: (toolCalls, response, assets) => ({
        success: true, issues: [], hallucinated: false,
      }),
      verify: async (bridge, assets) => {
        // Layer 3: check real API state.
      },
      teardown: async (bridge, assets) => {
        // Remove this task's entries. This hook always runs.
      },
    },
  ],

  teardown: async (bridge, assets) => {
    // Remove run-level modules and perform fallback orphan cleanup.
  },
};
```

**Key design decision:** Each task is a simple natural language instruction. The model decides on its own which tools to call. Global hooks isolate model runs; task hooks isolate tasks within a run.

### 2. Current Scenarios

| Scenario | ID | Tasks | What It Tests |
| --- | --- | --- | --- |
| Invoice Approval Workflow | `invoice_workflow` | 4 | Invoice creation, approval routing, overdue detection |
| Field Service Dispatch | `field_service_dispatch` | 4 | Technician type matching, availability checking via linked issues |
| Recruitment Interview | `recruitment_interview` | 4 | Cross-module scheduling, clash detection, foreign ref navigation |
| Loan Application | `loan_application` | 4 | Compound conditional branching via cross-module foreign refs |
| Vendor Selection | `vendor_selection` | 4 | Multi-option comparative evaluation with weighted decision gates |
| Inventory Reorder Cascade | `inventory_reorder` | 4 | Cross-module aggregation + cascading writes to variable row sets |
| Doctor Appointment — Patient Identity & Grounding | `doctor_appointment_grounding` | 5 | Similar-name identity resolution, empty-field grounding, booking and rescheduling |
| Email Activity — End-to-End Retrieval | `stateless_email_activity_workflow` | 5 | Cross-module recipient resolution and entry-scoped Email activity execution |
| All-Tools Smoke Test (Independent) | `smoke_all_tools_2` | 5 | All MCP tools, each task independent |
| All-Tools Smoke Test (Cascading) | `smoke_all_tools_2_cascading` | 5 | All MCP tools, tasks build on each other |
| All-Tools Smoke Test (Full) | `smoke_all_tools` | 21 | Every MCP tool exercised once across configure and runtime modes |

### 3. Models

Models are loaded dynamically from the OpenRouter API at startup, filtered to supported providers. A static fallback list is used if the API call fails.

Supported providers: `anthropic`, `openai`, `xai`, `deepseek`, `qwen`, `moonshotai`, `moonshot`, `minimax`

Local models (served via `mlx_lm`) are also supported — set `local: true` in `models.ts` and configure `LOCAL_BASE_URL`.

### 4. MCP Bridge

`mcp-bridge.ts` handles:

- Spawning the Inistate MCP server process
- Converting MCP tool definitions to OpenRouter Agent SDK `tool()` format
- Forwarding tool calls from the model back to the MCP server
- Exposing a `callTool()` method for scenario setup/teardown

### 5. Runner

`benchmark-runner.ts` orchestrates:

- Connecting MCP
- Running global scenario setup
- For each model × each task × each run: calling the model, evaluating the result, running verify
- Running global scenario teardown (no-op — actual cleanup in last task verify)
- Printing live progress and saving results

### 6. Visualiser & Analyser

`results-visualiser.ts` renders results in the terminal with:

- **Task tickbox grid** — ☑/☒ per model per task
- **Score bar chart** — horizontal bars with color coding
- **Token & cost table** — avg tokens in/out and cost per model
- **Hallucination rate** — bar chart showing hallucination frequency
- **Failure analysis** — grouped issue list per model

`results-analyser.ts` supports cross-run analysis across multiple result files.

---

## Metrics

| Metric | How Measured |
| --- | --- |
| Accuracy | `evaluate()` per task returns `success: true/false` |
| Verify | `verify()` per task calls real API post-agent to confirm state |
| Input tokens | Fetched per-generation from OpenRouter API |
| Output tokens | Fetched per-generation from OpenRouter API |
| Cost | Fetched per-generation from OpenRouter API |
| Hallucination | `evaluate()` returns `hallucinated: true/false` |
| Latency | `Date.now()` before/after `callModel()` |

---

## Evaluation: Three Levels

| Level | Where | What |
| --- | --- | --- |
| 1\. Tool call check | `evaluate()` | Did the agent call the right tools with the right arguments? |
| 2\. Response check | `evaluate()` | Did the response mention the right things? |
| 3\. Real API verify | `verify()` | Did the API actually record the correct state? |

Level 3 is the strongest signal — it catches cases where the agent called the right tool but with wrong data, or where the API rejected the call silently.

---

## Inistate API Notes

### Auth

```
Authorization: fsk TOKEN
wsid: WORKSPACE_ID   ← header, not body
```

### Key Endpoints

```
POST /api/mcp/activity/bulk   ← submit_activities
POST /api/mcp/entry           ← get_entry
POST /api/mcp/entries         ← list_entries
POST /api/mcp/form            ← get_form
POST /api/mcp/entry/history   ← get_entry_history
```

### Token Format

Token format: `uuid:secret` (e.g. `f600005f-f0e8-4d65-91dd-c95fd29c6eb2:TOKEN`) Tokens expire — always fetch fresh from `INISTATE_API_TOKEN` env var.

### Workspace

- **Test (11481)** — primary test workspace

---

## Setup

```zsh
npm install

export OPENROUTER_API_KEY=your_openrouter_key
export INISTATE_API_TOKEN=your_inistate_token
export INISTATE_API_URL=https://app02.apps.inistate.com
export INISTATE_MCP_PATH=/Users/yourname/Documents/inistate-mcp/build/index.js

npm start
```

---

## Adding a New Scenario (TypeScript)

1. Create `src/scenarios/my_scenario.ts`
2. Follow the pattern:
   - Global `setup` creates run-level modules and returns the assets shell
   - Every task `setup` seeds an independent dataset
   - Every task `verify` performs Layer 3 API validation
   - Every task `teardown` removes its entries
   - Global `teardown` removes modules and performs fallback cleanup
3. Export with `module.exports = scenario` — auto-discovered by the runner

## Adding a New Model

Models are loaded dynamically from OpenRouter. To add a local model:

1. Edit `src/data/models.ts`
2. Add `{ id: "my-model-local", name: "My Model", price_in: 0, price_out: 0, local: true }`
3. Ensure `LOCAL_BASE_URL` points to your local inference server

---

## Rate Limiting Notes

- Paid tier recommended for accurate latency measurement
- Free tier includes queue wait time which inflates latency numbers
- Current delays: 3s between tasks, 10s between models
