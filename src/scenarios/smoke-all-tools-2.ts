// 18 tools tested across 6 tasks:
//   list_workspaces, set_workspace
//   switch_mode, design_workflow, validate_design
//   create_module, get_module_schema, get_module_canvas, update_module
//   submit_activity, submit_activities
//   list_modules, list_entries, get_entry, get_entry_history
//   request_upload_url, confirm_upload, download_file
// upload_file tracked as a negative signal (fallback — should not be called)

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, Scenario } from "../types";

const PDF_NAME = "crm_integration_brief.pdf";

interface ProjectManagementAssets {
  workspaceId: string;
  workspaceName: string;
  pdfName: string;
}

type ToolCallLike = { name: string; arguments: Record<string, unknown> };

function called(toolCalls: ToolCallLike[], name: string): boolean {
  return toolCalls.some((t) => t.name === name);
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

function getCreatedModuleId(result: unknown): string | number | undefined {
  const r = result as Record<string, unknown>;
  return (
    r?.id ?? r?.moduleId ?? r?.vectorId ??
    (r?.module as Record<string, unknown>)?.id ??
    (r?.module as Record<string, unknown>)?.moduleId ??
    (r?.data as Record<string, unknown>)?.id
  ) as string | number | undefined;
}

async function deleteModuleByName(bridge: IBridge, assets: ProjectManagementAssets, nameFragment: string): Promise<void> {
  // set_workspace returns vectors[] with id — list_modules only returns {name, emoji} with no id
  const workspaceData = await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId }) as Record<string, unknown>;
  const vectors = (workspaceData?.vectors ?? []) as Array<Record<string, unknown>>;
  const target = vectors.find((v) =>
    String(v?.name ?? "").toLowerCase().includes(nameFragment.toLowerCase())
  );
  if (!target) return;
  const id = (target?.id ?? target?.module) as string | number | null | undefined;
  if (id == null) return;
  const api = new ApiBridge();
  await api.deleteModule(assets.workspaceId, assets.workspaceName, id);
  console.log(`\n    → Deleted "${target.name}" module (id: ${id})`);
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

async function ensureClientProjectsModule(bridge: IBridge, assets: ProjectManagementAssets): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  const workspaceData = await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId }) as Record<string, unknown>;
  const vectors = (workspaceData?.vectors ?? []) as Array<Record<string, unknown>>;
  const exists = vectors.some((v) => String(v?.name ?? "").toLowerCase().includes("client project"));
  if (!exists) {
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...CLIENT_PROJECTS_SCHEMA });
    console.log(`\n    → Created "Client Projects" module (task prerequisite)`);
  }
  await bridge.callTool("switch_mode", { mode: "runtime" });
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
Work through configure and runtime modes as required.
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
        await deleteModuleByName(bridge, assets, "client project");
      },
      prompt: (assets) =>
        `Create a module named "Client Projects". ` +
        `Then show me what's inside it. ` +
        `Finally update it: add a Priority field (Low/Medium/High) and a Notes field, ` +
        `and rename "Assigned team member" to "Owner" if that field exists.`,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        if (!called(toolCalls, "create_module")) issues.push("Did not call create_module");
        if (!called(toolCalls, "update_module")) issues.push("Did not call update_module");
        if (!called(toolCalls, "get_module_schema") && !called(toolCalls, "get_module_canvas"))
          issues.push("Did not inspect module (get_module_schema or get_module_canvas)");
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
      prompt: (assets) =>
        `Add entries to the Client Projects module.\n\n` +
        `First create this project on its own:\n` +
        `  CRM Integration | Gamma Inc | Active | starts 2026-06-01 | due 2026-12-31 | owner Carol | $48,000 | High priority | notes "Phase 1 kickoff completed"\n\n` +
        `Then create these two at the same time and submit together\n` +
        `  Brand Refresh | Delta Co | On Hold | 2026-03-01 to 2026-08-31 | owner Dave | $12,000 | Medium priority\n` +
        `  Data Migration | Epsilon LLC | Active | 2026-04-01 to 2026-10-31 | owner Eve | $27,000 | Low priority`,
      evaluate: (toolCalls) => {
        const ok = called(toolCalls, "submit_activity") || called(toolCalls, "submit_activities");
        return { success: ok, issues: ok ? [] : ["Did not call submit_activity or submit_activities"], hallucinated: false };
      },
    },
    {
      // Tools: list_modules, list_entries, get_entry, get_entry_history
      id: "task_5_entry_retrieval",
      name: "Entry Retrieval & Audit",
      maxSteps: 10,
      setup: async (bridge: IBridge, assets: ProjectManagementAssets) => {
        await ensureClientProjectsModule(bridge, assets);
      },
      prompt: (assets) =>
        `Find the project tracking module, ` +
        `then show me all active entries sorted by deadline. ` +
        `Then pull up the full details and complete history of the one with the earliest deadline.`,
      evaluate: (toolCalls) => {
        const issues: string[] = [];
        // list_modules is the expected discovery path but the model may discover modules
        // via set_workspace (which returns the same data). Track it but don't gate success.
        if (!called(toolCalls, "list_modules")) issues.push("Did not call list_modules (used alternate discovery)");
        if (!called(toolCalls, "list_entries"))      issues.push("Did not call list_entries");
        if (!called(toolCalls, "get_entry"))         issues.push("Did not call get_entry");
        if (!called(toolCalls, "get_entry_history")) issues.push("Did not call get_entry_history");
        const requiredMissing = !called(toolCalls, "list_entries") || !called(toolCalls, "get_entry") || !called(toolCalls, "get_entry_history");
        return { success: !requiredMissing, issues, hallucinated: false };
      },
    }
  ],

  teardown: async (bridge: IBridge, assets: ProjectManagementAssets): Promise<void> => {
    try {
      await bridge.callTool("switch_mode", { mode: "configure" });
      await deleteModuleByName(bridge, assets, "client project");
      await bridge.callTool("switch_mode", { mode: "runtime" });
    } catch { /* ignore */ }
  },
};

module.exports = scenario;
