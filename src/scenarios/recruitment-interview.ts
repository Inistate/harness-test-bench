// Recruitment Interview Workflow
// Tests cross-module tool calling across Interviewer, Candidate, and Interview modules.
//
// Seed data:
//   Interviewers: Alice (busy at 10am), Bob (busy at 10am), Carol (free)
//   Candidate: Jamie Chen, status "Applied"
//   Existing interviews: Alice → 10am slot, Bob → 10am slot (both clashing)
//
// Task 1: Schedule interview at 10am — agent must pick Carol (only free interviewer)
// Task 2: Confirm interview — transition candidate to "Interview Scheduled", notify candidate
// Task 3: Pre-interview info retrieval — read interviewer and candidate details via foreign refs
// Task 4: Record outcome — transition interview + candidate, notify candidate of result

import { ApiBridge } from "../bridges/api-bridge";
import type { IBridge, EvaluationResult, Scenario, ToolCall } from "../types";

interface RecruitmentAssets {
  workspaceId: string;
  interviewerModuleId: string | number;
  candidateModuleId: string | number;
  interviewModuleId: string | number;
  aliceId: string | number;
  bobId: string | number;
  carolId: string | number;
  candidateId: string | number;
  aliceInterviewId: string | number;
  bobInterviewId: string | number;
  interviewSlot: string; // ISO datetime string for the 10am slot
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hasError(result: unknown): boolean {
  const r = result as Record<string, unknown>;
  if (r?.error && r.error.toString().toLowerCase() === "human_actor_blocked") return false;
  if (r?.error) return true;
  if (typeof r?.result === "string" && r.result.toLowerCase().includes("error")) return true;
  return false;
}

function calledSuccessfully(toolCalls: ToolCall[], name: string): boolean {
  return toolCalls.some((t) => t.name === name && !hasError(t.result));
}

function firstDefined<T>(...values: (T | null | undefined)[]): T | undefined {
  return values.find((v): v is T => v !== undefined && v !== null);
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

function getCreatedModuleId(result: unknown): string | number | undefined {
  const r = result as Record<string, unknown>;
  const candidate = firstDefined(
    r?.id, r?.moduleId, r?.vectorId,
    (r?.module as Record<string, unknown>)?.id,
    (r?.module as Record<string, unknown>)?.moduleId,
    (r?.data as Record<string, unknown>)?.id,
  );
  return isValidId(candidate) ? (candidate as string | number) : undefined;
}

function getModuleList(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r?.list)) return r.list as Array<Record<string, unknown>>;
  if (Array.isArray(r?.modules)) return r.modules as Array<Record<string, unknown>>;
  return [];
}

function findModuleByName(result: unknown, name: string): Record<string, unknown> | undefined {
  const lower = name.toLowerCase();
  return getModuleList(result).find((m) =>
    String(m?.name ?? m?.module ?? m?.moduleName ?? "").toLowerCase() === lower
  );
}

const AI = { reasoning: "TestBench setup", model: "testbench", confidence: 1.0 };

// ─── Scenario ─────────────────────────────────────────────────────────────────

const scenario: Scenario<RecruitmentAssets> = {
  id: "recruitment_interview",
  name: "Recruitment Interview Workflow",
  description: "Cross-module workflow: schedule interview with clash detection, confirm candidate, retrieve foreign ref data, record outcome and notify",

  setup: async (_bridge: IBridge, workspaceId: string): Promise<RecruitmentAssets> => {
    return { workspaceId, interviewerModuleId: 0, candidateModuleId: 0, interviewModuleId: 0, aliceId: 0, bobId: 0, carolId: 0, candidateId: 0, aliceInterviewId: 0, bobInterviewId: 0, interviewSlot: "2026-07-15T10:00:00+08:00" };
  },

  system: (assets) => `You are a recruitment coordination AI assistant for Inistate.
Workspace ${assets.workspaceId} is already active — do not pass workspaceId to tools unless required.
You have access to three modules: Interviewer, Candidate, and Interview.
The Interview module links Candidate and Interviewer records by storing their names and entry IDs as foreign references.
You are already authorized to make these state changes — if a tool asks you to confirm a state change, resubmit the same call with confirmed: true. Do not stop to ask a human for permission.
Be concise. Use the minimum tools needed to complete each task.`,

  tasks: [
    {
      id: "task_1_schedule_interview",
      name: "Schedule Interview (Clash Detection)",
      maxSteps: 25,
      setup: async (bridge: IBridge, assets: RecruitmentAssets): Promise<void> => {
        const { workspaceId } = assets;
        await bridge.callTool("switch_mode", { mode: "configure" });
        let existingModules = await bridge.callTool("list_modules", { workspaceId });

        const interviewerSchema = {
          name: "Interviewer", icon: "👤",
          description: "Internal staff available to conduct interviews",
          states: [
            { name: "Available",   color: "#1E6B45", initial: true },
            { name: "Unavailable", color: "#C0392B" },
          ],
          information: [
            { name: "Name",       type: "Text", ai_hint: "Full name of the interviewer" },
            { name: "Department", type: "Text", ai_hint: "Department the interviewer belongs to" },
            { name: "Email",      type: "Text", ai_hint: "Interviewer email address" },
          ],
          activities: [
            { name: "Mark Unavailable", actor: "ai" },
            { name: "Mark Available",   actor: "ai" },
          ],
          flows: [
            { activity: "Mark Unavailable", from: "Available",   to: "Unavailable" },
            { activity: "Mark Available",   from: "Unavailable", to: "Available"   },
          ],
        };
        let interviewerModule = findModuleByName(existingModules, "Interviewer");
        if (!interviewerModule) {
          await bridge.callTool("validate_design", { schema: interviewerSchema, mode: "create" });
          await bridge.callTool("create_module", { workspaceId, ...interviewerSchema });
          existingModules = await bridge.callTool("list_modules", { workspaceId });
          interviewerModule = findModuleByName(existingModules, "Interviewer");
        }
        assets.interviewerModuleId = getCreatedModuleId(interviewerModule)!;

        const candidateSchema = {
          name: "Candidate", icon: "🙋",
          description: "Job applicants moving through the recruitment pipeline",
          states: [
            { name: "Applied",             color: "#5A6070", initial: true },
            { name: "Interview Scheduled", color: "#2968A8" },
            { name: "Offer Extended",      color: "#A07828" },
            { name: "Hired",               color: "#1E6B45" },
            { name: "Rejected",            color: "#C0392B" },
          ],
          information: [
            { name: "Name",  type: "Text",      ai_hint: "Full name of the candidate" },
            { name: "Email", type: "Text",      ai_hint: "Candidate email address" },
            { name: "Role",  type: "Text",      ai_hint: "Role the candidate applied for" },
            { name: "Notes", type: "MultiText", ai_hint: "Recruiter notes or notifications" },
          ],
          activities: [
            { name: "Schedule Interview", actor: "ai", ai_hint: "Transition candidate to Interview Scheduled", confidence_threshold: 0.95 },
            { name: "Extend Offer", actor: "ai" },
            { name: "Reject",       actor: "ai" },
            { name: "Hire",         actor: "ai" },
          ],
          flows: [
            { activity: "Schedule Interview", from: "Applied",             to: "Interview Scheduled" },
            { activity: "Extend Offer",       from: "Interview Scheduled", to: "Offer Extended"      },
            { activity: "Reject",             from: "Interview Scheduled", to: "Rejected"            },
            { activity: "Hire",               from: "Offer Extended",      to: "Hired"               },
          ],
        };
        let candidateModule = findModuleByName(existingModules, "Candidate");
        if (!candidateModule) {
          await bridge.callTool("validate_design", { schema: candidateSchema, mode: "create" });
          await bridge.callTool("create_module", { workspaceId, ...candidateSchema });
          existingModules = await bridge.callTool("list_modules", { workspaceId });
          candidateModule = findModuleByName(existingModules, "Candidate");
        }
        assets.candidateModuleId = getCreatedModuleId(candidateModule)!;

        const interviewSchema = {
          name: "Interview", icon: "📅",
          description: "Scheduled interview sessions linking interviewers to candidates",
          states: [
            { name: "Scheduled", color: "#2968A8", initial: true },
            { name: "Completed", color: "#1E6B45" },
            { name: "Cancelled", color: "#C0392B" },
          ],
          information: [
            { name: "Candidate",      type: "Text",      ai_hint: "Name of the candidate being interviewed" },
            { name: "Candidate ID",   type: "Text",      ai_hint: "Entry ID of the linked Candidate record" },
            { name: "Interviewer",    type: "Text",      ai_hint: "Name of the assigned interviewer" },
            { name: "Interviewer ID", type: "Text",      ai_hint: "Entry ID of the linked Interviewer record" },
            { name: "Scheduled Time", type: "Text",      ai_hint: "ISO 8601 datetime of the interview slot" },
            { name: "Result",         type: "Selection", options: ["Pass", "Fail"], ai_hint: "Outcome of the interview" },
            { name: "Notes",          type: "MultiText", ai_hint: "Interview notes" },
          ],
          activities: [
            { name: "Complete Interview", actor: "ai", fields: ["Result", "Notes"] },
            { name: "Cancel Interview",   actor: "ai" },
          ],
          flows: [
            { activity: "Complete Interview", from: "Scheduled", to: "Completed" },
            { activity: "Cancel Interview",   from: "Scheduled", to: "Cancelled" },
          ],
        };
        let interviewModule = findModuleByName(existingModules, "Interview");
        if (!interviewModule) {
          await bridge.callTool("validate_design", { schema: interviewSchema, mode: "create" });
          await bridge.callTool("create_module", { workspaceId, ...interviewSchema });
          existingModules = await bridge.callTool("list_modules", { workspaceId });
          interviewModule = findModuleByName(existingModules, "Interview");
        }
        assets.interviewModuleId = getCreatedModuleId(interviewModule)!;

        await bridge.callTool("switch_mode", { mode: "runtime" });

        const aliceResult = await bridge.callTool("submit_activity", { module: "Interviewer", activity: "create", workspaceId, input: { Name: "Alice Tan", Department: "Engineering", Email: "alice@company.com" }, ai: AI });
        assets.aliceId = getCreatedEntryId(aliceResult)!;
        if (!assets.aliceId) throw new Error(`Setup failed: aliceId`);

        const bobResult = await bridge.callTool("submit_activity", { module: "Interviewer", activity: "create", workspaceId, input: { Name: "Bob Lim", Department: "Engineering", Email: "bob@company.com" }, ai: AI });
        assets.bobId = getCreatedEntryId(bobResult)!;
        if (!assets.bobId) throw new Error(`Setup failed: bobId`);

        const carolResult = await bridge.callTool("submit_activity", { module: "Interviewer", activity: "create", workspaceId, input: { Name: "Carol Wong", Department: "Product", Email: "carol@company.com" }, ai: AI });
        assets.carolId = getCreatedEntryId(carolResult)!;
        if (!assets.carolId) throw new Error(`Setup failed: carolId`);

        const candidateResult = await bridge.callTool("submit_activity", { module: "Candidate", activity: "create", workspaceId, input: { Name: "Jamie Chen", Email: "jamie.chen@gmail.com", Role: "Software Engineer", Notes: "" }, ai: AI });
        assets.candidateId = getCreatedEntryId(candidateResult)!;
        if (!assets.candidateId) throw new Error(`Setup failed: candidateId`);

        const aliceInterviewResult = await bridge.callTool("submit_activity", { module: "Interview", activity: "create", workspaceId, input: { Candidate: "Existing Candidate A", "Candidate ID": "existing-1", Interviewer: "Alice Tan", "Interviewer ID": String(assets.aliceId), "Scheduled Time": assets.interviewSlot, Notes: "Pre-existing interview — clash seed" }, ai: AI });
        assets.aliceInterviewId = getCreatedEntryId(aliceInterviewResult)!;

        const bobInterviewResult = await bridge.callTool("submit_activity", { module: "Interview", activity: "create", workspaceId, input: { Candidate: "Existing Candidate B", "Candidate ID": "existing-2", Interviewer: "Bob Lim", "Interviewer ID": String(assets.bobId), "Scheduled Time": assets.interviewSlot, Notes: "Pre-existing interview — clash seed" }, ai: AI });
        assets.bobInterviewId = getCreatedEntryId(bobInterviewResult)!;

        await bridge.callTool("set_workspace", { workspaceId });
        console.log(`    → Seeded: Alice=${assets.aliceId}, Bob=${assets.bobId}, Carol=${assets.carolId}, candidate=${assets.candidateId}`);
      },
      prompt: (assets) =>
        `Schedule an interview for candidate Jamie Chen (entry ID: ${assets.candidateId}) ` +
        `at ${assets.interviewSlot}. ` +
        // `There are three available interviewers: Alice Tan (ID: ${assets.aliceId}), Bob Lim (ID: ${assets.bobId}), and Carol Wong (ID: ${assets.carolId}). ` +
        `Check the existing interview schedule to make sure you pick an interviewer who doesn't already have an interview at that time. ` +
        `Create the Interview entry with the correct interviewer linked.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Agent must check existing interviews to detect clashes
        const checkedSchedule = calledSuccessfully(toolCalls, "list_entries") &&
          toolCalls.some((t) => t.name === "list_entries" && JSON.stringify(t.arguments).toLowerCase().includes("interview"));
        if (!checkedSchedule) issues.push("Did not call list_entries on Interview module to check for clashes");

        // Agent must create an Interview entry
        const createCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            JSON.stringify(t.arguments).toLowerCase().includes("interview") &&
            !hasError(t.result)
        );
        if (!createCall) {
          issues.push("Did not successfully create an Interview entry");
          return { success: false, issues, hallucinated: false };
        }

        const raw = JSON.stringify(createCall.arguments).toLowerCase();

        // Carol (free) must be chosen — Alice and Bob are clashing
        const pickedCarol = raw.includes("carol") || (assets && raw.includes(String(assets.carolId).toLowerCase()));
        const pickedAlice = raw.includes("alice") || (assets && raw.includes(String(assets.aliceId).toLowerCase()));
        const pickedBob   = raw.includes("bob")   || (assets && raw.includes(String(assets.bobId).toLowerCase()));

        if (!pickedCarol) {
          if (pickedAlice) issues.push("Chose Alice Tan who has a clashing interview at the same time slot");
          else if (pickedBob) issues.push("Chose Bob Lim who has a clashing interview at the same time slot");
          else issues.push("Could not determine which interviewer was chosen — Carol Wong expected");
        }

        // Candidate must be linked
        const linkedCandidate = raw.includes("jamie") || (assets && raw.includes(String(assets.candidateId).toLowerCase()));
        if (!linkedCandidate) issues.push("Candidate Jamie Chen not linked in the Interview entry");

        return {
          success: issues.length === 0,
          issues,
          hallucinated: Boolean(!pickedCarol && (pickedAlice || pickedBob)),
        };
      },
      verify: async (bridge: IBridge, assets: RecruitmentAssets): Promise<EvaluationResult> => {
        const issues: string[] = [];
        const result = await bridge.callTool("list_entries", { module: "Interview" }) as Record<string, unknown>;
        const list = (Array.isArray(result?.list) ? result.list : Array.isArray(result) ? result : []) as Array<Record<string, unknown>>;

        // Find the agent-created Interview entry for Jamie + Carol (not the clash seeds)
        const agentEntry = list.find((e) => {
          const raw = JSON.stringify(e).toLowerCase();
          return (raw.includes("jamie") || raw.includes(String(assets.candidateId))) &&
                 (raw.includes("carol") || raw.includes(String(assets.carolId))) &&
                 !raw.includes("existing candidate");
        });

        if (!agentEntry) {
          issues.push("No Interview entry found linking Jamie Chen with Carol Wong");
        } else {
          const raw = JSON.stringify(agentEntry).toLowerCase();
          if (raw.includes("alice") || raw.includes(String(assets.aliceId))) {
            issues.push("Interview entry incorrectly links Alice Tan (who had a clash)");
          }
          if (raw.includes("bob") || raw.includes(String(assets.bobId))) {
            issues.push("Interview entry incorrectly links Bob Lim (who had a clash)");
          }
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },

    {
      id: "task_2_confirm_candidate",
      name: "Confirm Interview & Notify Candidate",
      maxSteps: 20,
      // Pre-setup: ensure an Interview entry for Jamie + Carol exists regardless of task 1 outcome
      setup: async (bridge: IBridge, assets: RecruitmentAssets): Promise<void> => {
        const result = await bridge.callTool("list_entries", { module: "Interview" }) as Record<string, unknown>;
        const list = (Array.isArray(result?.list) ? result.list : Array.isArray(result) ? result : []) as Array<Record<string, unknown>>;
        const exists = list.some((e) => {
          const raw = JSON.stringify(e).toLowerCase();
          return (raw.includes("jamie") || raw.includes(String(assets.candidateId))) && !raw.includes("existing candidate");
        });
        if (!exists) {
          console.log("    → [task_2 setup] No agent interview found — seeding fallback Interview entry");
          await bridge.callTool("submit_activity", {
            module: "Interview", activity: "create", workspaceId: assets.workspaceId,
            input: {
              Candidate: "Jamie Chen", "Candidate ID": String(assets.candidateId),
              Interviewer: "Carol Wong", "Interviewer ID": String(assets.carolId),
              "Scheduled Time": assets.interviewSlot, Notes: "Fallback seed — task 1 did not create this",
            }, ai: AI,
          });
        }
      },
      prompt: (assets) =>
        `The interview for Jamie Chen (candidate ID: ${assets.candidateId}) has been confirmed. ` +
        `Transition the candidate's status to "Interview Scheduled".` +
        `Then update the candidate's Notes field with a notification message letting Jamie know the interview is confirmed for ${assets.interviewSlot} with Carol Wong from Product.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Must transition candidate status
        const transitionCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            JSON.stringify(t.arguments).toLowerCase().includes("schedule interview") &&
            !hasError(t.result)
        );
        if (!transitionCall) {
          issues.push("Did not transition candidate using 'Schedule Interview' activity");
        } else if (assets) {
          const raw = JSON.stringify(transitionCall.arguments);
          const targetedCandidate =
            raw.includes(String(assets.candidateId)) ||
            JSON.stringify(transitionCall.arguments).toLowerCase().includes("jamie");
          if (!targetedCandidate) issues.push("Transition did not target candidate Jamie Chen");
        }

        // Must update Notes with notification content
        const notifyCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            JSON.stringify(t.arguments).toLowerCase().includes("notes") &&
            !hasError(t.result)
        );
        if (!notifyCall) {
          issues.push("Did not update candidate Notes field with a notification message");
        } else {
          const raw = JSON.stringify(notifyCall.arguments).toLowerCase();
          if (!raw.includes("carol") && !raw.includes("confirmed") && !raw.includes("interview")) {
            issues.push("Notification message does not mention confirmation, Carol, or interview details");
          }
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
      verify: async (bridge: IBridge, assets: RecruitmentAssets): Promise<EvaluationResult> => {
        const issues: string[] = [];
        const result = await bridge.callTool("get_entry", { module: "Candidate", entryId: assets.candidateId }) as Record<string, unknown>;
        if (hasError(result)) {
          issues.push("get_entry failed for candidate Jamie Chen");
          return { success: false, issues, hallucinated: false };
        }
        const raw = JSON.stringify(result).toLowerCase();
        if (!raw.includes("interview scheduled")) {
          issues.push(`Candidate state is not "Interview Scheduled" — got: ${JSON.stringify((result?.data as Record<string, unknown>)?.state ?? result?.state ?? "unknown")}`);
        }
        if (!raw.includes("carol") && !raw.includes("confirmed")) {
          issues.push("Candidate Notes field does not contain confirmation message referencing Carol or confirmation");
        }
        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },

    {
      id: "task_3_info_retrieval",
      name: "Pre-Interview Info Retrieval",
      maxSteps: 20,
      // Pre-setup: ensure candidate is in "Interview Scheduled" state so the briefing reflects real state
      setup: async (bridge: IBridge, assets: RecruitmentAssets): Promise<void> => {
        const result = await bridge.callTool("get_entry", { module: "Candidate", entryId: assets.candidateId }) as Record<string, unknown>;
        const raw = JSON.stringify(result).toLowerCase();
        if (!raw.includes("interview scheduled")) {
          console.log("    → [task_3 setup] Candidate not in Interview Scheduled — transitioning");
          await bridge.callTool("submit_activity", {
            module: "Candidate", activity: "Schedule Interview",
            entryId: assets.candidateId, workspaceId: assets.workspaceId,
            input: {}, ai: AI,
          });
        }
      },
      prompt: (assets) =>
        `Before the interview begins, pull together a briefing. ` +
        `Look up the full details of the interviewer Carol Wong (ID: ${assets.carolId}) from the Interviewer module, ` +
        `and the full profile of candidate Jamie Chen (ID: ${assets.candidateId}) from the Candidate module. ` +
        `Summarise both — department and email for the interviewer, role and current status for the candidate.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Must fetch interviewer record
        const interviewerCall = toolCalls.find(
          (t) => t.name === "get_entry" &&
            (JSON.stringify(t.arguments).includes(String(assets?.carolId ?? "")) ||
             JSON.stringify(t.arguments).toLowerCase().includes("interviewer"))
        );
        if (!interviewerCall) {
          issues.push("Did not call get_entry for Carol Wong (Interviewer module)");
        } else {
          // Check the actual returned data contains Carol's known details
          const resultRaw = JSON.stringify(interviewerCall.result).toLowerCase();
          if (!resultRaw.includes("product")) issues.push("Interviewer record does not contain Department 'Product'");
          if (!resultRaw.includes("carol")) issues.push("Interviewer record does not reference Carol Wong");
        }

        // Must fetch candidate record
        const candidateCall = toolCalls.find(
          (t) => t.name === "get_entry" &&
            (JSON.stringify(t.arguments).includes(String(assets?.candidateId ?? "")) ||
             JSON.stringify(t.arguments).toLowerCase().includes("candidate"))
        );
        if (!candidateCall) {
          issues.push("Did not call get_entry for Jamie Chen (Candidate module)");
        } else {
          const resultRaw = JSON.stringify(candidateCall.result).toLowerCase();
          if (!resultRaw.includes("software engineer")) issues.push("Candidate record does not contain Role 'Software Engineer'");
          if (!resultRaw.includes("jamie")) issues.push("Candidate record does not reference Jamie Chen");
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },

    {
      id: "task_4_outcome_and_notify",
      name: "Record Outcome & Notify Candidate",
      maxSteps: 25,
      // Pre-setup: ensure candidate is in Interview Scheduled state (required for Extend Offer transition)
      setup: async (bridge: IBridge, assets: RecruitmentAssets): Promise<void> => {
        const result = await bridge.callTool("get_entry", { module: "Candidate", entryId: assets.candidateId }) as Record<string, unknown>;
        const raw = JSON.stringify(result).toLowerCase();
        if (!raw.includes("interview scheduled")) {
          console.log("    → [task_4 setup] Candidate not in Interview Scheduled — transitioning");
          await bridge.callTool("submit_activity", {
            module: "Candidate", activity: "Schedule Interview",
            entryId: assets.candidateId, workspaceId: assets.workspaceId,
            input: {}, ai: AI,
          });
        }
      },
      prompt: (assets) =>
        `The interview for Jamie Chen has concluded with a positive result. ` +
        `Find the Interview entry for Jamie Chen and transition it to "Completed" using the "Complete Interview" activity, setting the Result field to "Pass". ` +
        `Then transition Jamie's candidate status to "Offer Extended" using the "Extend Offer" activity. ` +
        `Finally, update Jamie's Notes field with a message notifying them that they passed the interview and an offer is being extended.`,
      evaluate: (toolCalls, _response, assets): EvaluationResult => {
        const issues: string[] = [];

        // Must complete the Interview entry
        const completeCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            JSON.stringify(t.arguments).toLowerCase().includes("complete interview") &&
            !hasError(t.result)
        );
        if (!completeCall) {
          issues.push("Did not transition Interview entry using 'Complete Interview' activity");
        } else {
          const raw = JSON.stringify(completeCall.arguments).toLowerCase();
          if (!raw.includes("pass")) issues.push("'Complete Interview' call did not set Result to 'Pass'");
        }

        // Must extend offer to candidate
        const offerCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            JSON.stringify(t.arguments).toLowerCase().includes("extend offer") &&
            !hasError(t.result)
        );
        if (!offerCall) {
          issues.push("Did not transition candidate using 'Extend Offer' activity");
        } else if (assets) {
          const raw = JSON.stringify(offerCall.arguments);
          const targetedCandidate =
            raw.includes(String(assets.candidateId)) ||
            raw.toLowerCase().includes("jamie");
          if (!targetedCandidate) issues.push("'Extend Offer' did not target candidate Jamie Chen");
        }

        // Must notify candidate via Notes
        const notifyCall = toolCalls.find(
          (t) => (t.name === "submit_activity" || t.name === "submit_activities") &&
            JSON.stringify(t.arguments).toLowerCase().includes("notes") &&
            !hasError(t.result)
        );
        if (!notifyCall) {
          issues.push("Did not update candidate Notes with outcome notification");
        } else {
          const raw = JSON.stringify(notifyCall.arguments).toLowerCase();
          if (!raw.includes("offer") && !raw.includes("pass") && !raw.includes("congratulations")) {
            issues.push("Outcome notification does not mention the offer or passing result");
          }
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
      verify: async (bridge: IBridge, assets: RecruitmentAssets): Promise<EvaluationResult> => {
        const issues: string[] = [];

        // Check candidate reached Offer Extended
        const candidateResult = await bridge.callTool("get_entry", { module: "Candidate", entryId: assets.candidateId }) as Record<string, unknown>;
        if (hasError(candidateResult)) {
          issues.push("get_entry failed for candidate Jamie Chen");
        } else {
          const raw = JSON.stringify(candidateResult).toLowerCase();
          if (!raw.includes("offer extended")) {
            issues.push(`Candidate state is not "Offer Extended" — got: ${JSON.stringify((candidateResult?.data as Record<string, unknown>)?.state ?? candidateResult?.state ?? "unknown")}`);
          }
          if (!raw.includes("offer") && !raw.includes("congratulations") && !raw.includes("pass")) {
            issues.push("Candidate Notes does not contain an outcome notification");
          }
        }

        // Check Interview entry reached Completed with Pass result
        // Use list_entries to find Jamie's entry ID, then get_entry for full field data
        const interviewList = await bridge.callTool("list_entries", { module: "Interview" }) as Record<string, unknown>;
        const list = (Array.isArray(interviewList?.list) ? interviewList.list : Array.isArray(interviewList) ? interviewList : []) as Array<Record<string, unknown>>;
        const jamieInterview = list.find((e) => {
          const raw = JSON.stringify(e).toLowerCase();
          return (raw.includes("jamie") || raw.includes(String(assets.candidateId))) && !raw.includes("existing candidate");
        });
        if (!jamieInterview) {
          issues.push("No Interview entry found for Jamie Chen");
        } else {
          const entryId = jamieInterview?.entryId ?? jamieInterview?.id;
          const fullEntry = await bridge.callTool("get_entry", { module: "Interview", entryId }) as Record<string, unknown>;
          const entryRaw = JSON.stringify(fullEntry).toLowerCase();
          if (!entryRaw.includes("completed")) issues.push("Interview entry state is not 'Completed'");
        }

        // ── Teardown ────────────────────────────────────────────────────────────
        const allInterviews = await bridge.callTool("list_entries", { module: "Interview" }) as Record<string, unknown>;
        const allInterviewList = (Array.isArray(allInterviews?.list) ? allInterviews.list : Array.isArray(allInterviews) ? allInterviews : []) as Array<Record<string, unknown>>;
        for (const entry of allInterviewList) {
          const id = entry?.entryId ?? entry?.id;
          if (!id) continue;
          try { await bridge.callTool("submit_activity", { module: "Interview", activity: "delete", entryId: id, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
        }
        for (const { module, entryId } of [
          { module: "Candidate",   entryId: assets.candidateId },
          { module: "Interviewer", entryId: assets.aliceId },
          { module: "Interviewer", entryId: assets.bobId },
          { module: "Interviewer", entryId: assets.carolId },
        ]) {
          try { await bridge.callTool("submit_activity", { module, activity: "delete", entryId, workspaceId: assets.workspaceId, confirmed: true, ai: AI }); } catch { /* ignore */ }
        }
        const api = new ApiBridge();
        for (const moduleId of [assets.interviewModuleId, assets.candidateModuleId, assets.interviewerModuleId].filter(Boolean)) {
          try { await api.deleteModule(assets.workspaceId, null, moduleId); } catch { /* ignore */ }
        }

        return { success: issues.length === 0, issues, hallucinated: false };
      },
    },
  ],

  teardown: async (): Promise<void> => { /* cleanup handled in task_4 verify */ },
};

module.exports = scenario;
