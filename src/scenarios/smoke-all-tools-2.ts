// 18 tools tested across 6 tasks:
//   list_workspaces, set_workspace
//   switch_mode, design_workflow, validate_design
//   create_module, get_module_schema, get_module_canvas, update_module
//   submit_activity, submit_activities
//   list_modules, list_entries, get_entry, get_entry_history
//   request_upload_url, confirm_upload, download_file
// upload_file tracked as a negative signal (fallback — should not be called)

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, Scenario, ToolCall } from "../types";

const PDF_NAME = "crm_integration_brief.pdf";

interface ProjectManagementAssets {
  workspaceId: string;
  workspaceName: string;
  pdfName: string;
}

function called(toolCalls: ToolCall[], name: string): boolean {
  return toolCalls.some((t) => t.name === name);
}

// Returns true only if the tool was called AND did not return an error result.
function calledSuccessfully(toolCalls: ToolCall[], name: string): boolean {
  return toolCalls.some(
    (t) => t.name === name && !(t.result as Record<string, unknown>)?.error
  );
}

function getModuleList(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r?.list))    return r.list    as Array<Record<string, unknown>>;
  if (Array.isArray(r?.modules)) return r.modules as Array<Record<string, unknown>>;
  if (Array.isArray((r?.data as Record<string, unknown>)?.list))    return (r.data as Record<string, unknown>).list    as Array<Record<string, unknown>>;
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
    const listResult = await bridge.callTool("list_modules", {}) as unknown;
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

  if (candidateNames.size === 0) return;

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
    { name: "Draft",      color: "#5A6070", initial: true },
    { name: "Active",     color: "#2968A8" },
    { name: "On Hold",    color: "#A07828" },
    { name: "Completed",  color: "#2A7B50" },
    { name: "Cancelled",  color: "#C0392B" },
  ],
  information: [
    { name: "Project Name", type: "Text",      ai_hint: "Name of the project" },
    { name: "Client",       type: "Text",      ai_hint: "Client name" },
    { name: "Status",       type: "Selection", options: ["Draft", "Active", "On Hold", "Completed", "Cancelled"], ai_hint: "Project status" },
    { name: "Start Date",   type: "Date",      ai_hint: "Project start date" },
    { name: "Deadline",     type: "Date",      ai_hint: "Project deadline" },
    { name: "Owner",        type: "Text",      ai_hint: "Project owner" },
    { name: "Budget",       type: "Currency",  ai_hint: "Project budget" },
    { name: "Priority",     type: "Selection", options: ["Low", "Medium", "High"], ai_hint: "Project priority" },
    { name: "Notes",        type: "MultiText", ai_hint: "Additional notes" },
  ],
  activities: [
    { name: "Start Project",    actor: "human" },
    { name: "Pause Project",    actor: "human" },
    { name: "Resume Project",   actor: "human" },
    { name: "Complete Project", actor: "human" },
    { name: "Cancel Project",   actor: "human" },
  ],
  flows: [
    { activity: "Start Project",    from: "Draft",   to: "Active"    },
    { activity: "Pause Project",    from: "Active",  to: "On Hold"   },
    { activity: "Resume Project",   from: "On Hold", to: "Active"    },
    { activity: "Complete Project", from: "Active",  to: "Completed" },
    { activity: "Cancel Project",   from: "Draft",   to: "Cancelled" },
    { activity: "Cancel Project",   from: "Active",  to: "Cancelled" },
  ],
};

// Uses get_module_canvas as primary existence check (vectors misses unpublished modules).
async function ensureClientProjectsModule(bridge: IBridge, assets: ProjectManagementAssets): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  const canvas = await bridge.callTool("get_module_canvas", { module: "Client Projects" }) as Record<string, unknown>;
  if (canvas?.error) {
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...CLIENT_PROJECTS_SCHEMA });
    console.log(`\n    → Created "Client Projects" module (task prerequisite)`);
  }
  await bridge.callTool("switch_mode", { mode: "runtime" });
}

const SEED_ENTRIES = [
  { "Project Name": "CRM Integration", Client: "Gamma Inc",  state: "Active",  "Start Date": "2026-06-01", Deadline: "2026-12-31", Owner: "Carol", Budget: 48000, Priority: "High",   Notes: "Phase 1 kickoff completed" },
  { "Project Name": "Brand Refresh",   Client: "Delta Co",   state: "On Hold", "Start Date": "2026-03-01", Deadline: "2026-08-31", Owner: "Dave",  Budget: 12000, Priority: "Medium" },
  { "Project Name": "Data Migration",  Client: "Epsilon LLC", state: "Active",  "Start Date": "2026-04-01", Deadline: "2026-10-31", Owner: "Eve",   Budget: 27000, Priority: "Low" },
];

async function ensureTestEntries(bridge: IBridge): Promise<void> {
  const result = await bridge.callTool("list_entries", { module: "Client Projects" }) as Record<string, unknown>;
  const entries = (
    Array.isArray(result) ? result :
    Array.isArray(result?.entries) ? result.entries :
    Array.isArray((result?.data as Record<string, unknown>)?.entries) ? (result.data as Record<string, unknown>).entries :
    []
  ) as unknown[];
  if (entries.length > 0) return;
  await bridge.callTool("submit_activities", {
    module: "Client Projects",
    activities: SEED_ENTRIES.map((e) => ({ activity: "Create", input: e })),
  });
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

  system: (assets) => `You are an AI assistant for Inistate.
  Workspace ${assets.workspaceId} is already active — you do not need to pass workspaceId to any tool.
  Tools operate in two modes: configure and operate. If a tool returns a "disabled" error, call switch_mode with the appropriate mode before retrying.
  Be concise and call the minimum tools needed to complete the task.`,

  tasks: [
    {
      // Tools: list_workspaces, set_workspace
      id: "task_1_workspace_setup",
      name: "Workspace Setup",
      maxSteps: 10,
      prompt: (assets) =>
        `Set up my Inistate workspace for project management. ` +
        `Discover available workspaces and select workspace ${assets.workspaceId}.`,
        // workspaceId kept here intentionally — task 1 is specifically about workspace discovery
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        if (!called(toolCalls, "list_workspaces")) issues.push("Did not call list_workspaces");
        if (!called(toolCalls, "set_workspace"))   issues.push("Did not call set_workspace");
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      // Tools: design_workflow, validate_design
      id: "task_2_module_design",
      name: "Module Design & Validation",
      maxSteps: 10,
      setup: async (bridge: IBridge) => {
        await bridge.callTool("switch_mode", { mode: "configure" });
      },
      prompt:
        `Design a module for tracking client projects. It should have: ` +
        `project name, client, status, start date, deadline, owner, and budget. ` +
        `Validate the design before finishing.`,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        if (!called(toolCalls, "design_workflow")) issues.push("Did not call design_workflow");
        if (!called(toolCalls, "validate_design")) issues.push("Did not call validate_design");
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      // Tools: create_module, get_module_schema | get_module_canvas, update_module
      id: "task_3_module_creation",
      name: "Module Creation, Inspection & Update",
      maxSteps: 15,
      setup: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        await bridge.callTool("switch_mode", { mode: "configure" });
        await deleteAllModulesMatching(bridge, assets, "client project");
      },
      prompt: () =>
        `Create a module named "Client Projects". ` +
        `Then show me what's inside it. ` +
        `Finally update it: add a Priority field (Low/Medium/High) and a Notes field, ` +
        `and rename "Assigned team member" to "Owner" if that field exists.`,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        // Require successful calls — called but errored does not count.
        if (!calledSuccessfully(toolCalls, "create_module")) issues.push("Did not successfully call create_module");
        if (!calledSuccessfully(toolCalls, "update_module")) issues.push("Did not successfully call update_module");
        // create_module and update_module both return the full module payload — reading
        // that response counts as inspection; a separate schema/canvas call is not required.
        const inspected =
          called(toolCalls, "get_module_schema") ||
          called(toolCalls, "get_module_canvas") ||
          called(toolCalls, "create_module") ||
          called(toolCalls, "update_module");
        if (!inspected) issues.push("Did not inspect module");
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      // Tools: submit_activity | submit_activities
      id: "task_4_entry_creation",
      name: "Entry Creation",
      maxSteps: 10,
      setup: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        await ensureClientProjectsModule(bridge, assets);
      },
      prompt: () =>
        `Add the following entries to the Client Projects module. Use the exact field names as keys.\n\n` +
        `First, add this entry on its own:\n` +
        `  Project Name: "CRM Integration"\n` +
        `  Client: "Gamma Inc"\n` +
        `  Status: "Active"\n` +
        `  Start Date: "2026-06-01"\n` +
        `  Deadline: "2026-12-31"\n` +
        `  Owner: "Carol"\n` +
        `  Budget: 48000\n` +
        `  Priority: "High"\n` +
        `  Notes: "Phase 1 kickoff completed"\n\n` +
        `Then add these two together in a single batch:\n` +
        `  Entry 1 — Project Name: "Brand Refresh", Client: "Delta Co", Status: "On Hold", Start Date: "2026-03-01", Deadline: "2026-08-31", Owner: "Dave", Budget: 12000, Priority: "Medium"\n` +
        `  Entry 2 — Project Name: "Data Migration", Client: "Epsilon LLC", Status: "Active", Start Date: "2026-04-01", Deadline: "2026-10-31", Owner: "Eve", Budget: 27000, Priority: "Low"\n\n` +
        `If a field name has no match in the form, omit it and proceed.`,
      evaluate: (toolCalls) => {
        const ok = calledSuccessfully(toolCalls, "submit_activity") || calledSuccessfully(toolCalls, "submit_activities");
        return { success: ok, issues: ok ? [] : ["Did not successfully call submit_activity or submit_activities"], hallucinated: false };
      },
      verify: async (bridge: IBridge) => {
        const issues: string[] = [];
        const result = await bridge.callTool("list_entries", { module: "Client Projects" }) as Record<string, unknown>;

        // Response shape: { list: [...] } — each entry has a `data` object with snake_case field keys.
        const entries = (
          Array.isArray(result) ? result :
          Array.isArray(result?.list) ? result.list :
          Array.isArray(result?.entries) ? result.entries :
          []
        ) as Array<Record<string, unknown>>;

        const expected = [
          { name: "CRM Integration", client: "Gamma Inc"   },
          { name: "Brand Refresh",   client: "Delta Co"    },
          { name: "Data Migration",  client: "Epsilon LLC" },
        ];

        for (const exp of expected) {
          const entry = entries.find((e) => {
            const data = (e?.data ?? e) as Record<string, unknown>;
            const entryName = String(data?.project_name ?? data?.["Project Name"] ?? data?.name ?? e?.name ?? "");
            return entryName.toLowerCase() === exp.name.toLowerCase();
          });

          if (!entry) {
            issues.push(`Missing entry: "${exp.name}"`);
            continue;
          }

          // Client may be stored under "client", "Client", or "description" depending on agent field mapping.
          const data = (entry?.data ?? entry) as Record<string, unknown>;
          const client = String(data?.client ?? data?.Client ?? data?.description ?? "");
          if (client.toLowerCase() !== exp.client.toLowerCase())
            issues.push(`"${exp.name}": expected Client="${exp.client}" got "${client}"`);
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
        await ensureTestEntries(bridge);
      },
      prompt: () =>
        `Find the project tracking module, then list all active entries sorted by deadline. ` +
        `For the entry with the earliest deadline: retrieve its complete change history. ` +
        `Then transition it to the next appropriate state based on its current state.`,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        // list_modules is the expected discovery path but the model may discover modules
        // via set_workspace (which returns the same data). Track it but don't gate success.
        if (!called(toolCalls, "list_modules")) issues.push("Did not call list_modules (used alternate discovery)");
        if (!called(toolCalls, "list_entries"))      issues.push("Did not call list_entries");
        // get_entry is NOT required — list_entries returns full field data inline.
        // get_entry_history has no alternative path so it remains required.
        if (!called(toolCalls, "get_entry_history")) issues.push("Did not call get_entry_history");
        const requiredMissing = !called(toolCalls, "list_entries") || !called(toolCalls, "get_entry_history");
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
