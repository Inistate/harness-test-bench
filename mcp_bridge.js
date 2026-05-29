const { spawn } = require("child_process");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { z } = require("zod");

class MCPBridge {
  constructor(mcpPath, mcpEnv) {
    this.mcpPath = mcpPath;
    this.mcpEnv = mcpEnv;
    this.client = null;
    this.transport = null;
    this.agentTools = []; // OpenRouter agent tool() objects
    this.rawTools = [];   // raw MCP tool definitions
  }

  async connect() {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.mcpPath],
      env: { ...process.env, ...this.mcpEnv },
    });

    this.client = new Client(
      { name: "testbench", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);

    const { tools } = await this.client.listTools();
    this.rawTools = tools;
    this.agentTools = this._convertTools(tools);

    return this.agentTools;
  }

  _convertTools(mcpTools) {
    const { tool } = require("@openrouter/agent");

    return mcpTools.map((mcpTool) => {
      const bridge = this;

      // Build zod schema from MCP inputSchema
      const buildZodSchema = (schema) => {
        if (!schema || !schema.properties) return z.object({}).passthrough();
        const shape = {};
        for (const [key, val] of Object.entries(schema.properties)) {
          let fieldSchema;
          switch (val.type) {
            case "string":
              fieldSchema = z.string();
              break;
            case "number":
            case "integer":
              fieldSchema = z.number();
              break;
            case "boolean":
              fieldSchema = z.boolean();
              break;
            case "array":
              fieldSchema = z.array(z.any());
              break;
            case "object":
              fieldSchema = z.record(z.any());
              break;
            default:
              fieldSchema = z.any();
          }
          if (val.description) fieldSchema = fieldSchema.describe(val.description);
          const required = schema.required || [];
          if (!required.includes(key)) fieldSchema = fieldSchema.optional();
          shape[key] = fieldSchema;
        }
        return z.object(shape).passthrough();
      };

      return tool({
        name: mcpTool.name,
        description: mcpTool.description || mcpTool.name,
        inputSchema: buildZodSchema(mcpTool.inputSchema),
        execute: async (params) => {
          try {
            const result = await bridge.client.callTool({
              name: mcpTool.name,
              arguments: params,
            });
            // MCP returns content array — extract text
            const text = result.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            try {
              return JSON.parse(text);
            } catch {
              return { result: text };
            }
          } catch (e) {
            return { error: e.message };
          }
        },
      });
    });
  }

  async callTool(name, args) {
    const result = await this.client.callTool({ name, arguments: args });
    const text = result.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    try {
      return JSON.parse(text);
    } catch {
      return { result: text };
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
    }
  }
}

module.exports = { MCPBridge };
