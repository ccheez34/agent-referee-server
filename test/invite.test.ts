// Invite matches: one agent (the host) pays for both seats; the other joins free with an invite link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatchRoom } from "../src/match.ts";
import { randomToken, validateCreate, doublePrice } from "../src/logic.ts";
import { signReceipt } from "../src/receipt.ts";
// @ts-ignore plain JS client
import { AgentReferee, verifyOutcome } from "agent-referee-client";

const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const b64 = (b: ArrayBuffer) => Buffer.from(b).toString("base64");
const keys = { SIGNING_KEY: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), PUBLIC_KEY: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
const HOST_WALLET = "0x" + "a".repeat(40);

/** The real match rooms behind a fake HTTP service that mirrors the worker's routes (payments faked). */
function service(extraEnv: Record<string, unknown> = {}) {
  const rooms = new Map<string, MatchRoom>();
  const env: any = { ...keys, JOIN_WAIT_SECONDS: "1", CLAUDE_JUDGES_ENABLED: "true", ...extraEnv };
  const roomFor = (name: string) => {
    if (!rooms.has(name)) {
      const data = new Map<string, unknown>();
      const state = { storage: { async get(k: string) { return structuredClone(data.get(k)); }, async put(k: string, v: unknown) { data.set(k, structuredClone(v)); }, async deleteAll() { data.clear(); }, async setAlarm() {} } };
      rooms.set(name, new MatchRoom(state as any, env));
    }
    return rooms.get(name)!;
  };
  const call = async (id: string, action: string, body?: unknown) => {
    const res = await roomFor(id).fetch(new Request(`https://match/${action}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as any };
  };
  const paidJoins: string[] = []; // paths of joins that actually charged (succeeded)
  const fetch = async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    let out;
    if (path === "/matches" && init.method === "POST") {
      const id = randomToken(12);
      out = await call(id, "create", { id, input: body });
      if (out.status === 201 && out.body.invite) out.body.invite.url = `https://ref.test/invite/${id}?token=${out.body.invite.invite_token}`;
    } else if (/^(\/demo)?\/host\/join\//.test(path)) {
      const demo = path.startsWith("/demo");
      const tier = path.split("/").pop();
      out = await call(body.match_id, "join", { seat: body.seat, tier, role: "host", paid: !demo, payer: demo ? undefined : HOST_WALLET, payments_enabled: !demo, demo, wait: true });
      if (out.status < 400 && !demo) paidJoins.push(path);
    } else if (/^(\/demo)?\/join\//.test(path)) {
      const demo = path.startsWith("/demo");
      out = await call(body.match_id, "join", { seat: body.seat, tier: path.split("/").pop(), role: "party", paid: !demo, payments_enabled: !demo, demo, wait: true });
    } else if (path === "/invite/join") {
      out = await call(body.match_id, "join", { role: "guest", invite_token: body.invite_token, seat: body.seat });
    } else if (path.startsWith("/invite/")) {
      const st = await call(path.split("/").pop()!, "status");
      out = { status: st.status, body: { invite: "(as the worker says)", match: st.body } }; // the worker wraps the status like this
    } else {
      const [, , id, action] = path.split("/");
      out = action ? await call(id, action, body) : await call(id, "status");
    }
    return new Response(JSON.stringify(out.body), { status: out.status });
  };
  return { fetch, call, paidJoins };
}

const client = (svc: ReturnType<typeof service>, demo = false) =>
  new AgentReferee({ url: "https://ref.test", fetch: svc.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY], demo });

test("doublePrice covers both seats", () => {
  assert.deepEqual(["$0.01", "$0.015", "$0.02", "$0.15", "$0.25", "$0.50"].map(doublePrice), ["$0.02", "$0.03", "$0.04", "$0.3", "$0.5", "$1"]);
});

test("validation: host_pays must name a seat, can't use a shared key, isn't for draw, and only the host's seat can be wallet-locked", () => {
  const ok = validateCreate({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, host_pays: "alpha" });
  assert.equal(ok.ok, true);
  const bad = (b: any, re: RegExp) => {
    const v = validateCreate(b);
    assert.equal(v.ok, false);
    assert.match((v as any).error, re);
  };
  bad({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, host_pays: "gamma" }, /must be the seat/);
  bad({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, host_pays: "alpha", key: "shared-key-1" }, /can't use a shared key/);
  bad({ tier: "draw", seats: ["a", "b"], options: ["x", "y"], host_pays: "a" }, /mediator pays/);
  bad({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, host_pays: "alpha", seat_wallets: { beta: HOST_WALLET } }, /only the host's seat/);
});

test("invite: guest accepts the link first, host pays for both, the match plays out and both receipts check out", async () => {
  const svc = service();
  const host = client(svc), guest = client(svc);
  const m = await host.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 50, beta: 50 }, hostPays: "alpha" });
  assert.equal(m.host_pays, "alpha");
  assert.equal(m.invite.seat, "beta");
  assert.match(m.invite.url, /^https:\/\/ref\.test\/invite\/[a-f0-9]{24}\?token=/);
  // the token is never in the public status
  const st = await svc.call(m.match_id, "status");
  assert.equal(JSON.stringify(st.body).includes(m.invite.invite_token), false);

  const preview = await guest.openInvite(m.invite.url);
  assert.equal(preview.match.host_pays, "alpha");

  const pGuest = guest.acceptInvite(m.invite.url); // joins free, then waits for the host
  await new Promise((r) => setTimeout(r, 20));
  const a = await host.join(m.match_id, "alpha");
  const b = await pGuest;
  assert.equal(b.seat, "beta");
  const [ra, rb] = await Promise.all([a.play(), b.play()]);
  for (const r of [ra, rb]) assert.equal(r.check.ok, true, JSON.stringify(r.check));
  assert.equal(ra.receipt.payload.host_pays, "alpha");
  assert.deepEqual(ra.receipt.payload.paid_by, { alpha: HOST_WALLET }, "only the host paid");
  assert.deepEqual(svc.paidJoins, ["/host/join/weighted"], "one payment, at the host route (double price)");
  assert.equal((await verifyOutcome(rb.receipt, { seat: rb.seat ?? undefined })).ok, true);
});

test("invite: host joins first and waits; the guest arriving settles it. A host that times out is never charged", async () => {
  const svc = service();
  const host = client(svc), guest = client(svc);
  const m = await host.create({ tier: "rps", seats: ["alpha", "beta"], hostPays: "alpha" });

  // nobody comes: every 1-second wait ends in a released seat and no charge
  await assert.rejects(host.join(m.match_id, "alpha", { inviteWaitMs: 2000 }), (e: any) => e.status === 408 && /invite still works/.test(e.message));
  assert.deepEqual(svc.paidJoins, []);

  // try again; the guest shows up while the host is waiting
  const pHost = host.join(m.match_id, "alpha");
  await new Promise((r) => setTimeout(r, 50));
  const b = await guest.acceptInvite({ match_id: m.match_id, invite_token: m.invite.invite_token });
  const a = await pHost;
  const [ra, rb] = await Promise.all([a.play(), b.play()]);
  assert.equal(ra.check.ok && rb.check.ok, true);
  assert.deepEqual(svc.paidJoins, ["/host/join/rps"]);
});

test("invite: wrong token, wrong seat, the normal paid route, and rematch are all refused; links to another service are rejected", async () => {
  const svc = service();
  const host = client(svc), guest = client(svc);
  const m = await host.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, hostPays: "alpha" });
  const wrong = await svc.call(m.match_id, "join", { role: "guest", invite_token: "nope" });
  assert.equal(wrong.status, 403);
  const party = await svc.call(m.match_id, "join", { seat: "beta", tier: "weighted", role: "party", paid: true, wait: true });
  assert.equal(party.status, 400, "the guest seat can't be bought at the normal route");
  assert.match(party.body.error, /invite match/);
  await assert.rejects(guest.join(m.match_id, "beta"), /acceptInvite/);
  await assert.rejects(guest.acceptInvite(`https://evil.example/invite/${m.match_id}?token=${m.invite.invite_token}`), /different service/);
  // a normal match refuses the host route
  const plain = await host.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 } });
  const hostOnPlain = await svc.call(plain.match_id, "join", { seat: "alpha", tier: "weighted", role: "host", paid: true, wait: true });
  assert.equal(hostOnPlain.status, 400);
  // play it out, then rematch is refused
  const pGuest = guest.acceptInvite(m.invite.url);
  const a = await host.join(m.match_id, "alpha");
  const b = await pGuest;
  await Promise.all([a.play(), b.play()]);
  const re = await svc.call(m.match_id, "rematch", { seat: "alpha", seat_token: a.token });
  assert.equal(re.status, 400);
  assert.match(re.body.error, /invite matches/);
});

test("invite works in free demo matches too", async () => {
  const svc = service();
  const host = client(svc, true), guest = client(svc, true);
  const m = await host.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 70, beta: 30 }, hostPays: "alpha" });
  const pGuest = guest.acceptInvite(m.invite.url);
  const a = await host.join(m.match_id, "alpha");
  const b = await pGuest;
  const [ra, rb] = await Promise.all([a.play(), b.play()]);
  assert.equal(ra.check.ok && rb.check.ok, true);
  assert.equal(ra.receipt.payload.demo, true);
  assert.deepEqual(svc.paidJoins, []);
});

test("a receipt claiming a different payer than the agent agreed to fails the settings check", async () => {
  const svc = service();
  const host = client(svc), guest = client(svc);
  const m = await host.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, hostPays: "alpha" });
  const pGuest = guest.acceptInvite(m.invite.url);
  const a = await host.join(m.match_id, "alpha");
  const b = await pGuest;
  const [, rb] = await Promise.all([a.play(), b.play()]);
  // Validly signed (the test holds the key), but it no longer says the host paid: only the settings check can catch it.
  const payload = structuredClone(rb.receipt.payload);
  delete payload.host_pays;
  const resigned = await signReceipt(payload, keys.SIGNING_KEY, keys.PUBLIC_KEY);
  const check = await b._check(resigned);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p: string) => /payer \(host_pays\)/.test(p)), JSON.stringify(check.problems));
});

test("an invite link from either official address works with a client on the other one; other services are still refused", async () => {
  const svc = service();
  const host = client(svc);
  const m = await host.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 1, beta: 1 }, host_pays: "alpha" });
  // guest's client uses the original address; the link it got uses the new domain (and the reverse)
  const onOld = new AgentReferee({ url: "https://agent-referee.fairplayclub.workers.dev", fetch: svc.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
  const onNew = new AgentReferee({ url: "https://agentreferee.ai", fetch: svc.fetch, pollMs: 1, publicKeys: [keys.PUBLIC_KEY] });
  const t = m.invite.invite_token;
  assert.equal((await onOld.openInvite(`https://agentreferee.ai/invite/${m.match_id}?token=${t}`)).match.host_pays, "alpha");
  assert.equal((await onNew.openInvite(`https://agent-referee.fairplayclub.workers.dev/invite/${m.match_id}?token=${t}`)).match.host_pays, "alpha");
  await assert.rejects(onOld.openInvite(`https://agentreferee.evil/invite/${m.match_id}?token=${t}`), /different service/);
  const pGuest = onOld.acceptInvite(`https://agentreferee.ai/invite/${m.match_id}?token=${t}`);
  const a = await host.join(m.match_id, "alpha");
  const b = await pGuest;
  const [ra, rb] = await Promise.all([a.play(), b.play()]);
  assert.equal(ra.check.ok && rb.check.ok, true);
});
