import type { Model } from "../types";

const PROVIDERS = ["anthropic", "openai", "xai", "deepseek", "qwen", "moonshotai", "moonshot", "minimax"];

export async function loadModels(apiKey: string): Promise<Model[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as {
      data: Array<{ id: string; name: string; pricing: { prompt: string; completion: string } }>;
    };

    const dynamic: Model[] = data.data
      .filter((m) => PROVIDERS.some((p) => m.id.startsWith(p + "/")) && !m.id.includes(":"))
      .map((m) => ({
        id: m.id,
        name: m.name,
        price_in:  Number((parseFloat(m.pricing.prompt) * 1e6).toFixed(2)),
        price_out: Number((parseFloat(m.pricing.completion) * 1e6).toFixed(2)),
      }));

    const local = MODELS.filter((m) => m.local);
    return [...dynamic, ...local];
  } catch {
    return MODELS;
  }
}

export const MODELS: Model[] = [
  // Anthropic Claude
  { id: "anthropic/claude-opus-4.8",   name: "Claude Opus 4.8",   price_in: 5.00,  price_out: 25.00 },
  { id: "anthropic/claude-opus-4.7",   name: "Claude Opus 4.7",   price_in: 15.00, price_out: 75.00 },
  { id: "anthropic/claude-opus-4.6",   name: "Claude Opus 4.6",   price_in: 15.00, price_out: 75.00 },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", price_in: 3.00,  price_out: 15.00 },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", price_in: 3.00,  price_out: 15.00 },
  { id: "anthropic/claude-haiku-4.5",  name: "Claude Haiku 4.5",  price_in: 1.00,  price_out: 5.00  },

  // OpenAI GPT / Reasoning
  { id: "openai/gpt-5",       name: "GPT-5",       price_in: 5.00,  price_out: 15.00 },
  { id: "openai/gpt-5-mini",  name: "GPT-5 Mini",  price_in: 0.60,  price_out: 2.40  },
  { id: "openai/gpt-5-nano",  name: "GPT-5 Nano",  price_in: 0.15,  price_out: 0.60  },
  { id: "openai/gpt-4.1",     name: "GPT-4.1",     price_in: 2.00,  price_out: 8.00  },
  { id: "openai/gpt-4.1-mini",name: "GPT-4.1 Mini",price_in: 0.40,  price_out: 1.60  },
  { id: "openai/gpt-4.1-nano",name: "GPT-4.1 Nano",price_in: 0.10,  price_out: 0.40  },
  { id: "openai/o3",          name: "o3",           price_in: 10.00, price_out: 40.00 },
  { id: "openai/o3-mini",     name: "o3 Mini",      price_in: 1.10,  price_out: 4.40  },
  { id: "openai/o4-mini",     name: "o4 Mini",      price_in: 1.10,  price_out: 4.40  },

  // xAI Grok
  { id: "xai/grok-3",      name: "Grok 3",      price_in: 5.00, price_out: 15.00 },
  { id: "xai/grok-3-mini", name: "Grok 3 Mini", price_in: 0.30, price_out: 0.50  },
  { id: "xai/grok-2",      name: "Grok 2",      price_in: 2.00, price_out: 10.00 },

  // Moonshot Kimi
  { id: "moonshotai/kimi-k2.5",    name: "Kimi K2.5",      price_in: 0.40, price_out: 1.90  },
  { id: "moonshot/kimi-1.5",       name: "Kimi 1.5",        price_in: 1.00, price_out: 3.00  },
  { id: "moonshot/kimi-thinking",  name: "Kimi Thinking",   price_in: 4.00, price_out: 12.00 },

  // DeepSeek
  { id: "deepseek/deepseek-r1",        name: "DeepSeek R1",       price_in: 0.55,  price_out: 2.19 },
  { id: "deepseek/deepseek-v3",        name: "DeepSeek V3",       price_in: 0.27,  price_out: 1.10 },
  { id: "deepseek/deepseek-v4-pro",    name: "DeepSeek V4 Pro",   price_in: 0.435, price_out: 0.87 },
  { id: "deepseek/deepseek-chat",      name: "DeepSeek Chat",     price_in: 0.27,  price_out: 1.10 },
  { id: "deepseek/deepseek-coder-v2",  name: "DeepSeek Coder V2", price_in: 0.14,  price_out: 0.28 },

  // Alibaba Qwen
  { id: "qwen/qwen3.7-max", name: "Qwen 3.7 Max", price_in: 2.50, price_out: 7.50 },
  { id: "qwen/qwen-max",    name: "Qwen Max",      price_in: 1.60, price_out: 6.40 },
  { id: "qwen/qwen-plus",   name: "Qwen Plus",     price_in: 0.40, price_out: 1.20 },
  { id: "qwen/qwen-turbo",  name: "Qwen Turbo",    price_in: 0.05, price_out: 0.20 },

  // MiniMax
  { id: "minimax/minimax-m2.5", name: "MiniMax M2.5", price_in: 0.15, price_out: 1.15 },

  // Local models (served via mlx_lm at LOCAL_BASE_URL)
  { id: "qwen3-coder-30b-local", name: "Qwen3-Coder 30B (local)", price_in: 0, price_out: 0, local: true},
];
