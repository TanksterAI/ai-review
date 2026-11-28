import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemory, searchTerms, cleanLesson, MAX_LESSON_CHARS, MAX_PER_REPO } from "../src/memory.js";
import { fakeD1 } from "./helpers.js";

const R = "TanksterAI/x";

test("createMemory: no database, no memory (never a throw)", () => {
  assert.equal(createMemory(undefined), null);
  assert.equal(createMemory({}), null);
});

test("add: a maintainer's lesson is stored once, redacted, one line, bounded", async () => {
  const m = createMemory(fakeD1());
  const a = await m.add({ repo: R, text: `Use the helper in src/util.js\nnot raw fetch. token=abcd1234efgh5678 ${"x".repeat(900)}`, source: "maintainer", by: "rishitank", pr: 3 });
  assert.equal(a.ok, true);
  const [row] = await m.list({ repo: R });
  assert.ok(row.text.length <= MAX_LESSON_CHARS);
  assert.doesNotMatch(row.text, /abcd1234|\n/);
  assert.equal((await m.add({ repo: R, text: "Prefer early returns.", source: "maintainer", by: "a" })).ok, true);
  assert.equal((await m.add({ repo: R, text: "prefer EARLY returns!", source: "maintainer", by: "b" })).reason, "duplicate");
});

test("add: only the two sources, nothing too short, a cap per repo", async () => {
  const m = createMemory(fakeD1());
  assert.equal((await m.add({ repo: R, text: "A long enough lesson here", source: "model", by: "x" })).reason, "source");
  assert.equal((await m.add({ repo: R, text: "short", source: "maintainer", by: "x" })).reason, "empty");
  for (let i = 0; i < MAX_PER_REPO; i++) await m.add({ repo: R, text: `Lesson number ${i} about the thing`, source: "maintainer", by: "x" });
  assert.equal((await m.add({ repo: R, text: "One lesson too many here", source: "maintainer", by: "x" })).reason, "full");
});

test("relevant: finds lessons by the words of the change, stems them, keeps repos apart, falls back to the newest", async () => {
  const m = createMemory(fakeD1());
  await m.add({ repo: R, text: "Database migrations must be reversible.", source: "maintainer", by: "a" });
  await m.add({ repo: R, text: "Never log request bodies in the webhook handler.", source: "maintainer", by: "a" });
  await m.add({ repo: "TanksterAI/other", text: "Migrations here are forward only.", source: "maintainer", by: "a" });
  const got = await m.relevant({ repo: R, terms: searchTerms("Add migration for users", "worker/src/webhook.js"), limit: 1 });
  assert.equal(got.length, 1);
  assert.match(got[0].text, /migrations must be reversible|request bodies/);
  const both = await m.relevant({ repo: R, terms: searchTerms("migrating things"), limit: 5 });
  assert.equal(both.length, 2, "fills up from the newest when few match");
  assert.ok(both.every((l) => !/forward only/.test(l.text)), "another repository's lessons never leak in");
  assert.deepEqual(await m.relevant({ repo: "nobody/none", terms: ["x1y"] }), []);
});

test("relevant: a hostile search term is never FTS syntax", async () => {
  const m = createMemory(fakeD1());
  await m.add({ repo: R, text: "Keep functions small and tested.", source: "maintainer", by: "a" });
  assert.deepEqual(searchTerms('") OR x:* NEAR(', "AND NOT"), ["near", "not"]);
  await m.relevant({ repo: R, terms: ['x" OR y', "a*", "NEAR("] });
});

test("forget: only that repository's lesson, only once", async () => {
  const m = createMemory(fakeD1());
  const { id } = await m.add({ repo: R, text: "Prefer early returns to deep nesting.", source: "maintainer", by: "a" });
  assert.equal(await m.forget({ repo: "TanksterAI/other", id }), false);
  assert.equal(await m.forget({ repo: R, id }), true);
  assert.equal(await m.forget({ repo: R, id }), false);
  assert.deepEqual(await m.list({ repo: R }), []);
  assert.deepEqual(await m.relevant({ repo: R, terms: ["early"] }), [], "the search index forgets it too");
});

test("cleanLesson", () => {
  assert.equal(cleanLesson("  a\tb \n c  "), "a b c");
});
