# Inistate TestBench

Benchmark AI models against Inistate workflow scenarios.

## Setup

### 1. Clone and install

```sh
npm install
```

### 2. Configure environment

Copy the example and fill in your values:

```sh
cp .env.example .env
```

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `INISTATE_API_TOKEN` | Inistate API token |
| `INISTATE_API_URL` | Inistate base URL (default: `https://app02.apps.inistate.com`) |
| `INISTATE_MCP_PATH` | Absolute path to the built Inistate MCP entry file |
| `INISTATE_DEFAULT_WORKSPACE_ID` | (Optional) Default workspace ID offered as a shortcut when selecting a workspace per scenario |

If any required value is missing, the CLI will prompt for it at startup and save it to `.env`.

### 3. Build the Inistate MCP server

The MCP server is a separate repo — clone and build it first:

```sh
git clone https://github.com/Inistate/inistate-mcp
cd inistate-mcp
npm install && npm run build
```

`INISTATE_MCP_PATH` must point to the built entry file, e.g.:

```
/Users/yourname/Documents/inistate-mcp/build/index.js
```

TestBench starts it as a child process via Node, equivalent to:

```sh
node "$INISTATE_MCP_PATH"
```

## Run

```sh
npm start
```

The CLI will prompt you to select:
- Which scenarios to run
- Which models to test (search by name, or type `all`)
- How many runs per task

### Optional flags

Set `LOG_REASONING=1` to print model reasoning tokens to the console:

```sh
LOG_REASONING=1 npm start
```

## Visualise results

```sh
npm run visualise
```

Renders a summary table of the latest results file from `results/`.

## Adding a scenario

Create a new file in `src/scenarios/`:

```typescript
import type { IBridge, Scenario } from "../types";

interface MyAssets {
  entryId: string;
}

const scenario: Scenario<MyAssets> = {
  id: "my_scenario",
  name: "My Scenario",
  description: "What this tests",

  setup: async (bridge: IBridge): Promise<MyAssets> => {
    // create entries, return assets
    return { entryId: "123" };
  },

  system: "You are an AI assistant...",

  tasks: [
    {
      id: "task_1",
      name: "Do something",
      prompt: (assets) => `Do something with entry ${assets.entryId}`,
      evaluate: (toolCalls, response) => ({
        success: true,
        issues: [],
        hallucinated: false,
      }),
    },
  ],

  teardown: async (bridge: IBridge, assets: MyAssets): Promise<void> => {
    // delete created entries
  },
};

module.exports = scenario;
```

## Adding a model

Edit `src/data/models.ts` and add to the `MODELS` array:

```typescript
{ id: "provider/model-name", name: "Display Name", price_in: 0.10, price_out: 0.20 }
```

Prices are per 1M tokens.

## Output

Results are saved to `results/YYYY-MM-DDTHH-MM-SS.json` after each run.
