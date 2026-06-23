# Jenkins CI Runner — Design Spec

**Date:** 2026-06-22
**Status:** Approved

---

## Overview

Add a non-interactive CI entry point so the test bench can be driven by Jenkins (or any CI system) without `inquirer` prompts. All run inputs are supplied via `BENCH_*` environment variables. The existing interactive `npm start` path is unchanged.

---

## Section 1: Environment Variables

| Variable | Required | Format | Example |
|---|---|---|---|
| `BENCH_SCENARIOS` | Yes | Comma-separated scenario IDs | `appointment_booking,invoice_workflow` |
| `BENCH_MODELS` | Yes | Comma-separated OpenRouter model IDs | `anthropic/claude-sonnet-4-6,openai/gpt-4o` |
| `BENCH_WORKSPACE_ID` | Yes | Single workspace ID (applied to all selected scenarios) | `11085` |
| `BENCH_RUNS` | No | Positive integer, defaults to `1` | `3` |

Existing credentials (`OPENROUTER_API_KEY`, `INISTATE_API_TOKEN`, `INISTATE_API_URL`, `INISTATE_MCP_PATH`) are still read from env as before — the CI runner shares the same resolution logic.

---

## Section 2: Architecture

A new entry point `src/ci.ts` is added. It:

1. Reads and validates all `BENCH_*` vars — exits with a descriptive error and non-zero code if any required var is missing or invalid
2. Calls the existing `loadModels()` to fetch live prices from OpenRouter, then filters to the requested model IDs — unknown IDs fail fast before setup runs
3. Builds a `scenarioWorkspaces` map with `BENCH_WORKSPACE_ID` applied to every selected scenario
4. Calls `runBenchmark()` directly — the same function used by the interactive runner

No logic is duplicated. `ci.ts` is a thin wiring layer over the existing `benchmark-runner.ts` and `data/models.ts`.

```
src/ci.ts          ← new: reads BENCH_*, validates, calls runBenchmark()
src/index.ts       ← unchanged: interactive runner
src/core/benchmark-runner.ts  ← unchanged
```

A new `package.json` script is added:

```json
"ci": "ts-node src/ci.ts"
```

---

## Section 3: Validation & Error Behaviour

All validation runs before any MCP connection or scenario setup:

- Missing `BENCH_SCENARIOS` or `BENCH_MODELS` or `BENCH_WORKSPACE_ID` → print which vars are missing, `process.exit(1)`
- `BENCH_RUNS` non-integer or `< 1` → error and exit
- Model ID in `BENCH_MODELS` not found in OpenRouter catalogue → list the unknown IDs, exit
- Scenario ID in `BENCH_SCENARIOS` not found in auto-discovered scenarios → list the unknown IDs, exit

This ensures Jenkins marks the build failed immediately on misconfiguration rather than after a long run.

---

## Section 4: JUnit XML Output

After `runBenchmark()` completes, `ci.ts` writes a JUnit-compatible XML file so Jenkins can display test results natively via the **Test Results** tab.

### Output path

Default: `results/report.xml`. Overridable via `BENCH_JUNIT_OUTPUT` env var.

### Mapping

| JUnit element | Source |
|---|---|
| `<testsuite name>` | Scenario name (e.g. `"Appointment Booking"`) |
| `<testsuite tests>` | Total task × model combinations |
| `<testsuite failures>` | Count of failed (non-skipped) task results |
| `<testsuite time>` | Sum of `latency_ms / 1000` across all tasks |
| `<testcase name>` | `[model name] task name` e.g. `"[claude-sonnet-4-6] End-to-End Booking"` |
| `<testcase classname>` | Scenario ID (e.g. `appointment_booking`) |
| `<testcase time>` | `latency_ms / 1000` |
| `<failure message>` | Issues joined by `"; "` — present when `success === false` |
| `<skipped/>` | Present when task was skipped |

### Example output

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Appointment Booking" tests="4" failures="1" skipped="0" time="24.6">
    <testcase name="[claude-sonnet-4-6] End-to-End Booking" classname="appointment_booking" time="12.3"/>
    <testcase name="[claude-sonnet-4-6] Implicit Conflict Detection" classname="appointment_booking" time="12.3">
      <failure message="Wrong slot: expected Sun 2026-06-28 13:30; got [{&quot;Time&quot;:&quot;13:00&quot;}]"/>
    </testcase>
    <testcase name="[gpt-4o] End-to-End Booking" classname="appointment_booking" time="0">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>
```

`junit-writer.ts` is a pure function `writeJUnit(results, outputPath)` with no side effects beyond writing the file. It lives in `src/display/` alongside other result formatters.

### Jenkins step

```groovy
post {
  always {
    junit 'results/report.xml'
  }
}
```

---

## Section 5: File Structure

```
src/
├── bridges/
│   ├── api-bridge.ts
│   └── mcp-bridge.ts
├── core/
│   ├── benchmark-runner.ts
│   ├── check-evaluator.ts
│   └── llm-judge.ts
├── data/
│   └── models.ts
├── display/
│   ├── merge-results.ts
│   ├── results-analyser.ts
│   ├── results-visualiser.ts
│   └── junit-writer.ts        ← new
├── scenarios/
│   └── ...
├── ci.ts                      ← new
├── index.ts
└── types.ts
```

---

## Section 6: Jenkins Usage

A minimal `Jenkinsfile` using the CI runner:

```groovy
pipeline {
  agent any
  environment {
    BENCH_SCENARIOS    = 'appointment_booking'
    BENCH_MODELS       = 'anthropic/claude-sonnet-4-6'
    BENCH_WORKSPACE_ID = '11085'
    BENCH_RUNS         = '1'
    OPENROUTER_API_KEY    = credentials('openrouter-api-key')
    INISTATE_API_TOKEN    = credentials('inistate-api-token')
  }
  stages {
    stage('Run Benchmark') {
      steps {
        sh 'npm ci'
        sh 'npm run ci'
      }
    }
  }
  post {
    always {
      junit 'results/report.xml'
    }
  }
}
```

No `input` steps, no stdin piping. Jenkins sets the vars; the runner exits with code 0 on success, non-zero on failure. The `post { always }` block ensures JUnit results are published even if the benchmark run fails.

---

## Section 7: Out of Scope

- Per-scenario workspace IDs (single `BENCH_WORKSPACE_ID` covers the Jenkins use case)
- Parallel model runs (existing sequential model loop is unchanged)
- Result upload or Jenkins artifact publishing (handled outside this runner)
