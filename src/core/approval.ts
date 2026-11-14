import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Scenario } from "./scenario.js";

export interface ApprovalRecord { hash: string; by: string; at: string }
export type ScenarioStatus = "aprovado" | "rascunho" | "alterado";

interface ApprovalsFile { scenarios: Record<string, ApprovalRecord> }

export class Approvals {
  private constructor(private readonly file: string, private data: ApprovalsFile) {}

  static async load(root: string): Promise<Approvals> {
    const file = join(root, ".rastro", "approvals.json");
    const data: ApprovalsFile = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : { scenarios: {} };
    return new Approvals(file, data);
  }

  get(id: string): ApprovalRecord | undefined {
    return this.data.scenarios[id];
  }

  status(s: Scenario): ScenarioStatus {
    const rec = this.get(s.meta.id);
    if (!rec) return "rascunho";
    return rec.hash === s.hash ? "aprovado" : "alterado";
  }

  async approve(s: Scenario, by: string): Promise<ApprovalRecord> {
    const rec = { hash: s.hash, by, at: new Date().toISOString() };
    this.data.scenarios[s.meta.id] = rec;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2) + "\n");
    return rec;
  }

  async revoke(id: string): Promise<void> {
    delete this.data.scenarios[id];
    await writeFile(this.file, JSON.stringify(this.data, null, 2) + "\n");
  }
}
