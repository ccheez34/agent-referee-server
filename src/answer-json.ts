// The JSON object in a reviewer's or judge's answer (defect 1.0-D191, owner 5.0: a single review of a JSON-handling
// function failed three times as "reviewer returned unparseable output", while a review-3 of the same text passed).
//
// The prompts ask for only a JSON object, but an answer sometimes has text around it with a brace in it, or quotes
// code inside a string with an escape JSON doesn't allow (\d, \s, a lone \u) or a raw line break. Taking the span
// from the first "{" to the last "}" then fails. This keeps that span as the first try, so every answer that parsed
// before parses the same way, and only then looks further. It never guesses: two different objects that both carry
// the answer's key are refused.

type Parsed = { ok: true; value: unknown } | { ok: false };

function tryParse(s: string): Parsed {
  if (!s) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** Every top-level balanced {...} span in the text, in order, read the way JSON reads strings and escapes. */
export function balancedObjects(text: string): string[] {
  const out: string[] = [];
  let i = text.indexOf("{");
  while (i >= 0) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let k = i; k < text.length; k++) {
      const c = text[k];
      if (inString) {
        if (c === "\\") k++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = k;
        break;
      }
    }
    if (end < 0) {
      i = text.indexOf("{", i + 1); // this brace never closes: try the next one
      continue;
    }
    out.push(text.slice(i, end + 1));
    i = text.indexOf("{", end + 1);
  }
  return out;
}

/**
 * The same text with what JSON refuses inside strings made legal: a backslash before a character JSON doesn't
 * escape becomes an escaped backslash (so "\d" reads as backslash-d), and a raw control character becomes its escape.
 * Nothing outside strings changes.
 */
export function repairJson(s: string): string {
  let out = "";
  let inString = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === "\\") {
      const n = s[k + 1] ?? "";
      if ('"\\/bfnrt'.includes(n) && n !== "") {
        out += c + n;
        k++;
      } else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(k + 2, k + 6))) {
        out += s.slice(k, k + 6);
        k += 5;
      } else out += "\\\\";
      continue;
    }
    if (c === '"') {
      inString = false;
      out += c;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
    else out += c;
  }
  return out;
}

const hasKey = (v: unknown, key: string) => !!v && typeof v === "object" && !Array.isArray(v) && key in (v as object);

/**
 * The answer object: the first "{" to the last "}" if that parses (as before); else the one top-level object that
 * parses and carries `key`; else the same after repairJson. Throws "<who> returned unparseable output" when none does,
 * and "<who> returned more than one answer" when two different objects carry `key`.
 */
export function extractAnswerObject(text: string, key: string, who: string): any {
  const span = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const first = tryParse(span);
  if (first.ok) return first.value;
  for (const repair of [false, true]) {
    const found = new Map<string, unknown>();
    for (const s of balancedObjects(text)) {
      const p = tryParse(repair ? repairJson(s) : s);
      if (p.ok && hasKey(p.value, key)) found.set(JSON.stringify(p.value), p.value);
    }
    if (found.size > 1) throw new Error(`${who} returned more than one answer`);
    if (found.size === 1) return [...found.values()][0];
  }
  const repaired = tryParse(repairJson(span));
  if (repaired.ok) return repaired.value;
  throw new Error(`${who} returned unparseable output`);
}
