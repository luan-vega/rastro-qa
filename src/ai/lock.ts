import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Dialect, QueryMode } from "./types.js";

export interface LockEntry {
  scenario: string;
  step: string;
  dialect: Dialect;
  mode: QueryMode;
  intent: string;
  query: string;            // com {{correlationId}} no lugar do valor da execução
  expectedFields: string[];
  rationale: string;
  model: string;
  createdAt: string;
  approved?: { by: string; at: string };
}

interface LockFile { version: 1; entries: Record<string, LockEntry> }

export function lockKey(parts: { scenario: string; step: string; dialect: string; intent: string }): string {
  return createHash("sha256").update([parts.scenario, parts.step, parts.dialect, parts.intent.trim()].join("\0")).digest("hex").slice(0, 12);
}

export class QueryLock {
  private constructor(private readonly file: string, private data: LockFile) {}

  static async load(root: string, rel: string): Promise<QueryLock> {
    const file = join(root, rel);
    const data: LockFile = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : { version: 1, entries: {} };
    return new QueryLock(file, data);
  }

  get(key: string): LockEntry | undefined { return this.data.entries[key]; }
  entries(): [string, LockEntry][] { return Object.entries(this.data.entries); }

  async put(key: string, entry: LockEntry): Promise<void> {
    this.data.entries[key] = entry;
    await this.save();
  }

  async approve(key: string, by: string): Promise<LockEntry> {
    const e = this.data.entries[key];
    if (!e) throw new Error(`Query ${key} não existe no lock`);
    e.approved = { by, at: new Date().toISOString() };
    await this.save();
    return e;
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2) + "\n");
  }
}
