import type { EvaluationResult, ToolCall } from "../types";

// Check syntax:
//   called:<tool>           tool was called at least once
//   not_called:<tool>       tool was NOT called
//   arg:<tool>.<arg>=<val>  argument on any call to <tool> matches <val>
//   success:<tool>          tool was called and at least one call returned without error

/** Run a list of declarative check assertions against captured tool calls. */
export function runChecks(checks: string[], toolCalls: ToolCall[]): EvaluationResult {
  const issues: string[] = [];
  let hallucinated = false;

  for (const check of checks) {
    if (check.startsWith("called:")) {
      const tool = check.slice("called:".length);
      if (!toolCalls.some((t) => t.name === tool))
        issues.push(`Layer 1: did not call ${tool}`);

    } else if (check.startsWith("not_called:")) {
      const tool = check.slice("not_called:".length);
      if (toolCalls.some((t) => t.name === tool)) {
        issues.push(`Layer 1: called ${tool} (should not have)`);
        hallucinated = true;
      }

    } else if (check.startsWith("arg:")) {
      // arg:submit_activity.module=Invoice
      const rest = check.slice("arg:".length);
      const eqIdx = rest.indexOf("=");
      const dotIdx = rest.indexOf(".");
      if (eqIdx === -1 || dotIdx === -1 || dotIdx > eqIdx) {
        issues.push(`Layer 2: malformed parameter check: ${check}`);
        continue;
      }
      const tool     = rest.slice(0, dotIdx);
      const argName  = rest.slice(dotIdx + 1, eqIdx);
      const expected = rest.slice(eqIdx + 1);
      const matched  = toolCalls.some(
        (t) => t.name === tool && String(t.arguments[argName]) === expected
      );
      if (!matched)
        issues.push(`Layer 2: ${tool}.${argName} ≠ "${expected}"`);

    } else if (check.startsWith("success:")) {
      const tool  = check.slice("success:".length);
      const calls = toolCalls.filter((t) => t.name === tool);
      if (calls.length === 0) {
        issues.push(`Layer 1: did not call ${tool}`);
      } else {
        const anyOk = calls.some((t) => !(t.result as Record<string, unknown>)?.error);
        if (!anyOk) issues.push(`Layer 1: ${tool} returned an error on all calls`);
      }

    } else {
      issues.push(`Layer 2: unknown check syntax: ${check}`);
    }
  }

  return { success: issues.length === 0, issues, hallucinated };
}
