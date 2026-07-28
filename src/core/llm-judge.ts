import type { EvaluationResult, ToolCall } from "../types";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_JUDGE_MODEL = "deepseek/deepseek-v4-flash";

/** Evaluate a model's task execution against given criteria using an LLM judge. */
export async function judge(
  taskName: string,
  taskPrompt: string,
  criteria: string,
  toolCalls: ToolCall[],
  response: string,
  openRouterKey: string,
  judgeModel: string,
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
      model: judgeModel,
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
    const result = JSON.parse(
      data.choices[0]?.message?.content ?? "{}",
    ) as EvaluationResult;
    return {
      ...result,
      issues: (result.issues ?? []).map((issue) =>
        /^Layer [123]:/i.test(issue) ? issue : `Layer 2: ${issue}`
      ),
    };
  } catch {
    return {
      success: false,
      issues: ["Layer 2: judge failed to parse LLM response"],
      hallucinated: false,
    };
  }
}
