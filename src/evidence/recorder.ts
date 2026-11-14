import { mkdir, writeFile, appendFile, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { mask } from "./mask.js";

export interface ManifestFile { path: string; sha256: string; bytes: number }

export class Evidence {
  constructor(readonly dir: string, private readonly sensitiveKeys: string[]) {}

  path(rel: string): string { return join(this.dir, rel); }

  async write(rel: string, data: string | Buffer): Promise<string> {
    const p = this.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    return rel;
  }

  async writeJson(rel: string, data: unknown): Promise<string> {
    return this.write(rel, JSON.stringify(data, null, 2) + "\n");
  }

  /** Grava com segredos e CPF/CNPJ mascarados. */
  async writeMasked(rel: string, data: unknown): Promise<string> {
    return this.writeJson(rel, this.mask(data));
  }

  mask<T>(data: T): T { return mask(data, this.sensitiveKeys); }

  async appendJsonl(rel: string, data: unknown): Promise<void> {
    const p = this.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify(this.mask(data)) + "\n");
  }

  async files(): Promise<ManifestFile[]> {
    const out: ManifestFile[] = [];
    const entries = await readdir(this.dir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const abs = join(e.parentPath ?? (e as any).path, e.name);
      const rel = relative(this.dir, abs);
      if (rel === "manifest.json") continue;
      const buf = await readFile(abs);
      out.push({ path: rel, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}

/** Confere se os arquivos da pasta batem com os hashes do manifest. */
export async function verifyEvidence(dir: string): Promise<{ ok: boolean; problems: string[] }> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  const ev = new Evidence(dir, []);
  const current = new Map((await ev.files()).map((f) => [f.path, f.sha256]));
  const problems: string[] = [];
  for (const f of manifest.files as ManifestFile[]) {
    const h = current.get(f.path);
    if (!h) problems.push(`faltando: ${f.path}`);
    else if (h !== f.sha256) problems.push(`alterado: ${f.path}`);
    current.delete(f.path);
  }
  for (const extra of current.keys()) problems.push(`não listado no manifest: ${extra}`);
  return { ok: problems.length === 0, problems };
}
