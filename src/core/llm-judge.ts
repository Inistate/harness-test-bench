import type { EvaluationResult, ToolCall } from "../types";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const JUDGE_MODEL = "google/gemini-flash-1.5";

export async function judge(
  taskName: string,
  taskPrompt: string,
  criteria: string,
  toolCalls: ToolCall[],
  response: string,
  openRouterKey: string
): Promise<EvaluationResult> {
  const system = `You are an impartial benchmark evaluator. Assess whether an AI model met the given criteria.
Respond with JSON only — no prose, no markdown fences.
Schema: {"success": boolean, "issues": string[], "hallucinated": boolean}
- success: true if the model fully satisfied the criteria
- issues: specific problems found (empty array if success)
- hallucinated: true if the model stated facts not supported by the tool results`;

  const userMsg = `Task: ${taskName}
Prompt given to model:
${taskPrompt}

Evaluation criteria:
${criteria}

Tool calls (name → arguments → result):
${JSON.stringify(toolCalls.map((t) => ({ name: t.name, arguments: t.arguments, result: t.result })), null, 2)}

Model response:
${response}`;

  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openRouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Judge LLM error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  try {
    return JSON.parse(data.choices[0]?.message?.content ?? "{}") as EvaluationResult;
  } catch {
    return { success: false, issues: ["Judge failed to parse LLM response"], hallucinated: false };
  }
}
