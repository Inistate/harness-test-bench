const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const envLevel: Level = (process.env.LOG_LEVEL?.toLowerCase() as Level) ?? "info";
const currentIdx = LEVELS.indexOf(envLevel);

function emit(level: Level, ...args: unknown[]): void {
  if (LEVELS.indexOf(level) < currentIdx) return;
  const prefix = level === "debug" ? "[debug]" : level === "warn" ? "[warn]" : level === "error" ? "[error]" : "";
  if (prefix) {
    console[level === "error" ? "error" : "log"](prefix, ...args);
  } else {
    console.log(...args);
  }
}

/** Logger with level gating controlled by the LOG_LEVEL env var (default: info). */
export const logger = {
  debug: (...args: unknown[]) => emit("debug", ...args),
  info:  (...args: unknown[]) => emit("info", ...args),
  warn:  (...args: unknown[]) => emit("warn", ...args),
  error: (...args: unknown[]) => emit("error", ...args),
};
