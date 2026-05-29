const fs = require("fs");
const path = require("path");

// ─── ANSI ──────────────────────────────────────────────────────────────────────
const c = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  white:   "\x1b[37m",
  bgGreen: "\x1b[42m",
  bgRed:   "\x1b[41m",
};

const tick  = `${c.green}☑${c.reset}`;
const cross = `${c.red}☒${c.reset}`;
const skip  = `${c.yellow}⊘${c.reset}`;
const dot   = `${c.dim}○${c.reset}`;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function bar(value, max, width = 20, color = c.green) {
  const filled = Math.round((value / max) * width);
  const empty  = width - filled;
  return color + "█".repeat(filled) + c.dim + "░".repeat(empty) + c.reset;
}

function pctColor(pct) {
  if (pct === 100) return c.green;
  if (pct >= 75)  return c.cyan;
  if (pct >= 50)  return c.yellow;
  return c.red;
}

function fmtCost(n) {
  if (n === 0) return `${c.dim}free${c.reset}`;
  return `$${n.toFixed(6)}`;
}

function fmtTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function header(text, width = 65) {
  const pad = Math.max(0, width - text.length - 4);
  const left  = Math.floor(pad / 2);
  const right = pad - left;
  console.log(
    c.bold + c.cyan +
    "╔" + "═".repeat(width - 2) + "╗\n" +
    "║" + " ".repeat(left + 1) + text + " ".repeat(right + 1) + "║\n" +
    "╚" + "═".repeat(width - 2) + "╝" +
    c.reset
  );
}

function divider(width = 65, char = "─") {
  console.log(c.dim + char.repeat(width) + c.reset);
}

// ─── Load latest result file ───────────────────────────────────────────────────
function loadResults(filePath) {
  if (filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  const dir = path.join(__dirname, "results");
  if (!fs.existsSync(dir)) {
    console.error("No results directory found. Run testbench first.");
    process.exit(1);
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .sort()
    .reverse();
  if (files.length === 0) {
    console.error("No result files found. Run testbench first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
}

// ─── Consistent sort order: score DESC → cost ASC → latency ASC ───────────────
function sortedModelIds(scenarioData) {
  return Object.keys(scenarioData.models).sort((a, b) => {
    const statsFor = (id) => {
      const validRuns = (scenarioData.models[id] || []).filter(r => !r.skipped);
      if (validRuns.length === 0) return { score: -1, cost: Infinity, latency: Infinity };
      const avgScore = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
      const avgCost  = validRuns.reduce((s, r) => s + r.total_cost, 0) / validRuns.length;
      let latSum = 0, latCount = 0;
      for (const run of validRuns) {
        for (const task of Object.values(run.tasks || {})) {
          if (!task.skipped && task.latency_ms) { latSum += task.latency_ms; latCount++; }
        }
      }
      return { score: avgScore, cost: avgCost, latency: latCount > 0 ? latSum / latCount : Infinity };
    };
    const sa = statsFor(a), sb = statsFor(b);
    if (sb.score !== sa.score) return sb.score - sa.score;
    if (sa.cost  !== sb.cost)  return sa.cost  - sb.cost;
    return sa.latency - sb.latency;
  });
}

// ─── Task grid ─────────────────────────────────────────────────────────────────
// Draws a tickbox grid: rows = models, cols = tasks
function drawTaskGrid(scenarioData, scenarioName) {
  // Collect all task IDs in order
  const taskIds = new Set();
  for (const runs of Object.values(scenarioData.models)) {
    for (const run of runs) {
      if (!run.skipped) {
        Object.keys(run.tasks || {}).forEach(id => taskIds.add(id));
      }
    }
  }
  const tasks = Array.from(taskIds);
  if (tasks.length === 0) return;

  // Collect task names from first available run
  const taskNames = {};
  for (const runs of Object.values(scenarioData.models)) {
    for (const run of runs) {
      if (!run.skipped) {
        for (const [id, result] of Object.entries(run.tasks || {})) {
          if (!taskNames[id] && !result.skipped) {
            taskNames[id] = id.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
          }
        }
      }
    }
  }

  // Column widths
  const modelColW = 22;
  const taskColW  = 12;
  const totalW    = modelColW + tasks.length * (taskColW + 1) + 20;

  console.log(`\n${c.bold}Task Breakdown${c.reset}`);
  divider(totalW);

  // Header row — task names (truncated)
  let headerRow = " ".repeat(modelColW) + " ";
  for (const id of tasks) {
    const name = (taskNames[id] || id).slice(0, taskColW - 2);
    headerRow += c.dim + name.padEnd(taskColW) + c.reset + " ";
  }
  headerRow += c.dim + "Score".padEnd(10) + "Tokens".padEnd(10) + "Cost" + c.reset;
  console.log(headerRow);
  divider(totalW);

  // Data rows — one per model, in sort order
  for (const modelId of sortedModelIds(scenarioData)) {
    const runs = scenarioData.models[modelId];
    const validRuns = runs.filter(r => !r.skipped);
    if (validRuns.length === 0) {
      console.log(
        c.dim + modelId.split("/").pop().slice(0, modelColW - 1).padEnd(modelColW) + c.reset +
        " " + skip + " skipped"
      );
      continue;
    }

    // Average across runs
    const avgTaskResult = {};
    for (const id of tasks) {
      const results = validRuns.map(r => r.tasks?.[id]).filter(Boolean);
      if (results.length === 0) { avgTaskResult[id] = null; continue; }
      const successes = results.filter(r => !r.skipped && r.success).length;
      const skippedAll = results.every(r => r.skipped);
      avgTaskResult[id] = skippedAll ? "skipped" : successes / results.length;
    }

    const avgScore   = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
    const avgTokens  = Math.round(validRuns.reduce((s, r) => s + r.total_tokens, 0) / validRuns.length);
    const avgCost    = validRuns.reduce((s, r) => s + r.total_cost, 0) / validRuns.length;
    const pct        = Math.round(avgScore * 100);
    const modelLabel = modelId.split("/").pop().slice(0, modelColW - 1).padEnd(modelColW);

    let row = c.bold + modelLabel + c.reset + " ";

    for (const id of tasks) {
      const res = avgTaskResult[id];
      let cell;
      if (res === null)      cell = dot + " ".repeat(taskColW - 1);
      else if (res === "skipped") cell = skip + " ".repeat(taskColW - 1);
      else if (res === 1)    cell = tick + " ".repeat(taskColW - 1);
      else if (res === 0)    cell = cross + " ".repeat(taskColW - 1);
      else {
        // partial (multiple runs, mixed)
        const pctTask = Math.round(res * 100);
        cell = `${c.yellow}◑${c.reset} ${pctTask}%`.padEnd(taskColW);
      }
      row += cell + " ";
    }

    const col = pctColor(pct);
    row +=
      col + `${pct}%`.padEnd(6) + c.reset +
      "  " +
      c.dim + fmtTokens(avgTokens).padEnd(9) + c.reset +
      fmtCost(avgCost);

    console.log(row);
  }

  divider(totalW);
}

// ─── Score bar chart ───────────────────────────────────────────────────────────
function drawScoreChart(scenarioData) {
  console.log(`\n${c.bold}Overall Score${c.reset}`);
  divider(65);

  for (const modelId of sortedModelIds(scenarioData)) {
    const runs = scenarioData.models[modelId];
    const validRuns = runs.filter(r => !r.skipped);
    if (validRuns.length === 0) continue;
    const avgScore = validRuns.reduce((s, r) => s + r.score / r.total, 0) / validRuns.length;
    const pct      = Math.round(avgScore * 100);
    const col      = pctColor(pct);
    const label    = modelId.split("/").pop().slice(0, 20).padEnd(21);
    const barStr   = bar(pct, 100, 25, col);
    const pctStr   = col + `${pct}%`.padStart(4) + c.reset;
    console.log(`${label} ${barStr} ${pctStr}`);
  }

  divider(65);
}

// ─── Token & cost table ────────────────────────────────────────────────────────
function drawTokenCostTable(scenarioData) {
  console.log(`\n${c.bold}Token Usage & Cost${c.reset}`);
  divider(65);
  console.log(
    c.dim +
    "Model".padEnd(22) +
    "Avg Tokens".padEnd(14) +
    "Input".padEnd(12) +
    "Output".padEnd(12) +
    "Avg Cost" +
    c.reset
  );
  divider(65);

  const tokenEntries = [];
  for (const modelId of sortedModelIds(scenarioData)) {
    const runs = scenarioData.models[modelId];
    const validRuns = runs.filter(r => !r.skipped);
    if (validRuns.length === 0) continue;

    let totalIn = 0, totalOut = 0, totalCost = 0;
    for (const run of validRuns) {
      for (const task of Object.values(run.tasks || {})) {
        if (!task.skipped) {
          totalIn   += task.input_tokens  || 0;
          totalOut  += task.output_tokens || 0;
          totalCost += task.cost_usd      || 0;
        }
      }
    }
    const n = validRuns.length;
    tokenEntries.push({
      modelId,
      avgIn:    Math.round(totalIn  / n),
      avgOut:   Math.round(totalOut / n),
      avgTotal: Math.round((totalIn + totalOut) / n),
      avgCost:  totalCost / n,
    });
  }

  for (const e of tokenEntries) {
    const label = e.modelId.split("/").pop().slice(0, 21).padEnd(22);
    console.log(
      label +
      fmtTokens(e.avgTotal).padEnd(14) +
      c.dim + fmtTokens(e.avgIn).padEnd(12) + c.reset +
      c.dim + fmtTokens(e.avgOut).padEnd(12) + c.reset +
      fmtCost(e.avgCost)
    );
  }

  divider(65);
}

// ─── Latency & tool calls ──────────────────────────────────────────────────────
function drawLatencyToolTable(scenarioData) {
  console.log(`\n${c.bold}Latency & Tool Calls${c.reset}`);
  divider(65);
  console.log(
    c.dim +
    "Model".padEnd(22) +
    "Avg Latency".padEnd(14) +
    "Total Calls".padEnd(14) +
    "Calls/Task" +
    c.reset
  );
  divider(65);

  const latEntries = [];
  for (const modelId of sortedModelIds(scenarioData)) {
    const runs = scenarioData.models[modelId];
    const validRuns = runs.filter(r => !r.skipped);
    if (validRuns.length === 0) continue;

    let latencySum = 0, latencyCount = 0, toolCallSum = 0, taskCount = 0;
    for (const run of validRuns) {
      for (const task of Object.values(run.tasks || {})) {
        if (!task.skipped) {
          if (task.latency_ms) { latencySum += task.latency_ms; latencyCount++; }
          toolCallSum += task.tool_calls?.length || 0;
          taskCount++;
        }
      }
    }
    const avgLatency = latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0;
    const totalCalls = Math.round(toolCallSum / validRuns.length);
    const callsPerTask = taskCount > 0 ? (toolCallSum / taskCount / validRuns.length).toFixed(1) : "0";
    latEntries.push({ modelId, avgLatency, totalCalls, callsPerTask });
  }

  for (const e of latEntries) {
    const label = e.modelId.split("/").pop().slice(0, 21).padEnd(22);
    const latCol = e.avgLatency < 5000 ? c.green : e.avgLatency < 15000 ? c.yellow : c.red;
    console.log(
      label +
      (latCol + `${e.avgLatency}ms` + c.reset).padEnd(22) +
      String(e.totalCalls).padEnd(14) +
      e.callsPerTask
    );
  }

  divider(65);
}

// ─── Issues summary ────────────────────────────────────────────────────────────
function drawIssuesSummary(scenarioData) {
  const issueMap = {}; // modelId → [issues]

  for (const [modelId, runs] of Object.entries(scenarioData.models)) {
    const validRuns = runs.filter(r => !r.skipped);
    for (const run of validRuns) {
      for (const task of Object.values(run.tasks || {})) {
        if (!task.skipped && task.issues?.length > 0) {
          if (!issueMap[modelId]) issueMap[modelId] = [];
          issueMap[modelId].push(...task.issues);
        }
      }
    }
  }

  if (Object.keys(issueMap).length === 0) return;

  console.log(`\n${c.bold}Failure Analysis${c.reset}`);
  divider(65);

  for (const [modelId, issues] of Object.entries(issueMap)) {
    const label = modelId.split("/").pop().slice(0, 20);
    console.log(`${c.yellow}${label}${c.reset}`);
    const freq = {};
    issues.forEach(i => { freq[i] = (freq[i] || 0) + 1; });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    for (const [issue, count] of sorted) {
      const countStr = count > 1 ? ` ${c.dim}(×${count})${c.reset}` : "";
      console.log(`  ${cross} ${issue}${countStr}`);
    }
  }

  divider(65);
}

// ─── Hallucination summary ─────────────────────────────────────────────────────
function drawHallucinationSummary(scenarioData) {
  const hallMap = {};

  for (const [modelId, runs] of Object.entries(scenarioData.models)) {
    const validRuns = runs.filter(r => !r.skipped);
    let hallucinatedTasks = 0;
    let totalTasks = 0;
    for (const run of validRuns) {
      for (const task of Object.values(run.tasks || {})) {
        if (!task.skipped) {
          totalTasks++;
          if (task.hallucinated) hallucinatedTasks++;
        }
      }
    }
    if (totalTasks > 0) hallMap[modelId] = { hallucinatedTasks, totalTasks };
  }

  if (Object.keys(hallMap).length === 0) return;

  console.log(`\n${c.bold}Hallucination Rate${c.reset}`);
  divider(65);

  for (const modelId of sortedModelIds(scenarioData).filter(id => hallMap[id])) {
    const { hallucinatedTasks, totalTasks } = hallMap[modelId];
    const pct   = Math.round((hallucinatedTasks / totalTasks) * 100);
    const label = modelId.split("/").pop().slice(0, 20).padEnd(21);
    const col   = pct === 0 ? c.green : pct < 25 ? c.yellow : c.red;
    const barStr = bar(pct, 100, 20, col);
    console.log(`${label} ${barStr} ${col}${pct}%${c.reset} (${hallucinatedTasks}/${totalTasks} tasks)`);
  }

  divider(65);
}

// ─── Main ──────────────────────────────────────────────────────────────────────
function visualise(filePath) {
  const data    = loadResults(filePath);
  const scenIds = Object.keys(data);

  console.log("\n");
  header("Inistate TestBench — Results");

  for (const scenId of scenIds) {
    const scenData = data[scenId];
    console.log(`\n${c.bold}${c.magenta}▶ ${scenData.scenario}${c.reset}`);

    drawTaskGrid(scenData, scenData.scenario);
    drawScoreChart(scenData);
    drawTokenCostTable(scenData);
    drawLatencyToolTable(scenData);
    drawHallucinationSummary(scenData);
    drawIssuesSummary(scenData);
  }

  // Footer — file info
  const src = filePath || (() => {
    const dir = path.join(__dirname, "results");
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort().reverse();
    return path.join(dir, files[0]);
  })();
  console.log(`\n${c.dim}Source: ${src}${c.reset}\n`);
}

// Run directly or export
if (require.main === module) {
  visualise(process.argv[2]);
} else {
  module.exports = { visualise };
}
