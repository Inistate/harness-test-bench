# Inistate TestBench

Benchmark AI models against Inistate workflow scenarios.

## Setup

```zsh
npm install

export OPENROUTER_API_KEY=your_openrouter_key
export INISTATE_API_TOKEN=your_inistate_token
export INISTATE_API_URL=https://app02.apps.inistate.com
export INISTATE_MCP_PATH=/Users/yourname/Documents/inistate-mcp/build/index.js
```

The Inistate MCP server is a separate repo — clone and build it first:

```zsh
git clone https://github.com/Inistate/inistate-mcp
cd inistate-mcp
npm install && npm run build
```

`INISTATE_MCP_PATH` must point to the built entry file. TestBench starts it as a child process with Node, equivalent to:

```zsh
node "$INISTATE_MCP_PATH"
```

There are two ways to provide these values:

- **CLI prompts:** run `node index.js` and paste missing values when prompted.
- **Environment variables:** export the values before running `node index.js`, as shown above.

If the OpenRouter API key, Inistate token, Inistate base URL, or MCP path is missing, the CLI will prompt for it at startup.

## Reproducible local run

Use an explicit environment block so the same run can be repeated later:

```zsh
cd /path/to/TestBench

export OPENROUTER_API_KEY="sk-or-v1-..."
export INISTATE_API_TOKEN="your_inistate_token"
export INISTATE_API_URL="https://app02.apps.inistate.com"
export INISTATE_MCP_PATH="/absolute/path/to/inistate-mcp/build/index.js"

test -f "$INISTATE_MCP_PATH"
node --check "$INISTATE_MCP_PATH"
node index.js
```

For this workspace, the default MCP path is:

```zsh
export INISTATE_MCP_PATH="$HOME/Documents/inistate-mcp/build/index.js"
```

You can inspect where the MCP path is read and passed through with:

```zsh
rg "INISTATE_MCP_PATH|MCP_PATH|mcpPath"
```

## Run

```zsh
node index.js
```

CLI will prompt you to select:
- Which scenarios to run
- Which models to test
- How many runs per task, entered manually
- The Inistate base URL if you want to override the default

## Adding a scenario

Create a new file in `scenarios/`:

```javascript
module.exports = {
  id: "my_scenario",
  name: "My Scenario",
  description: "What this tests",

  setup: async (mcpBridge) => {
    // create entries, return assets
    return { entryId: 123 };
  },

  system: "You are an AI assistant...",

  tasks: [
    {
      id: "task_1",
      name: "Do something",
      prompt: (assets) => `Do something with entryId ${assets.entryId}`,
      evaluate: (toolCalls, response) => ({
        success: true/false,
        issues: [],
        hallucinated: false
      })
    }
  ],

  teardown: async (mcpBridge, assets) => {
    // delete created entries
  }
};
```

## Adding a model

Edit `models.js` and add to the MODELS array:

```javascript
{ id: "provider/model-name", name: "Display Name", price_in: 0.10, price_out: 0.20 }
```

## Output

Results saved to `results/YYYY-MM-DDTHH-MM-SS.json` after each run.
