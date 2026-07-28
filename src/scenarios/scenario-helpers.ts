// Shared helpers for scenario setup/verify — used across loan-application.ts,
// inventory-reorder.ts, and any future scenario that creates modules/entries.

export function hasError(result: unknown): boolean {
  const r = result as Record<string, unknown>;
  if (r?.error && r.error.toString().toLowerCase() === "human_actor_blocked") return false;
  if (r?.error) return true;
  if (typeof r?.result === "string" && r.result.toLowerCase().includes("error")) return true;
  return false;
}

export function firstDefined<T>(...values: (T | null | undefined)[]): T | undefined {
  return values.find((v): v is T => v !== undefined && v !== null);
}

export function isValidId(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") return v.length > 0 && v !== "new" && !isNaN(Number(v));
  return false;
}

export function getCreatedEntryId(result: unknown): string | number | undefined {
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

export function getCreatedModuleId(result: unknown): string | number | undefined {
  const r = result as Record<string, unknown>;
  const module = r?.module as Record<string, unknown> | undefined;
  const data = r?.data as Record<string, unknown> | undefined;
  const nestedResult = r?.result as Record<string, unknown> | undefined;
  const candidate = firstDefined(
    r?.id, r?.moduleId, r?.module_id, r?.vectorId, r?.vector_id,
    module?.id, module?.moduleId, module?.module_id, module?.vectorId, module?.vector_id,
    data?.id, data?.moduleId, data?.module_id, data?.vectorId, data?.vector_id,
    nestedResult?.id, nestedResult?.moduleId, nestedResult?.module_id,
    nestedResult?.vectorId, nestedResult?.vector_id,
  );
  const validModuleId =
    (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) ||
    (typeof candidate === "string" &&
      candidate.trim().length > 0 &&
      candidate.toLowerCase() !== "new");
  return validModuleId ? (candidate as string | number) : undefined;
}

export function getModuleList(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r?.list)) return r.list as Array<Record<string, unknown>>;
  if (Array.isArray(r?.modules)) return r.modules as Array<Record<string, unknown>>;
  if (Array.isArray(r?.data)) return r.data as Array<Record<string, unknown>>;
  const data = r?.data as Record<string, unknown> | undefined;
  if (Array.isArray(data?.list)) return data.list as Array<Record<string, unknown>>;
  if (Array.isArray(data?.modules)) return data.modules as Array<Record<string, unknown>>;
  if (Array.isArray(r?.result)) return r.result as Array<Record<string, unknown>>;
  const nestedResult = r?.result as Record<string, unknown> | undefined;
  if (Array.isArray(nestedResult?.list))
    return nestedResult.list as Array<Record<string, unknown>>;
  if (Array.isArray(nestedResult?.modules))
    return nestedResult.modules as Array<Record<string, unknown>>;
  return [];
}

export function findModuleByName(result: unknown, name: string): Record<string, unknown> | undefined {
  const lower = name.toLowerCase();
  return getModuleList(result).find((m) =>
    String(
      m?.name ?? m?.module ?? m?.moduleName ?? m?.module_name ??
      m?.displayName ?? m?.display_name ?? m?.title ?? ""
    ).toLowerCase() === lower
  );
}

export function getEntryList(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r?.list)) return r.list as Array<Record<string, unknown>>;
  if (Array.isArray(r?.results)) return r.results as Array<Record<string, unknown>>;
  return [];
}

export const AI = { reasoning: "TestBench setup", model: "testbench", confidence: 1.0 };
