import * as fs from "fs";
import * as path from "path";
import type { ScenarioResult } from "../types";

function loadJson(filePath: string): Record<string, ScenarioResult> {
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as Record<string, unknown>;
  return (raw.scenarios ?? raw) as Record<string, ScenarioResult>;
}

function mergeResults(files: string[], outPath: string): void {
  if (files.length < 2) {
    console.error("Provide at least two input files to merge.");
    process.exit(1);
  }

  const merged: Record<string, ScenarioResult> = {};

  for (const file of files) {
    const data = loadJson(file);
    for (const [scenId, scen] of Object.entries(data)) {
      if (!merged[scenId]) {
        merged[scenId] = { scenario: scen.scenario, models: {} };
      }
      for (const [modelId, runs] of Object.entries(scen.models)) {
        if (!merged[scenId].models[modelId]) {
          merged[scenId].models[modelId] = [];
        }
        merged[scenId].models[modelId].push(...runs);
      }
    }
  }

  const resolved = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(merged, null, 2));
  console.log(`Merged ${files.length} files → ${resolved}`);

  for (const [, scen] of Object.entries(merged)) {
    console.log(`\n  ${scen.scenario}`);
    for (const [modelId, runs] of Object.entries(scen.models)) {
      console.log(`    ${modelId}: ${runs.length} run(s)`);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error("Usage: npm run merge -- <file1.json> <file2.json> [...] <output.json>");
    process.exit(1);
  }
  mergeResults(args.slice(0, -1), args[args.length - 1]);
}
