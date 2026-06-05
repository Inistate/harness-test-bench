import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tool } from "@openrouter/agent";
import type { Tool } from "@openrouter/agent";
import { z } from "zod";
import type { IBridge } from "../types";

interface McpToolSchema {
  type?: string;
  properties?: Record<string, McpFieldSchema>;
  required?: string[];
}

interface McpFieldSchema {
  type?: string;
  description?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: McpToolSchema;
}

interface McpCallResult {
  content?: Array<{ type: string; text?: string }>;
}

export class MCPBridge implements IBridge {
  private mcpPath: string;
  private mcpEnv: Record<string, string>;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  agentTools: Tool[] = [];
  rawTools: McpTool[] = [];

  constructor(mcpPath: string, mcpEnv: Record<string, string>) {
    this.mcpPath = mcpPath;
    this.mcpEnv = mcpEnv;
  }

  async connect(): Promise<Tool[]> {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.mcpPath],
      env: { ...process.env, ...this.mcpEnv } as Record<string, string>,
    });

    this.client = new Client(
      { name: "testbench", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);

    const { tools } = await this.client.listTools();
    this.rawTools = tools as McpTool[];
    this.agentTools = this._convertTools(this.rawTools);

    return this.agentTools;
  }

  private _convertTools(mcpTools: McpTool[]): Tool[] {
    const bridge = this;

    return mcpTools.map((mcpTool) => {
      const buildZodSchema = (schema?: McpToolSchema) => {
        if (!schema?.properties) return z.object({}).passthrough();
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, val] of Object.entries(schema.properties)) {
          let field: z.ZodTypeAny;
          switch (val.type) {
            case "string":  field = z.string(); break;
            case "number":
            case "integer": field = z.number(); break;
            case "boolean": field = z.boolean(); break;
            case "array":   field = z.array(z.unknown()); break;
            case "object":  field = z.record(z.string(), z.unknown()); break;
            default:        field = z.unknown();
          }
          if (val.description) field = field.describe(val.description);
          if (!(schema.required ?? []).includes(key)) field = field.optional();
          shape[key] = field;
        }
        return z.object(shape).passthrough();
      };

      return tool({
        name: mcpTool.name,
        description: mcpTool.description ?? mcpTool.name,
        inputSchema: buildZodSchema(mcpTool.inputSchema),
        execute: async (params: Record<string, unknown>) => {
          try {
            const result = await bridge.client!.callTool({
              name: mcpTool.name,
              arguments: params,
            }) as McpCallResult;
            const text = result.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            try {
              return JSON.parse(text ?? "");
            } catch {
              return { result: text };
            }
          } catch (e) {
            return { error: (e as Error).message };
          }
        },
      });
    });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client!.callTool({ name, arguments: args }) as McpCallResult;
    const text = result.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    try {
      return JSON.parse(text ?? "");
    } catch {
      return { result: text };
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
  }
}
