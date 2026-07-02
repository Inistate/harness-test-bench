// Inventory Reorder Cascade Workflow
// Tests cross-module aggregation + cascading writes to a variable number of rows.
//
// Modules:
//   Product     — { Name, Description }, states: In Stock | Reorder
//   Inventory1  — location A stock rows, { "Product ID" (ref), "Available Qty" }, states: Stocked | Reorder
//   Inventory2  — location B stock rows, same shape as Inventory1
//   A product can have MULTIPLE rows in the same inventory table (batches/shelves),
//   so the model must list_entries + filter by Product ID, not assume one row each.
//
// Behavior:
//   1. Find every Inventory1 + Inventory2 row for the product, sum "Available Qty"
//   2. If sum < REORDER_THRESHOLD: flag Product → Reorder, AND flag every one of
//      those Inventory1/Inventory2 rows → Reorder (cascade to ALL matching rows)
//   3. If sum >= REORDER_THRESHOLD: do nothing — no state changes anywhere
//
// Task 1: 2 inv1 rows (10+5) + 1 inv2 row (10)  = 25 < 50  → reorder cascade (3 rows + product)
// Task 2: 1 inv1 row (60) + 1 inv2 row (40)      = 100 >= 50 → no cascade
// Task 3: 2 inv1 rows (2+3) + 2 inv2 rows (20+20) = 45 < 50  → reorder cascade (4 rows + product)
// Task 4 (trap): 1 inv1 row (5, alarming alone) + 2 inv2 rows (30+25) = 60 >= 50
//                → must NOT reorder despite the lone low reading

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, EvaluationResult, Scenario, ToolCall } from "../types";
import {
  hasError, getCreatedEntryId, getCreatedModuleId, findModuleByName, getEntryList, AI,
} from "./scenario-helpers";

const REORDER_THRESHOLD = 50;

interface InventoryAssets {
  workspaceId: string;
  productModuleId: string | number;
  inventory1ModuleId: string | number;
  inventory2ModuleId: string | number;
  // per-task: product id + the inventory row ids seeded for it
  task1ProductId: string | number; task1Inv1Ids: (string | number)[]; task1Inv2Ids: (string | number)[];
  task2ProductId: string | number; task2Inv1Ids: (string | number)[]; task2Inv2Ids: (string | number)[];
  task3ProductId: string | number; task3Inv1Ids: (string | number)[]; task3Inv2Ids: (string | number)[];
  task4ProductId: string | number; task4Inv1Ids: (string | number)[]; task4Inv2Ids: (string | number)[];
}

// ─── Module schemas ────────────────────────────────────────────────────────────

const productSchema = {
  name: "Product", icon: "📦",
  description: "Master product catalogue entries",
  states: [
    { name: "In Stock", color: "#1E6B45", initial: true },
    { name: "Reorder",  color: "#C0392B" },
  ],
  information: [
    { name: "Name",        type: "Text", ai_hint: "Product name" },
    { name: "Description", type: "Text", ai_hint: "Short product description" },
  ],
  activities: [
    { name: "Flag Reorder", actor: "ai", fields: [] },
  ],
  flows: [
    { activity: "Flag Reorder", from: "In Stock", to: "Reorder" },
  ],
};

function inventorySchema(moduleName: string) {
  return {
    name: moduleName, icon: "🏬",
    description: `Stock rows for ${moduleName}`,
    states: [
      { name: "Stocked", color: "#1E6B45", initial: true },
      { name: "Reorder", color: "#C0392B" },
    ],
    information: [
      { name: "Product ID",    type: "Text",   ai_hint: "Entry ID of the linked Product record" },
      { name: "Available Qty", type: "Number", ai_hint: "Units available at this location" },
    ],
    activities: [
      { name: "Flag Reorder", actor: "ai", fields: [] },
    ],
    flows: [
      { activity: "Flag Reorder", from: "Stocked", to: "Reorder" },
    ],
  };
}

// ─── Setup helper: ensure 3 modules exist ─────────────────────────────────────

async function ensureModules(bridge: IBridge, assets: InventoryAssets): Promise<void> {
  await bridge.callTool("switch_mode", { mode: "configure" });
  let modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });

  let productModule = findModuleByName(modules, "Product");
  if (!productModule) {
    await bridge.callTool("validate_design", { schema: productSchema, mode: "create" });
    await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...productSchema });
    modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
    productModule = findModuleByName(modules, "Product");
  }
  assets.productModuleId = getCreatedModuleId(productModule)!;

  for (const [key, name] of [["inventory1ModuleId", "Inventory1"], ["inventory2ModuleId", "Inventory2"]] as const) {
    let mod = findModuleByName(modules, name);
    if (!mod) {
      const schema = inventorySchema(name);
      await bridge.callTool("validate_design", { schema, mode: "create" });
      await bridge.callTool("create_module", { workspaceId: assets.workspaceId, ...schema });
      modules = await bridge.callTool("list_modules", { workspaceId: assets.workspaceId });
      mod = findModuleByName(modules, name);
    }
    assets[key] = getCreatedModuleId(mod)!;
  }

  await bridge.callTool("switch_mode", { mode: "runtime" });
}

async function seedProductAndRows(
  bridge: IBridge,
  assets: InventoryAssets,
  name: string,
  description: string,
  inv1Qtys: number[],
  inv2Qtys: number[],
): Promise<{ productId: string | number; inv1Ids: (string | number)[]; inv2Ids: (string | number)[] }> {
  const productResult = await bridge.callTool("submit_activity", {
    module: "Product", activity: "create", workspaceId: assets.workspaceId,
    input: { Name: name, Description: description },
    ai: AI,
  });
  const productId = getCreatedEntryId(productResult)!;
  if (!productId) throw new Error(`Setup failed: product id for ${name}`);

  const inv1Ids: (string | number)[] = [];
  for (const qty of inv1Qtys) {
    const r = await bridge.callTool("submit_activity", {
      module: "Inventory1", activity: "create", workspaceId: assets.workspaceId,
      input: { "Product ID": String(productId), "Available Qty": qty },
      ai: AI,
    });
    const id = getCreatedEntryId(r)!;
    if (!id) throw new Error(`Setup failed: inventory1 row for ${name}`);
    inv1Ids.push(id);
  }

  const inv2Ids: (string | number)[] = [];
  for (const qty of inv2Qtys) {
    const r = await bridge.callTool("submit_activity", {
      module: "Inventory2", activity: "create", workspaceId: assets.workspaceId,
      input: { "Product ID": String(productId), "Available Qty": qty },
      ai: AI,
    });
    const id = getCreatedEntryId(r)!;
    if (!id) throw new Error(`Setup failed: inventory2 row for ${name}`);
    inv2Ids.push(id);
  }

  return { productId, inv1Ids, inv2Ids };
}

// ─── Evaluate + Verify helpers ────────────────────────────────────────────────

type ExpectedOutcome = "Reorder" | "No Change";

// Level 1 + 2: correct tool calls and correct params
function evaluateCascade(
  toolCalls: ToolCall[],
  productId: string | number,
  inv1Ids: (string | number)[],
  inv2Ids: (string | number)[],
  expected: ExpectedOutcome,
): EvaluationResult {
  const issues: string[] = [];

  // Level 1 — must read both inventory sources for this product before deciding
  const readInv1 = toolCalls.some((t) =>
    (t.name === "list_entries" || t.name === "get_entry") &&
    JSON.stringify(t.arguments).toLowerCase().includes("inventory1"));
  const readInv2 = toolCalls.some((t) =>
    (t.name === "list_entries" || t.name === "get_entry") &&
    JSON.stringify(t.arguments).toLowerCase().includes("inventory2"));
  if (!readInv1) issues.push("Level 1: did not read Inventory1 rows for the product");
  if (!readInv2) issues.push("Level 1: did not read Inventory2 rows for the product");

  const reorderCalls = toolCalls.filter((t) =>
    (t.name === "submit_activity" || t.name === "submit_activities") &&
    JSON.stringify(t.arguments).toLowerCase().includes("reorder") &&
    !hasError(t.result));

  if (expected === "Reorder") {
    const productFlagged = reorderCalls.some((t) => JSON.stringify(t.arguments).includes(String(productId)));
    if (!productFlagged) issues.push("Level 1: Product was not flagged for Reorder");

    for (const id of inv1Ids) {
      if (!reorderCalls.some((t) => JSON.stringify(t.arguments).includes(String(id)))) {
        issues.push(`Level 1: Inventory1 row ${id} was not flagged for Reorder`);
      }
    }
    for (const id of inv2Ids) {
      if (!reorderCalls.some((t) => JSON.stringify(t.arguments).includes(String(id)))) {
        issues.push(`Level 1: Inventory2 row ${id} was not flagged for Reorder`);
      }
    }
  } else {
    // No Change expected — any reorder call anywhere is a false trigger
    if (reorderCalls.length > 0) {
      issues.push("Level 1: model triggered Reorder when total stock was above threshold (false trigger)");
    }
  }

  return { success: issues.length === 0, issues, hallucinated: false };
}

// Level 3 — real API validation
async function verifyCascadeState(
  bridge: IBridge,
  productId: string | number,
  inv1Ids: (string | number)[],
  inv2Ids: (string | number)[],
  expected: ExpectedOutcome,
): Promise<EvaluationResult> {
  const issues: string[] = [];
  const expectedState = expected === "Reorder" ? "reorder" : "in stock";

  const product = await bridge.callTool("get_entry", { module: "Product", entryId: productId }) as Record<string, unknown>;
  if (!JSON.stringify(product).toLowerCase().includes(expectedState)) {
    issues.push(`Level 3: Product state is not "${expected === "Reorder" ? "Reorder" : "In Stock"}"`);
  }

  for (const id of inv1Ids) {
    const row = await bridge.callTool("get_entry", { module: "Inventory1", entryId: id }) as Record<string, unknown>;
    const rowExpected = expected === "Reorder" ? "reorder" : "stocked";
    if (!JSON.stringify(row).toLowerCase().includes(rowExpected)) {
      issues.push(`Level 3: Inventory1 row ${id} state mismatch (expected ${expected === "Reorder" ? "Reorder" : "Stocked"})`);
    }
  }
  for (const id of inv2Ids) {
    const row = await bridge.callTool("get_entry", { module: "Inventory2", entryId: id }) as Record<string, unknown>;
    const rowExpected = expected === "Reorder" ? "reorder" : "stocked";
    if (!JSON.stringify(row).toLowerCase().includes(rowExpected)) {
      issues.push(`Level 3: Inventory2 row ${id} state mismatch (expected ${expected === "Reorder" ? "Reorder" : "Stocked"})`);
    }
  }

  return { success: issues.length === 0, issues, hallucinated: false };
}

// ─── Scenario ─────────────────────────────────────────────────────────────────

const scenario: Scenario<InventoryAssets> = {
  id: "inventory_reorder",
  name: "Inventory Reorder Cascade",
  description: "Cross-module aggregation (sum stock across multiple rows in 2 inventory tables) + cascading writes to every matching row, with a false-trigger trap task",

  setup: async (_bridge: IBridge, workspaceId: string): Promise<InventoryAssets> => ({
    workspaceId,
    productModuleId: 0, inventory1ModuleId: 0, inventory2ModuleId: 0,
    task1ProductId: 0, task1Inv1Ids: [], task1Inv2Ids: [],
    task2ProductId: 0, task2Inv1Ids: [], task2Inv2Ids: [],
    task3ProductId: 0, task3Inv1Ids: [], task3Inv2Ids: [],
    task4ProductId: 0, task4Inv1Ids: [], task4Inv2Ids: [],
  }),

  system: (assets) => `You are an inventory assistant for Inistate.
Workspace ${assets.workspaceId} is already active.
You have access to three modules: Product, Inventory1, Inventory2.
A product may have several stock rows spread across Inventory1 and Inventory2 — you must find ALL of them, not just one.
Policy: sum "Available Qty" across every matching row in both tables. If the total is below ${REORDER_THRESHOLD}, flag the Product AND every one of those rows for Reorder. If the total is ${REORDER_THRESHOLD} or above, leave everything as is.
You are already authorized to make these state changes, including bulk updates across multiple rows — if a tool asks you to confirm a state change, resubmit the same call with confirmed: true. Do not stop to ask a human for permission.
Be concise. Use the minimum tools needed.`,

  tasks: [
    // ── Task 1: 2 inv1 rows + 1 inv2 row, sum 25 → reorder cascade ──────────
    {
      id: "task_1_reorder_multi_row",
      name: "Stock Check — Reorder (Split Across Multiple Rows)",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: InventoryAssets): Promise<void> => {
        await ensureModules(bridge, assets);
        const seeded = await seedProductAndRows(bridge, assets, "Widget A", "Standard widget, 10cm", [10, 5], [10]);
        assets.task1ProductId = seeded.productId;
        assets.task1Inv1Ids = seeded.inv1Ids;
        assets.task1Inv2Ids = seeded.inv2Ids;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: product=${seeded.productId}, inv1=[${seeded.inv1Ids}], inv2=[${seeded.inv2Ids}]`);
      },
      prompt: (assets) =>
        `Hey — can you check on Widget A (Product ID ${assets.task1ProductId}) for me? ` +
        `Pull the stock numbers from both inventory sheets and see how many we've actually got left in total. ` +
        `If we're running low, flag it for reorder and make sure the warehouse records on both sheets get updated too, not just the product itself. Thanks!`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateCascade(toolCalls, assets?.task1ProductId ?? 0, assets?.task1Inv1Ids ?? [], assets?.task1Inv2Ids ?? [], "Reorder"),
      verify: async (bridge: IBridge, assets: InventoryAssets): Promise<EvaluationResult> =>
        verifyCascadeState(bridge, assets.task1ProductId, assets.task1Inv1Ids, assets.task1Inv2Ids, "Reorder"),
    },

    // ── Task 2: 1 inv1 row + 1 inv2 row, sum 100 → no cascade ───────────────
    {
      id: "task_2_no_reorder_healthy",
      name: "Stock Check — No Reorder (Healthy Stock)",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: InventoryAssets): Promise<void> => {
        const seeded = await seedProductAndRows(bridge, assets, "Widget B", "Heavy-duty widget, 20cm", [60], [40]);
        assets.task2ProductId = seeded.productId;
        assets.task2Inv1Ids = seeded.inv1Ids;
        assets.task2Inv2Ids = seeded.inv2Ids;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: product=${seeded.productId}, inv1=[${seeded.inv1Ids}], inv2=[${seeded.inv2Ids}]`);
      },
      prompt: (assets) =>
        `Quick check for you — Widget B (Product ID ${assets.task2ProductId}). ` +
        `Look across both inventory sheets and tell me the total we've got. Only flag it for reorder if we're actually running low. Let me know what you find.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateCascade(toolCalls, assets?.task2ProductId ?? 0, assets?.task2Inv1Ids ?? [], assets?.task2Inv2Ids ?? [], "No Change"),
      verify: async (bridge: IBridge, assets: InventoryAssets): Promise<EvaluationResult> =>
        verifyCascadeState(bridge, assets.task2ProductId, assets.task2Inv1Ids, assets.task2Inv2Ids, "No Change"),
    },

    // ── Task 3: 2 inv1 rows + 2 inv2 rows, sum 45 → reorder cascade ─────────
    {
      id: "task_3_reorder_four_rows",
      name: "Stock Check — Reorder (Four Rows, Still Low)",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: InventoryAssets): Promise<void> => {
        const seeded = await seedProductAndRows(bridge, assets, "Widget C", "Compact widget, 5cm", [2, 3], [20, 20]);
        assets.task3ProductId = seeded.productId;
        assets.task3Inv1Ids = seeded.inv1Ids;
        assets.task3Inv2Ids = seeded.inv2Ids;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: product=${seeded.productId}, inv1=[${seeded.inv1Ids}], inv2=[${seeded.inv2Ids}]`);
      },
      prompt: (assets) =>
        `Can you run the numbers on Widget C (Product ID ${assets.task3ProductId})? ` +
        `It's spread across a few rows on both sheets, so add it all up before deciding. If the total's below our reorder line, flag the product and every one of those stock rows so the team knows.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateCascade(toolCalls, assets?.task3ProductId ?? 0, assets?.task3Inv1Ids ?? [], assets?.task3Inv2Ids ?? [], "Reorder"),
      verify: async (bridge: IBridge, assets: InventoryAssets): Promise<EvaluationResult> =>
        verifyCascadeState(bridge, assets.task3ProductId, assets.task3Inv1Ids, assets.task3Inv2Ids, "Reorder"),
    },

    // ── Task 4 (trap): inv1 alarming alone, inv2 covers it, sum 60 → no cascade ─
    {
      id: "task_4_no_reorder_trap",
      name: "Stock Check — No Reorder (Misleading Single Reading Trap)",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: InventoryAssets): Promise<void> => {
        const seeded = await seedProductAndRows(bridge, assets, "Widget D", "Premium widget, 15cm", [5], [30, 25]);
        assets.task4ProductId = seeded.productId;
        assets.task4Inv1Ids = seeded.inv1Ids;
        assets.task4Inv2Ids = seeded.inv2Ids;
        await bridge.callTool("set_workspace", { workspaceId: assets.workspaceId });
        console.log(`    → Seeded: product=${seeded.productId}, inv1=[${seeded.inv1Ids}], inv2=[${seeded.inv2Ids}]`);
      },
      prompt: (assets) =>
        `One more for you — Widget D (Product ID ${assets.task4ProductId}). ` +
        `Check both sheets and total it up before you decide anything — don't flag it just off one sheet looking low. Only reorder if the combined total is actually under our line.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult =>
        evaluateCascade(toolCalls, assets?.task4ProductId ?? 0, assets?.task4Inv1Ids ?? [], assets?.task4Inv2Ids ?? [], "No Change"),
      verify: async (bridge: IBridge, assets: InventoryAssets): Promise<EvaluationResult> => {
        const result = await verifyCascadeState(bridge, assets.task4ProductId, assets.task4Inv1Ids, assets.task4Inv2Ids, "No Change");

        // ── Teardown ──────────────────────────────────────────────────────────
        for (const moduleName of ["Inventory1", "Inventory2"]) {
          const list = await bridge.callTool("list_entries", { module: moduleName }) as Record<string, unknown>;
          for (const entry of getEntryList(list)) {
            const id = entry?.entryId ?? entry?.id;
            if (!id) continue;
            try { await bridge.callTool("submit_activity", { module: moduleName, activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
          }
        }
        const productList = await bridge.callTool("list_entries", { module: "Product" }) as Record<string, unknown>;
        for (const entry of getEntryList(productList)) {
          const id = entry?.entryId ?? entry?.id;
          if (!id) continue;
          try { await bridge.callTool("submit_activity", { module: "Product", activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
        }

        const api = new ApiBridge();
        for (const moduleId of [assets.inventory1ModuleId, assets.inventory2ModuleId, assets.productModuleId].filter(Boolean)) {
          try { await api.deleteModule(assets.workspaceId, null, moduleId); } catch { /* ignore */ }
        }

        return result;
      },
    },
  ],

  teardown: async (): Promise<void> => { /* cleanup handled in task_4 verify */ },
};

module.exports = scenario;
