// Field Service Dispatch Workflow
// Tests technician type matching and availability checking via linked active issues.
//
// Seed data:
//   Technicians: Alan/Electrical (busy — has active In Progress issue), Ben/Electrical (free),
//                Clara/Plumbing (free), Dana/HVAC (free)
//   Alan's active issue: "Faulty circuit breaker — Block A" (In Progress)
//
// Task 1: Assign electrical issue — agent must check active issues, pick Ben (Alan is busy)
// Task 2: Assign plumbing issue — agent must match type, pick Clara (only free plumber)
// Task 3: Resolve + reassign — resolve Alan's issue, assign new electrical issue (Alan now free, Ben busy)
// Task 4: HVAC assignment + summary — assign HVAC issue to Dana, list all open issues

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, EvaluationResult, Scenario, ToolCall } from "../types";

interface FieldServiceAssets {
  workspaceId: string;
  technicianModuleId: string | number;
  issueModuleId: string | number;
  alanId: string | number;
  benId: string | number;
  claraId: string | number;
  danaId: string | number;
  alanActiveIssueId: string | number;
  task1IssueId: string | number;
  task2IssueId: string | number;
  task3IssueId: string | number;
  task4IssueId: string | number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasError(result: unknown): boolean {
  const r = result as Record<string, unknown>;
  if (r?.error && r.error.toString().toLowerCase() === "human_actor_blocked") return false;
  if (r?.error) return true;
  if (typeof r?.result === "string" && r.result.toLowerCase().includes("error")) return true;
  return false;
}

function calledSuccessfully(toolCalls: ToolCall[], name: string): boolean {
  return toolCalls.some((t) => t.name === name && !hasError(t.result));
}

function firstDefined<T>(...values: (T | null | undefined)[]): T | undefined {
  return values.find((v): v is T => v !== undefined && v !== null);
}

function isValidId(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") return v.length > 0 && v !== "new" && !isNaN(Number(v));
  return false;
}

function getCreatedEntryId(result: unknown): string | number | undefined {
  const r = result as Record<string, unknown>;
  const results = r?.results as Array<Record<string, unknown>> | undefined;
  const list = r?.list as Array<Record<string, unknown>> | undefined;
  const candidate = firstDefined(
    r?.entryId,
    (r?.entryIds as unknown[])?.[0],
    results?.[0]?.entryId,
    results?.[0]?.id,
    list?.[0]?.entryId,
    (r?.data as Record<string, unknown>)?.entryId,
    (r?.data as Record<string, unknown> & { results?: Array<Record<string, unknown>> })?.results?.[0]?.entryId,
  );
  return isValidId(candidate) ? (candidate as string | number) : undefined;
}

function getCreatedModuleId(result: unknown): string | number | undefined {
  const r = result as Record<string, unknown>;
  const candidate = firstDefined(
    r?.id, r?.moduleId, r?.vectorId,
    (r?.module as Record<string, unknown>)?.id,
    (r?.module as Record<string, unknown>)?.moduleId,
    (r?.data as Record<string, unknown>)?.id,
  );
  return isValidId(candidate) ? (candidate as string | number) : undefined;
}

function getModuleList(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r?.list)) return r.list as Array<Record<string, unknown>>;
  if (Array.isArray(r?.modules)) return r.modules as Array<Record<string, unknown>>;
  return [];
}

function findModuleByName(result: unknown, name: string): Record<string, unknown> | undefined {
  const lower = name.toLowerCase();
  return getModuleList(result).find((m) =>
    String(m?.name ?? m?.module ?? m?.moduleName ?? "").toLowerCase() === lower
  );
}

const AI = { reasoning: "TestBench setup", model: "testbench", confidence: 1.0 };

// ─── Scenario ─────────────────────────────────────────────────────────────────

const scenario: Scenario<FieldServiceAssets> = {
  id: "field_service_dispatch",
  name: "Field Service Dispatch Workflow",
  description: "Tests technician type matching and availability checking: agent must inspect active linked issues to determine which technician is free, then match issue category to correct trade type",

  setup: async (_bridge: IBridge, workspaceId: string): Promise<FieldServiceAssets> => {
    return {
      workspaceId,
      technicianModuleId: 0, issueModuleId: 0,
      alanId: 0, benId: 0, claraId: 0, danaId: 0,
      alanActiveIssueId: 0,
      task1IssueId: 0, task2IssueId: 0, task3IssueId: 0, task4IssueId: 0,
    };
  },

  system: (assets) => `You are a field service dispatch AI assistant for Inistate.
Workspace ${assets.workspaceId} is already active — do not pass workspaceId to tools unless required.
You have access to two modules: Technician and Issue.
A technician is considered busy if they have at least one Issue in "In Progress" state with their ID in the "Assigned Tech ID" field.
Always check existing issues to determine availability before assigning a technician.
Be concise. Use the minimum tools needed to complete each task.`,

  tasks: [
    {
      id: "task_1_assign_electrical_issue",
      name: "Assign Electrical Issue to Free Technician",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: FieldServiceAssets): Promise<void> => {
        const { workspaceId } = assets;
        await bridge.callTool("switch_mode", { mode: "configure" });
        let existingModules = await bridge.callTool("list_modules", { workspaceId });

        const technicianSchema = {
          name: "Technician", icon: "🔧",
          description: "Field technicians categorised by their trade type",
          states: [
            { name: "Available",   color: "#1E6B45", initial: true },
            { name: "Unavailable", color: "#C0392B" },
          ],
          information: [
            { name: "Name",  type: "Text",      ai_hint: "Full name of the technician" },
            { name: "Type",  type: "Selection", options: ["Electrical", "Plumbing", "HVAC"], ai_hint: "Trade type of the technician" },
            { name: "Email", type: "Text",      ai_hint: "Technician email address" },
          ],
          activities: [
            { name: "Mark Unavailable", actor: "ai" },
            { name: "Mark Available",   actor: "ai" },
          ],
          flows: [
            { activity: "Mark Unavailable", from: "Available",   to: "Unavailable" },
            { activity: "Mark Available",   from: "Unavailable", to: "Available"   },
          ],
        };
        let techModule = findModuleByName(existingModules, "Technician");
        if (!techModule) {
          await bridge.callTool("create_module", { workspaceId, ...technicianSchema });
          existingModules = await bridge.callTool("list_modules", { workspaceId });
          techModule = findModuleByName(existingModules, "Technician");
        }
        assets.technicianModuleId = getCreatedModuleId(techModule)!;

        const issueSchema = {
          name: "Issue", icon: "🛠️",
          description: "Maintenance and repair issues requiring technician assignment",
          states: [
            { name: "Open",        color: "#5A6070", initial: true },
            { name: "In Progress", color: "#2968A8" },
            { name: "Resolved",    color: "#1E6B45" },
          ],
          information: [
            { name: "Title",            type: "Text",      ai_hint: "Short description of the issue" },
            { name: "Category",         type: "Selection", options: ["Electrical", "Plumbing", "HVAC"], ai_hint: "Trade category required to fix this issue" },
            { name: "Priority",         type: "Selection", options: ["Low", "Medium", "High"], ai_hint: "Urgency of the issue" },
            { name: "Assigned To",      type: "Text",      ai_hint: "Name of the assigned technician" },
            { name: "Assigned Tech ID", type: "Text",      ai_hint: "Entry ID of the linked Technician record" },
            { name: "Notes",            type: "MultiText", ai_hint: "Additional notes or updates" },
          ],
          activities: [
            { name: "Assign",  actor: "ai", fields: ["Assigned To", "Assigned Tech ID"] },
            { name: "Resolve", actor: "ai" },
          ],
          flows: [
            { activity: "Assign",  from: "Open",        to: "In Progress" },
            { activity: "Resolve", from: "In Progress", to: "Resolved"    },
          ],
        };
        let issueModule = findModuleByName(existingModules, "Issue");
        if (!issueModule) {
          await bridge.callTool("create_module", { workspaceId, ...issueSchema });
          existingModules = await bridge.callTool("list_modules", { workspaceId });
          issueModule = findModuleByName(existingModules, "Issue");
        }
        assets.issueModuleId = getCreatedModuleId(issueModule)!;

        await bridge.callTool("switch_mode", { mode: "runtime" });

        const alanResult = await bridge.callTool("submit_activity", { module: "Technician", activity: "create", workspaceId, input: { Name: "Alan Goh", Type: "Electrical", Email: "alan@fieldco.com" }, ai: AI });
        assets.alanId = getCreatedEntryId(alanResult)!;
        if (!assets.alanId) throw new Error("Setup failed: alanId");

        const benResult = await bridge.callTool("submit_activity", { module: "Technician", activity: "create", workspaceId, input: { Name: "Ben Tan", Type: "Electrical", Email: "ben@fieldco.com" }, ai: AI });
        assets.benId = getCreatedEntryId(benResult)!;
        if (!assets.benId) throw new Error("Setup failed: benId");

        const claraResult = await bridge.callTool("submit_activity", { module: "Technician", activity: "create", workspaceId, input: { Name: "Clara Ng", Type: "Plumbing", Email: "clara@fieldco.com" }, ai: AI });
        assets.claraId = getCreatedEntryId(claraResult)!;
        if (!assets.claraId) throw new Error("Setup failed: claraId");

        const danaResult = await bridge.callTool("submit_activity", { module: "Technician", activity: "create", workspaceId, input: { Name: "Dana Lim", Type: "HVAC", Email: "dana@fieldco.com" }, ai: AI });
        assets.danaId = getCreatedEntryId(danaResult)!;
        if (!assets.danaId) throw new Error("Setup failed: danaId");

        // Seed Alan's active issue so he is busy
        const alanIssueResult = await bridge.callTool("submit_activity", { module: "Issue", activity: "create", workspaceId, input: { Title: "Faulty circuit breaker — Block A", Category: "Electrical", Priority: "Medium", "Assigned To": "Alan Goh", "Assigned Tech ID": String(assets.alanId), Notes: "" }, ai: AI });
        assets.alanActiveIssueId = getCreatedEntryId(alanIssueResult)!;
        if (!assets.alanActiveIssueId) throw new Error("Setup failed: alanActiveIssueId");
        await bridge.callTool("submit_activity", { module: "Issue", activity: "Assign", entryId: assets.alanActiveIssueId, workspaceId, input: { "Assigned To": "Alan Goh", "Assigned Tech ID": String(assets.alanId) }, ai: AI });

        await bridge.callTool("set_workspace", { workspaceId });
        console.log(`    → Seeded: Alan=${assets.alanId}, Ben=${assets.benId}, Clara=${assets.claraId}, Dana=${assets.danaId}, Alan's active issue=${assets.alanActiveIssueId}`);
      },
      prompt: (_assets) =>
        `A new electrical issue has come in: "Power outage in Server Room", Priority: High. ` +
        `Find a free Electrical technician and assign the issue to them. ` +
        `A technician is considered busy if they have an active issue (In Progress) linked to them. ` +
        `Check existing issues to determine availability before assigning.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Level 1: required tool calls
        const checkedIssues = calledSuccessfully(toolCalls, "list_entries") &&
          toolCalls.some((t) => t.name === "list_entries" && JSON.stringify(t.arguments).toLowerCase().includes("issue"));
        if (!checkedIssues) issues.push("Did not call list_entries on Issue module to check technician availability");

        const assignCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") && !hasError(t.result)
        );
        if (!assignCall) {
          issues.push("Did not successfully call submit_activity");
          return { success: false, issues, hallucinated: false };
        }

        const raw = JSON.stringify(assignCall.arguments).toLowerCase();

        // Level 2: params in tool call
        const transitioned = raw.includes("assign");
        if (!transitioned) issues.push("submit_activity did not use 'Assign' activity to transition issue");

        const correctCategory = raw.includes("electrical") || raw.includes("power outage") || raw.includes("server room");
        if (!correctCategory) issues.push("Issue created does not reference the electrical issue");

        const pickedBen   = raw.includes("ben")   || (assets && raw.includes(String(assets.benId).toLowerCase()));
        const pickedAlan  = raw.includes("alan")   || (assets && raw.includes(String(assets.alanId).toLowerCase()));
        const pickedClara = raw.includes("clara")  || (assets && raw.includes(String(assets.claraId).toLowerCase()));
        const pickedDana  = raw.includes("dana")   || (assets && raw.includes(String(assets.danaId).toLowerCase()));

        if (!pickedBen) {
          if (pickedAlan)       issues.push("Assigned to Alan Goh who already has an active In Progress issue");
          else if (pickedClara) issues.push("Assigned to Clara Ng whose type is Plumbing, not Electrical");
          else if (pickedDana)  issues.push("Assigned to Dana Lim whose type is HVAC, not Electrical");
          else                  issues.push("Could not determine assigned technician — Ben Tan expected");
        }

        return {
          success: issues.length === 0,
          issues,
          hallucinated: Boolean(!pickedBen && (pickedAlan || pickedClara || pickedDana)),
        };
      },
      verify: async (bridge: IBridge, assets: FieldServiceAssets): Promise<EvaluationResult> => {
        const issues: string[] = [];
        const result = await bridge.callTool("list_entries", { module: "Issue" }) as Record<string, unknown>;
        const list = (Array.isArray(result?.list) ? result.list : Array.isArray(result) ? result : []) as Array<Record<string, unknown>>;

        // Level 3: entry exists, assigned to Ben, in correct state
        const agentEntry = list.find((e) => {
          const raw = JSON.stringify(e).toLowerCase();
          return raw.includes("server room") || raw.includes("power outage");
        });

        if (!agentEntry) {
          issues.push("No Issue entry found for 'Power outage in Server Room'");
        } else {
          const raw = JSON.stringify(agentEntry).toLowerCase();
          if (!raw.includes("ben") && !(assets && raw.includes(String(assets.benId)))) {
            issues.push("Issue entry is not assigned to Ben Tan");
          }
          assets.task1IssueId = (agentEntry?.entryId ?? agentEntry?.id) as string | number;
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },

    {
      id: "task_2_assign_plumbing_issue",
      name: "Assign Plumbing Issue (Type Matching)",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: FieldServiceAssets): Promise<void> => {
        // Fallback: ensure Ben has task 1's issue in progress so he shows as an option but wrong type check still applies
        const result = await bridge.callTool("list_entries", { module: "Issue" }) as Record<string, unknown>;
        const list = (Array.isArray(result?.list) ? result.list : Array.isArray(result) ? result : []) as Array<Record<string, unknown>>;
        const benIssueExists = list.some((e) => {
          const raw = JSON.stringify(e).toLowerCase();
          return (raw.includes("server room") || raw.includes("power outage")) && raw.includes("in progress");
        });
        if (!benIssueExists) {
          console.log("    → [task_2 setup] Ben's issue not found — seeding fallback");
          const r = await bridge.callTool("submit_activity", { module: "Issue", activity: "create", workspaceId: assets.workspaceId, input: { Title: "Power outage in Server Room", Category: "Electrical", Priority: "High", "Assigned To": "Ben Tan", "Assigned Tech ID": String(assets.benId), Notes: "Fallback seed" }, ai: AI });
          const id = getCreatedEntryId(r);
          if (id) await bridge.callTool("submit_activity", { module: "Issue", activity: "Assign", entryId: id, workspaceId: assets.workspaceId, input: { "Assigned To": "Ben Tan", "Assigned Tech ID": String(assets.benId) }, ai: AI });
        }

        // Seed the plumbing issue as Open
        const plumbingResult = await bridge.callTool("submit_activity", { module: "Issue", activity: "create", workspaceId: assets.workspaceId, input: { Title: "Burst pipe in Level 3 Bathroom", Category: "Plumbing", Priority: "High", "Assigned To": "", "Assigned Tech ID": "", Notes: "" }, ai: AI });
        assets.task2IssueId = getCreatedEntryId(plumbingResult)!;
        console.log(`    → Seeded plumbing issue=${assets.task2IssueId}`);
      },
      prompt: (assets) =>
        `A new plumbing issue has come in: "Burst pipe in Level 3 Bathroom" (Issue ID: ${assets.task2IssueId}), Priority: High. ` +
        `Find a free Plumbing technician and assign the issue to them. ` +
        `A technician is considered busy if they have an active issue (In Progress) linked to them. ` +
        `Check existing issues to determine availability before assigning.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Level 1: required tool calls
        const checkedIssues = calledSuccessfully(toolCalls, "list_entries") &&
          toolCalls.some((t) => t.name === "list_entries" && JSON.stringify(t.arguments).toLowerCase().includes("issue"));
        if (!checkedIssues) issues.push("Did not call list_entries on Issue module to check technician availability");

        const assignCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") && !hasError(t.result)
        );
        if (!assignCall) {
          issues.push("Did not successfully call submit_activity");
          return { success: false, issues, hallucinated: false };
        }

        const raw = JSON.stringify(assignCall.arguments).toLowerCase();

        // Level 2: params in tool call
        const transitioned = raw.includes("assign");
        if (!transitioned) issues.push("submit_activity did not use 'Assign' activity to transition issue");

        const correctIssue = raw.includes("burst pipe") || raw.includes("level 3") || raw.includes("plumbing") ||
          (assets && raw.includes(String(assets.task2IssueId).toLowerCase()));
        if (!correctIssue) issues.push("Assigned call does not reference the plumbing issue");

        const pickedClara = raw.includes("clara")  || (assets && raw.includes(String(assets.claraId).toLowerCase()));
        const pickedAlan  = raw.includes("alan")   || (assets && raw.includes(String(assets.alanId).toLowerCase()));
        const pickedBen   = raw.includes("ben")    || (assets && raw.includes(String(assets.benId).toLowerCase()));
        const pickedDana  = raw.includes("dana")   || (assets && raw.includes(String(assets.danaId).toLowerCase()));

        if (!pickedClara) {
          if (pickedAlan)      issues.push("Assigned to Alan Goh whose type is Electrical, not Plumbing");
          else if (pickedBen)  issues.push("Assigned to Ben Tan whose type is Electrical, not Plumbing");
          else if (pickedDana) issues.push("Assigned to Dana Lim whose type is HVAC, not Plumbing");
          else                 issues.push("Could not determine assigned technician — Clara Ng expected");
        }

        return {
          success: issues.length === 0,
          issues,
          hallucinated: Boolean(!pickedClara && (pickedAlan || pickedBen || pickedDana)),
        };
      },
      verify: async (bridge: IBridge, assets: FieldServiceAssets): Promise<EvaluationResult> => {
        const issues: string[] = [];
        const result = await bridge.callTool("get_entry", { module: "Issue", entryId: assets.task2IssueId }) as Record<string, unknown>;

        if (hasError(result)) {
          issues.push("get_entry failed for plumbing issue");
          return { success: false, issues, hallucinated: false };
        }

        // Level 3: assigned to Clara, in correct state
        const raw = JSON.stringify(result).toLowerCase();
        if (!raw.includes("clara") && !(assets && raw.includes(String(assets.claraId)))) {
          issues.push("Plumbing issue is not assigned to Clara Ng");
        }
        if (!raw.includes("in progress")) {
          issues.push("Plumbing issue state is not 'In Progress'");
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },

    {
      id: "task_3_resolve_and_reassign",
      name: "Resolve Issue and Reassign (Dynamic Availability)",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: FieldServiceAssets): Promise<void> => {
        const result = await bridge.callTool("list_entries", { module: "Issue" }) as Record<string, unknown>;
        const list = (Array.isArray(result?.list) ? result.list : Array.isArray(result) ? result : []) as Array<Record<string, unknown>>;

        // Ensure Alan's original issue is still In Progress
        const alanIssue = list.find((e) => {
          const raw = JSON.stringify(e).toLowerCase();
          return raw.includes("circuit breaker") && raw.includes(String(assets.alanId));
        });
        if (!alanIssue || !JSON.stringify(alanIssue).toLowerCase().includes("in progress")) {
          console.log("    → [task_3 setup] Alan's active issue missing — reseeding");
          const r = await bridge.callTool("submit_activity", { module: "Issue", activity: "create", workspaceId: assets.workspaceId, input: { Title: "Faulty circuit breaker — Block A", Category: "Electrical", Priority: "Medium", "Assigned To": "Alan Goh", "Assigned Tech ID": String(assets.alanId), Notes: "Fallback seed" }, ai: AI });
          const id = getCreatedEntryId(r);
          if (id) {
            assets.alanActiveIssueId = id;
            await bridge.callTool("submit_activity", { module: "Issue", activity: "Assign", entryId: id, workspaceId: assets.workspaceId, input: { "Assigned To": "Alan Goh", "Assigned Tech ID": String(assets.alanId) }, ai: AI });
          }
        } else {
          assets.alanActiveIssueId = (alanIssue?.entryId ?? alanIssue?.id) as string | number;
        }

        // Ensure Ben's task 1 issue is still In Progress
        const benIssue = list.find((e) => {
          const raw = JSON.stringify(e).toLowerCase();
          return (raw.includes("server room") || raw.includes("power outage")) && raw.includes("in progress");
        });
        if (!benIssue) {
          console.log("    → [task_3 setup] Ben's active issue missing — reseeding");
          const r = await bridge.callTool("submit_activity", { module: "Issue", activity: "create", workspaceId: assets.workspaceId, input: { Title: "Power outage in Server Room", Category: "Electrical", Priority: "High", "Assigned To": "Ben Tan", "Assigned Tech ID": String(assets.benId), Notes: "Fallback seed" }, ai: AI });
          const id = getCreatedEntryId(r);
          if (id) await bridge.callTool("submit_activity", { module: "Issue", activity: "Assign", entryId: id, workspaceId: assets.workspaceId, input: { "Assigned To": "Ben Tan", "Assigned Tech ID": String(assets.benId) }, ai: AI });
        }

        // Seed the new electrical issue as Open
        const newIssueResult = await bridge.callTool("submit_activity", { module: "Issue", activity: "create", workspaceId: assets.workspaceId, input: { Title: "Tripped breaker in Gym", Category: "Electrical", Priority: "Medium", "Assigned To": "", "Assigned Tech ID": "", Notes: "" }, ai: AI });
        assets.task3IssueId = getCreatedEntryId(newIssueResult)!;
        console.log(`    → Seeded: Alan's active issue=${assets.alanActiveIssueId}, new electrical issue=${assets.task3IssueId}`);
      },
      prompt: (assets) =>
        `Alan's active issue "Faulty circuit breaker — Block A" (Issue ID: ${assets.alanActiveIssueId}) has been resolved. ` +
        `Mark it as Resolved using the Resolve activity. ` +
        `Then assign the new electrical issue "Tripped breaker in Gym" (Issue ID: ${assets.task3IssueId}) to a free Electrical technician. ` +
        `Check active issues to determine availability before assigning.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Level 1: required tool calls
        const checkedIssues = calledSuccessfully(toolCalls, "list_entries") &&
          toolCalls.some((t) => t.name === "list_entries" && JSON.stringify(t.arguments).toLowerCase().includes("issue"));
        if (!checkedIssues) issues.push("Did not call list_entries on Issue module to check technician availability");

        const allCalls = toolCalls.filter(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") && !hasError(t.result)
        );
        if (allCalls.length < 2) {
          issues.push("Expected at least two successful submit_activity calls (resolve + assign)");
          return { success: false, issues, hallucinated: false };
        }

        // Level 2: resolve call targeting Alan's issue
        const resolveCall = allCalls.find((t) => {
          const raw = JSON.stringify(t.arguments).toLowerCase();
          return raw.includes("resolve") &&
            (raw.includes(String(assets?.alanActiveIssueId)) || raw.includes("circuit breaker") || raw.includes("alan"));
        });
        if (!resolveCall) issues.push("Did not call Resolve activity on Alan's active issue");

        // Level 2: assign call targeting the new electrical issue
        const assignCall = allCalls.find((t) => {
          const raw = JSON.stringify(t.arguments).toLowerCase();
          return raw.includes("assign") &&
            (raw.includes(String(assets?.task3IssueId)) || raw.includes("tripped") || raw.includes("gym"));
        });
        if (!assignCall) {
          issues.push("Did not call Assign activity on the new electrical issue");
          return { success: false, issues, hallucinated: false };
        }

        const raw = JSON.stringify(assignCall.arguments).toLowerCase();
        const pickedAlan  = raw.includes("alan")  || (assets && raw.includes(String(assets.alanId).toLowerCase()));
        const pickedBen   = raw.includes("ben")   || (assets && raw.includes(String(assets.benId).toLowerCase()));
        const pickedClara = raw.includes("clara")  || (assets && raw.includes(String(assets.claraId).toLowerCase()));
        const pickedDana  = raw.includes("dana")   || (assets && raw.includes(String(assets.danaId).toLowerCase()));

        if (!pickedAlan) {
          if (pickedBen)        issues.push("Assigned to Ben Tan who still has an active In Progress issue");
          else if (pickedClara) issues.push("Assigned to Clara Ng whose type is Plumbing, not Electrical");
          else if (pickedDana)  issues.push("Assigned to Dana Lim whose type is HVAC, not Electrical");
          else                  issues.push("Could not determine assigned technician — Alan Goh expected (now free after resolve)");
        }

        return {
          success: issues.length === 0,
          issues,
          hallucinated: Boolean(!pickedAlan && (pickedBen || pickedClara || pickedDana)),
        };
      },
      verify: async (bridge: IBridge, assets: FieldServiceAssets): Promise<EvaluationResult> => {
        const issues: string[] = [];

        // Level 3: Alan's original issue should be Resolved
        const alanIssueResult = await bridge.callTool("get_entry", { module: "Issue", entryId: assets.alanActiveIssueId }) as Record<string, unknown>;
        if (hasError(alanIssueResult)) {
          issues.push("get_entry failed for Alan's original issue");
        } else if (!JSON.stringify(alanIssueResult).toLowerCase().includes("resolved")) {
          issues.push("Alan's original issue state is not 'Resolved'");
        }

        // Level 3: new electrical issue assigned to Alan, In Progress
        const newIssueResult = await bridge.callTool("get_entry", { module: "Issue", entryId: assets.task3IssueId }) as Record<string, unknown>;
        if (hasError(newIssueResult)) {
          issues.push("get_entry failed for new electrical issue");
        } else {
          const raw = JSON.stringify(newIssueResult).toLowerCase();
          if (!raw.includes("alan") && !(assets && raw.includes(String(assets.alanId)))) {
            issues.push("New electrical issue is not assigned to Alan Goh");
          }
          if (!raw.includes("in progress")) {
            issues.push("New electrical issue state is not 'In Progress'");
          }
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },

    {
      id: "task_4_hvac_assignment_and_summary",
      name: "HVAC Assignment and Open Issues Summary",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: FieldServiceAssets): Promise<void> => {
        // Seed HVAC issue as Open
        const hvacResult = await bridge.callTool("submit_activity", { module: "Issue", activity: "create", workspaceId: assets.workspaceId, input: { Title: "AC unit failure in Board Room", Category: "HVAC", Priority: "High", "Assigned To": "", "Assigned Tech ID": "", Notes: "" }, ai: AI });
        assets.task4IssueId = getCreatedEntryId(hvacResult)!;
        console.log(`    → Seeded HVAC issue=${assets.task4IssueId}`);
      },
      prompt: (assets) =>
        `A new HVAC issue has come in: "AC unit failure in Board Room" (Issue ID: ${assets.task4IssueId}), Priority: High. ` +
        `Assign it to a free HVAC technician. ` +
        `A technician is considered busy if they have an active issue (In Progress) linked to them. ` +
        `After assigning, list all currently In Progress issues and summarise who is working on what.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Level 1: required tool calls
        const checkedIssues = calledSuccessfully(toolCalls, "list_entries") &&
          toolCalls.some((t) => t.name === "list_entries" && JSON.stringify(t.arguments).toLowerCase().includes("issue"));
        if (!checkedIssues) issues.push("Did not call list_entries on Issue module to check technician availability");

        const assignCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") && !hasError(t.result)
        );
        if (!assignCall) {
          issues.push("Did not successfully call submit_activity");
          return { success: false, issues, hallucinated: false };
        }

        const raw = JSON.stringify(assignCall.arguments).toLowerCase();

        // Level 2: params in tool call
        const transitioned = raw.includes("assign");
        if (!transitioned) issues.push("submit_activity did not use 'Assign' activity");

        const correctIssue = raw.includes("board room") || raw.includes("ac unit") || raw.includes("hvac") ||
          (assets && raw.includes(String(assets.task4IssueId).toLowerCase()));
        if (!correctIssue) issues.push("Assign call does not reference the HVAC issue");

        const pickedDana  = raw.includes("dana")  || (assets && raw.includes(String(assets.danaId).toLowerCase()));
        const pickedAlan  = raw.includes("alan")  || (assets && raw.includes(String(assets.alanId).toLowerCase()));
        const pickedBen   = raw.includes("ben")   || (assets && raw.includes(String(assets.benId).toLowerCase()));
        const pickedClara = raw.includes("clara") || (assets && raw.includes(String(assets.claraId).toLowerCase()));

        if (!pickedDana) {
          if (pickedAlan)       issues.push("Assigned to Alan Goh whose type is Electrical, not HVAC");
          else if (pickedBen)   issues.push("Assigned to Ben Tan whose type is Electrical, not HVAC");
          else if (pickedClara) issues.push("Assigned to Clara Ng whose type is Plumbing, not HVAC");
          else                  issues.push("Could not determine assigned technician — Dana Lim expected");
        }

        return {
          success: issues.length === 0,
          issues,
          hallucinated: Boolean(!pickedDana && (pickedAlan || pickedBen || pickedClara)),
        };
      },
      verify: async (bridge: IBridge, assets: FieldServiceAssets): Promise<EvaluationResult> => {
        const issues: string[] = [];

        // Level 3: HVAC issue assigned to Dana, In Progress
        const hvacIssueResult = await bridge.callTool("get_entry", { module: "Issue", entryId: assets.task4IssueId }) as Record<string, unknown>;
        if (hasError(hvacIssueResult)) {
          issues.push("get_entry failed for HVAC issue");
        } else {
          const raw = JSON.stringify(hvacIssueResult).toLowerCase();
          if (!raw.includes("dana") && !(assets && raw.includes(String(assets.danaId)))) {
            issues.push("HVAC issue is not assigned to Dana Lim");
          }
          if (!raw.includes("in progress")) {
            issues.push("HVAC issue state is not 'In Progress'");
          }
        }

        // ── Teardown ────────────────────────────────────────────────────────────
        const allIssues = await bridge.callTool("list_entries", { module: "Issue" }) as Record<string, unknown>;
        const allIssueList = (Array.isArray(allIssues?.list) ? allIssues.list : Array.isArray(allIssues) ? allIssues : []) as Array<Record<string, unknown>>;
        for (const entry of allIssueList) {
          const id = entry?.entryId ?? entry?.id;
          if (!id) continue;
          try { await bridge.callTool("submit_activity", { module: "Issue", activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
        }

        const allTechs = await bridge.callTool("list_entries", { module: "Technician" }) as Record<string, unknown>;
        const allTechList = (Array.isArray(allTechs?.list) ? allTechs.list : Array.isArray(allTechs) ? allTechs : []) as Array<Record<string, unknown>>;
        for (const entry of allTechList) {
          const id = entry?.entryId ?? entry?.id;
          if (!id) continue;
          try { await bridge.callTool("submit_activity", { module: "Technician", activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
        }

        const api = new ApiBridge();
        for (const moduleId of [assets.issueModuleId, assets.technicianModuleId].filter(Boolean)) {
          try { await api.deleteModule(assets.workspaceId, null, moduleId); } catch { /* ignore */ }
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
  ],

  teardown: async (): Promise<void> => { /* cleanup handled in last task verify */ },
};

module.exports = scenario;

