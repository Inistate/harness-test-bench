import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type { GeneratedScenario, ResolvedConfig } from "../../types";

const GENERATED_DIR = path.join(__dirname, "generated");
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const BUILDER_MODEL = "openai/gpt-5-nano";
const SCENARIO_RE = /<scenario>([\s\S]*?)<\/scenario>/;

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

function buildSystemPrompt(toolNames: string[]): string {
  const toolList = toolNames.map((t) => `  - ${t}`).join("\n");
  return `You are a scenario builder for Inistate TestBench — a tool that benchmarks AI models on Inistate workflow scenarios.

Your job: guide the user through designing a complete test scenario via conversation, then output it as JSON.

Available MCP tools the AI model under test can call:
${toolList}

Through conversation, gather:
- What Inistate module(s) are involved? What states, fields, activities?
- What 2–5 tasks should the model be tested on?
- What test data needs to exist upfront (modules, entries)?
- For each task: what tool calls are expected, what argument values, any correctness criteria?
- Does each task need a pre-setup step to prevent cascading failures?

Ask 2–3 focused questions at a time. Once you have enough to write a complete, unambiguous scenario, output it.

When ready, wrap the JSON in <scenario>...</scenario> tags.

JSON format:
{
  "id": "snake_case_id",
  "name": "Human readable name",
  "description": "One sentence description",
  "system": "System prompt for the AI model under test. Tell it what it is and that the workspace is already active — no need to pass workspaceId to tools.",
  "setupPrompt": "Natural language instructions for setting up the test environment before the benchmark runs. The setup agent will execute this using MCP tools. Describe: what modules to create (states, fields, activities, flows), what entries to create and in what state. End with: output <assets>{workspaceId, ...allCreatedIds}</assets>",
  "tasks": [
    {
      "id": "task_1",
      "name": "Task name",
      "prompt": "Natural language instruction for the model. Use \${workspaceId} or \${entryId} for dynamic values from setup assets.",
      "setupPrompt": "Optional. Ensure correct pre-task state regardless of prior task outcome (e.g. reset entry to Draft, recreate a deleted entry). Prevents cascading failures.",
      "checks": [
        "called:get_form",
        "not_called:upload_file",
        "arg:submit_activity.module=Invoice",
        "success:submit_activity"
      ],
      "ai": "Optional. LLM judge criteria for things checks cannot verify — e.g. 'The model correctly extracted the client name and amount from the ambiguous description'",
      "maxSteps": 10
    }
  ]
}

Check syntax (all deterministic — no LLM needed):
- called:<tool>          tool was called at least once
- not_called:<tool>      tool was NOT called (hallucination guard)
- arg:<tool>.<arg>=<val> a specific argument matches this exact value
- success:<tool>         tool was called and returned without error

Rules:
- Every task must have at least one check.
- setupPrompt at scenario level is required.
- Per-task setupPrompt is optional but recommended for tasks 2+ that depend on state.
- Use "ai" only for subjective correctness (field content, response quality) — not for tool presence.`;
}

async function callLLM(messages: Message[], apiKey: string): Promise<string> {
  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: BUILDER_MODEL, messages, temperature: 0.7 }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

function validateScenario(raw: unknown): raw is GeneratedScenario {
  const s = raw as Record<string, unknown>;
  if (!s?.id || typeof s.id !== "string") return false;
  if (!s?.name || typeof s.name !== "string") return false;
  if (!s?.system || typeof s.system !== "string") return false;
  if (!s?.setupPrompt || typeof s.setupPrompt !== "string") return false;
  if (!Array.isArray(s?.tasks) || (s.tasks as unknown[]).length === 0) return false;
  for (const task of s.tasks as Array<Record<string, unknown>>) {
    if (!task?.id || !task?.name || !task?.prompt) return false;
    if (!Array.isArray(task?.checks) || (task.checks as unknown[]).length === 0) return false;
  }
  return true;
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function runChatAgent(config: ResolvedConfig, toolNames: string[]): Promise<void> {
  if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const messages: Message[] = [{ role: "system", content: buildSystemPrompt(toolNames) }];

  console.log("\n╔══════════════════════════════════════╗");
  console.log("║     Inistate Scenario Builder        ║");
  console.log("╚══════════════════════════════════════╝");
  console.log('Describe the workflow you want to benchmark. Type "quit" to exit.\n');

  try {
    while (true) {
      const userInput = await ask(rl, "You: ");
      const trimmed = userInput.trim();
      if (trimmed.toLowerCase() === "quit") break;
      if (!trimmed) continue;

      messages.push({ role: "user", content: trimmed });

      process.stdout.write("\nAssistant: ");
      let reply: string;
      try {
        reply = await callLLM(messages, config.openRouterKey);
      } catch (e) {
        console.log(`\n⚠  LLM error: ${(e as Error).message}\n`);
        messages.pop(); // remove the failed user message so user can retry
        continue;
      }
      console.log(reply + "\n");
      messages.push({ role: "assistant", content: reply });

      const match = SCENARIO_RE.exec(reply);
      if (!match) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(match[1].trim());
      } catch {
        console.log('⚠  Could not parse scenario JSON. Tell me what to fix.\n');
        continue;
      }

      if (!validateScenario(parsed)) {
        console.log('⚠  Scenario is missing required fields (id, name, system, setupPrompt, tasks with checks). Tell me what to fix.\n');
        continue;
      }

      const scenario = parsed as GeneratedScenario;
      const outPath = path.join(GENERATED_DIR, `${scenario.id}.json`);
      const exists = fs.existsSync(outPath);

      console.log("─── Scenario Preview ───────────────────────────────────");
      console.log(`ID:          ${scenario.id}`);
      console.log(`Name:        ${scenario.name}`);
      console.log(`Description: ${scenario.description ?? "(none)"}`);
      console.log(`Tasks (${scenario.tasks.length}):   ${scenario.tasks.map((t) => t.name).join(" → ")}`);
      if (exists) console.log(`⚠  Will overwrite existing: ${outPath}`);
      console.log("────────────────────────────────────────────────────────\n");

      const confirm = await ask(rl, "Save this scenario? (y / n to keep refining): ");
      if (confirm.trim().toLowerCase() === "y") {
        fs.writeFileSync(outPath, JSON.stringify(scenario, null, 2));
        console.log(`\n✅ Saved to ${outPath}\n`);
        break;
      }
      console.log("Kept. Continue refining.\n");
    }
  } finally {
    rl.close();
  }
}
