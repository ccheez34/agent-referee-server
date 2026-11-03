// scrub.mjs: the find skill's scrub and printing (v1 build, Nov 1, 2026). Every printed line passes
// scrubText first. No file access here: folder.mjs is the only module that touches the folder.

// 64+ hex shows only on a hash-labelled line, never on a key-word line.
export const HIDDEN = "[hidden: looks like a secret]";
const HASH_LABEL = /sha-?(1|224|256|384|512)|\bsha\b|(?<![a-z])hash(es)?(?![a-z])|digest|fingerprint|checksum|manifest|\btx(id)?\b|transaction/i;
const KEY_WORD = /private|secret|seed|mnemonic|passphrase|privkey|wallet|(?<![a-z])(?<!public[ _-])keys?(?![a-z])|signing|signer|passw(or)?d|credential|token|keystore/i, CAMEL = /[a-z0-9](Keys?|Secret|Token|Passw(or)?d|Credential|Mnemonic|Seed)(?![a-z])/;
const LISTED = /^\s*(?:[-*]\s+)?[0-9a-f]{64,}\s+\*?\S*\.[a-z0-9]{1,5}\s*$|(\.(md|txt|json|jsonl|csv|mjs|js|cjs|ts|py|ps1|sh|html|zip|pdf|lock)\b|\bv\d+(\.\d+)*\b).*`[0-9a-f]{64,}`/i;
const HEX = /(?<![0-9a-f])(?:0x)?[0-9a-f]{64,}(?![0-9a-f])/gi, HEX32 = /[0-9a-f]{32,}/gi;
const B64 = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}/g;
const PEM_BEGIN = /-----BEGIN[A-Z0-9 ]*PRIVATE KEY[A-Z0-9 ]*-----/i, PEM_END = /-----END[A-Z0-9 ]*-----/i;
const PREFIXED = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{35}|ya29\.[\w-]{20,})/g;
const BEARER = /\b(bearer)(\s+)[A-Za-z0-9._~+/=-]{16,}/gi, URLCRED = /\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)\S+@/gi; // to the last @
const ASSIGNED = /(password|passwd|pwd|passphrase|secret|token|credentials?|api[-_]?key|private[-_]?key|access[-_]?key|secret[-_]?key)(["']?\s*[:=]\s*)("[^"]*"?|'[^']*'?|[^\s"']+)/gi; // a quoted value whole
const PHRASE = /(?<![A-Za-z0-9])(mnemonic|seed|passphrase|pass[ _-]phrase|(?:seed|recovery)[ _-]?phrase)(["']?\s*[:=]\s*)(.{8,})$/gi;
const HOME_WIN = /\b[a-z]:(\\\\|\\|\/)users\1[^\\/"'`<>|\r\n]+/gi, HOME_GIT = /(?<![\w.~-])(?:\/mnt)?\/[a-z]\/users\/[^/"'`<>|\r\n]+/gi;
// Removed: zero-width, soft-hyphen and bidi characters (so they can't split a secret). Blanked: C0
// controls but tab, DEL, C1 controls, line and paragraph separators.
const ch = (...c) => String.fromCharCode(...c);
const ZW = new RegExp(`[${ch(0xad, 0x61c)}${ch(0x200b)}-${ch(0x200f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2060)}-${ch(0x2069)}${ch(0xfeff)}]`, "g");
const CTRL = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${ch(0x2028, 0x2029)}]`, "g");
const clean = (l) => String(l).replace(ZW, "").replace(CTRL, " ");

/** One line, scrubbed. */
export function scrubText(line, labelled = HASH_LABEL.test(line) || LISTED.test(line)) {
  let n = 0;
  const hide = () => (n++, HIDDEN), s = clean(line);
  if (PEM_BEGIN.test(s)) return { text: HIDDEN, hidden: 1 };
  const key = KEY_WORD.test(s) || CAMEL.test(s);
  let t = s.replace(HOME_WIN, "%USERPROFILE%").replace(HOME_GIT, "%USERPROFILE%").replace(PREFIXED, hide).replace(URLCRED, (m, a) => `${a}${hide()}@`);
  t = t.replace(BEARER, (m, w, sp) => w + sp + hide()).replace(ASSIGNED, (m, k, sep) => k + sep + hide()).replace(PHRASE, (m, k, sep, v) => k + sep + (v.startsWith(HIDDEN) ? HIDDEN : hide())); // counted once
  t = t.replace(HEX, (m) => (labelled ? m : hide())); // and on a key-word line, HEX32 below
  if (key) t = t.replace(HEX32, hide).replace(B64, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) ? hide() : m));
  return { text: t, hidden: n };
}

/** One file's lines, cleaned first: key blocks whole; labels from table headers and JSON openers naming no key. */
export function scrubber(raw) {
  const lines = raw.map(clean), pem = new Set(), ind = (l) => /^\s*/.exec(l)[0].length, ok = (l) => HASH_LABEL.test(l) && !KEY_WORD.test(l) && !CAMEL.test(l);
  for (let i = 0, open = false; i < lines.length; i++) { if (PEM_BEGIN.test(lines[i])) open = true; if (open) { pem.add(i); if (PEM_END.test(lines[i])) open = false; } }
  const tableHead = (i) => { let j = i; while (j > 0 && /^\s*\|/.test(lines[j - 1])) j--; return j < i ? lines[j] : ""; };
  const opener = (i) => {
    let j = i - 1;
    while (j >= 0 && i - j < 50 && ind(lines[j]) === ind(lines[i]) && !/[{[]\s*$/.test(lines[j])) j--;
    return j >= 0 && /[{[]\s*$/.test(lines[j]) && ind(lines[j]) < ind(lines[i]) ? lines[j] : "";
  };
  return (i) => {
    if (pem.has(i)) return { text: HIDDEN, hidden: 1 };
    const l = lines[i];
    return scrubText(l, HASH_LABEL.test(l) || LISTED.test(l) || (/^\s*\|/.test(l) && ok(tableHead(i))) || ok(opener(i)));
  };
}

// Output: only these push to ctx.out. Names and subjects are scrubbed as unlabelled text (plain).
const OUT = "(this output)";
export const cut = (s, n = 240) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const note = (ctx, rel, n) => { if (n) ctx.hidden.set(rel, (ctx.hidden.get(rel) ?? 0) + n); };
export const say = (ctx, s, rel = OUT) => { for (const l of String(s).split(/\r?\n/)) { const r = scrubText(l); note(ctx, rel, r.hidden); ctx.out.push(r.text); } };
export const plain = (ctx, s, rel = OUT) => { const r = scrubText(s, false); note(ctx, rel, r.hidden); return r.text; };
export const pathText = (ctx, rel) => plain(ctx, rel, rel);
export const sayLine = (ctx, rel, sc, i, mark, focus) => {
  const r = sc(i), at = focus ? r.text.toLowerCase().indexOf(focus) : -1;
  note(ctx, rel, r.hidden);
  const t = `${mark} ${i + 1}: ${cut(at > 160 ? "…" + r.text.slice(at - 80) : r.text)}`;
  ctx.out.push(t);
  return t.length;
};
export function page(ctx, list, fmt, next) {
  for (const m of list.slice(0, 50)) say(ctx, fmt(m), m.rel);
  if (list.length > 50) say(ctx, `${list.length - 50} more${next ? `. Next: ${next} "${plain(ctx, list[49].name, list[49].rel)}"` : " not shown"}.`);
}
export function finish(ctx) {
  const n = [...ctx.hidden.values()].reduce((a, b) => a + b, 0), files = [...ctx.hidden.keys()].filter((k) => k !== OUT);
  const where = [files.length && `in: ${files.slice(0, 5).map((k) => scrubText(k, false).text).join(", ")}${files.length > 5 ? " and more" : ""}`, ctx.hidden.has(OUT) && "in this output's own lines"].filter(Boolean);
  if (n) say(ctx, `${n} item(s) hidden as possible leaks, ${where.join("; ")}. Don't open those files to look; tell ccheez34 (rule 6).`);
  return ctx.out.join("\n") + "\n";
}
