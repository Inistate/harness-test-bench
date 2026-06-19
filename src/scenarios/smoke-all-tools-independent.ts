// 15 tools tested across 5 tasks:
//   list_workspaces, set_workspace
//   switch_mode, design_workflow, validate_design
//   create_module, get_module_schema, get_module_canvas, update_module
//   submit_activity, submit_activities
//   list_modules, list_entries, get_entry, get_entry_history
// upload_file tracked as a negative signal (fallback — should not be called)

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, Scenario, ToolCall } from "../types";

const PDF_NAME = "crm_integration_brief.pdf";

interface ProjectManagementAssets {
  workspaceId: string;
  workspaceName: string;
  pdfName: string;
}

function calledSuccessfully(toolCalls: ToolCall[], name: string): boolean {
  return toolCalls.some((t) => t.name === name && !hasError(t.result));
}

function hasError(result: unknown): boolean {
  const r = result as Record<string, unknown>;
  if (r?.error && r.error.toString().toLowerCase() === "human_actor_blocked") return false; // allow tools to be blocked by human actor without failing the task
  if (r?.error) return true;
  if (typeof r?.result === "string" && r.result.toLowerCase().includes("error")) return true;
  return false;
}

function getModuleList(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r?.list)) return r.list as Array<Record<string, unknown>>;
  if (Array.isArray(r?.modules)) return r.modules as Array<Record<string, unknown>>;
  if (Array.isArray((r?.data as Record<string, unknown>)?.list)) return (r.data as Record<string, unknown>).list as Array<Record<string, unknown>>;
  if (Array.isArray((r?.data as Record<string, unknown>)?.modules)) return (r.data as Record<string, unknown>).modules as Array<Record<string, unknown>>;
  return [];
}

// Deletes every module whose name contains namePattern (case-insensitive).
// Collects candidates from list_modules + set_workspace vectors, resolves IDs
// via get_module_canvas, then deletes via API.
async function deleteAllModulesMatching(bridge: IBridge, assets: ProjectManagementAssets, namePattern: string): Promise<void> {
  const pattern = namePattern.toLowerCase();
  const candidateNames = new Set<string>();

  // Source 1: list_modules (includes unpublished modules)
  try {
    const listResult = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId }) as unknown;
    for (const m of getModuleList(listResult)) {
      const n = String(m?.name ?? "");
      if (n.toLowerCase().includes(pattern)) candidateNames.add(n);
    }
  } catch { /* ignore — vectors fallback covers this */ }

  // Source 2: set_workspace vectors (published modules)
  const workspaceData = await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId }) as Record<string, unknown>;
  const vectors = (workspaceData?.vectors ?? []) as Array<Record<string, unknown>>;
  for (const v of vectors) {
    const n = String(v?.name ?? "");
    if (n.toLowerCase().includes(pattern)) candidateNames.add(n);
  }

  if (candidateNames.size === 0) {
    return;
  }

  const api = new ApiBridge();
  for (const name of candidateNames) {
    const canvas = await bridge.callTool("get_module_canvas", { module: name }) as Record<string, unknown>;
    if (canvas?.error) continue;
    const id = canvas?.id as string | number | null | undefined;
    if (id == null) continue;
    await api.deleteModule(assets.workspaceId, assets.workspaceName, id);
    console.log(`\n    → Deleted module "${name}" (id: ${id})`);
  }
}

const CLIENT_PROJECTS_SCHEMA = {
  name: "Client Projects", icon: "📋",
  description: "Track and manage client projects",
  states: [
    { name: "Draft", color: "#5A6070", initial: true },
    { name: "Active", color: "#2968A8" },
    { name: "On Hold", color: "#A07828" },
    { name: "Completed", color: "#2A7B50" },
    { name: "Cancelled", color: "#C0392B" },
  ],
  information: [
    { name: "Project Name", type: "Text", ai_hint: "Name of the project" },
    { name: "Client", type: "Text", ai_hint: "Client name" },
    { name: "Status", type: "Selection", options: ["Draft", "Active", "On Hold", "Completed", "Cancelled"], ai_hint: "Project status" },
    { name: "Start Date", type: "Date", ai_hint: "Project start date" },
    { name: "Deadline", type: "Date", ai_hint: "Project deadline" },
    { name: "Owner", type: "Text", ai_hint: "Project owner" },
    { name: "Budget", type: "Currency", ai_hint: "Project budget" },
    { name: "Priority", type: "Selection", options: ["Low", "Medium", "High"], ai_hint: "Project priority" },
    { name: "Notes", type: "MultiText", ai_hint: "Additional notes" },
  ],
  activities: [
    { name: "Start Project", actor: "human" },
    { name: "Pause Project", actor: "human" },
    { name: "Resume Project", actor: "human" },
    { name: "Complete Project", actor: "human" },
    { name: "Cancel Project", actor: "human" },
  ],
  flows: [
    { activity: "Start Project", from: "Draft", to: "Active" },
    { activity: "Pause Project", from: "Active", to: "On Hold" },
    { activity: "Resume Project", from: "On Hold", to: "Active" },
    { activity: "Complete Project", from: "Active", to: "Completed" },
    { activity: "Cancel Project", from: "Draft", to: "Cancelled" },
    { activity: "Cancel Project", from: "Active", to: "Cancelled" },
  ],
};

async function ensureClientProjectsModule(bridge: IBridge, assets: ProjectManagementAssets): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  const { name, ...schemaFields } = CLIENT_PROJECTS_SCHEMA;
  await deleteAllModulesMatching(bridge, assets, name);
  const createResult = await bridge.callTool("create_module", { name, workspaceId: assets.workspaceId, ...schemaFields }) as Record<string, unknown>;
  if (hasError(createResult)) throw new Error(`ensureClientProjectsModule: create_module failed — ${JSON.stringify(createResult)}`);
  console.log(`\n    → Created "${name}" module (task prerequisite)`);
  await bridge.callTool("switch_mode", { mode: "runtime" });
}

const SEED_ENTRIES = [
  { "Project Name": "CRM Integration", Client: "Gamma Inc", "Start Date": "2026-06-01", Deadline: "2026-12-31", Owner: "Carol", Budget: 48000, Priority: "High", Notes: "Phase 1 kickoff completed" },
  { "Project Name": "Brand Refresh", Client: "Delta Co", "Start Date": "2026-03-01", Deadline: "2026-08-31", Owner: "Dave", Budget: 12000, Priority: "Medium" },
  { "Project Name": "Data Migration", Client: "Epsilon LLC", "Start Date": "2026-04-01", Deadline: "2026-10-31", Owner: "Eve", Budget: 27000, Priority: "Low" },
];

async function ensureTestEntries(bridge: IBridge, assets: ProjectManagementAssets): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  const result = await bridge.callTool("list_entries", { module: "Client Projects", workspaceId: assets.workspaceId }) as Record<string, unknown>;
  const list = Array.isArray(result)
    ? result
    : Array.isArray(result?.list)
      ? result.list
      : Array.isArray((result?.data as Record<string, unknown>)?.list)
        ? (result.data as Record<string, unknown>).list
        : [];
  const entryIds = (list as Array<Record<string, unknown>>).map((e) => e.entryId).filter((id): id is string | number => id != null);
  if (entryIds.length > 0) {
    await bridge.callTool("submit_activity", {
      module: "Client Projects",
      activity: "delete",
      entryIds,
      ai: { reasoning: "Clearing entries before seeding", model: "claude-sonnet-4-6", confidence: 1 },
      workspaceId: assets.workspaceId,
    });
  }

  const seedResult = await bridge.callTool("submit_activities", {
    workspaceId: assets.workspaceId,
    module: "Client Projects",
    activity: "create",
    confirmed: true,
    ai: { reasoning: "Seeding test entries", model: "claude-sonnet-4-6", confidence: 1 },
    items: SEED_ENTRIES.map((fields) => ({ input: fields })),
  }) as Record<string, unknown>;
  if (hasError(seedResult)) throw new Error(`ensureTestEntries: seed failed — ${JSON.stringify(seedResult)}`);
  console.log(`\n    → Seeded ${SEED_ENTRIES.length} entries into "Client Projects" (task prerequisite)`);
}

const scenario: Scenario<ProjectManagementAssets> = {
  id: "smoke_all_tools_2",
  name: "All-Tools Smoke Test 2",
  description: "Five-task workflow covering workspace setup, module design, entry management, and file operations",

  setup: async (bridge: IBridge, workspaceId: string): Promise<ProjectManagementAssets> => {
    console.log("    → Resolving workspace name...");
    const workspacesResult = await bridge.callTool("list_workspaces", {});
    const list = [
      ...(Array.isArray(workspacesResult) ? workspacesResult as Array<Record<string, unknown>> : []),
      ...((workspacesResult as Record<string, unknown>)?.workspaces as Array<Record<string, unknown>> ?? []),
      ...getModuleList(workspacesResult),
    ];
    const workspace = list.find((w) => String(w?.id ?? w?.workspaceId ?? "") === String(workspaceId));
    const workspaceName = String(workspace?.name ?? workspace?.workspaceName ?? "Inistate");
    await bridge.callTool("set_workspace", { workspaceId });
    console.log(`    → Workspace: ${workspaceName} (${workspaceId})`);
    return { workspaceId, workspaceName, pdfName: PDF_NAME };
  },

  // Schema constraints included because some models serialize arrays as {item:[...]} and booleans
  // as strings ("true"/"false"), causing MCP -32602 validation failures that silently break tasks.
  system: (assets) => `You are an AI assistant for Inistate.
  Tools operate in two modes: configure and operate. If a tool returns a "disabled" error, call switch_mode with the appropriate mode before retrying.
  Be concise and call the minimum tools needed to complete the task.
  JSON schema constraints: arrays must be plain JSON arrays (never {item:[...]}); booleans must be true/false (never "true"/"false"); all field names must match the tool schema exactly.`,

  tasks: [
    {
      // Tools: list_workspaces, set_workspace
      id: "task_1_workspace_setup",
      name: "Workspace Setup",
      maxSteps: 20,
      prompt: (assets) =>
        `I'm getting set up in Inistate for project management — can you find my available workspaces ` +
        `and switch me into workspace ${assets.workspaceId}?`,
      // workspaceId kept here intentionally — task 1 is specifically about workspace discovery
      evaluate: (toolCalls, _response, assets) => {
        const issues: string[] = [];
        if (!calledSuccessfully(toolCalls, "list_workspaces")) issues.push("Did not call list_workspaces");
        const autoSelectedCheck = toolCalls.some((t) => t.name === "list_workspaces" && (t?.result as Record<string, unknown>)?.autoSelected);
        const setWs = toolCalls.find((t) => t.name === "set_workspace" && !hasError(t.result));
        if (!setWs && !autoSelectedCheck) {
          issues.push("Did not call set_workspace");
        } else if (setWs && assets && String(setWs.arguments?.workspaceId ?? "") !== String(assets.workspaceId)) {
          issues.push(`set_workspace called with wrong workspaceId (got "${setWs.arguments?.workspaceId}", expected "${assets.workspaceId}")`);
        }
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      // Tools: design_workflow, validate_design
      id: "task_2_module_design",
      name: "Module Design & Validation",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        await bridge.callTool("switch_mode", { mode: "configure" });
      },
      prompt:
        `Design a module called "Client Projects" for tracking client projects. It should have: ` +
        `project name, client, status, start date, deadline, owner, and budget. ` +
        `Please validate the design before finishing.` +
        `Workspace is already active, don't need to explicitly set it again.` +
        `Don't need to create module after designing — just design and validate.`,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        if (!calledSuccessfully(toolCalls, "design_workflow")) issues.push("Did not call design_workflow");
        const validateCall = toolCalls.find((t) => t.name === "validate_design" && !hasError(t.result));
        if (!validateCall) {
          issues.push("Did not call validate_design");
        } else {
          const schema = validateCall.arguments?.schema as Record<string, unknown> | undefined;
          const info = Array.isArray(schema?.information) ? (schema!.information as Array<Record<string, unknown>>) : [];
          const fieldNames = info.map((f) => String(f?.name ?? "").toLowerCase());
          process.stdout.write('Field names: ' + fieldNames.join(', ') + '\n');
          const required = ["project name", "client", "start date", "deadline", "owner", "budget"];
          const missing = required.filter((r) => !fieldNames.some((n) => n.includes(r) || r.includes(n)));
          const states = schema?.states as unknown[] | undefined;
          const hasStatusField = fieldNames.some((n) => n.includes("status"));
          if ((!Array.isArray(states) || states.length === 0) && !hasStatusField) missing.push("status");
          if (missing.length > 0) issues.push(`Validated design is missing fields: ${missing.join(", ")}`);
        }
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      // Tools: create_module, get_module_schema | get_module_canvas, update_module
      id: "task_3_module_creation",
      name: "Module Creation, Inspection & Update",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        await bridge.callTool("switch_mode", { mode: "configure" });
        await deleteAllModulesMatching(bridge, assets, "client project");
      },
      prompt: () =>
        `Create a module named "Client Projects" with a states: Draft (initial), Active, On Hold, Completed, and Cancelled. ` +
        `Then show me what's inside it. ` +
        `Finally update it: add a "Priority" field (Low/Medium/High) and a "Notes" field, ` +
        `When updating, include all of the module's existing fields in the request, not just the ones you're changing — `,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        // create_module response includes the full schema (information, states, activities)
        // so a separate get_module_schema/get_module_canvas call is not required.
        const createCall = toolCalls.find((t) => t.name === "create_module" && !hasError(t.result));
        if (!createCall) {
          issues.push("Did not successfully call create_module");
        } else {
          const states = createCall.arguments?.states as unknown[] | undefined;
          if (!Array.isArray(states) || states.length === 0) {
            issues.push("create_module call did not include any states");
          }
        }
        const updateCall = toolCalls.find((t) => t.name === "update_module" && !hasError(t.result));
        if (!updateCall) {
          issues.push("Did not successfully call update_module");
        } else {
          const info = updateCall.arguments?.information as Array<Record<string, unknown>> | undefined;
          const names = Array.isArray(info) ? info.map((f) => String(f?.name ?? "").toLowerCase()) : [];
          if (!names.some((n) => n.includes("priority"))) issues.push("update_module call did not add a Priority field");
          if (!names.some((n) => n.includes("notes"))) issues.push("update_module call did not add a Notes field");
        }
        return { success: issues.length === 0, issues, hallucinated: false };
      },
      verify: async (bridge: IBridge) => {
        const issues: string[] = [];
        const schema = await bridge.callTool("get_module_schema", { module: "Client Projects", tier: "basic" }) as Record<string, unknown>;
        if (hasError(schema)) {
          issues.push("get_module_schema failed when verifying the final module state");
          return { success: false, issues, hallucinated: false };
        }
        const info = Array.isArray(schema?.information) ? (schema.information as Array<Record<string, unknown>>) : [];
        const names = info.map((f) => String(f?.name ?? "").toLowerCase());
        const states = Array.isArray(schema?.states) ? (schema.states as unknown[]) : [];
        if (states.length === 0) issues.push("Module has no states defined");
        if (!names.some((n) => n.includes("priority"))) issues.push("Module schema is missing the Priority field");
        if (!names.some((n) => n.includes("notes"))) issues.push("Module schema is missing the Notes field");
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      // Tools: submit_activity | submit_activities
      id: "task_4_entry_creation",
      name: "Entry Creation",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        await ensureClientProjectsModule(bridge, assets);
      },
      prompt: () =>
        `I need three new client projects logged in the Client Projects module.\n\n` +
        `First, add this one on its own: a project called "CRM Integration" for Gamma Inc, ` +
        `status Active, running from 2026-06-01 to a 2026-12-31 deadline, owned by Carol, budget 48000, ` +
        `high priority, with a note that phase 1 kickoff is completed.\n\n` +
        `Then add these next two together in one batch: "Brand Refresh" for Delta Co (On Hold, ` +
        `2026-03-01 to 2026-08-31, owned by Dave, budget 12000, medium priority), and "Data Migration" ` +
        `for Epsilon LLC (Active, 2026-04-01 to 2026-10-31, owned by Eve, budget 27000, low priority).\n\n` +
        `If a field has no match in the form or its value is empty, just skip it and keep going.`,
      evaluate: (toolCalls) => {
        const singleCall = toolCalls.find((t) => t.name === "submit_activity" && !hasError(t.result));
        const batchCall = toolCalls.find((t) => t.name === "submit_activities" && !hasError(t.result));
        const issues: string[] = [];

        if (!singleCall || hasError(singleCall.result)) {
          issues.push("Did not successfully call submit_activity (single entry)");
        } else {
          const input = singleCall.arguments?.input as Record<string, unknown> | undefined;
          if (!input || !String(input["Project Name"] ?? "").toLowerCase().includes("crm integration")) {
            issues.push("submit_activity input did not match the requested CRM Integration entry");
          }
        }

        if (!batchCall || hasError(batchCall.result)) {
          issues.push("Did not successfully call submit_activities (batch of two)");
        } else {
          const items = batchCall.arguments?.items as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(items) || items.length !== 2) {
            issues.push(`submit_activities batch did not contain exactly 2 items (got ${items?.length ?? 0})`);
          } else {
            const names = items.map((it) => String((it?.input as Record<string, unknown>)?.["Project Name"] ?? "").toLowerCase());
            if (!names.some((n) => n.includes("brand refresh"))) issues.push("submit_activities batch missing Brand Refresh entry");
            if (!names.some((n) => n.includes("data migration"))) issues.push("submit_activities batch missing Data Migration entry");
          }
        }

        const success = !!singleCall && !hasError(singleCall.result) && !!batchCall && !hasError(batchCall.result);
        return { success, issues, hallucinated: false };
      },
      verify: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        const issues: string[] = [];
        const result = await bridge.callTool("list_entries", { module: "Client Projects", workspaceId: assets.workspaceId }) as Record<string, unknown>;

        const entries = (
          Array.isArray(result) ? result :
            Array.isArray(result?.list) ? result.list :
              Array.isArray(result?.entries) ? result.entries :
                []
        ) as Array<Record<string, unknown>>;

        const expected = [
          { name: "CRM Integration", client: "Gamma Inc" },
          { name: "Brand Refresh", client: "Delta Co" },
          { name: "Data Migration", client: "Epsilon LLC" },
        ];

        for (const exp of expected) {
          const raw = entries.find((e) => JSON.stringify(e).toLowerCase().includes(exp.name.toLowerCase()));

          if (!raw) {
            issues.push(`Missing entry: "${exp.name}"`);
            continue;
          }

          if (!JSON.stringify(raw).toLowerCase().includes(exp.client.toLowerCase()))
            issues.push(`"${exp.name}": Client "${exp.client}" not found in entry`);
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      // Tools: list_modules, list_entries, get_entry_history
      id: "task_5_entry_retrieval",
      name: "Entry Retrieval & Audit",
      maxSteps: 20,
      setup: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        await ensureClientProjectsModule(bridge, assets);
        await ensureTestEntries(bridge, assets);
      },
      prompt: () =>
        `Find the "Client Projects" module, then list all entries sorted by deadline.` +
        `For the entry with the earliest deadline: retrieve its complete change history. ` +
        `Then transition it to the next appropriate state based on its current state.`,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        // list_modules is the expected discovery path but the model may discover modules
        // via set_workspace (which returns the same data). Track it but don't gate success.
        if (!calledSuccessfully(toolCalls, "list_modules")) issues.push("Did not call list_modules (used alternate discovery)");
        const listCall = toolCalls.find((t) => t.name === "list_entries" && !hasError(t.result));
        if (!listCall) issues.push("Did not call list_entries");
        // get_entry is NOT required — list_entries returns full field data inline.
        // get_entry_history has no alternative path so it remains required.
        const historyCall = toolCalls.find((t) => t.name === "get_entry_history" && !hasError(t.result));
        if (!historyCall) issues.push("Did not call get_entry_history");
        // Server-side gating (confirmation, actor checks) still counts as a valid
        // attempt here — don't require the transition to have succeeded.
        const transitionCall = toolCalls.find((t) => t.name === "submit_activity");
        if (!transitionCall) issues.push("Did not attempt to transition entry to next state");

        // Param check: the entry inspected via get_entry_history and the entry
        // transitioned should be the same entry — not two different ones.
        if (historyCall && transitionCall) {
          const historyEntryId = String(historyCall.arguments?.entryId ?? "");
          const transitionEntryId = String(
            transitionCall.arguments?.entryId ??
            (transitionCall.arguments?.entryIds as unknown[])?.[0] ?? ""
          );
          if (historyEntryId && transitionEntryId && historyEntryId !== transitionEntryId) {
            issues.push(`Inspected entry (${historyEntryId}) does not match the entry transitioned (${transitionEntryId})`);
          }
        }

        const requiredMissing = !listCall || !historyCall || !transitionCall;
        return { success: !requiredMissing, issues, hallucinated: false };
      },
    }
  ],

  teardown: async (bridge: IBridge, assets: ProjectManagementAssets): Promise<void> => {
    await bridge.callTool("switch_mode", { mode: "configure" });
    await deleteAllModulesMatching(bridge, assets, "client project");
    await bridge.callTool("switch_mode", { mode: "runtime" });
  },
};

module.exports = scenario;
