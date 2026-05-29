# Inistate TestBench — Full Plan

## Overview

TestBench is a benchmarking framework that runs multiple AI models against end-to-end Inistate workflow scenarios, measuring accuracy and token usage per task. It uses OpenRouter as the model gateway and connects to the Inistate MCP server for real workflow execution.

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

3. **Convert MCP tools → OpenRouter Agent SDK `tool()` format**
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

```
testbench/
  index.js              ← CLI entry point (inquirer prompts)
  runner.js             ← Main benchmark loop
  mcp_bridge.js         ← Spawns MCP, converts tools, bridges calls
  models.js             ← Model list + pricing
  visualise.js          ← CLI results visualiser
  scenarios/
    invoice_workflow.js ← End-to-end scenario with setup, tasks, teardown
  results/              ← JSON output per run
  plan.md               ← This file
```

---

## Components

### 1. Scenarios

Each scenario is a self-contained end-to-end workflow with:

- **setup** — creates required entries in Inistate before testing
- **system** — constant system prompt across all models
- **tasks** — array of individual tasks, each with a prompt and evaluator
- **teardown** — deletes created entries after all models finish

```javascript
{
  id: "invoice_workflow",
  name: "Invoice Approval Workflow",
  setup: async (mcpBridge) => { /* create entries */ return assets },
  system: "You are an invoice management AI...",
  tasks: [
    {
      id: "task_1",
      name: "Create Invoice",
      prompt: (assets) => `Create an invoice for Apex Solutions...`,
      evaluate: (toolCalls, response) => ({ success, issues, hallucinated })
    }
  ],
  teardown: async (mcpBridge, assets) => { /* delete entries */ }
}
```

**Key design decision:** Each task is a simple natural language instruction. The model decides on its own which tools to call (`get_form`, `list_entries`, `get_entry`, etc.). No ReAct prompting needed — that's only for stress-testing error recovery.

### 2. Models

Simple config file — add/remove models freely:

```javascript
{ id: "tencent/hy3-preview", name: "Hy3 Preview", price_in: 0.18, price_out: 0.59 }
```

Current models under test:

| Model | OpenRouter ID | Price (in/out per 1M) | AI Index |
|---|---|---|---|
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash` | $0.10/$0.20 | 47 |
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | $0.435/$0.87 | 52 |
| GPT-5 Nano | `openai/gpt-5-nano` | $2.50/$10.00 | 44 |
| Hy3 Preview | `tencent/hy3-preview` | $0.18/$0.59 | 42 |
| Gemini 3 Flash | `google/gemini-3-flash-preview` | $0.50/$3.00 | 71.3 |
| Gemini 3.1 Pro | `google/gemini-3.1-pro-preview` | $2.00/$12.00 | 57 |
| Owl Alpha | `openrouter/owl-alpha` | free | N/A |
| MiMo-V2.5 | `xiaomi/mimo-v2.5-pro` | $0.40/$2.00 | 54 |
| GPT OSS 120B | `openai/gpt-oss-120b` | free | 33.3 |
| Qwen 3.7 Max | `qwen/qwen3.7-max` | $2.50/$7.50 | 56.6 |

### 3. MCP Bridge

`mcp_bridge.js` handles:
- Spawning the Inistate MCP server process
- Converting MCP tool definitions to OpenRouter Agent SDK `tool()` format
- Forwarding tool calls from the model back to the MCP server
- Exposing a `callTool()` method for scenario setup/teardown

### 4. Runner

`runner.js` orchestrates:
- Connecting MCP
- Running scenario setup
- For each model × each task × each run: calling the model and evaluating the result
- Running scenario teardown
- Printing live progress and saving results

### 5. Visualiser

`visualise.js` renders results in the terminal with:
- **Task tickbox grid** — ☑/☒ per model per task
- **Score bar chart** — horizontal bars with color coding
- **Token & cost table** — avg tokens in/out and cost per model
- **Hallucination rate** — bar chart showing hallucination frequency
- **Failure analysis** — grouped issue list per model

Run standalone: `node visualise.js` (loads latest result automatically)

---

## Metrics

| Metric | How Measured |
|---|---|
| Accuracy | Judge function per task returns `success: true/false` |
| Input tokens | `response.usage.prompt_tokens` from OpenRouter |
| Output tokens | `response.usage.completion_tokens` from OpenRouter |
| Cost | `(input_tokens / 1M × price_in) + (output_tokens / 1M × price_out)` |
| Hallucination | Judge function returns `hallucinated: true/false` |
| Latency | `Date.now()` before/after `callModel()` |

---

## Use Cases Tested (Invoice Workflow Scenario)

| Task | What It Tests | Success Criteria |
|---|---|---|
| Create Invoice | Ambiguous input → structured form | Correct fields + amounts |
| Submit for Approval | State transition reasoning | Reaches Pending Approval via Generate Invoice |
| Check Available Actions | get_entry usage | Calls get_entry, mentions available activities |
| Check Overdue Invoices | Tool selection + filtering | Calls list_entries with Pinnacle filter |

---

## Benchmark Use Cases (benchmark.js — separate from TestBench)

The standalone `benchmark.js` tests 10 use cases across all models:

| # | Use Case | Type | Inistate API |
|---|---|---|---|
| 1 | Invoice Processing (Ambiguous Input) | Pure prompt | No |
| 2 | State Transition Reasoning | Tool calling | Yes |
| 3 | Multi-step Approval Workflow | Tool calling | Yes |
| 4 | Tool Selection | Tool calling | Dummy |
| 5 | Contradictory Instructions | Pure prompt | No |
| 6 | Missing Information Handling | Pure prompt | No |
| 7 | Error Recovery | Tool calling | Dummy |
| 8 | Long Context Retention | Multi-turn | No |
| 9 | Hallucination Trap | Tool calling | Dummy |
| 10 | Structured Output Consistency | Pure prompt | No |

---

## Key Findings from Benchmark Runs

### Hy3 Preview (AI Index 42, $0.18/1M)
- Passed 8/10 use cases on first benchmark run
- UC7 failure was likely test setup issue (entry not in correct state), not model failure
- UC10 failure: arithmetic inconsistency — tax calculation varied across 3 runs
- **Headline:** Low AI index does not predict production reliability for structured workflows

### Hallucination
- Every model hallucinated on at least one use case
- UC9 (Hallucination Trap) was hardest — models confidently invented invoice data for non-existent clients
- UC10 (Structured Output Consistency) showed arithmetic variance at temperature 1.5

### Temperature Effects
- Temperature 1.5 used for stress testing (state machine / hallucination experiments)
- Temperature 1.0 used for ReAct comparison
- Temperature 0.7 recommended for production reliability benchmarking

---

## Experiments Run (Proving Inistate Claims)

### Experiment 1 — State Machine vs Prompt Engineering
- **Setup:** 200 runs, GPT-4o-mini, temp 1.5, vague prompt
- **Group A:** Detailed step-by-step system prompt → 23/200 illegal executions (11.5%)
- **Group B:** Real Inistate API → 0/200 illegal executions (0%)
- **Claim:** Prompt engineering is a soft guardrail. State machine is a hard guardrail.
- **File:** `experiment.js`

### Experiment 2 — Typed Form vs No Schema (Hallucination)
- **Setup:** 20 runs Group A (no schema) vs 1 run Group B (typed schema + real API)
- **Group A:** 10% runs had hallucinated fields ("Net 45", "8%", wrong dates)
- **Group B:** 0 pre-submit issues, API enforced schema at boundary
- **Claim:** Instructions tell AI what to do. Typed schema forces it.
- **File:** `experiment2.js`

### Experiment 3 — ReAct Feedback Quality
- **Setup:** Same model, tools, restrictions — only feedback quality differs
- **Group A:** Generic error → "Unable to process request" → 8 steps, 2 failed attempts, tried irrelevant Edit action
- **Group B:** Structured error → "Activity Issue to Client not available" + available transitions → corrected in 1 step
- **Claim:** Standard ReAct is a closed loop (self-policing). Inistate ReAct is an open loop (real feedback injected).
- **File:** `experiment3.js`

### Adversarial Injection Test
- Submitted `bonus_payout: 5000` alongside valid invoice fields
- Result: field completely absent from stored data
- **Claim:** Schema doesn't just validate — it quarantines. Any field outside the contract is dead on arrival.

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
Token format: `uuid:secret` (e.g. `f600005f-f0e8-4d65-91dd-c95fd29c6eb2:TOKEN`)
Tokens expire — always fetch fresh from `INISTATE_API_TOKEN` env var or MCP logs.

### Workspace
- **Test (2234)** — primary test workspace
- **Inistate (1138)** — issue tracking workspace

---

## Setup

```zsh
cd testbench
npm install

export OPENROUTER_API_KEY=your_openrouter_key
export INISTATE_API_TOKEN=your_inistate_token
export INISTATE_API_URL=https://app02.apps.inistate.com
export INISTATE_MCP_PATH=/Users/jesmondtay/Documents/inistate-mcp/build/index.js

node index.js
```

---

## Adding a New Scenario

1. Create `scenarios/my_scenario.js`
2. Export object with `id`, `name`, `description`, `setup`, `system`, `tasks[]`, `teardown`
3. TestBench auto-discovers it — no other changes needed

## Adding a New Model

1. Edit `models.js`
2. Add `{ id: "provider/model-id", name: "Display Name", price_in: X, price_out: Y }`
3. Restart TestBench — model appears in CLI selection

---

## Rate Limiting Notes

- Free tier on OpenRouter: ~60s queue wait per call
- Hy3 Preview bypasses free tier queue — fast even on free tier
- Observed latency on free tier ≠ real model latency (includes queue overhead)
- Production latency target: **< 1000ms** for interactive use cases
- Paid tier recommended for accurate latency measurement
- Current delays: 3s between tasks, 10s between models (increase to 65s for free tier)
