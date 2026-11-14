import { cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Copia o projeto modelo de templates/init (inclui .mcp.json e o guia para agentes) sem sobrescrever nada que já exista. */
export async function initProject(dir: string): Promise<string[]> {
  const src = fileURLToPath(new URL("../templates/init", import.meta.url));
  const created: string[] = [];
  for (const e of await readdir(src, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const from = join(e.parentPath ?? (e as any).path, e.name);
    // npm não publica arquivos com ponto no início: no modelo eles se chamam dot-<nome>.
    const rel = relative(src, from).replace(/^gitignore$/, ".gitignore").replace(/(^|[\\/])dot-/g, "$1.");
    const to = join(dir, rel);
    if (existsSync(to)) continue;
    await cp(from, to, { recursive: true });
    created.push(rel);
  }
  return created;
}
