// Loan Application Workflow
// Tests compound conditional branching via cross-module foreign ref navigation.
//
// Seed data:
//   4 Applicants (seeded per-task) with varying credit_score and active_loans
//   Each LoanApplication links to an Applicant via foreign ref — model must read Applicant to get the fields
//
// Branch logic (compound AND):
//   credit_score < 400 OR active_loans >= 4  → Rejected  (deny + note reason)
//   credit_score >= 650 AND active_loans < 2  → Approved  (approve + set offer_amount = requested_amount)
//   else                                      → Under Review (assign underwriter)
//
// Task 1: score=320, loans=1  → Reject  (low score)
// Task 2: score=520, loans=2  → Review  (mid score, mid loans)
// Task 3: score=720, loans=1  → Approve (high score, low loans)
// Task 4: score=680, loans=3  → Review  (trap: looks approvable but active_loans disqualifies)

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, EvaluationResult, Scenario, ToolCall } from "../types";
import {
  hasError, getCreatedEntryId, getCreatedModuleId, findModuleByName, AI,
} from "./scenario-helpers";

interface LoanAssets {
  workspaceId: string;
  applicantModuleId: string | number;
  loanModuleId: string | number;
  // per-task applicant + loan IDs
  task1ApplicantId: string | number;
  task1LoanId: string | number;
  task2ApplicantId: string | number;
  task2LoanId: string | number;
  task3ApplicantId: string | number;
  task3LoanId: string | number;
  task4ApplicantId: string | number;
  task4LoanId: string | number;
}

// ─── Module schemas ────────────────────────────────────────────────────────────

const applicantSchema = {
  name: "Applicant", icon: "👤",
  description: "Loan applicants with credit profile data",
  states: [
    { name: "Active", color: "#1E6B45", initial: true },
  ],
  information: [
    { name: "Name",         type: "Text",   ai_hint: "Full name of the applicant" },
    { name: "Email",        type: "Text",   ai_hint: "Applicant email address" },
    { name: "Credit Score", type: "Number", ai_hint: "Applicant credit score (0-850)" },
    { name: "Active Loans", type: "Number", ai_hint: "Number of currently active loans" },
    { name: "Annual Income", type: "Number", ai_hint: "Annual income in USD" },
  ],
  activities: [],
  flows: [],
};

const loanSchema = {
  name: "LoanApplication", icon: "📋",
  description: "Loan applications linked to applicant records",
  states: [
    { name: "Pending",      color: "#5A6070", initial: true },
    { name: "Under Review", color: "#2968A8" },
    { name: "Approved",     color: "#1E6B45" },
    { name: "Rejected",     color: "#C0392B" },
  ],
  information: [
    { name: "Applicant Name", type: "Text",   ai_hint: "Name of the applicant" },
    { name: "Applicant ID",   type: "Text",   ai_hint: "Entry ID of the linked Applicant record" },
    { name: "Requested Amount", type: "Number", ai_hint: "Loan amount requested in USD" },
    { name: "Offer Amount",   type: "Number", ai_hint: "Approved loan amount — set only when Approved" },
    { name: "Assigned To",    type: "Text",   ai_hint: "Underwriter assigned for review — set only for Under Review" },
    { name: "Rejection Reason", type: "MultiText", ai_hint: "Reason for rejection — set only when Rejected" },
  ],
  activities: [
    { name: "Approve",       actor: "ai", fields: ["Offer Amount"] },
    { name: "Reject",        actor: "ai", fields: ["Rejection Reason"] },
    { name: "Send to Review", actor: "ai", fields: ["Assigned To"] },
  ],
  flows: [
    { activity: "Approve",        from: "Pending", to: "Approved"     },
    { activity: "Reject",         from: "Pending", to: "Rejected"     },
    { activity: "Send to Review", from: "Pending", to: "Under Review" },
  ],
};

// ─── Setup helper: ensure modules exist ───────────────────────────────────────

async function ensureModules(bridge: IBridge, assets: LoanAssets): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  let modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });

  let applicantModule = findModuleByName(modules, "Applicant");
  if (!applicantModule) {
    await bridge.callTool("validate_design", { schema: applicantSchema, mode: "create" });
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...applicantSchema });
    modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
    applicantModule = findModuleByName(modules, "Applicant");
  }
  assets.applicantModuleId = getCreatedModuleId(applicantModule)!;

  let loanModule = findModuleByName(modules, "LoanApplication");
  if (!loanModule) {
    await bridge.callTool("validate_design", { schema: loanSchema, mode: "create" });
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...loanSchema });
    modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
    loanModule = findModuleByName(modules, "LoanApplication");
  }
  assets.loanModuleId = getCreatedModuleId(loanModule)!;

  await bridge.callTool("switch_mode", { mode: "runtime" });
}

// ─── Evaluate + Verify helpers ────────────────────────────────────────────────

type ExpectedBranch = "Rejected" | "Approved" | "Under Review";

const activityMap: Record<ExpectedBranch, string> = {
  "Rejected":     "reject",
  "Approved":     "approve",
  "Under Review": "send to review",
};

// Layer 1 + 2: correct tool calls and correct params
function evaluateBranch(
  toolCalls: ToolCall[],
  _assets: LoanAssets | undefined,
  applicantId: string | number,
  loanId: string | number,
  expected: ExpectedBranch,
): EvaluationResult {
  const issues: string[] = [];

  // Layer 1 — correct tool calls
  // Must navigate the foreign ref: get_entry on Applicant
  const readApplicant = toolCalls.some(
    (t) => t.name === "get_entry" &&
      JSON.stringify(t.arguments).includes(String(applicantId)) &&
      !hasError(t.result)
  );
  if (!readApplicant) {
    issues.push("Layer 1: did not call get_entry on Applicant to read credit_score / active_loans");
  }

  // Must call the correct branch activity
  const expectedActivity = activityMap[expected];
  const branchCall = toolCalls.find(
    (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
      JSON.stringify(t.arguments).toLowerCase().includes(expectedActivity) &&
      !hasError(t.result)
  );
  if (!branchCall) {
    issues.push(`Layer 1: expected activity "${expected}" was not called successfully`);
    const wrongBranch = (Object.keys(activityMap) as ExpectedBranch[])
      .filter((b) => b !== expected)
      .find((b) => toolCalls.some(
        (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
          JSON.stringify(t.arguments).toLowerCase().includes(activityMap[b]) &&
          !hasError(t.result)
      ));
    if (wrongBranch) {
      issues.push(`Layer 2: wrong branch taken — "${wrongBranch}" instead of "${expected}"`);
    }
    return { success: false, issues, hallucinated: wrongBranch !== undefined };
  }

  // Layer 2 — correct params on the branch call
  const argRaw = JSON.stringify(branchCall.arguments).toLowerCase();

  // Loan entry must be targeted
  if (!argRaw.includes(String(loanId))) {
    issues.push(`Layer 2: branch activity did not target LoanApplication entry (ID: ${loanId})`);
  }

  // Branch-specific required fields
  if (expected === "Approved") {
    if (!argRaw.includes("offer amount") && !argRaw.includes("offer_amount")) {
      issues.push("Layer 2: Approve call missing Offer Amount field");
    }
  }
  if (expected === "Rejected") {
    if (!argRaw.includes("rejection reason") && !argRaw.includes("rejection_reason")) {
      issues.push("Layer 2: Reject call missing Rejection Reason field");
    }
  }
  if (expected === "Under Review") {
    if (!argRaw.includes("assigned to") && !argRaw.includes("assigned_to")) {
      issues.push("Layer 2: Send to Review call missing Assigned To field");
    }
  }

  return { success: issues.length === 0, issues, hallucinated: false };
}

// Layer 3 — real API validation via get_entry
async function verifyLoanState(
  bridge: IBridge,
  loanId: string | number,
  expected: ExpectedBranch,
  requestedAmount?: number,
): Promise<EvaluationResult> {
  const issues: string[] = [];
  const result = await bridge.callTool("get_entry", { module: "LoanApplication", entryId: loanId }) as Record<string, unknown>;
  if (hasError(result)) {
    issues.push(`Layer 3: get_entry failed for LoanApplication ${loanId}`);
    return { success: false, issues, hallucinated: false };
  }
  const raw = JSON.stringify(result).toLowerCase();

  // State check
  if (!raw.includes(expected.toLowerCase())) {
    issues.push(`Layer 3: state is not "${expected}"`);
  }

  // Field value checks per branch
  if (expected === "Approved") {
    if (!raw.includes("offer amount") && !raw.includes("offer_amount")) {
      issues.push("Layer 3: Offer Amount not set on approved entry");
    } else if (requestedAmount !== undefined && !raw.includes(String(requestedAmount))) {
      issues.push(`Layer 3: Offer Amount does not match requested amount (${requestedAmount})`);
    }
  }
  if (expected === "Rejected") {
    if (!raw.includes("rejection reason") && !raw.includes("rejection_reason")) {
      issues.push("Layer 3: Rejection Reason not set on rejected entry");
    }
  }
  if (expected === "Under Review") {
    if (!raw.includes("assigned to") && !raw.includes("assigned_to")) {
      issues.push("Layer 3: Assigned To not set on under-review entry");
    }
  }

  return { success: issues.length === 0, issues, hallucinated: false };
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

const scenario: Scenario<LoanAssets> = {
  id: "loan_application",
  name: "Loan Application Workflow",
  description: "Compound conditional branching via cross-module foreign ref: model reads Applicant credit_score + active_loans to route each loan to Rejected / Under Review / Approved",

  setup: async (_bridge: IBridge, workspaceId: string): Promise<LoanAssets> => ({
    workspaceId,
    applicantModuleId: 0, loanModuleId: 0,
    task1ApplicantId: 0, task1LoanId: 0,
    task2ApplicantId: 0, task2LoanId: 0,
    task3ApplicantId: 0, task3LoanId: 0,
    task4ApplicantId: 0, task4LoanId: 0,
  }),

  system: (assets) => `You are a loan processing AI for Inistate.
Workspace ${assets.workspaceId} is already active — do not pass workspaceId to tools unless required.
You have access to two modules: Applicant and LoanApplication.
Each LoanApplication links to an Applicant record via "Applicant ID". To assess a loan, you must read the linked Applicant entry to get their Credit Score and Active Loans count.
Branch logic:
  - Credit Score < 400 OR Active Loans >= 4 → Reject (set Rejection Reason)
  - Credit Score >= 650 AND Active Loans < 2 → Approve (set Offer Amount = Requested Amount)
  - Otherwise → Send to Review (assign underwriter)
You are already authorized to make these state changes — if a tool asks you to confirm a state change, resubmit the same call with confirmed: true. Do not stop to ask a human for permission.
Be concise. Use the minimum tools needed.`,

  tasks: [
    // ── Task 1: Reject (score=320, loans=1 — low score) ──────────────────────
    {
      id: "task_1_reject",
      name: "Process Loan — Reject (Low Credit Score)",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: LoanAssets): Promise<void> => {
        await ensureModules(bridge, assets);

        const appResult = await bridge.callTool("submit_activity", {
          module: "Applicant", activity: "create", workspaceId: assets.workspaceId,
          input: { Name: "Marcus Webb", Email: "marcus.webb@email.com", "Credit Score": 320, "Active Loans": 1, "Annual Income": 42000 },
          ai: AI,
        });
        assets.task1ApplicantId = getCreatedEntryId(appResult)!;
        if (!assets.task1ApplicantId) throw new Error("Setup failed: task1ApplicantId");

        const loanResult = await bridge.callTool("submit_activity", {
          module: "LoanApplication", activity: "create", workspaceId: assets.workspaceId,
          input: { "Applicant Name": "Marcus Webb", "Applicant ID": String(assets.task1ApplicantId), "Requested Amount": 50000 },
          ai: AI,
        });
        assets.task1LoanId = getCreatedEntryId(loanResult)!;
        if (!assets.task1LoanId) throw new Error("Setup failed: task1LoanId");

        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: applicant=${assets.task1ApplicantId}, loan=${assets.task1LoanId}`);
      },
      prompt: () =>
        `A new loan application has come in for Marcus Webb. ` +
        `Find the application, look up the linked Applicant record to assess their credit profile, then process the application according to our branching policy. ` +
        `Make sure to set the appropriate fields for whichever branch you take.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateBranch(toolCalls, assets, assets?.task1ApplicantId ?? 0, assets?.task1LoanId ?? 0, "Rejected"),
      verify: async (bridge: IBridge, assets: LoanAssets): Promise<EvaluationResult> =>
        verifyLoanState(bridge, assets.task1LoanId, "Rejected"),
    },

    // ── Task 2: Under Review (score=520, loans=2 — mid) ──────────────────────
    {
      id: "task_2_review",
      name: "Process Loan — Under Review (Mid Score)",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: LoanAssets): Promise<void> => {
        const appResult = await bridge.callTool("submit_activity", {
          module: "Applicant", activity: "create", workspaceId: assets.workspaceId,
          input: { Name: "Priya Nair", Email: "priya.nair@email.com", "Credit Score": 520, "Active Loans": 2, "Annual Income": 68000 },
          ai: AI,
        });
        assets.task2ApplicantId = getCreatedEntryId(appResult)!;
        if (!assets.task2ApplicantId) throw new Error("Setup failed: task2ApplicantId");

        const loanResult = await bridge.callTool("submit_activity", {
          module: "LoanApplication", activity: "create", workspaceId: assets.workspaceId,
          input: { "Applicant Name": "Priya Nair", "Applicant ID": String(assets.task2ApplicantId), "Requested Amount": 30000 },
          ai: AI,
        });
        assets.task2LoanId = getCreatedEntryId(loanResult)!;
        if (!assets.task2LoanId) throw new Error("Setup failed: task2LoanId");

        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: applicant=${assets.task2ApplicantId}, loan=${assets.task2LoanId}`);
      },
      prompt: () =>
        `A new loan application has come in for Priya Nair. ` +
        `Find the application, look up the linked Applicant record to assess their credit profile, then process the application according to our branching policy. ` +
        `Make sure to set the appropriate fields for whichever branch you take.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateBranch(toolCalls, assets, assets?.task2ApplicantId ?? 0, assets?.task2LoanId ?? 0, "Under Review"),
      verify: async (bridge: IBridge, assets: LoanAssets): Promise<EvaluationResult> =>
        verifyLoanState(bridge, assets.task2LoanId, "Under Review"),
    },

    // ── Task 3: Approve (score=720, loans=1) ─────────────────────────────────
    {
      id: "task_3_approve",
      name: "Process Loan — Approve (High Score)",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: LoanAssets): Promise<void> => {
        const appResult = await bridge.callTool("submit_activity", {
          module: "Applicant", activity: "create", workspaceId: assets.workspaceId,
          input: { Name: "Elena Vasquez", Email: "elena.vasquez@email.com", "Credit Score": 720, "Active Loans": 1, "Annual Income": 95000 },
          ai: AI,
        });
        assets.task3ApplicantId = getCreatedEntryId(appResult)!;
        if (!assets.task3ApplicantId) throw new Error("Setup failed: task3ApplicantId");

        const loanResult = await bridge.callTool("submit_activity", {
          module: "LoanApplication", activity: "create", workspaceId: assets.workspaceId,
          input: { "Applicant Name": "Elena Vasquez", "Applicant ID": String(assets.task3ApplicantId), "Requested Amount": 80000 },
          ai: AI,
        });
        assets.task3LoanId = getCreatedEntryId(loanResult)!;
        if (!assets.task3LoanId) throw new Error("Setup failed: task3LoanId");

        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: applicant=${assets.task3ApplicantId}, loan=${assets.task3LoanId}`);
      },
      prompt: () =>
        `A new loan application has come in for Elena Vasquez. ` +
        `Find the application, look up the linked Applicant record to assess their credit profile, then process the application according to our branching policy. ` +
        `Make sure to set the appropriate fields for whichever branch you take.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateBranch(toolCalls, assets, assets?.task3ApplicantId ?? 0, assets?.task3LoanId ?? 0, "Approved"),
      verify: async (bridge: IBridge, assets: LoanAssets): Promise<EvaluationResult> =>
        verifyLoanState(bridge, assets.task3LoanId, "Approved", 80000),
    },

    // ── Task 4: Under Review (score=680, loans=3 — conflicting signals trap) ─
    {
      id: "task_4_review_trap",
      name: "Process Loan — Under Review (Conflicting Signals Trap)",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: LoanAssets): Promise<void> => {
        const appResult = await bridge.callTool("submit_activity", {
          module: "Applicant", activity: "create", workspaceId: assets.workspaceId,
          input: { Name: "David Okafor", Email: "david.okafor@email.com", "Credit Score": 680, "Active Loans": 3, "Annual Income": 82000 },
          ai: AI,
        });
        assets.task4ApplicantId = getCreatedEntryId(appResult)!;
        if (!assets.task4ApplicantId) throw new Error("Setup failed: task4ApplicantId");

        const loanResult = await bridge.callTool("submit_activity", {
          module: "LoanApplication", activity: "create", workspaceId: assets.workspaceId,
          input: { "Applicant Name": "David Okafor", "Applicant ID": String(assets.task4ApplicantId), "Requested Amount": 40000 },
          ai: AI,
        });
        assets.task4LoanId = getCreatedEntryId(loanResult)!;
        if (!assets.task4LoanId) throw new Error("Setup failed: task4LoanId");

        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: applicant=${assets.task4ApplicantId}, loan=${assets.task4LoanId}`);
      },
      prompt: () =>
        `A new loan application has come in for David Okafor. ` +
        `Find the application, look up the linked Applicant record to assess their credit profile, then process the application according to our branching policy. ` +
        `Make sure to set the appropriate fields for whichever branch you take.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        // Trap: score=680 looks approvable but active_loans=3 disqualifies from Approve — must go Under Review
        evaluateBranch(toolCalls, assets, assets?.task4ApplicantId ?? 0, assets?.task4LoanId ?? 0, "Under Review"),
      verify: async (bridge: IBridge, assets: LoanAssets): Promise<EvaluationResult> => {
        const result = await verifyLoanState(bridge, assets.task4LoanId, "Under Review");

        // ── Teardown ──────────────────────────────────────────────────────────
        const loanList = await bridge.callTool("list_entries", { module: "LoanApplication" }) as Record<string, unknown>;
        const loans = (Array.isArray(loanList?.list) ? loanList.list : Array.isArray(loanList) ? loanList : []) as Array<Record<string, unknown>>;
        for (const entry of loans) {
          const id = entry?.entryId ?? entry?.id;
          if (!id) continue;
          try { await bridge.callTool("submit_activity", { module: "LoanApplication", activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
        }
        for (const id of [assets.task1ApplicantId, assets.task2ApplicantId, assets.task3ApplicantId, assets.task4ApplicantId]) {
          if (!id) continue;
          try { await bridge.callTool("submit_activity", { module: "Applicant", activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
        }
        const api = new ApiBridge();
        for (const moduleId of [assets.loanModuleId, assets.applicantModuleId].filter(Boolean)) {
          try { await api.deleteModule(assets.workspaceId, null, moduleId); } catch { /* ignore */ }
        }

        return result;
      },
    },
  ],

  teardown: async (): Promise<void> => { /* cleanup handled in task_4 verify */ },
};

module.exports = scenario;
