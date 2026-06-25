import * as fs from "fs";
import * as path from "path";
import type { ScenarioResult, Model, Scenario } from "../types";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function writeJUnit(
  results: Record<string, ScenarioResult>,
  models: Model[],
  scenarios: Scenario[],
  outputPath: string
): void {
  const modelMap = new Map(models.map((m) => [m.id, m.name]));
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<testsuites>"];

  for (const [scenarioId, scenarioResult] of Object.entries(results)) {
    const scenario = scenarios.find((s) => s.id === scenarioId);
    const testcases: string[] = [];
    let totalTests = 0;
    let totalFailures = 0;
    let totalSkipped = 0;
    let totalTime = 0;

    for (const [modelId, runs] of Object.entries(scenarioResult.models)) {
      const modelName = modelMap.get(modelId) ?? modelId;
      const validRuns = runs.filter((r) => !r.skipped);

      if (validRuns.length === 0) {
        testcases.push(
          `    <testcase name="${escapeXml(`[${modelName}] (all runs skipped)`)}" classname="${escapeXml(scenarioId)}" time="0"><skipped/></testcase>`
        );
        totalTests++;
        totalSkipped++;
        continue;
      }

      const taskIds = new Set(validRuns.flatMap((r) => Object.keys(r.tasks)));

      for (const taskId of taskIds) {
        const taskResults = validRuns.map((r) => r.tasks[taskId]).filter(Boolean);
        if (taskResults.length === 0) continue;

        totalTests++;

        const taskName = scenario?.tasks.find((t) => t.id === taskId)?.name ?? taskId;
        const allSkipped = taskResults.every((t) => t.skipped);
        const anyFailed = taskResults.some((t) => !t.skipped && t.success === false);
        const avgLatency =
          taskResults.reduce((s, t) => s + (t.latency_ms ?? 0), 0) / taskResults.length;
        const allIssues = taskResults.flatMap((t) => t.issues ?? []);

        totalTime += avgLatency / 1000;

        const tcName = escapeXml(`[${modelName}] ${taskName}`);
        const tcClass = escapeXml(scenarioId);
        const tcTime = (avgLatency / 1000).toFixed(3);

        if (allSkipped) {
          testcases.push(
            `    <testcase name="${tcName}" classname="${tcClass}" time="${tcTime}"><skipped/></testcase>`
          );
          totalSkipped++;
        } else if (anyFailed) {
          const shortMsg = escapeXml(
            allIssues.length === 1
              ? allIssues[0]
              : `${allIssues.length} issues: ${allIssues[0]}`
          );
          const toolCalls = taskResults.find((t) => (t.tool_calls?.length ?? 0) > 0)?.tool_calls;
          const bodyLines = ["ISSUES:", ...allIssues.map((i) => `  ✗ ${i}`)];
          if (toolCalls && toolCalls.length > 0) {
            bodyLines.push("", `TOOL CALLS: ${toolCalls.join(" → ")}`);
          }
          const body = bodyLines.join("\n");
          testcases.push(
            `    <testcase name="${tcName}" classname="${tcClass}" time="${tcTime}"><failure message="${shortMsg}"><![CDATA[${body}]]></failure></testcase>`
          );
          totalFailures++;
        } else {
          testcases.push(
            `    <testcase name="${tcName}" classname="${tcClass}" time="${tcTime}"/>`
          );
        }
      }
    }

    lines.push(
      `  <testsuite name="${escapeXml(scenarioResult.scenario)}" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${totalTime.toFixed(3)}">`
    );
    lines.push(...testcases);
    lines.push("  </testsuite>");
  }

  lines.push("</testsuites>");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
}
