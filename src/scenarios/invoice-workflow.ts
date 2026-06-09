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

  setup: async (bridge: IBridge, workspaceId: string): Promise<InvoiceAssets> => {
    console.log("    → Switching to configure mode...");
    await bridge.callTool("switch_mode", { mode: "configure" });
    let existingModules = await bridge.callTool("list_modules", { workspaceId });

    // ── Client module ──────────────────────────────────────────────────────────
    console.log("    → Checking Client module...");
    const clientSchema = {
      name: "Client", icon: "🏢",
      description: "Client records for invoice management",
      states: [
        { name: "Active",   color: "#1E6B45", initial: true },
        { name: "Inactive", color: "#5A6070" },
      ],
      information: [
        { name: "Client Name",    type: "Text",      ai_hint: "Full legal name of the client" },
        { name: "Email",          type: "Text",      ai_hint: "Primary contact email" },
        { name: "Payment Terms",  type: "Selection", options: ["Net 15", "Net 30", "Net 60"], ai_hint: "Default payment terms for this client" },
      ],
      activities: [
        { name: "Onboard Client", actor: "human" },
        { name: "Deactivate",     actor: "human" },
      ],
      flows: [
        { activity: "Onboard Client", from: "Active",   to: "Active"   },
        { activity: "Deactivate",      from: "Active",   to: "Inactive" },
      ],
    };

    let clientModule = findModuleByName(existingModules, "Client");
    if (clientModule) {
      console.log("    → Client module already exists");
    } else {
      await bridge.callTool("validate_design", { schema: clientSchema, mode: "create" });
      await bridge.callTool("create_module", { workspaceId: workspaceId, ...clientSchema });
      existingModules = await bridge.callTool("list_modules", { workspaceId: workspaceId });
      clientModule = findModuleByName(existingModules, "Client");
    }
    const clientModuleId = getCreatedModuleId(clientModule)!;
    console.log(`    → Client module ready (id: ${clientModuleId})`);

    // ── Invoice module ─────────────────────────────────────────────────────────
    console.log("    → Checking Invoice module...");
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
    if (invoiceModule) {
      console.log("    → Invoice module already exists");
    } else {
      await bridge.callTool("validate_design", { schema: invoiceSchema, mode: "create" });
      await bridge.callTool("create_module", { workspaceId: workspaceId, ...invoiceSchema });
      existingModules = await bridge.callTool("list_modules", { workspaceId: workspaceId });
      invoiceModule = findModuleByName(existingModules, "Invoice");
    }
    const invoiceModuleId = getCreatedModuleId(invoiceModule)!;
    console.log(`    → Invoice module ready (id: ${invoiceModuleId})`);

    // ── Switch to runtime ──────────────────────────────────────────────────────
    console.log("    → Switching to runtime mode...");
    await bridge.callTool("switch_mode", { mode: "runtime" });

    const ai = { reasoning: "TestBench setup", model: "testbench", confidence: 1.0 };

    // ── Client entry ───────────────────────────────────────────────────────────
    console.log("    → Creating Pinnacle Ventures client entry...");
    const clientResult = await bridge.callTool("submit_activity", {
      module: "Client", activity: "create", workspaceId: workspaceId,
      input: { "Client Name": "Pinnacle Ventures Sdn Bhd", "Email": "meilin@pinnacleventures.com.my", "Payment Terms": "Net 30" },
      ai,
    });
    const clientId = getCreatedEntryId(clientResult);
    if (!clientId) throw new Error(`Setup failed: could not extract clientId. Raw: ${JSON.stringify(clientResult)}`);
    console.log(`    → Client entry created (id: ${clientId})`);

    // ── Task 2 entry ───────────────────────────────────────────────────────────
    console.log("    → Creating Task 2 invoice entry (Draft)...");
    const t2Result = await bridge.callTool("submit_activity", {
      module: "Invoice", activity: "create", workspaceId: workspaceId,
      input: { "Invoice Number": `BENCH-T2-${Date.now()}`, "Client": "Meridian Logistics Sdn Bhd", "Description": "Software development services Q2 2026", "Billing Amount": 20000, "Tax": 1600, "Total Amount": 21600, "Issue Date": "2026-05-28", "Due Date": "2026-06-27", "Payment Terms": "Net 30", "Finance Manager": "Jesmond Tay" },
      ai,
    });
    const task2EntryId = getCreatedEntryId(t2Result);
    if (!task2EntryId) throw new Error(`Setup failed: could not extract task2EntryId. Raw: ${JSON.stringify(t2Result)}`);
    console.log(`    → Task 2 entry created (id: ${task2EntryId})`);

    // ── Task 3 entry ───────────────────────────────────────────────────────────
    console.log("    → Creating Task 3 invoice entry (Draft)...");
    const t3Result = await bridge.callTool("submit_activity", {
      module: "Invoice", activity: "create", workspaceId: workspaceId,
      input: { "Invoice Number": `BENCH-T3-${Date.now()}`, "Client": "Horizon Group Sdn Bhd", "Description": "Consultancy retainer May 2026", "Billing Amount": 8000, "Tax": 640, "Total Amount": 8640, "Issue Date": "2026-05-28", "Due Date": "2026-06-27", "Payment Terms": "Net 30", "Finance Manager": "Jesmond Tay" },
      ai,
    });
    const task3EntryId = getCreatedEntryId(t3Result);
    if (!task3EntryId) throw new Error(`Setup failed: could not extract task3EntryId. Raw: ${JSON.stringify(t3Result)}`);
    console.log(`    → Task 3 entry created (id: ${task3EntryId})`);

    // ── Overdue entry ──────────────────────────────────────────────────────────
    console.log("    → Creating overdue invoice entry for Pinnacle Ventures...");
    const overdueResult = await bridge.callTool("submit_activity", {
      module: "Invoice", activity: "create", workspaceId: workspaceId,
      input: { "Invoice Number": `BENCH-T4-${Date.now()}`, "Client": "Pinnacle Ventures Sdn Bhd", "Description": "Consulting services — TestBench setup entry", "Billing Amount": 15000, "Tax": 1200, "Total Amount": 16200, "Issue Date": "2026-04-01", "Due Date": "2026-04-30", "Payment Terms": "Net 30", "Finance Manager": "Jesmond Tay" },
      ai: { ...ai, reasoning: "TestBench setup — overdue invoice for Pinnacle Ventures" },
    });
    const overdueEntryId = getCreatedEntryId(overdueResult);
    if (!overdueEntryId) throw new Error(`Setup failed: could not extract overdueEntryId. Raw: ${JSON.stringify(overdueResult)}`);
    console.log(`    → Overdue entry created (id: ${overdueEntryId})`);

    await bridge.callTool("set_workspace", { workspaceId });
    return { workspaceId, invoiceModuleId, clientModuleId, task2EntryId, task3EntryId, overdueEntryId, clientId };
  },

  system: (assets) => `You are an invoice management AI assistant for Inistate.
Workspace ${assets.workspaceId} is already active — you do not need to pass workspaceId to any tool.
Use the tools to complete the given task. Be concise and efficient.`,

  tasks: [
    {
      id: "task_1",
      name: "Create Invoice",
      prompt: (assets) =>
        `Create an invoice for Apex Solutions for $15,000 consulting services. Tax is 8% ($1,200). Total is $16,200. Payment terms Net 30.`,
      evaluate: (toolCalls) => {
        const isInvoiceCreate = (t: { name: string; arguments: Record<string, unknown> }) =>
          (t.name === "submit_activity" || t.name === "submit_activities") &&
          t.arguments?.["module"] === "Invoice" &&
          (!t.arguments?.["activity"] || t.arguments?.["activity"] === "create");
        const invoiceCreateCalls = toolCalls.filter(isInvoiceCreate);
        const created        = toolCalls.some((t) => isInvoiceCreate(t) && !(t.result as Record<string, unknown>)?.error);
        const calledGetForm  = toolCalls.some((t) => t.name === "get_form");
        const correctAmount  = invoiceCreateCalls.some((t) => {
          const items = (t.arguments?.["items"] as Array<{ input?: Record<string, unknown> }>) ?? [{ input: (t.arguments?.["input"] as Record<string, unknown>) ?? {} }];
          return items.some((item) => {
            const input = item?.input ?? {};
            return Number(input["Billing Amount"]) === 15000 && Number(input["Tax"]) === 1200 && Number(input["Total Amount"]) === 16200;
          });
        });
        const issues: string[] = [];
        if (!calledGetForm)  issues.push("Did not call get_form before submit");
        if (!created)        issues.push("Did not create invoice entry");
        if (!correctAmount)  issues.push(`Billing amount, tax or total incorrect; captured=${JSON.stringify(invoiceCreateCalls.map((t) => t.arguments?.["input"] ?? t.arguments?.["items"])).slice(0, 500)}`);
        return { success: created && correctAmount, issues, hallucinated: created && !correctAmount };
      },
    },
    {
      id: "task_2",
      name: "Submit for Approval",
      prompt: (assets) =>
        `Submit invoice entryId ${assets.task2EntryId} for Finance Manager approval. The invoice amount exceeds the $10,000 threshold.`,
      evaluate: (toolCalls) => {
        const checkedEntry = toolCalls.some((t) => t.name === "get_entry");
        const submitted    = toolCalls.some(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            t.arguments?.["module"] === "Invoice" &&
            !(t.result as Record<string, unknown>)?.error
        );
        const issues: string[] = [];
        if (!checkedEntry) issues.push("Did not call get_entry to check current state");
        if (!submitted)    issues.push("Did not submit an activity on the Invoice");
        return { success: submitted, issues, hallucinated: false };
      },
    },
    {
      id: "task_3",
      name: "Check Available Actions",
      prompt: (assets) =>
        `Check what actions are currently available for invoice entryId ${assets.task3EntryId}.`,
      evaluate: (toolCalls, response) => {
        const calledGetEntry             = toolCalls.some((t) => t.name === "get_entry");
        const responseMentionsActivities = ["available", "activit", "transition", "action"].some((w) => response.toLowerCase().includes(w));
        const issues: string[] = [];
        if (!calledGetEntry)             issues.push("Did not call get_entry");
        if (!responseMentionsActivities) issues.push("Response did not mention available activities");
        return { success: calledGetEntry && responseMentionsActivities, issues, hallucinated: false };
      },
    },
    {
      id: "task_4",
      name: "Check Overdue Invoices",
      prompt: (assets) =>
        `Check if there are any overdue invoices for Pinnacle Ventures Sdn Bhd.`,
      evaluate: (toolCalls, response) => {
        const calledListEntries  = toolCalls.some((t) => t.name === "list_entries");
        const filteredByClient   = toolCalls.some((t) => t.name === "list_entries" && JSON.stringify(t.arguments).toLowerCase().includes("pinnacle"));
        const hallucinated       = !calledListEntries && ["overdue", "outstanding"].some((w) => response.toLowerCase().includes(w));
        const issues: string[] = [];
        if (!calledListEntries)                    issues.push("Did not call list_entries");
        if (calledListEntries && !filteredByClient) issues.push("Did not filter by Pinnacle Ventures");
        if (hallucinated)                          issues.push("Hallucinated invoice data without checking database");
        return { success: calledListEntries && filteredByClient, issues, hallucinated };
      },
    },
  ],

  teardown: async (_bridge: IBridge, assets: InvoiceAssets): Promise<void> => {
    const entriesToDelete = [
      assets.task2EntryId   && { module: "Invoice", entryId: assets.task2EntryId },
      assets.task3EntryId   && { module: "Invoice", entryId: assets.task3EntryId },
      assets.overdueEntryId && { module: "Invoice", entryId: assets.overdueEntryId },
      assets.clientId       && { module: "Client",  entryId: assets.clientId },
    ].filter((x): x is { module: string; entryId: string | number } => Boolean(x));

    for (const { module, entryId } of entriesToDelete) {
      try {
        await _bridge.callTool("submit_activity", {
          module, activity: "delete", workspaceId: assets.workspaceId, confirmed: true,
          items: [{ entryId }],
          ai: { reasoning: "TestBench teardown", model: "testbench", confidence: 1.0 },
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
  },
};

module.exports = scenario;
