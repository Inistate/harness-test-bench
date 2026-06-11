import * as fs from "fs";
import * as path from "path";
import type { ScenarioResult, TaskResult, ToolCall } from "../types";

const c = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  magenta: "\x1b[35m",
};

const tick  = `${c.green}✅${c.reset}`;
const cross = `${c.red}❌${c.reset}`;
const warn  = `${c.yellow}⚠${c.reset}`;

function loadResults(filePath?: string): Record<string, ScenarioResult> {
  if (filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, ScenarioResult>;
  }
  const dir = path.join(__dirname, "../../results");
  if (!fs.existsSync(dir)) { console.error("No results directory found."); process.exit(1); }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
  if (files.length === 0) { console.error("No result files found."); process.exit(1); }
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8")) as Record<string, ScenarioResult>;
}

function fmtArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 120 ? text.slice(0, 120) + "…" : text;
}

function fmtResult(result: unknown): string {
  if (result === undefined) return "—";
  const r = result as Record<string, unknown>;
  if (r?.error) return `${c.red}error: ${String(r.error).slice(0, 80)}${c.reset}`;
  const entryId  = r?.entryId ?? (r?.entryIds as unknown[])?.[0];
  const state    = r?.state;
  const listLen  = Array.isArray(r?.list) ? (r.list as unknown[]).length : undefined;
  const parts: string[] = [];
  if (entryId  !== undefined) parts.push(`entryId=${String(entryId)}`);
  if (state    !== undefined) parts.push(`state=${String(state)}`);
  if (listLen  !== undefined) parts.push(`list[${listLen}]`);
  if (r?.success !== undefined) parts.push(`success=${String(r.success)}`);
  if (parts.length > 0) return c.dim + parts.join(" ") + c.reset;
  const text = JSON.stringify(result);
  return c.dim + (text.length > 80 ? text.slice(0, 80) + "…" : text) + c.reset;
}

function printTask(taskId: string, task: TaskResult, runIndex: number): void {
  const label = taskId.replace(/_/g, " ").replace(/\btask_\d+_/g, "").replace(/\b\w/g, (l) => l.toUpperCase());

  if (task.skipped) {
    console.log(`    ${warn} ${c.bold}${label}${c.reset} — skipped: ${c.dim}${task.reason ?? "unknown"}${c.reset}`);
    return;
  }

  const icon      = task.success ? tick : cross;
  const latency   = task.latency_ms ? `${task.latency_ms}ms` : "—";
  const tokens    = (task.input_tokens ?? 0) + (task.output_tokens ?? 0);
  const cost      = task.cost_usd ? `$${task.cost_usd.toFixed(6)}` : "$0.000000";
  const issueStr  = (task.issues?.length ?? 0) > 0
    ? `${c.red}${task.issues!.join("; ")}${c.reset}`
    : `${c.dim}no issues${c.reset}`;

  console.log(`    ${icon} ${c.bold}${label}${c.reset}`);
  console.log(`       ${c.dim}latency:${c.reset} ${latency}  ${c.dim}tokens:${c.reset} ${tokens}  ${c.dim}cost:${c.reset} ${cost}`);
  console.log(`       ${c.dim}issues:${c.reset}  ${issueStr}`);

  if (task.response_preview) {
    const preview = task.response_preview.replace(/\n/g, " ").slice(0, 160);
    console.log(`       ${c.dim}response:${c.reset} ${c.dim}"${preview}"${c.reset}`);
  }

  const details = (task.tool_call_details ?? []) as ToolCall[];
  if (details.length > 0) {
    console.log(`       ${c.dim}tool calls (${details.length}):${c.reset}`);
    for (const tc of details) {
      console.log(`         ${c.cyan}${tc.name}${c.reset}`);
      console.log(`           ${c.dim}args:${c.reset}   ${fmtArgs(tc.arguments)}`);
      console.log(`           ${c.dim}result:${c.reset} ${fmtResult(tc.result)}`);
    }
  } else if ((task.tool_calls?.length ?? 0) > 0) {
    console.log(`       ${c.dim}tools:${c.reset} ${task.tool_calls!.join(", ")}`);
  } else {
    console.log(`       ${c.dim}tools:${c.reset} ${c.dim}none${c.reset}`);
  }
}

function analyse(filePath?: string): void {
  const data = loadResults(filePath);

  for (const scenData of Object.values(data)) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`${c.bold}${c.magenta}SCENARIO: ${scenData.scenario}${c.reset}`);
    console.log("═".repeat(70));

    for (const [modelId, runs] of Object.entries(scenData.models)) {
      const modelName = modelId.split("/").pop() ?? modelId;
      console.log(`\n  ${c.bold}[${modelName}]${c.reset}`);

      for (const [ri, run] of runs.entries()) {
        if (runs.length > 1) console.log(`\n  ${c.dim}Run ${ri + 1}/${runs.length}${c.reset}`);

        if (run.skipped) {
          console.log(`    ${warn} Skipped: ${run.skip_reason ?? "unknown"}`);
          continue;
        }

        const pct = Math.round((run.score / run.total) * 100);
        const scoreCol = pct === 100 ? c.green : pct >= 50 ? c.yellow : c.red;
        console.log(
          `    ${c.dim}Score: ${scoreCol}${run.score}/${run.total} (${pct}%)${c.reset}` +
          `  ${c.dim}tokens: ${run.total_tokens}  cost: $${run.total_cost.toFixed(6)}  avg latency: ${run.avg_latency_ms}ms${c.reset}`
        );
        console.log();

        for (const [taskId, task] of Object.entries(run.tasks)) {
          printTask(taskId, task, ri);
          console.log();
        }
      }
    }
  }

  const src = filePath ?? (() => {
    const dir = path.join(__dirname, "../../results");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
    return path.join(dir, files[0]);
  })();
  console.log(`${c.dim}Source: ${src}${c.reset}\n`);
}

if (require.main === module) {
  analyse(process.argv[2]);
}
