// All-Tools Smoke Test (Full)
// Exercises every MCP tool exactly once across configure and runtime modes (21 tasks).

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, Scenario } from "../types";

// ─── Asset type ───────────────────────────────────────────────────────────────
interface SmokeAssets {
  workspaceId: string;
  workspaceName: string;
}

// ─── Result extraction helpers ────────────────────────────────────────────────
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

// ─── Evaluation helpers ───────────────────────────────────────────────────────
type ToolCallLike = { name: string; arguments: Record<string, unknown> };

function called(toolCalls: ToolCallLike[], name: string): boolean {
  return toolCalls.some((t) => t.name === name);
}

function calledWith(toolCalls: ToolCallLike[], name: string, argCheck: (a: Record<string, unknown>) => boolean): boolean {
  return toolCalls.some((t) => t.name === name && argCheck(t.arguments ?? {}));
}

function mentionsAny(response: string, ...words: string[]): boolean {
  const lower = response.toLowerCase();
  return words.some((w) => lower.includes(w));
}

// ─── Scenario ─────────────────────────────────────────────────────────────────
const scenario: Scenario<SmokeAssets> = {
  id: "smoke_all_tools",
  name: "All-Tools Smoke Test",
  description: "Exercises every MCP tool exactly once across configure and runtime modes",

  setup: async (bridge: IBridge, workspaceId: string): Promise<SmokeAssets> => {
    console.log("    → Resolving workspace name...");
    const workspacesResult = await bridge.callTool("list_workspaces", {});
    const workspaceList = [
      ...getModuleList(workspacesResult),
      ...(Array.isArray(workspacesResult) ? (workspacesResult as Array<Record<string, unknown>>) : []),
      ...((workspacesResult as Record<string, unknown>)?.workspaces as Array<Record<string, unknown>> ?? []),
    ];
    const workspace = workspaceList.find(
      (w) => String(w?.id ?? w?.workspaceId ?? "") === String(workspaceId)
    );
    const workspaceName = String(workspace?.name ?? workspace?.workspaceName ?? "Inistate");
    console.log(`    → Workspace: ${workspaceName}`);
    return { workspaceId, workspaceName };
  },

  system: "You are an AI assistant for Inistate. You are already authorized to make these state changes — if a tool asks you to confirm a state change, resubmit the same call with confirmed: true. Do not stop to ask a human for permission. Use the available tools to complete each task. Be concise and efficient.",

  tasks: [
    {
      id: "task_01_list_workspaces", name: "list_workspaces",
      prompt: "What workspaces are there?",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "list_workspaces");
        return { success: ok, issues: ok ? [] : ["Did not call list_workspaces"], hallucinated: !ok && mentionsAny(response, "workspace") };
      },
    },
    {
      id: "task_02_set_workspace", name: "set_workspace",
      prompt: (assets) => `Use the ${assets.workspaceName} workspace.`,
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "set_workspace");
        return { success: ok, issues: ok ? [] : ["Did not call set_workspace"], hallucinated: !ok && mentionsAny(response, "set", "active", "switched") };
      },
    },
    {
      id: "task_03_switch_mode_configure", name: "switch_mode (configure)",
      prompt: "Switch to configure mode.",
      evaluate: (toolCalls, response) => {
        const ok = calledWith(toolCalls, "switch_mode", (a) => a["mode"] === "configure");
        return { success: ok, issues: ok ? [] : ["Did not call switch_mode with mode=configure"], hallucinated: !ok && mentionsAny(response, "configure", "switched") };
      },
    },
    {
      id: "task_04_design_workflow", name: "design_workflow",
      prompt: "Design a Support Ticket approval workflow.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "design_workflow");
        return { success: ok, issues: ok ? [] : ["Did not call design_workflow"], hallucinated: !ok && mentionsAny(response, "template", "state", "activit", "workflow") };
      },
    },
    {
      id: "task_05_validate_design", name: "validate_design",
      prompt: `Is this schema valid? ${JSON.stringify({ name: "Validate Me", information: [{ name: "Title", type: "Text" }], states: [{ name: "Open", color: "#5A6070", initial: true }, { name: "Closed", color: "#1E6B45" }], activities: [{ name: "Close", actor: "human", fields: ["Title"] }], flows: [{ from: "Open", to: "Closed", activity: "Close" }] })}`,
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "validate_design");
        return { success: ok, issues: ok ? [] : ["Did not call validate_design"], hallucinated: !ok && mentionsAny(response, "valid", "error", "schema") };
      },
    },
    {
      id: "task_06_create_module", name: "create_module",
      prompt: (assets) => `Create a module called SmokeTemp in the ${assets.workspaceName} workspace — Title text field, File files field, Open and Closed states, a Close activity, and a flow from Open to Closed.`,
      evaluate: (toolCalls, response) => {
        const ok = calledWith(toolCalls, "create_module", (a) => String(a["name"] ?? "").toLowerCase().includes("smoketemp"));
        const wrongName = called(toolCalls, "create_module") && !ok;
        const issues: string[] = [];
        if (!called(toolCalls, "create_module")) issues.push("Did not call create_module");
        else if (wrongName) issues.push("create_module called but name did not include 'SmokeTemp'");
        return { success: ok, issues, hallucinated: !called(toolCalls, "create_module") && mentionsAny(response, "created", "module") };
      },
    },
    {
      id: "task_07_get_module_schema", name: "get_module_schema",
      prompt: "What fields and states does SmokeTemp have?",
      evaluate: (toolCalls, response) => {
        const ok = calledWith(toolCalls, "get_module_schema", (a) => String(a["module"] ?? "").toLowerCase().includes("smoketemp"));
        const issues: string[] = [];
        if (!called(toolCalls, "get_module_schema")) issues.push("Did not call get_module_schema");
        else if (!ok) issues.push("Called get_module_schema but for wrong module");
        return { success: ok, issues, hallucinated: !called(toolCalls, "get_module_schema") && mentionsAny(response, "title", "open", "closed", "field") };
      },
    },
    {
      id: "task_08_get_module_canvas", name: "get_module_canvas",
      prompt: "Get the complete SmokeTemp definition.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "get_module_canvas");
        const usedSchema = !ok && called(toolCalls, "get_module_schema");
        const issues: string[] = [];
        if (!ok) issues.push(usedSchema ? "Called get_module_schema instead of get_module_canvas" : "Did not call get_module_canvas");
        return { success: ok, issues, hallucinated: !ok && !usedSchema && mentionsAny(response, "id", "canvas", "definition") };
      },
    },
    {
      id: "task_09_update_module", name: "update_module",
      prompt: "Add a Priority field (Low, Medium, High) to SmokeTemp.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "update_module");
        return { success: ok, issues: ok ? [] : ["Did not call update_module"], hallucinated: !ok && mentionsAny(response, "added", "priority", "updated") };
      },
    },
    {
      id: "task_10_switch_mode_runtime", name: "switch_mode (runtime)",
      prompt: "Switch back to runtime mode.",
      evaluate: (toolCalls, response) => {
        const ok = calledWith(toolCalls, "switch_mode", (a) => a["mode"] === "runtime");
        return { success: ok, issues: ok ? [] : ["Did not call switch_mode with mode=runtime"], hallucinated: !ok && mentionsAny(response, "runtime", "switched") };
      },
    },
    {
      id: "task_11_list_modules", name: "list_modules",
      prompt: (assets) => `What modules are in the ${assets.workspaceName} workspace?`,
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "list_modules");
        return { success: ok, issues: ok ? [] : ["Did not call list_modules"], hallucinated: !ok && mentionsAny(response, "module", "smoketemp", "invoice") };
      },
    },
    {
      id: "task_12_get_form", name: "get_form",
      prompt: "What do I need to fill in to create a SmokeTemp entry?",
      evaluate: (toolCalls, response) => {
        const ok = calledWith(toolCalls, "get_form", (a) => String(a["module"] ?? "").toLowerCase().includes("smoketemp"));
        const issues: string[] = [];
        if (!called(toolCalls, "get_form")) issues.push("Did not call get_form");
        else if (!ok) issues.push("Called get_form but for wrong module");
        return { success: ok, issues, hallucinated: !called(toolCalls, "get_form") && mentionsAny(response, "title", "field", "fill", "required") };
      },
    },
    {
      id: "task_13_submit_activity", name: "submit_activity",
      prompt: "Create a SmokeTemp entry — Title: 'Smoke Test Entry'.",
      evaluate: (toolCalls, response) => {
        const ok = calledWith(toolCalls, "submit_activity", (a) => String(a["module"] ?? "").toLowerCase().includes("smoketemp"));
        const issues: string[] = [];
        if (!called(toolCalls, "submit_activity")) issues.push("Did not call submit_activity");
        else if (!ok) issues.push("Called submit_activity but for wrong module");
        return { success: ok, issues, hallucinated: !called(toolCalls, "submit_activity") && mentionsAny(response, "created", "entry") };
      },
    },
    {
      id: "task_14_list_entries", name: "list_entries",
      prompt: "What's in SmokeTemp?",
      evaluate: (toolCalls, response) => {
        const ok = calledWith(toolCalls, "list_entries", (a) => String(a["module"] ?? "").toLowerCase().includes("smoketemp"));
        const issues: string[] = [];
        if (!called(toolCalls, "list_entries")) issues.push("Did not call list_entries");
        else if (!ok) issues.push("Called list_entries but for wrong module");
        return { success: ok, issues, hallucinated: !called(toolCalls, "list_entries") && mentionsAny(response, "entry", "entries") };
      },
    },
    {
      id: "task_15_get_entry", name: "get_entry",
      prompt: "Show me the entry SMK00001 in SmokeTemp.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "get_entry");
        return { success: ok, issues: ok ? [] : ["Did not call get_entry"], hallucinated: !ok && mentionsAny(response, "title", "open", "smoke test entry") };
      },
    },
    {
      id: "task_16_submit_activities", name: "submit_activities",
      prompt: "Create two SmokeTemp entries: Title 'Bulk A' and Title 'Bulk B'.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "submit_activities");
        const usedSingle = !ok && toolCalls.filter((t) => t.name === "submit_activity").length >= 2;
        const issues: string[] = [];
        if (!ok) issues.push(usedSingle ? "Used submit_activity twice instead of submit_activities" : "Did not call submit_activities");
        return { success: ok, issues, hallucinated: !ok && !usedSingle && mentionsAny(response, "created", "bulk a", "bulk b") };
      },
    },
    {
      id: "task_17_get_entry_history", name: "get_entry_history",
      prompt: "What's the history of entry SMK00001 in SmokeTemp?",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "get_entry_history");
        return { success: ok, issues: ok ? [] : ["Did not call get_entry_history"], hallucinated: !ok && mentionsAny(response, "history", "created", "audit") };
      },
    },
    {
      id: "task_18_request_upload_url", name: "request_upload_url",
      prompt: "Upload a file called smoke-test.pdf to SmokeTemp.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "request_upload_url");
        const usedFallback = !ok && called(toolCalls, "upload_file");
        const issues: string[] = [];
        if (!ok) issues.push(usedFallback ? "Used upload_file (fallback) instead of request_upload_url" : "Did not call request_upload_url");
        return { success: ok, issues, hallucinated: !ok && !usedFallback && mentionsAny(response, "upload", "url", "presigned") };
      },
    },
    {
      id: "task_19_confirm_upload", name: "confirm_upload",
      prompt: "Confirm a pending file upload to SmokeTemp.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "confirm_upload");
        return { success: ok, issues: ok ? [] : ["Did not call confirm_upload"], hallucinated: !ok && mentionsAny(response, "confirmed", "upload") };
      },
    },
    {
      id: "task_20_upload_file", name: "upload_file",
      prompt: "The presigned upload isn't working. Upload smoke.txt to SmokeTemp directly — content: 'c21va2U=' (base64), type: text/plain.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "upload_file");
        return { success: ok, issues: ok ? [] : ["Did not call upload_file"], hallucinated: !ok && mentionsAny(response, "uploaded", "file") };
      },
    },
    {
      id: "task_21_download_file", name: "download_file",
      prompt: "Download a file from SmokeTemp.",
      evaluate: (toolCalls, response) => {
        const ok = called(toolCalls, "download_file");
        return { success: ok, issues: ok ? [] : ["Did not call download_file"], hallucinated: !ok && mentionsAny(response, "download", "url", "link") };
      },
    },
  ],

  teardown: async (bridge: IBridge, assets: SmokeAssets): Promise<void> => {
    try {
      await bridge.callTool("switch_mode", { mode: "configure" });

      const modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
      const smokeTemp = getModuleList(modules).find((m) =>
        String(m?.name ?? m?.module ?? m?.moduleName ?? "").toLowerCase().includes("smoketemp")
      );
      if (smokeTemp) {
        const id = getCreatedModuleId(smokeTemp);
        if (id !== undefined) {
          const api = new ApiBridge();
          await api.deleteModule(assets.workspaceId, assets.workspaceName, id);
        }
      }

      await bridge.callTool("switch_mode", { mode: "runtime" });
    } catch { /* ignore */ }
  },
};

module.exports = scenario;
