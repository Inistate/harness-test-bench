// Vendor Selection / Procurement Workflow
// Tests multi-option comparative evaluation with weighted decision gates.
//
// The model must evaluate multiple vendor quotes against a procurement policy:
//   1. Budget gate: Total Price must be ≤ PurchaseRequest Budget
//   2. Delivery gate: urgency-based max delivery days (High ≤ 7, Medium ≤ 14, Low ≤ 30)
//   3. Quality gate: minimum 3.0 rating, or ≥ 2.5 for preferred vendors
//
// After filtering, pick the lowest Total Price among qualifiers.
// If no vendor qualifies, cancel the PurchaseRequest with explanation.
//
// Tasks:
//   Task 1: Standard — Medium urgency, all thresholds matter. Winner: Steelcase ($7,000)
//   Task 2: Quality trap — Cheapest vendor fails quality gate. Winner: MidRange ($12,500)
//   Task 3: Urgency gate — High urgency cuts slow vendor. Winner: Arctic Air ($2,800)
//   Task 4: No qualifiers — Every vendor fails at least one gate. → Cancel

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, EvaluationResult, Scenario, ToolCall } from "../types";
import {
  hasError, getCreatedEntryId, getCreatedModuleId, findModuleByName, getEntryList, AI,
} from "./scenario-helpers";

// ─── Assets type ───────────────────────────────────────────────────────────────

interface VendorAssets {
  workspaceId: string;
  vendorModuleId: string | number;
  prModuleId: string | number;
  quoteModuleId: string | number;
  task1PrId: string | number; task1QuoteIds: (string | number)[]; task1VendorIds: (string | number)[];
  task2PrId: string | number; task2QuoteIds: (string | number)[]; task2VendorIds: (string | number)[];
  task3PrId: string | number; task3QuoteIds: (string | number)[]; task3VendorIds: (string | number)[];
  task4PrId: string | number; task4QuoteIds: (string | number)[]; task4VendorIds: (string | number)[];
}

// ─── Module schemas ────────────────────────────────────────────────────────────

const vendorSchema = {
  name: "Vendor", icon: "🏭",
  description: "Approved vendors and suppliers",
  states: [
    { name: "Active",   color: "#1E6B45", initial: true },
    { name: "Inactive", color: "#5A6070" },
  ],
  information: [
    { name: "Name",           type: "Text",      ai_hint: "Full company name of the vendor" },
    { name: "Contact Email",  type: "Text",      ai_hint: "Primary contact email address" },
    { name: "Quality Rating", type: "Number",    ai_hint: "Quality rating score (1-5)" },
    { name: "Preferred",      type: "Selection", options: ["Yes", "No"], ai_hint: "Whether this is a preferred vendor" },
  ],
  activities: [
    { name: "Mark Inactive", actor: "ai" },
  ],
  flows: [
    { activity: "Mark Inactive", from: "Active", to: "Inactive" },
  ],
};

const prSchema = {
  name: "PurchaseRequest", icon: "📋",
  description: "Purchase requests requiring vendor selection and ordering",
  states: [
    { name: "Pending",    color: "#5A6070", initial: true },
    { name: "Ordered",    color: "#2968A8" },
    { name: "Cancelled",  color: "#C0392B" },
  ],
  information: [
    { name: "Item Name",         type: "Text",      ai_hint: "Name of the item to purchase" },
    { name: "Quantity",          type: "Number",    ai_hint: "Number of units needed" },
    { name: "Urgency",           type: "Selection", options: ["Low", "Medium", "High"], ai_hint: "Delivery urgency level" },
    { name: "Budget",            type: "Currency",  ai_hint: "Maximum total spend allowed" },
    { name: "Selected Vendor",   type: "Text",      ai_hint: "Name of the selected vendor (set when ordered)" },
    { name: "Selected Quote ID", type: "Text",      ai_hint: "Entry ID of the accepted quote" },
    { name: "Total Cost",        type: "Currency",  ai_hint: "Total cost of the order" },
    { name: "Status Notes",      type: "MultiText", ai_hint: "Notes about the order or cancellation reason" },
  ],
  activities: [
    { name: "Place Order", actor: "ai", fields: ["Selected Vendor", "Selected Quote ID", "Total Cost", "Status Notes"] },
    { name: "Cancel",      actor: "ai", fields: ["Status Notes"] },
  ],
  flows: [
    { activity: "Place Order", from: "Pending", to: "Ordered" },
    { activity: "Cancel",      from: "Pending", to: "Cancelled" },
  ],
};

const quoteSchema = {
  name: "VendorQuote", icon: "📄",
  description: "Quotes submitted by vendors for purchase requests",
  states: [
    { name: "Submitted", color: "#5A6070", initial: true },
    { name: "Accepted",  color: "#1E6B45" },
    { name: "Declined",  color: "#C0392B" },
  ],
  information: [
    { name: "Vendor Name",         type: "Text",      ai_hint: "Name of the quoting vendor" },
    { name: "Vendor ID",           type: "Text",      ai_hint: "Entry ID of the linked Vendor record" },
    { name: "Purchase Request ID", type: "Text",      ai_hint: "Entry ID of the linked PurchaseRequest" },
    { name: "Unit Price",          type: "Currency",  ai_hint: "Price per unit" },
    { name: "Delivery Days",       type: "Number",    ai_hint: "Estimated delivery time in days" },
    { name: "Total Price",         type: "Currency",  ai_hint: "Total price (unit price × quantity)" },
    { name: "Terms",               type: "Text",      ai_hint: "Payment and delivery terms" },
  ],
  activities: [
    { name: "Accept Quote",  actor: "ai" },
    { name: "Decline Quote", actor: "ai" },
  ],
  flows: [
    { activity: "Accept Quote",  from: "Submitted", to: "Accepted" },
    { activity: "Decline Quote", from: "Submitted", to: "Declined" },
  ],
};

// ─── Task seed definitions ─────────────────────────────────────────────────────

interface TaskSeed {
  itemName: string;
  quantity: number;
  urgency: string;
  budget: number;
  vendors: Array<{ name: string; email: string; rating: number; preferred: boolean }>;
  quotes: Array<{ vendorIndex: number; unitPrice: number; deliveryDays: number; terms: string }>;
  winnerIndex: number | null;
  winnerVendorName: string;
  winnerTotalCost: number;
}

const TASK_SEEDS: TaskSeed[] = [
  // Task 1 — Standard selection: Medium urgency, budget $8k
  // Budget Office excluded by delivery (21d > 14d), Steelcase ($7k) beats Herman Miller ($7.6k)
  {
    itemName: "Office Chairs", quantity: 20, urgency: "Medium", budget: 8000,
    vendors: [
      { name: "Steelcase Supplies",  email: "sales@steelcase.com",   rating: 4.5, preferred: true  },
      { name: "Herman Miller Co",    email: "sales@hermanmiller.com", rating: 4.0, preferred: true  },
      { name: "Budget Office Inc",   email: "orders@budgetoffice.com", rating: 3.5, preferred: false },
    ],
    quotes: [
      { vendorIndex: 0, unitPrice: 350, deliveryDays: 10, terms: "Net 30" },
      { vendorIndex: 1, unitPrice: 380, deliveryDays: 5,  terms: "Net 30" },
      { vendorIndex: 2, unitPrice: 320, deliveryDays: 21, terms: "Net 60" },
    ],
    winnerIndex: 0, winnerVendorName: "Steelcase Supplies", winnerTotalCost: 7000,
  },
  // Task 2 — Quality gate trap: cheapest (Discount Racks) has rating 2.0 < 3.0 and not preferred
  // MidRange ($12.5k) qualifies and beats Premium ($14k)
  {
    itemName: "Server Racks", quantity: 5, urgency: "Low", budget: 15000,
    vendors: [
      { name: "Premium Rack Co",    email: "sales@premiumrack.com",  rating: 4.8, preferred: true  },
      { name: "Discount Racks",     email: "sales@discountracks.com", rating: 2.0, preferred: false },
      { name: "MidRange Solutions", email: "info@midrange.com",      rating: 3.5, preferred: false },
    ],
    quotes: [
      { vendorIndex: 0, unitPrice: 2800, deliveryDays: 20, terms: "Net 30" },
      { vendorIndex: 1, unitPrice: 2000, deliveryDays: 25, terms: "Net 15" },
      { vendorIndex: 2, unitPrice: 2500, deliveryDays: 15, terms: "Net 30" },
    ],
    winnerIndex: 2, winnerVendorName: "MidRange Solutions", winnerTotalCost: 12500,
  },
  // Task 3 — Urgency gate: High urgency excludes BreezeMax (10d > 7d)
  // QuickCool ($2.9k) and Arctic Air ($2.8k) both qualify, Arctic Air wins
  {
    itemName: "Cooling Fans", quantity: 10, urgency: "High", budget: 3000,
    vendors: [
      { name: "QuickCool Ltd",   email: "orders@quickcool.com", rating: 3.5, preferred: false },
      { name: "Arctic Air Co",   email: "sales@arcticair.com",  rating: 3.2, preferred: false },
      { name: "BreezeMax Inc",   email: "info@breezemax.com",   rating: 4.0, preferred: true  },
    ],
    quotes: [
      { vendorIndex: 0, unitPrice: 290, deliveryDays: 3,  terms: "Net 15" },
      { vendorIndex: 1, unitPrice: 280, deliveryDays: 5,  terms: "Net 15" },
      { vendorIndex: 2, unitPrice: 260, deliveryDays: 10, terms: "Net 30" },
    ],
    winnerIndex: 1, winnerVendorName: "Arctic Air Co", winnerTotalCost: 2800,
  },
  // Task 4 — No valid vendor: High urgency, all fail
  // PrintPro over budget ($5200 > $4500), OfficeTech delivery (15d > 7d), BudgetPrint rating (2.5 < 3.0 and not pref)
  {
    itemName: "Industrial Printer", quantity: 1, urgency: "High", budget: 4500,
    vendors: [
      { name: "PrintPro Corp",    email: "sales@printpro.com",  rating: 4.5, preferred: true  },
      { name: "OfficeTech Ltd",   email: "orders@officetech.com", rating: 3.0, preferred: false },
      { name: "BudgetPrint Inc",  email: "info@budgetprint.com",  rating: 2.5, preferred: false },
    ],
    quotes: [
      { vendorIndex: 0, unitPrice: 5200, deliveryDays: 4,  terms: "Net 30" },
      { vendorIndex: 1, unitPrice: 3800, deliveryDays: 15, terms: "Net 15" },
      { vendorIndex: 2, unitPrice: 4200, deliveryDays: 8,  terms: "Net 30" },
    ],
    winnerIndex: null, winnerVendorName: "", winnerTotalCost: 0,
  },
];

// ─── Setup: ensure all three modules exist ─────────────────────────────────────

async function ensureModules(bridge: IBridge, assets: VendorAssets): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  let modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });

  let vendorModule = findModuleByName(modules, "Vendor");
  if (!vendorModule) {
    await bridge.callTool("validate_design", { schema: vendorSchema, mode: "create" });
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...vendorSchema });
    modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
    vendorModule = findModuleByName(modules, "Vendor");
  }
  assets.vendorModuleId = getCreatedModuleId(vendorModule)!;

  let prModule = findModuleByName(modules, "PurchaseRequest");
  if (!prModule) {
    await bridge.callTool("validate_design", { schema: prSchema, mode: "create" });
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...prSchema });
    modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
    prModule = findModuleByName(modules, "PurchaseRequest");
  }
  assets.prModuleId = getCreatedModuleId(prModule)!;

  let quoteModule = findModuleByName(modules, "VendorQuote");
  if (!quoteModule) {
    await bridge.callTool("validate_design", { schema: quoteSchema, mode: "create" });
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...quoteSchema });
    modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
    quoteModule = findModuleByName(modules, "VendorQuote");
  }
  assets.quoteModuleId = getCreatedModuleId(quoteModule)!;

  await bridge.callTool("switch_mode", { mode: "runtime" });
}

async function seedTask(
  bridge: IBridge,
  assets: VendorAssets,
  seed: TaskSeed,
): Promise<{ prId: string | number; vendorIds: (string | number)[]; quoteIds: (string | number)[] }> {
  const vendorIds: (string | number)[] = [];
  for (const v of seed.vendors) {
    const r = await bridge.callTool("submit_activity", {
      module: "Vendor", activity: "create", workspaceId: assets.workspaceId,
      input: { Name: v.name, "Contact Email": v.email, "Quality Rating": v.rating, Preferred: v.preferred ? "Yes" : "No" },
      ai: AI,
    });
    const id = getCreatedEntryId(r)!;
    if (!id) throw new Error(`Setup failed: vendor ${v.name}`);
    vendorIds.push(id);
  }

  const prResult = await bridge.callTool("submit_activity", {
    module: "PurchaseRequest", activity: "create", workspaceId: assets.workspaceId,
    input: { "Item Name": seed.itemName, Quantity: seed.quantity, Urgency: seed.urgency, Budget: seed.budget },
    ai: AI,
  });
  const prId = getCreatedEntryId(prResult)!;
  if (!prId) throw new Error(`Setup failed: PurchaseRequest for ${seed.itemName}`);

  const quoteIds: (string | number)[] = [];
  for (const q of seed.quotes) {
    const vendorName = seed.vendors[q.vendorIndex].name;
    const totalPrice = q.unitPrice * seed.quantity;
    const r = await bridge.callTool("submit_activity", {
      module: "VendorQuote", activity: "create", workspaceId: assets.workspaceId,
      input: {
        "Vendor Name": vendorName, "Vendor ID": String(vendorIds[q.vendorIndex]),
        "Purchase Request ID": String(prId),
        "Unit Price": q.unitPrice, "Delivery Days": q.deliveryDays,
        "Total Price": totalPrice, Terms: q.terms,
      },
      ai: AI,
    });
    const id = getCreatedEntryId(r)!;
    if (!id) throw new Error(`Setup failed: VendorQuote for ${vendorName}`);
    quoteIds.push(id);
  }

  return { prId, vendorIds, quoteIds };
}

// ─── Evaluate + Verify helpers ────────────────────────────────────────────────

interface ExpectedVendorSelection {
  prId: string | number;
  quoteIds: (string | number)[];
  vendorIds: (string | number)[];
  seed: TaskSeed;
}

function evaluateVendorSelection(
  toolCalls: ToolCall[],
  _assets: VendorAssets | undefined,
  expected: ExpectedVendorSelection,
): EvaluationResult {
  const issues: string[] = [];
  const { seed, vendorIds, quoteIds, prId } = expected;

  const readQuotes = toolCalls.some(t =>
    t.name === "list_entries" &&
    (JSON.stringify(t.arguments).toLowerCase().includes("vendorquote") ||
     JSON.stringify(t.arguments).toLowerCase().includes("quote"))
  );
  if (!readQuotes) issues.push("Did not call list_entries on VendorQuote to retrieve quotes");

  const readVendors = vendorIds.some(id =>
    toolCalls.some(t => t.name === "get_entry" && JSON.stringify(t.arguments).includes(String(id)))
  );
  if (!readVendors) issues.push("Did not call get_entry on any Vendor to check quality ratings");

  const allSubmitCalls = toolCalls.filter(t =>
    (t.name === "submit_activity") && !hasError(t.result)
  );

  if (seed.winnerIndex === null) {
    const cancelCall = allSubmitCalls.find(t =>
      JSON.stringify(t.arguments).toLowerCase().includes("cancel")
    );
    if (!cancelCall) {
      issues.push("Expected to cancel the PurchaseRequest but no Cancel activity was found");
      const placedOrder = allSubmitCalls.some(t =>
        JSON.stringify(t.arguments).toLowerCase().includes("place order")
      );
      if (placedOrder) {
        issues.push("Placed an order instead of cancelling — no vendor qualified");
        return { success: false, issues, hallucinated: true };
      }
      return { success: false, issues, hallucinated: false };
    }
    const raw = JSON.stringify(cancelCall.arguments).toLowerCase();
    if (!raw.includes("status notes") && !raw.includes("status_notes")) {
      issues.push("Cancel call missing Status Notes with explanation");
    }
    return { success: issues.length === 0, issues, hallucinated: false };
  }

  const placeOrderCall = allSubmitCalls.find(t =>
    JSON.stringify(t.arguments).toLowerCase().includes("place order")
  );
  if (!placeOrderCall) {
    issues.push("Did not call Place Order activity on the PurchaseRequest");
    const cancelled = allSubmitCalls.some(t =>
      JSON.stringify(t.arguments).toLowerCase().includes("cancel")
    );
    if (cancelled) {
      issues.push("Cancelled the PurchaseRequest instead of placing an order");
      return { success: false, issues, hallucinated: true };
    }
    return { success: false, issues, hallucinated: false };
  }

  const raw = JSON.stringify(placeOrderCall.arguments).toLowerCase();
  const correctVendor = raw.includes(seed.winnerVendorName.toLowerCase());
  const correctCost = raw.includes(String(seed.winnerTotalCost));
  const correctPrTarget = raw.includes(String(prId)) || raw.includes("purchaserequest");

  if (!correctVendor) {
    issues.push(`Place Order did not reference expected vendor "${seed.winnerVendorName}"`);
    const wrongVendors = seed.vendors
      .filter((_, i) => i !== seed.winnerIndex)
      .filter(v => raw.includes(v.name.toLowerCase()));
    for (const wv of wrongVendors) {
      issues.push(`Place Order referenced "${wv.name}" instead of expected winner`);
    }
  }
  if (!correctCost) issues.push(`Place Order missing Total Cost of $${seed.winnerTotalCost}`);
  if (!correctPrTarget) issues.push("Place Order did not target the PurchaseRequest module");

  const acceptCalls = allSubmitCalls.filter(t =>
    JSON.stringify(t.arguments).toLowerCase().includes("accept")
  );
  const declineCalls = allSubmitCalls.filter(t =>
    JSON.stringify(t.arguments).toLowerCase().includes("decline")
  );

  if (acceptCalls.length === 0) {
    issues.push("Did not call Accept Quote on any vendor quote");
  }
  const expectedDeclines = quoteIds.length - 1;
  if (declineCalls.length < expectedDeclines) {
    issues.push(`Expected ${expectedDeclines} Decline Quote calls but found ${declineCalls.length}`);
  }

  const hallucinated = !correctVendor && raw.length > 0;
  return { success: issues.length === 0, issues, hallucinated };
}

async function verifyVendorSelection(
  bridge: IBridge,
  expected: ExpectedVendorSelection,
): Promise<EvaluationResult> {
  const issues: string[] = [];
  const { seed, quoteIds, prId } = expected;

  const pr = await bridge.callTool("get_entry", { module: "PurchaseRequest", entryId: prId }) as Record<string, unknown>;
  if (hasError(pr)) {
    issues.push("get_entry failed for PurchaseRequest");
    return { success: false, issues, hallucinated: false };
  }

  if (seed.winnerIndex === null) {
    if (!JSON.stringify(pr).toLowerCase().includes("cancelled")) {
      issues.push("PurchaseRequest state is not Cancelled as expected");
    }
    return { success: issues.length === 0, issues, hallucinated: false };
  }

  const prRaw = JSON.stringify(pr).toLowerCase();
  if (!prRaw.includes("ordered")) {
    issues.push("PurchaseRequest state is not Ordered");
  } else {
    if (!prRaw.includes(seed.winnerVendorName.toLowerCase())) {
      issues.push(`Selected Vendor field does not contain "${seed.winnerVendorName}"`);
    }
    if (!prRaw.includes(String(seed.winnerTotalCost))) {
      issues.push(`Total Cost $${seed.winnerTotalCost} not found on PurchaseRequest`);
    }
  }

  const winQuoteId = quoteIds[seed.winnerIndex];
  const winQuote = await bridge.callTool("get_entry", { module: "VendorQuote", entryId: winQuoteId }) as Record<string, unknown>;
  if (hasError(winQuote)) {
    issues.push("get_entry failed for winning VendorQuote");
  } else if (!JSON.stringify(winQuote).toLowerCase().includes("accepted")) {
    issues.push("Winning VendorQuote state is not Accepted");
  }

  for (let i = 0; i < quoteIds.length; i++) {
    if (i === seed.winnerIndex) continue;
    const quote = await bridge.callTool("get_entry", { module: "VendorQuote", entryId: quoteIds[i] }) as Record<string, unknown>;
    if (hasError(quote)) {
      issues.push(`get_entry failed for VendorQuote ${quoteIds[i]}`);
    } else if (!JSON.stringify(quote).toLowerCase().includes("declined")) {
      issues.push(`VendorQuote ${quoteIds[i]} (index ${i}) state is not Declined`);
    }
  }

  return { success: issues.length === 0, issues, hallucinated: false };
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

const scenario: Scenario<VendorAssets> = {
  id: "vendor_selection",
  name: "Vendor Selection & Procurement",
  description: "Multi-option comparative evaluation: model assesses vendor quotes against budget, delivery, and quality gates, selects the best qualifying vendor, or cancels if none qualify",

  setup: async (_bridge: IBridge, workspaceId: string): Promise<VendorAssets> => ({
    workspaceId,
    vendorModuleId: 0, prModuleId: 0, quoteModuleId: 0,
    task1PrId: 0, task1QuoteIds: [], task1VendorIds: [],
    task2PrId: 0, task2QuoteIds: [], task2VendorIds: [],
    task3PrId: 0, task3QuoteIds: [], task3VendorIds: [],
    task4PrId: 0, task4QuoteIds: [], task4VendorIds: [],
  }),

  system: (assets) => `You are a procurement AI assistant for Inistate.
Workspace ${assets.workspaceId} is already active — do not pass workspaceId to tools unless explicitly required.
You have access to three modules: Vendor, PurchaseRequest, and VendorQuote.
Each PurchaseRequest has several VendorQuote entries linked to it (via "Purchase Request ID" field).
Each VendorQuote references a Vendor (via "Vendor ID" field) — you must read the Vendor record to check "Quality Rating" and "Preferred" status.

Procurement policy (evaluate every quote against ALL gates):
  1. Budget gate: Total Price must be ≤ the PurchaseRequest's Budget
  2. Delivery gate: Delivery Days must be ≤ max allowed for the urgency level:
     - High urgency: ≤ 7 days
     - Medium urgency: ≤ 14 days
     - Low urgency: ≤ 30 days
  3. Quality gate: Vendor Quality Rating must be ≥ 3.0, OR ≥ 2.5 if the vendor is Preferred (Preferred = "Yes")

Decision rules:
  - After filtering out non-qualifying quotes, pick the qualifying quote with the lowest Total Price
  - Place the order by calling Place Order on the PurchaseRequest, setting Selected Vendor, Selected Quote ID, and Total Cost
  - Accept the winning quote and Decline all other quotes
  - If no vendor qualifies, Cancel the PurchaseRequest with a Status Notes explaining why

You are already authorized to make these state changes — if a tool asks you to confirm a state change, resubmit the same call with confirmed: true.
Be concise and use the minimum tools needed.`,

  tasks: [
    // ── Task 1: Standard selection (Medium urgency, budget $8k) ──────────────
    {
      id: "task_1_standard",
      name: "Vendor Selection — Standard",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: VendorAssets): Promise<void> => {
        await ensureModules(bridge, assets);
        const seed = TASK_SEEDS[0];
        const result = await seedTask(bridge, assets, seed);
        assets.task1PrId = result.prId;
        assets.task1QuoteIds = result.quoteIds;
        assets.task1VendorIds = result.vendorIds;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: PR=${result.prId}, vendors=[${result.vendorIds}], quotes=[${result.quoteIds}]`);
      },
      prompt: () =>
        `We need to order 20 Office Chairs with a budget of $8,000. Medium urgency — not a rush but shouldn't drag. ` +
        `Three vendors have submitted quotes. Please evaluate each one against our procurement policy and place the ` +
        `order with the best qualifying vendor.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateVendorSelection(toolCalls, assets, {
          prId: assets?.task1PrId ?? 0,
          quoteIds: assets?.task1QuoteIds ?? [],
          vendorIds: assets?.task1VendorIds ?? [],
          seed: TASK_SEEDS[0],
        }),
      verify: async (bridge: IBridge, assets: VendorAssets): Promise<EvaluationResult> =>
        verifyVendorSelection(bridge, {
          prId: assets.task1PrId,
          quoteIds: assets.task1QuoteIds,
          vendorIds: assets.task1VendorIds,
          seed: TASK_SEEDS[0],
        }),
    },

    // ── Task 2: Quality gate trap (cheapest vendor has low rating) ───────────
    {
      id: "task_2_quality_trap",
      name: "Vendor Selection — Quality Gate Trap",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: VendorAssets): Promise<void> => {
        await ensureModules(bridge, assets);
        const seed = TASK_SEEDS[1];
        const result = await seedTask(bridge, assets, seed);
        assets.task2PrId = result.prId;
        assets.task2QuoteIds = result.quoteIds;
        assets.task2VendorIds = result.vendorIds;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: PR=${result.prId}, vendors=[${result.vendorIds}], quotes=[${result.quoteIds}]`);
      },
      prompt: () =>
        `We need to purchase 5 Server Racks with a $15,000 budget. Low urgency so we have time. ` +
        `Three vendors sent in quotes. Please evaluate each against our policy and go with the best qualifying option.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateVendorSelection(toolCalls, assets, {
          prId: assets?.task2PrId ?? 0,
          quoteIds: assets?.task2QuoteIds ?? [],
          vendorIds: assets?.task2VendorIds ?? [],
          seed: TASK_SEEDS[1],
        }),
      verify: async (bridge: IBridge, assets: VendorAssets): Promise<EvaluationResult> =>
        verifyVendorSelection(bridge, {
          prId: assets.task2PrId,
          quoteIds: assets.task2QuoteIds,
          vendorIds: assets.task2VendorIds,
          seed: TASK_SEEDS[1],
        }),
    },

    // ── Task 3: Urgency gate (High urgency cuts slow vendor) ────────────────
    {
      id: "task_3_urgency_gate",
      name: "Vendor Selection — Urgency Gate",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: VendorAssets): Promise<void> => {
        await ensureModules(bridge, assets);
        const seed = TASK_SEEDS[2];
        const result = await seedTask(bridge, assets, seed);
        assets.task3PrId = result.prId;
        assets.task3QuoteIds = result.quoteIds;
        assets.task3VendorIds = result.vendorIds;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: PR=${result.prId}, vendors=[${result.vendorIds}], quotes=[${result.quoteIds}]`);
      },
      prompt: () =>
        `We need 10 Cooling Fans ASAP — $3,000 budget, high urgency. Three vendors have submitted quotes. ` +
        `Please evaluate them against our procurement policy and place the order with the best qualifying vendor.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateVendorSelection(toolCalls, assets, {
          prId: assets?.task3PrId ?? 0,
          quoteIds: assets?.task3QuoteIds ?? [],
          vendorIds: assets?.task3VendorIds ?? [],
          seed: TASK_SEEDS[2],
        }),
      verify: async (bridge: IBridge, assets: VendorAssets): Promise<EvaluationResult> =>
        verifyVendorSelection(bridge, {
          prId: assets.task3PrId,
          quoteIds: assets.task3QuoteIds,
          vendorIds: assets.task3VendorIds,
          seed: TASK_SEEDS[2],
        }),
    },

    // ── Task 4: No valid vendor → Cancel ─────────────────────────────────────
    {
      id: "task_4_no_qualifier",
      name: "Vendor Selection — No Qualifiers (Cancel)",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: VendorAssets): Promise<void> => {
        await ensureModules(bridge, assets);
        const seed = TASK_SEEDS[3];
        const result = await seedTask(bridge, assets, seed);
        assets.task4PrId = result.prId;
        assets.task4QuoteIds = result.quoteIds;
        assets.task4VendorIds = result.vendorIds;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: PR=${result.prId}, vendors=[${result.vendorIds}], quotes=[${result.quoteIds}]`);
      },
      prompt: () =>
        `We need an Industrial Printer, just one unit, with a $4,500 budget — high urgency. ` +
        `Three vendors submitted quotes. Please evaluate each against our policy and proceed accordingly. ` +
        `If none qualify, cancel the request and explain why.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateVendorSelection(toolCalls, assets, {
          prId: assets?.task4PrId ?? 0,
          quoteIds: assets?.task4QuoteIds ?? [],
          vendorIds: assets?.task4VendorIds ?? [],
          seed: TASK_SEEDS[3],
        }),
      verify: async (bridge: IBridge, assets: VendorAssets): Promise<EvaluationResult> => {
        const result = await verifyVendorSelection(bridge, {
          prId: assets.task4PrId,
          quoteIds: assets.task4QuoteIds,
          vendorIds: assets.task4VendorIds,
          seed: TASK_SEEDS[3],
        });

        // ── Teardown ─────────────────────────────────────────────────────────
        for (const moduleName of ["VendorQuote", "PurchaseRequest", "Vendor"]) {
          const list = await bridge.callTool("list_entries", { module: moduleName }) as Record<string, unknown>;
          for (const entry of getEntryList(list)) {
            const id = entry?.entryId ?? entry?.id;
            if (!id) continue;
            try { await bridge.callTool("submit_activity", { module: moduleName, activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
          }
        }
        const api = new ApiBridge();
        for (const moduleId of [assets.quoteModuleId, assets.prModuleId, assets.vendorModuleId].filter(Boolean)) {
          try { await api.deleteModule(assets.workspaceId, null, moduleId); } catch { /* ignore */ }
        }

        return result;
      },
    },
  ],

  teardown: async (): Promise<void> => { /* cleanup handled in task_4 verify */ },
};

module.exports = scenario;
