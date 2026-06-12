export interface Model {
  id: string;
  name: string;
  price_in: number;
  price_out: number;
  local?: boolean;
}

export interface McpEnv {
  INISTATE_API_TOKEN: string;
  INISTATE_API_URL: string;
  INISTATE_WORKSPACE_ID: string;
  INISTATE_MCP_MODE: string;
}

export interface ResolvedConfig {
  openRouterKey: string;
  mcpPath: string;
  mcpEnv: McpEnv;
}

export interface BenchmarkConfig {
  scenarios: Scenario[];
  models: Model[];
  runs: number;
  mcpPath: string;
  mcpEnv: McpEnv;
  openRouterKey: string;
  logReasoning?: boolean;
  scenarioWorkspaces: Record<string, string>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface EvaluationResult {
  success: boolean;
  issues: string[];
  hallucinated: boolean;
}

export interface TaskResult {
  skipped: boolean;
  reason?: string;
  success?: boolean;
  issues?: string[];
  hallucinated?: boolean;
  latency_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  tool_calls?: string[];
  tool_call_details?: ToolCall[];
  response_preview?: string;
}

export interface ModelRunResult {
  model: string;
  tasks: Record<string, TaskResult>;
  score: number;
  total: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  total_tool_calls: number;
  avg_latency_ms: number;
  skipped: boolean;
  skip_reason?: string;
}

export interface ScenarioResult {
  scenario: string;
  models: Record<string, ModelRunResult[]>;
}

export interface Task<TAssets> {
  id: string;
  name: string;
  prompt: string | ((assets: TAssets) => string);
  evaluate: (toolCalls: ToolCall[], response: string) => EvaluationResult;
  verify?: (bridge: IBridge, assets: TAssets) => Promise<EvaluationResult>;
  maxSteps?: number;
  setup?: (bridge: IBridge, assets: TAssets) => Promise<void>;
}

/** Minimal bridge interface used by scenario setup/teardown — avoids circular imports. */
export interface IBridge {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface GeneratedTask {
  id: string;
  name: string;
  prompt: string;
  setupPrompt?: string;
  checks: string[];
  ai?: string;
  maxSteps?: number;
}

export interface GeneratedScenario {
  id: string;
  name: string;
  description?: string;
  system: string;
  setupPrompt: string;
  tasks: GeneratedTask[];
}

export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}


export interface Scenario<TAssets = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  system: string | ((assets: TAssets) => string);
  setup: (bridge: IBridge, workspaceId: string) => Promise<TAssets>;
  tasks: Task<TAssets>[];
  teardown: (bridge: IBridge, assets: TAssets) => Promise<void>;
}
