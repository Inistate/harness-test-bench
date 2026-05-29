const WORKSPACE_ID = 2234;

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function getCreatedModuleId(result) {
  return firstDefined(
    result?.id,
    result?.moduleId,
    result?.vectorId,
    result?.module?.id,
    result?.module?.moduleId,
    result?.module?.vectorId,
    result?.data?.id,
    result?.data?.moduleId,
    result?.data?.vectorId
  );
}

function getCreatedEntryId(result) {
  return firstDefined(
    result?.entryId,
    result?.entryIds?.[0],
    result?.results?.[0]?.entryId,
    result?.results?.[0]?.id,
    result?.list?.[0]?.entryId,
    result?.data?.entryId,
    result?.data?.results?.[0]?.entryId
  );
}

function getModuleList(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.list)) return result.list;
  if (Array.isArray(result?.modules)) return result.modules;
  if (Array.isArray(result?.data?.list)) return result.data.list;
  if (Array.isArray(result?.data?.modules)) return result.data.modules;
  return [];
}

function findModuleByName(result, name) {
  const lowerName = name.toLowerCase();
  return getModuleList(result).find((module) => {
    const moduleName = module?.name || module?.module || module?.moduleName;
    return String(moduleName || "").toLowerCase() === lowerName;
  });
}

module.exports = {
  id: "invoice_workflow",
  name: "Invoice Approval Workflow",
  description: "End-to-end invoice creation, approval routing and overdue checking",

  // ─── Setup — creates modules and entries from scratch ─────────────────────────
  setup: async (mcpBridge) => {
    console.log("    → Switching to configure mode...");
    await mcpBridge.callTool("switch_mode", { mode: "configure" });
    let existingModules = await mcpBridge.callTool("list_modules", {
      workspaceId: String(WORKSPACE_ID)
    });

    // ── Create Client module ───────────────────────────────────────────────────
    console.log("    → Checking Client module...");
    const clientModuleSchema = {
      name: "Client",
      icon: "🏢",
      description: "Client records for invoice management",
      states: [
        { name: "Active", color: "#1E6B45", initial: true },
        { name: "Inactive", color: "#5A6070" }
      ],
      information: [
        { name: "Client Name", type: "Text", ai_hint: "Full legal name of the client" },
        { name: "Email", type: "Text", ai_hint: "Primary contact email" },
        { name: "Payment Terms", type: "Selection", options: ["Net 15", "Net 30", "Net 60"], ai_hint: "Default payment terms for this client" }
      ],
      activities: [
        { name: "Onboard Client", actor: "human" },
        { name: "Deactivate", actor: "human" }
      ],
      flows: [
        { activity: "Onboard Client", from: "Active", to: "Active" },
        { activity: "Deactivate", from: "Active", to: "Inactive" }
      ]
    };

    let clientModule = findModuleByName(existingModules, "Client");
    if (clientModule) {
      console.log("    → Client module already exists");
    } else {
      await mcpBridge.callTool("validate_design", { schema: clientModuleSchema, mode: "create" });
      await mcpBridge.callTool("create_module", {
        workspaceId: String(WORKSPACE_ID),
        ...clientModuleSchema
      });
      existingModules = await mcpBridge.callTool("list_modules", {
        workspaceId: String(WORKSPACE_ID)
      });
      clientModule = findModuleByName(existingModules, "Client");
    }
    const clientModuleId = getCreatedModuleId(clientModule);
    console.log(`    → Client module ready (id: ${clientModuleId})`);

    // ── Create Invoice module ──────────────────────────────────────────────────
    console.log("    → Checking Invoice module...");
    const invoiceModuleSchema = {
      name: "Invoice",
      icon: "🧾",
      description: "Invoice lifecycle from creation to payment or escalation",
      states: [
        { name: "Draft", color: "#5A6070", initial: true },
        { name: "Pending Approval", color: "#A07828" },
        { name: "Sent", color: "#2968A8" },
        { name: "Paid", color: "#1E6B45" },
        { name: "Overdue", color: "#C0392B" },
        { name: "Void", color: "#5A6070" }
      ],
      information: [
        { name: "Invoice Number", type: "Text", ai_hint: "Auto-generated invoice number e.g. INV-2026-001" },
        { name: "Client", type: "Text", ai_hint: "Client name" },
        { name: "Description", type: "MultiText", ai_hint: "Service description" },
        { name: "Billing Amount", type: "Currency", ai_hint: "Amount before tax and discount" },
        { name: "Tax", type: "Currency", ai_hint: "Tax amount (8% SST)" },
        { name: "Discount", type: "Currency", ai_hint: "Discount amount if applicable" },
        { name: "Total Amount", type: "Currency", ai_hint: "Total = Billing Amount + Tax - Discount" },
        { name: "Issue Date", type: "Date", ai_hint: "Invoice issue date in ISO 8601" },
        { name: "Due Date", type: "Date", ai_hint: "Payment due date in ISO 8601" },
        { name: "Payment Terms", type: "Selection", options: ["Net 15", "Net 30", "Net 60"], ai_hint: "Payment terms" },
        { name: "Finance Manager", type: "Text", ai_hint: "Finance Manager assigned for approval" },
        { name: "Notes", type: "MultiText", ai_hint: "Additional notes" }
      ],
      activities: [
        {
          name: "Generate Invoice",
          actor: "ai",
          ai_hint: "AI generates and validates invoice fields, computes tax and total",
          confidence_threshold: 0.8,
          fields: ["Invoice Number", "Client", "Billing Amount", "Tax", "Discount", "Total Amount", "Issue Date", "Due Date", "Payment Terms", "Description", "Notes"]
        },
        { name: "Approve", actor: "human" },
        { name: "Issue to Client", actor: "human" },
        { name: "Mark as Paid", actor: "human" },
        { name: "Mark Overdue", actor: "ai", confidence_threshold: 0.8 },
        { name: "Void Invoice", actor: "human" }
      ],
      flows: [
        { activity: "Generate Invoice", from: "Draft", to: "Pending Approval" },
        { activity: "Approve", from: "Pending Approval", to: "Sent" },
        { activity: "Issue to Client", from: "Pending Approval", to: "Sent" },
        { activity: "Mark as Paid", from: "Sent", to: "Paid" },
        { activity: "Mark Overdue", from: "Sent", to: "Overdue" },
        { activity: "Void Invoice", from: "Draft", to: "Void" }
      ]
    };

    let invoiceModule = findModuleByName(existingModules, "Invoice");
    if (invoiceModule) {
      console.log("    → Invoice module already exists");
    } else {
      await mcpBridge.callTool("validate_design", { schema: invoiceModuleSchema, mode: "create" });
      await mcpBridge.callTool("create_module", {
        workspaceId: String(WORKSPACE_ID),
        ...invoiceModuleSchema
      });
      existingModules = await mcpBridge.callTool("list_modules", {
        workspaceId: String(WORKSPACE_ID)
      });
      invoiceModule = findModuleByName(existingModules, "Invoice");
    }
    const invoiceModuleId = getCreatedModuleId(invoiceModule);
    console.log(`    → Invoice module ready (id: ${invoiceModuleId})`);

    // ── Switch to runtime mode ─────────────────────────────────────────────────
    console.log("    → Switching to runtime mode...");
    await mcpBridge.callTool("switch_mode", { mode: "runtime" });

    // ── Create Client entry ────────────────────────────────────────────────────
    console.log("    → Creating Pinnacle Ventures client entry...");
    const clientResult = await mcpBridge.callTool("submit_activity", {
      module: "Client",
      activity: "create",
      workspaceId: String(WORKSPACE_ID),
      input: {
        "Client Name": "Pinnacle Ventures Sdn Bhd",
        "Email": "meilin@pinnacleventures.com.my",
        "Payment Terms": "Net 30"
      },
      ai: { reasoning: "TestBench setup — creating Pinnacle Ventures client", model: "testbench", confidence: 1.0 }
    });
    const clientId = getCreatedEntryId(clientResult);
    if (!clientId) {
      throw new Error(`Setup failed: could not extract clientId from client create response. Raw: ${JSON.stringify(clientResult)}`);
    }
    console.log(`    → Client entry created (id: ${clientId})`);

    // ── Task 2 entry — fresh Draft for "Submit for Approval" ──────────────────
    console.log("    → Creating Task 2 invoice entry (Draft)...");
    const t2Result = await mcpBridge.callTool("submit_activity", {
      module: "Invoice",
      activity: "create",
      workspaceId: String(WORKSPACE_ID),
      input: {
        "Invoice Number": `BENCH-T2-${Date.now()}`,
        "Client": "Meridian Logistics Sdn Bhd",
        "Description": "Software development services Q2 2026",
        "Billing Amount": 20000,
        "Tax": 1600,
        "Total Amount": 21600,
        "Issue Date": "2026-05-28",
        "Due Date": "2026-06-27",
        "Payment Terms": "Net 30",
        "Finance Manager": "Jesmond Tay"
      },
      ai: { reasoning: "TestBench setup — fresh Draft entry for Task 2", model: "testbench", confidence: 1.0 }
    });
    const task2EntryId = getCreatedEntryId(t2Result);
    if (!task2EntryId) {
      throw new Error(`Setup failed: could not extract task2EntryId. Raw: ${JSON.stringify(t2Result)}`);
    }
    console.log(`    → Task 2 entry created (id: ${task2EntryId})`);

    // ── Task 3 entry — fresh Draft for "Check Available Actions" ──────────────
    console.log("    → Creating Task 3 invoice entry (Draft)...");
    const t3Result = await mcpBridge.callTool("submit_activity", {
      module: "Invoice",
      activity: "create",
      workspaceId: String(WORKSPACE_ID),
      input: {
        "Invoice Number": `BENCH-T3-${Date.now()}`,
        "Client": "Horizon Group Sdn Bhd",
        "Description": "Consultancy retainer May 2026",
        "Billing Amount": 8000,
        "Tax": 640,
        "Total Amount": 8640,
        "Issue Date": "2026-05-28",
        "Due Date": "2026-06-27",
        "Payment Terms": "Net 30",
        "Finance Manager": "Jesmond Tay"
      },
      ai: { reasoning: "TestBench setup — fresh Draft entry for Task 3", model: "testbench", confidence: 1.0 }
    });
    const task3EntryId = getCreatedEntryId(t3Result);
    if (!task3EntryId) {
      throw new Error(`Setup failed: could not extract task3EntryId. Raw: ${JSON.stringify(t3Result)}`);
    }
    console.log(`    → Task 3 entry created (id: ${task3EntryId})`);

    // ── Overdue entry — Pinnacle Ventures past-due invoice for Task 4 ──────────
    console.log("    → Creating overdue invoice entry for Pinnacle Ventures...");
    const overdueResult = await mcpBridge.callTool("submit_activity", {
      module: "Invoice",
      activity: "create",
      workspaceId: String(WORKSPACE_ID),
      input: {
        "Invoice Number": `BENCH-T4-${Date.now()}`,
        "Client": "Pinnacle Ventures Sdn Bhd",
        "Description": "Consulting services — TestBench setup entry",
        "Billing Amount": 15000,
        "Tax": 1200,
        "Total Amount": 16200,
        "Issue Date": "2026-04-01",
        "Due Date": "2026-04-30",
        "Payment Terms": "Net 30",
        "Finance Manager": "Jesmond Tay"
      },
      ai: { reasoning: "TestBench setup — overdue invoice for Pinnacle Ventures", model: "testbench", confidence: 1.0 }
    });
    const overdueEntryId = getCreatedEntryId(overdueResult);
    if (!overdueEntryId) {
      throw new Error(`Setup failed: could not extract overdueEntryId. Raw: ${JSON.stringify(overdueResult)}`);
    }
    console.log(`    → Overdue entry created (id: ${overdueEntryId})`);

    return {
      workspaceId: String(WORKSPACE_ID),
      invoiceModuleId,
      clientModuleId,
      task2EntryId,
      task3EntryId,
      overdueEntryId,
      clientId
    };
  },

  // ─── System prompt — constant across all models ───────────────────────────────
  system: `You are an invoice management AI assistant for Inistate.
You have access to tools to manage invoices, clients, and workflow states.
Use the tools to complete the given task. Be concise and efficient.
Always use the correct module names and workspace IDs as provided.`,

  // ─── Tasks — each evaluated independently ─────────────────────────────────────
  tasks: [
    {
      id: "task_1",
      name: "Create Invoice",
      prompt: (assets) =>
        `Create an invoice for Apex Solutions Sdn Bhd for RM 15,000 consulting services. Tax is 8% (RM 1,200). Total is RM 16,200. Payment terms Net 30. Use workspace ${assets.workspaceId}.`,
      evaluate: (toolCalls, response) => {
        const isInvoiceCreate = (t) =>
          (t.name === "submit_activity" || t.name === "submit_activities") &&
          t.arguments?.module === "Invoice" &&
          (!t.arguments?.activity || t.arguments?.activity === "create");
        const invoiceCreateCalls = toolCalls.filter(isInvoiceCreate);
        const created = toolCalls.some((t) => isInvoiceCreate(t) && !t.result?.error);
        const calledGetForm = toolCalls.some((t) => t.name === "get_form");
        const correctAmount = invoiceCreateCalls.some((t) => {
          const items = t.arguments?.items || [{ input: t.arguments?.input || {} }];
          return items.some((item) => {
            const input = item?.input || {};
            return (
              Number(input["Billing Amount"]) === 15000 &&
              Number(input["Tax"]) === 1200 &&
              Number(input["Total Amount"]) === 16200
            );
          });
        });
        const issues = [];
        if (!calledGetForm) issues.push("Did not call get_form before submit");
        if (!created) issues.push("Did not create invoice entry");
        if (!correctAmount) {
          const capturedInputs = invoiceCreateCalls.map((t) => t.arguments?.input || t.arguments?.items?.[0]?.input || {});
          issues.push(`Billing amount, tax or total incorrect; captured invoice input=${JSON.stringify(capturedInputs).slice(0, 500)}`);
        }
        return {
          success: created && correctAmount,
          issues,
          hallucinated: created && !correctAmount
        };
      }
    },

    {
      id: "task_2",
      name: "Submit for Approval",
      prompt: (assets) =>
        `Submit invoice entryId ${assets.task2EntryId} for Finance Manager approval. The invoice amount exceeds the RM 10,000 threshold. Use workspace ${assets.workspaceId}.`,
      evaluate: (toolCalls, response) => {
        const checkedEntry = toolCalls.some((t) => t.name === "get_entry");
        const submittedForApproval = toolCalls.some(
          (t) =>
            t.name === "submit_activity" || t.name === "submit_activities" &&
            t.arguments?.activity === "Generate Invoice" &&
            (t.result?.results?.[0]?.success === true || t.result?.summary?.succeeded > 0)
        );
        const issues = [];
        if (!checkedEntry) issues.push("Did not call get_entry to check current state");
        if (!submittedForApproval) issues.push("Did not submit Generate Invoice activity");
        return { success: submittedForApproval, issues, hallucinated: false };
      }
    },

    {
      id: "task_3",
      name: "Check Available Actions",
      prompt: (assets) =>
        `Check what actions are currently available for invoice entryId ${assets.task3EntryId}. Use workspace ${assets.workspaceId}.`,
      evaluate: (toolCalls, response) => {
        const calledGetEntry = toolCalls.some((t) => t.name === "get_entry");
        const responseMentionsActivities =
          (response || "").toLowerCase().includes("available") ||
          (response || "").toLowerCase().includes("activit") ||
          (response || "").toLowerCase().includes("transition") ||
          (response || "").toLowerCase().includes("action");
        const issues = [];
        if (!calledGetEntry) issues.push("Did not call get_entry");
        if (!responseMentionsActivities) issues.push("Response did not mention available activities");
        return {
          success: calledGetEntry && responseMentionsActivities,
          issues,
          hallucinated: false
        };
      }
    },

    {
      id: "task_4",
      name: "Check Overdue Invoices",
      prompt: (assets) =>
        `Check if there are any overdue invoices for Pinnacle Ventures Sdn Bhd in workspace ${assets.workspaceId}.`,
      evaluate: (toolCalls, response) => {
        const calledListEntries = toolCalls.some((t) => t.name === "list_entries");
        const filteredByClient = toolCalls.some((t) => {
          const args = JSON.stringify(t.arguments || {}).toLowerCase();
          return t.name === "list_entries" && args.includes("pinnacle");
        });
        const hallucinated =
          !calledListEntries &&
          ((response || "").toLowerCase().includes("overdue") ||
           (response || "").toLowerCase().includes("outstanding"));
        const issues = [];
        if (!calledListEntries) issues.push("Did not call list_entries");
        if (calledListEntries && !filteredByClient) issues.push("Did not filter by Pinnacle Ventures");
        if (hallucinated) issues.push("Hallucinated invoice data without checking database");
        return {
          success: calledListEntries && filteredByClient,
          issues,
          hallucinated
        };
      }
    }
  ],

  // ─── Teardown — deletes everything created in setup ───────────────────────────
  teardown: async (mcpBridge, assets) => {
    // Delete entries first
    const entriesToDelete = [
      assets.task2EntryId   && { module: "Invoice", entryId: assets.task2EntryId },
      assets.task3EntryId   && { module: "Invoice", entryId: assets.task3EntryId },
      assets.overdueEntryId && { module: "Invoice", entryId: assets.overdueEntryId },
      assets.clientId       && { module: "Client",  entryId: assets.clientId }
    ].filter(Boolean);

    for (const { module, entryId } of entriesToDelete) {
      try {
        await mcpBridge.callTool("submit_activity", {
          module,
          activity: "delete",
          workspaceId: assets.workspaceId,
          confirmed: true,
          items: [{ entryId }],
          ai: { reasoning: "TestBench teardown", model: "testbench", confidence: 1.0 }
        });
      } catch (e) { /* ignore */ }
    }

    // Switch to configure mode to delete modules
    try {
      await mcpBridge.callTool("switch_mode", { mode: "configure" });

      const modulesToDelete = [
        assets.invoiceModuleId,
        assets.clientModuleId
      ].filter(Boolean);

      for (const moduleId of modulesToDelete) {
        try {
          await mcpBridge.callTool("delete_module", {
            workspaceId: String(assets.workspaceId),
            moduleId: String(moduleId)
          });
        } catch (e) { /* ignore — delete_module may not exist, that's ok */ }
      }

      await mcpBridge.callTool("switch_mode", { mode: "runtime" });
    } catch (e) { /* ignore */ }
  }
};
