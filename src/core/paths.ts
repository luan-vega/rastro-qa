/** Lê um valor por caminho: "body.items[0].id" ou "payload.discountCode". */
export function getPath(obj: unknown, path: string): unknown {
  if (path === "" || path === ".") return obj;
  // Chave literal com ponto (ex.: campo "payload.discountCode" vindo do CloudWatch)
  if (obj && typeof obj === "object" && path in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>)[path];
  }
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur === "string") {
      try { cur = JSON.parse(cur); } catch { return undefined; }
    }
    const rest = parts.slice(i).join(".");
    if (typeof cur === "object" && rest in (cur as Record<string, unknown>)) {
      return (cur as Record<string, unknown>)[rest];
    }
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

/** Converte um glob de URL (`**` e `*`) em RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
    else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
