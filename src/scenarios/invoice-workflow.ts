// Invoice Approval Workflow
// Tests end-to-end invoice lifecycle handling: form-schema-aware creation, state transitions, and read-only reporting.
//
// Seed data:
//   Client: Pinnacle Ventures Sdn Bhd (Net 30)
//   Invoices: task2 entry (Meridian Logistics, Draft), task3 entry (Horizon Group, Draft),
//             overdue entry (Pinnacle Ventures, Draft, back-dated Issue/Due dates)
//
// Task 1: Create invoice — agent must call get_form, then create an Invoice entry for Apex Solutions
//         with the exact figures given in prose ($15,000 / $1,200 tax / $16,200 total, Net 30)
// Task 2: Submit for approval — agent must check current state, then transition Draft → Pending Approval
//         via the "Generate Invoice" activity (not just any activity)
// Task 3: Check available actions — read-only task; agent must get_entry and report on available transitions
// Task 4: Check overdue invoices — read-only task; agent must list_entries filtered to a named client and
//         correctly report on overdue status

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, Scenario } from "../types";

// ─── Asset type ───────────────────────────────────────────────────────────────
interface InvoiceAssets {
  workspaceId: string;
  invoiceModuleId: string | number;
  clientModuleId: string | number;
  task2EntryId: string | number;
  task3EntryId: string | number;
  overdueEntryId: string | number;
  clientId: string | number;
}

// ─── Error detection ──────────────────────────────────────────────────────────
function hasError(result: unknown): boolean {
  const r = result as Record<string, unknown>;
  if (r?.error) return true;
  if (typeof r?.result === "string" && r.result.toLowerCase().includes("error")) return true;
  return false;
}

// ─── Result extraction helpers ────────────────────────────────────────────────
function firstDefined<T>(...values: (T | null | undefined)[]): T | undefined {
  return values.find((v): v is T => v !== undefined && v !== null);
}

function getCreatedModuleId(result: unknown): string | number | undefined {
  const r = result as Record<string, unknown>;
  return firstDefined(
    r?.id, r?.moduleId, r?.vectorId,
    (r?.module as Record<string, unknown>)?.id,
    (r?.module as Record<string, unknown>)?.moduleId,
    (r?.module as Record<string, unknown>)?.vectorId,
    (r?.data as Record<string, unknown>)?.id,
    (r?.data as Record<string, unknown>)?.moduleId,
    (r?.data as Record<string, unknown>)?.vectorId,
  ) as string | number | undefined;
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
  const list    = r?.list    as Array<Record<string, unknown>> | undefined;
  const candidate = firstDefined(
    r?.entryId,
    (r?.entryIds as unknown[])?.[0],
    results?.[0]?.entryId,
    results?.[0]?.id,
    list?.[0]?.entryId,
    (r?.data as Record<string, unknown>)?.entryId,
    (r?.data as Record<string, unknown> & { results?: Array<Record<string, unknown>> })?.results?.[0]?.entryId,
  );
  return isValidId(candidate) ? candidate as string | number : undefined;
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

function findModuleByName(result: unknown, name: string): Record<string, unknown> | undefined {
  const lower = name.toLowerCase();
  return getModuleList(result).find((m) =>
    String(m?.name ?? m?.module ?? m?.moduleName ?? "").toLowerCase() === lower
  );
}

// ─── Scenario ─────────────────────────────────────────────────────────────────
const scenario: Scenario<InvoiceAssets> = {
  id: "invoice_workflow",
  name: "Invoice Approval Workflow",
  description: "End-to-end invoice creation, approval routing and overdue checking",

  setup: async (_bridge: IBridge, workspaceId: string): Promise<InvoiceAssets> => {
    return { workspaceId, invoiceModuleId: 0, clientModuleId: 0, task2EntryId: 0, task3EntryId: 0, overdueEntryId: 0, clientId: 0 };
  },

  system: (assets) => `You are an invoice management AI assistant for Inistate.
Workspace ${assets.workspaceId} is already active — you do not need to pass workspaceId to any tool.
You are already authorized to make these state changes — if a tool asks you to confirm a state change, resubmit the same call with confirmed: true. Do not stop to ask a human for permission.
Use the tools to complete the given task. Be concise and efficient.`,

  tasks: [
    {
      id: "task_1",
      name: "Create Invoice",
      setup: async (bridge: IBridge, assets: InvoiceAssets): Promise<void> => {
        const workspaceId = assets.workspaceId;
        await bridge.callTool("switch_mode", { mode: "configure" });
        let existingModules = await bridge.callTool("list_modules", { workspaceId });

        // ── Client module ────────────────────────────────────────────────────────
        const clientSchema = {
          name: "Client", icon: "🏢",
          description: "Client records for invoice management",
          states: [
            { name: "Active",   color: "#1E6B45", initial: true },
            { name: "Inactive", color: "#5A6070" },
          ],
          information: [
            { name: "Client Name",   type: "Text",      ai_hint: "Full legal name of the client" },
            { name: "Email",         type: "Text",      ai_hint: "Primary contact email" },
            { name: "Payment Terms", type: "Selection", options: ["Net 15", "Net 30", "Net 60"], ai_hint: "Default payment terms for this client" },
          ],
          activities: [
            { name: "Onboard Client", actor: "human" },
            { name: "Deactivate",     actor: "human" },
          ],
          flows: [
            { activity: "Onboard Client", from: "Active", to: "Active"   },
            { activity: "Deactivate",     from: "Active", to: "Inactive" },
          ],
        };
        let clientModule = findModuleByName(existingModules, "Client");
        if (!clientModule) {
          await bridge.callTool("validate_design", { schema: clientSchema, mode: "create" });
          await bridge.callTool("create_module", { workspaceId, ...clientSchema });
          existingModules = await bridge.callTool("list_modules", { workspaceId });
          clientModule = findModuleByName(existingModules, "Client");
        }
        assets.clientModuleId = getCreatedModuleId(clientModule)!;
        console.log(`    → Client module ready (id: ${assets.clientModuleId})`);

        // ── Invoice module ───────────────────────────────────────────────────────
        const invoiceSchema = {
          name: "Invoice", icon: "🧾",
          description: "Invoice lifecycle from creation to payment or escalation",
          states: [
            { name: "Draft",            color: "#5A6070", initial: true },
            { name: "Pending Approval", color: "#A07828" },
            { name: "Sent",             color: "#2968A8" },
            { name: "Paid",             color: "#1E6B45" },
            { name: "Overdue",          color: "#C0392B" },
            { name: "Void",             color: "#5A6070" },
          ],
          information: [
            { name: "Invoice Number",  type: "Text",      ai_hint: "Auto-generated invoice number e.g. INV-2026-001" },
            { name: "Client",          type: "Text",      ai_hint: "Client name" },
            { name: "Description",     type: "MultiText", ai_hint: "Service description" },
            { name: "Billing Amount",  type: "Currency",  ai_hint: "Amount before tax and discount" },
            { name: "Tax",             type: "Currency",  ai_hint: "Tax amount (8% SST)" },
            { name: "Discount",        type: "Currency",  ai_hint: "Discount amount if applicable" },
            { name: "Total Amount",    type: "Currency",  ai_hint: "Total = Billing Amount + Tax - Discount" },
            { name: "Issue Date",      type: "Date",      ai_hint: "Invoice issue date in ISO 8601" },
            { name: "Due Date",        type: "Date",      ai_hint: "Payment due date in ISO 8601" },
            { name: "Payment Terms",   type: "Selection", options: ["Net 15", "Net 30", "Net 60"], ai_hint: "Payment terms" },
            { name: "Finance Manager", type: "Text",      ai_hint: "Finance Manager assigned for approval" },
            { name: "Notes",           type: "MultiText", ai_hint: "Additional notes" },
          ],
          activities: [
            { name: "Generate Invoice", actor: "ai",    ai_hint: "AI generates and validates invoice fields", confidence_threshold: 0.8, fields: ["Invoice Number", "Client", "Billing Amount", "Tax", "Discount", "Total Amount", "Issue Date", "Due Date", "Payment Terms", "Description", "Notes"] },
            { name: "Approve",          actor: "human" },
            { name: "Issue to Client",  actor: "human" },
            { name: "Mark as Paid",     actor: "human" },
            { name: "Mark Overdue",     actor: "ai",    confidence_threshold: 0.8 },
            { name: "Void Invoice",     actor: "human" },
          ],
          flows: [
            { activity: "Generate Invoice", from: "Draft",            to: "Pending Approval" },
            { activity: "Approve",          from: "Pending Approval", to: "Sent"             },
            { activity: "Issue to Client",  from: "Pending Approval", to: "Sent"             },
            { activity: "Mark as Paid",     from: "Sent",             to: "Paid"             },
            { activity: "Mark Overdue",     from: "Sent",             to: "Overdue"          },
            { activity: "Void Invoice",     from: "Draft",            to: "Void"             },
          ],
        };
        let invoiceModule = findModuleByName(existingModules, "Invoice");
        if (!invoiceModule) {
          await bridge.callTool("validate_design", { schema: invoiceSchema, mode: "create" });
          await bridge.callTool("create_module", { workspaceId, ...invoiceSchema });
          existingModules = await bridge.callTool("list_modules", { workspaceId });
          invoiceModule = findModuleByName(existingModules, "Invoice");
        }
        assets.invoiceModuleId = getCreatedModuleId(invoiceModule)!;
        console.log(`    → Invoice module ready (id: ${assets.invoiceModuleId})`);

        await bridge.callTool("switch_mode", { mode: "runtime" });

        const ai = { reasoning: "TestBench setup", model: "testbench", confidence: 1.0 };

        // ── Client entry ─────────────────────────────────────────────────────────
        const clientResult = await bridge.callTool("submit_activity", {
          module: "Client", activity: "create", workspaceId,
          input: { "Client Name": "Pinnacle Ventures Sdn Bhd", "Email": "meilin@pinnacleventures.com.my", "Payment Terms": "Net 30" },
          ai,
        });
        assets.clientId = getCreatedEntryId(clientResult)!;
        if (!assets.clientId) throw new Error(`Setup failed: clientId. Raw: ${JSON.stringify(clientResult)}`);

        // ── Task 2 entry ─────────────────────────────────────────────────────────
        const t2Result = await bridge.callTool("submit_activity", {
          module: "Invoice", activity: "create", workspaceId,
          input: { "Invoice Number": `BENCH-T2-${Date.now()}`, "Client": "Meridian Logistics Sdn Bhd", "Description": "Software development services Q2 2026", "Billing Amount": 20000, "Tax": 1600, "Total Amount": 21600, "Issue Date": "2026-05-28", "Due Date": "2026-06-27", "Payment Terms": "Net 30", "Finance Manager": "Jesmond Tay" },
          ai,
        });
        assets.task2EntryId = getCreatedEntryId(t2Result)!;
        if (!assets.task2EntryId) throw new Error(`Setup failed: task2EntryId. Raw: ${JSON.stringify(t2Result)}`);

        // ── Task 3 entry ─────────────────────────────────────────────────────────
        const t3Result = await bridge.callTool("submit_activity", {
          module: "Invoice", activity: "create", workspaceId,
          input: { "Invoice Number": `BENCH-T3-${Date.now()}`, "Client": "Horizon Group Sdn Bhd", "Description": "Consultancy retainer May 2026", "Billing Amount": 8000, "Tax": 640, "Total Amount": 8640, "Issue Date": "2026-05-28", "Due Date": "2026-06-27", "Payment Terms": "Net 30", "Finance Manager": "Jesmond Tay" },
          ai,
        });
        assets.task3EntryId = getCreatedEntryId(t3Result)!;
        if (!assets.task3EntryId) throw new Error(`Setup failed: task3EntryId. Raw: ${JSON.stringify(t3Result)}`);

        // ── Overdue entry ────────────────────────────────────────────────────────
        const overdueResult = await bridge.callTool("submit_activity", {
          module: "Invoice", activity: "create", workspaceId,
          input: { "Invoice Number": `BENCH-T4-${Date.now()}`, "Client": "Pinnacle Ventures Sdn Bhd", "Description": "Consulting services — TestBench setup entry", "Billing Amount": 15000, "Tax": 1200, "Total Amount": 16200, "Issue Date": "2026-04-01", "Due Date": "2026-04-30", "Payment Terms": "Net 30", "Finance Manager": "Jesmond Tay" },
          ai: { ...ai, reasoning: "TestBench setup — overdue invoice for Pinnacle Ventures" },
        });
        assets.overdueEntryId = getCreatedEntryId(overdueResult)!;
        if (!assets.overdueEntryId) throw new Error(`Setup failed: overdueEntryId. Raw: ${JSON.stringify(overdueResult)}`);

        await bridge.callTool("set_workspace", { workspaceId });
        console.log(`    → Seeded: client=${assets.clientId}, t2=${assets.task2EntryId}, t3=${assets.task3EntryId}, overdue=${assets.overdueEntryId}`);
      },
      prompt: (assets) =>
        `Create an invoice for Apex Solutions for $15,000 consulting services. Tax is 8% ($1,200). Total is $16,200. Payment terms Net 30.`,
      evaluate: (toolCalls) => {
        const isInvoiceCreate = (t: { name: string; arguments: Record<string, unknown> }) =>
          (t.name === "submit_activity" || t.name === "submit_activities") &&
          t.arguments?.["module"] === "Invoice" &&
          (!t.arguments?.["activity"] || t.arguments?.["activity"] === "create");
        const invoiceCreateCalls = toolCalls.filter(isInvoiceCreate);
        const successfulInvoiceCreateCalls = invoiceCreateCalls.filter((toolCall) =>
          !hasError(toolCall.result)
        );
        const created = successfulInvoiceCreateCalls.length > 0;
        const calledGetForm  = toolCalls.some((t) => t.name === "get_form");
        const correctCreateCall = successfulInvoiceCreateCalls.find((toolCall) => {
          const raw = JSON.stringify(toolCall.arguments).toLowerCase();
          return raw.includes("15000") &&
            raw.includes("1200") &&
            raw.includes("16200") &&
            raw.includes("apex solutions");
        });
        const correctAmount = successfulInvoiceCreateCalls.some((t) => {
          const raw = JSON.stringify(t.arguments);
          return raw.includes("15000") && raw.includes("1200") && raw.includes("16200");
        });
        const correctClient = successfulInvoiceCreateCalls.some((t) =>
          JSON.stringify(t.arguments).toLowerCase().includes("apex solutions")
        );
        const issues: string[] = [];
        if (!calledGetForm) issues.push("Layer 1: did not call get_form before submit");
        if (!created) issues.push("Layer 1: did not create invoice entry");
        if (!correctAmount) issues.push(`Layer 2: billing amount, tax or total incorrect; captured=${JSON.stringify(invoiceCreateCalls.map((t) => t.arguments?.["input"] ?? t.arguments?.["items"])).slice(0, 500)}`);
        if (!correctClient) issues.push("Layer 2: client 'Apex Solutions' not found in submitted arguments");
        if (created && !correctCreateCall) {
          issues.push("Layer 2: no single successful create call contains the correct client and all requested amounts");
        }
        return {
          success: issues.length === 0,
          issues,
          hallucinated: created && !correctCreateCall,
        };
      },
      verify: async (bridge: IBridge) => {
        const issues: string[] = [];
        const results = await bridge.callTool("list_entries", { module: "Invoice" }) as Record<string, unknown>;
        if (hasError(results)) {
          issues.push("Layer 3: list_entries failed when verifying the final module state");
          return { success: false, issues, hallucinated: false };
        }
        const entries = (
          Array.isArray(results) ? results :
          Array.isArray(results?.list) ? results.list :
          Array.isArray(results?.entries) ? results.entries :
          []
        ) as Array<Record<string, unknown>>;

        const expected = [
          { client: "Apex Solutions", price: 15000, tax: 1200, total: 16200, terms: "Net 30" },
        ];

        for (const exp of expected) {
          const raw = entries.find((e) => JSON.stringify(e).toLowerCase().includes(exp.client.toLowerCase()));

          if (!raw) {
            issues.push(`Layer 3: missing entry: "${exp.client}"`);
            continue;
          }
          
          if (!JSON.stringify(raw).toLowerCase().includes(exp.client.toLowerCase()))
            issues.push(`Layer 3: "${exp.client}": client "${exp.client}" not found in entry`);
          const serializedEntry = JSON.stringify(raw).toLowerCase();
          if (!serializedEntry.includes(String(exp.price)))
            issues.push(`Layer 3: "${exp.client}": Billing Amount ${exp.price} not found in entry`);
          if (!serializedEntry.includes(String(exp.tax)))
            issues.push(`Layer 3: "${exp.client}": Tax ${exp.tax} not found in entry`);
          if (!serializedEntry.includes(String(exp.total)))
            issues.push(`Layer 3: "${exp.client}": Total Amount ${exp.total} not found in entry`);
          if (!JSON.stringify(raw).toLowerCase().includes(exp.terms.toLowerCase()))
            issues.push(`Layer 3: "${exp.client}": Payment Terms "${exp.terms}" not found in entry`);
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      id: "task_2",
      name: "Submit for Approval",
      prompt: () =>
        `Submit the Meridian Logistics Sdn Bhd invoice for Finance Manager approval. The invoice amount exceeds the $10,000 threshold.`,
      evaluate: (toolCalls) => {
        const checkedEntry = toolCalls.some((t) => t.name === "get_entry");
        const isSubmitted = toolCalls.some(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            t.arguments?.["module"] === "Invoice" &&
            !hasError(t.result)
        );
        const usedCorrectActivity = toolCalls.some(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            t.arguments?.["activity"] === "Generate Invoice" &&
            !hasError(t.result)
        );
        const issues: string[] = [];
        if (!checkedEntry) issues.push("Layer 1: did not call get_entry to check current state");
        if (!isSubmitted) issues.push("Layer 1: did not successfully submit an activity on the Invoice");
        if (isSubmitted && !usedCorrectActivity) issues.push("Layer 2: did not use 'Generate Invoice' activity (Draft → Pending Approval)");
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      id: "task_3",
      name: "Check Available Actions",
      prompt: () =>
        `Check what actions are currently available for the Horizon Group Sdn Bhd invoice.`,
      evaluate: (toolCalls, response) => {
        const calledGetEntry             = toolCalls.some((t) => t.name === "get_entry");
        const responseMentionsActivities = ["available", "activity", "transition", "action"].some((w) => response.toLowerCase().includes(w));
        const issues: string[] = [];
        if (!calledGetEntry) issues.push("Layer 1: did not call get_entry");
        if (!responseMentionsActivities) issues.push("Layer 2: response did not mention available activities");
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
    {
      id: "task_4",
      name: "Check Overdue Invoices",
      prompt: () =>
        `Check if there are any overdue invoice
      s for Pinnacle Ventures Sdn Bhd.`,
      evaluate: (toolCalls, response) => {
        const calledListEntries  = toolCalls.some((t) => t.name === "list_entries");
        const filteredByClient   = toolCalls.some((t) => t.name === "list_entries" && JSON.stringify(t.arguments).toLowerCase().includes("pinnacle"));
        const text = response.toLowerCase();
        const mentionsOverdue = text.includes("overdue") || text.includes("past due") || text.includes("late");
        // const negated = /\b(no|none|not|zero|0|isn't|aren't|doesn't|don't|didn't)\b[^.]{0,30}overdue/.test(text)
            //  || /overdue[^.]{0,30}\b(none|not found|0)\b/.test(text);
        // const correctlyIdentified = (mentionsOverdue && !negated) || (!mentionsOverdue && negated);
        const issues: string[] = [];
        if (!calledListEntries) issues.push("Layer 1: did not call list_entries");
        if (calledListEntries && !filteredByClient) issues.push("Layer 2: did not filter by Pinnacle Ventures");
        if (!mentionsOverdue) issues.push("Layer 2: response did not identify the overdue Pinnacle Ventures invoice");
        return {
          success: issues.length === 0,
          issues,
          hallucinated: mentionsOverdue && !(calledListEntries && filteredByClient),
        };
      },
      verify: async (bridge: IBridge, assets: InvoiceAssets): Promise<{ success: boolean; issues: string[]; hallucinated: boolean }> => {
        const ai = { reasoning: "TestBench teardown", model: "testbench", confidence: 1.0 };
        const entriesToDelete = [
          assets.task2EntryId   && { module: "Invoice", entryId: assets.task2EntryId },
          assets.task3EntryId   && { module: "Invoice", entryId: assets.task3EntryId },
          assets.overdueEntryId && { module: "Invoice", entryId: assets.overdueEntryId },
          assets.clientId       && { module: "Client",  entryId: assets.clientId },
        ].filter((x): x is { module: string; entryId: string | number } => Boolean(x));

        for (const { module, entryId } of entriesToDelete) {
          try {
            await bridge.callTool("submit_activity", {
              module, activity: "delete", entryId, workspaceId: assets.workspaceId, confirmed: true, ai,
            });
          } catch { /* ignore */ }
        }

        // Also delete any agent-created Invoice entries (task 1 creates one)
        const allInvoices = await bridge.callTool("list_entries", { module: "Invoice" }) as Record<string, unknown>;
        const list = (Array.isArray(allInvoices?.list) ? allInvoices.list : Array.isArray(allInvoices) ? allInvoices : []) as Array<Record<string, unknown>>;
        for (const entry of list) {
          const id = entry?.entryId ?? entry?.id;
          if (!id) continue;
          try {
            await bridge.callTool("submit_activity", {
              module: "Invoice", activity: "delete", entryId: id,
              workspaceId: assets.workspaceId, confirmed: true, ai,
            });
          } catch { /* ignore */ }
        }

        const modulesToDelete = [assets.invoiceModuleId, assets.clientModuleId].filter(Boolean);
        if (modulesToDelete.length > 0) {
          const api = new ApiBridge();
          for (const moduleId of modulesToDelete) {
            try { await api.deleteModule(assets.workspaceId, null, moduleId); } catch { /* ignore */ }
          }
        }

        return { success: true, issues: [], hallucinated: false };
      },
    },
  ],

  teardown: async (): Promise<void> => { /* cleanup handled in task_4 verify */ },
};

module.exports = scenario;
