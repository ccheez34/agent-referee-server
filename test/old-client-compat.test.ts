// The published v0.2.0 client (no ack support) must work unchanged against the new server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { randomToken } from "../src/logic.ts";
// @ts-ignore plain JS
import { AgentReferee as OldClient } from "./fixtures/agent-referee-client-0.2.0.mjs";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };

test("v0.2.0 client plays weighted and rps-bo3 against the new server with check.ok true", async () => {
  for (const input of [
    { tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 70, beta: 30 } },
    { tier: "rps-bo3", seats: ["alpha", "beta"] },
  ]) {
    const data = new Map<string, unknown>();
    const state = { storage: { async get(k: string) { return structuredClone(data.get(k)); }, async put(k: string, v: unknown) { data.set(k, structuredClone(v)); }, async deleteAll() { data.clear(); }, async setAlarm() {} } };
    const r = new MatchRoom(state as any, { ...keys, CLAUDE_JUDGES_ENABLED: "true" } as any);
    const call = async (action: string, body?: unknown) => (await (await r.fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }))).json()) as any;
    const id = randomToken(12);
    await call("create", { id, input });
    const fetch = async (url: string, init: any = {}) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : undefined;
      const out = path.startsWith("/join/") ? await call("join", { seat: body.seat, tier: path.split("/")[2], paid: true })
        : path.endsWith("/commit") ? await call("commit", body)
        : path.endsWith("/reveal") ? await call("reveal", body)
        : await call("status");
      return new Response(JSON.stringify(out), { status: out.error ? 400 : 200 });
    };
    const ref = new OldClient({ url: "https://ref.test", fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
    const [a, b] = await Promise.all([ref.join(id, "alpha"), ref.join(id, "beta")]);
    const [sa, sb] = await Promise.all([a.play(), b.play()]);
    assert.equal(sa.phase, "done");
    assert.deepEqual([sa.check.ok, sb.check.ok, sa.check.signed], [true, true, true], JSON.stringify(sa.check));
  }
});
