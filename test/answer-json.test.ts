// The answer's JSON object (defect 1.0-D191): what parsed before parses the same; text around the object with braces
// in it, or an escape JSON refuses inside a string, no longer fails the review; two answers are refused, never guessed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_UNCLOSED, balancedObjects, extractAnswerObject, repairJson } from "../src/answer-json.ts";
import { parseReview } from "../src/review.ts";
import { parseVote } from "../src/judge.ts";

const ans = (verdict: string, extra = "") => `{"verdict": "${verdict}", "confidence": "high", "issues": ["one"], "reasoning": "fine${extra}"}`;

test("an answer that parsed before parses the same way, first try", () => {
  assert.equal(parseReview(ans("pass")).verdict, "pass");
  assert.equal(parseReview("Sure! " + ans("NEEDS_CHANGES") + " done").verdict, "needs_changes");
  assert.equal(parseReview("```json\n" + ans("fail") + "\n```").verdict, "fail");
  assert.throws(() => parseReview("no json at all"), /reviewer returned unparseable output/);
  assert.throws(() => parseReview(ans("approved")), /invalid verdict/, "a bad verdict is still a bad verdict");
});

test("text around the answer with a brace in it no longer fails the review", () => {
  const before = 'The function builds objects like { a: 1 } and sorts keys.\n' + ans("needs_changes");
  assert.equal(parseReview(before).verdict, "needs_changes");
  const after = ans("pass") + "\nNote: an empty input returns {} as expected.";
  assert.equal(parseReview(after).verdict, "pass");
  const both = "Reading canonicalJson({b: 2, a: 1}) first. " + ans("fail") + " (see the } above)";
  assert.equal(parseReview(both).verdict, "fail");
});

test("an escape JSON refuses, or a raw line break, inside a string is repaired, and only there", () => {
  const badEscape = '{"verdict": "needs_changes", "confidence": "medium", "issues": ["the regex /\\d+/ misses \\s"], "reasoning": "uses \\u and \\x"}';
  const v = parseReview(badEscape);
  assert.equal(v.verdict, "needs_changes");
  assert.equal(v.issues[0], "the regex /\\d+/ misses \\s", "the backslashes are kept as written");
  assert.equal(v.reasoning, "uses \\u and \\x");
  const rawBreak = '{"verdict": "pass", "confidence": "high", "issues": [], "reasoning": "line one\nline two\ttabbed"}';
  assert.equal(parseReview(rawBreak).reasoning, "line one\nline two\ttabbed");
  assert.equal(repairJson('{"a": "\\u00e9 \\" \\\\ \\/ \\n"} \\d outside'), '{"a": "\\u00e9 \\" \\\\ \\/ \\n"} \\d outside', "legal escapes and text outside strings are untouched");
});

test("two different answers are refused, never guessed; one answer quoted twice is one", () => {
  assert.throws(() => parseReview("First: " + ans("pass") + " On second thought: " + ans("fail") + " {"), /more than one answer/);
  // The same answer twice (and an unbalanced brace that forces the slower path): one answer.
  assert.equal(parseReview("{ " + ans("pass") + " again " + ans("pass")).verdict, "pass");
});

test("objects inside the answer don't count as answers of their own", () => {
  const nested = 'Intro {. {"verdict": "pass", "confidence": "high", "issues": [], "reasoning": "x", "scores": {"accuracy": 9}}';
  const v = parseReview(nested, [{ name: "accuracy", weight: 1 }]);
  assert.equal(v.verdict, "pass");
  assert.deepEqual(v.scores, { accuracy: 9 });
  assert.deepEqual(balancedObjects('a {"x": {"y": 1}} b {"z": "}"}'), ['{"x": {"y": 1}}', '{"z": "}"}'], "braces inside strings don't end an object");
});

test("the judge's parser takes the same care, with its own key", () => {
  const vote = (w: string) => `{"winner": "${w}", "reasoning": "because"}`;
  assert.equal(parseVote(vote("A"), ["A", "B"], undefined, false).winner, "A");
  assert.equal(parseVote("Party A's rule {x} wins. " + vote("B"), ["A", "B"], undefined, false).winner, "B");
  assert.throws(() => parseVote(vote("A") + " or " + vote("B") + " {", ["A", "B"], undefined, false), /judge returned more than one answer/);
  assert.throws(() => parseVote("no answer", ["A", "B"], undefined, false), /judge returned unparseable output/);
  assert.equal(extractAnswerObject('x {"winner": "A", "reasoning": "a \\d b"} y {', "winner", "judge").reasoning, "a \\d b");
});

// 5.0's read before the paid review (Nov 21): three planted bugs got past the tests above (the repair on the search
// path, the scan's escapes, the last whole-text repair), and two answers were picked between when one needed the repair.
test("an answer that needs the repair is found among text with braces in it", () => {
  const v = parseReview('Reading canonicalJson({b: 2}) first. {"verdict": "fail", "confidence": "low", "issues": ["misses \\d"], "reasoning": "a \\x b"} (see } above)');
  assert.equal(v.verdict, "fail");
  assert.equal(v.issues[0], "misses \\d", "the backslash kept as written");
});

test("two different answers are refused when only one of them needed the repair, in either order", () => {
  const a = (verdict: string, reasoning: string) => `{"verdict": "${verdict}", "confidence": "high", "issues": [], "reasoning": "${reasoning}"}`;
  assert.throws(() => parseReview(a("pass", "ok") + " On second thought: " + a("fail", "uses \\d")), /more than one answer/);
  assert.throws(() => parseReview(a("pass", "uses \\d") + " On second thought: " + a("fail", "no")), /more than one answer/);
  // the same answer written twice, once with the escape JSON refuses and once as JSON writes it, is one answer
  assert.equal(parseReview(a("pass", "uses \\d") + " again: " + a("pass", "uses \\\\d")).verdict, "pass");
});

test("an escaped quote and a brace inside a string don't end the object, on the search path", () => {
  const v = parseReview('Intro {. {"verdict": "pass", "confidence": "high", "issues": [], "reasoning": "it prints \\"} done\\" here"}');
  assert.equal(v.verdict, "pass");
  assert.equal(v.reasoning, 'it prints "} done" here');
});

test("a broken object with no answer key still reads as unparseable, as before the fix", () => {
  assert.throws(() => parseReview('{"result": {"verdict": "pass"}, "note": "uses \\d"}'), /reviewer returned unparseable output/);
});

test("the search stops after MAX_UNCLOSED braces that never close, so the work stays linear", () => {
  const ans = '{"verdict": "pass", "confidence": "high", "issues": [], "reasoning": "ok"}';
  assert.equal(parseReview("{ ".repeat(MAX_UNCLOSED - 1) + ans).verdict, "pass", "fewer than the limit: found");
  assert.throws(() => parseReview("{ ".repeat(MAX_UNCLOSED) + ans), /unparseable output/, "at the limit: the search stops");
  const t0 = performance.now();
  assert.throws(() => parseReview("{".repeat(40_000) + " " + ans), /unparseable output/);
  assert.ok(performance.now() - t0 < 1_000, "40,000 unclosed braces end quickly (about 2 s before the limit)");
});
