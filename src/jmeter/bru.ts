// Leitor mínimo de arquivos .bru (Bruno): método, url, headers, auth bearer e body:json.

export interface BruRequest {
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bearer?: string;
  body?: string;
}

function blocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^([a-z:\-]+)\s*\{\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1, i = re.lastIndex;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    out.set(m[1].toLowerCase(), text.slice(re.lastIndex, i - 1).replace(/^\n|\n\s*$/g, ""));
    re.lastIndex = i;
  }
  return out;
}

function kv(body = ""): Record<string, string> {
  return Object.fromEntries(body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("~")).map((l) => {
    const i = l.indexOf(":");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
}

export function parseBru(text: string): BruRequest {
  const b = blocks(text.replace(/\r\n/g, "\n"));
  const method = ["get", "post", "put", "patch", "delete", "options", "head"].find((v) => b.has(v));
  if (!method) throw new Error("Arquivo .bru sem bloco de método (get/post/put/...)");
  const req = kv(b.get(method));
  const body = b.get("body:json");
  return {
    name: kv(b.get("meta")).name ?? method.toUpperCase(),
    method: method.toUpperCase(),
    url: req.url,
    headers: kv(b.get("headers")),
    bearer: kv(b.get("auth:bearer")).token,
    body: body?.split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n"),
  };
}
