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

test("relevant: only matches raise a count; the newest fill in unmarked and never raise one", async () => {
  const db = fakeD1();
  const m = createMemory(db);
  for (const t of ["Database migrations must be reversible.", "Prefer early returns.", "Keep functions small.", "Tests must not touch the network."]) await m.add({ repo: R, text: t, source: "maintainer", by: "a" });
  const got = await m.relevant({ repo: R, terms: searchTerms("migrations") });
  assert.equal(got.length, 3, "one match, two of the newest");
  assert.deepEqual(got.map((l) => l.matched), [true, false, false]);
  const hits = Object.fromEntries((await db.prepare("SELECT id, hits FROM lessons").bind().all()).results.map((r) => [r.id, r.hits]));
  assert.deepEqual(hits, { 1: 1, 2: 0, 3: 0, 4: 0 }, "only the match was counted");
  assert.deepEqual((await m.relevant({ repo: R, terms: [], limit: 1 })).map((l) => l.id), [4], "the fill never exceeds the limit");
});

test("list: every lesson up to the cap is listed, so any can be forgotten", async () => {
  const m = createMemory(fakeD1());
  for (let i = 0; i < 60; i++) await m.add({ repo: R, text: `Lesson number ${i} about the thing`, source: "maintainer", by: "x" });
  const rows = await m.list({ repo: R });
  assert.equal(rows.length, 60);
  assert.equal(rows.at(-1).id, 1);
});

test("the cap holds inside the insert, and search terms take titles and paths before the description", async () => {
  const db = fakeD1();
  const m = createMemory(db);
  for (let i = 0; i < MAX_PER_REPO; i++) await m.add({ repo: R, text: `Lesson number ${i} about the thing`, source: "maintainer", by: "x" });
  const racers = await Promise.all([1, 2, 3].map((n) => m.add({ repo: R, text: `Racing lesson ${n} arrives late`, source: "maintainer", by: "x" })));
  assert.ok(racers.every((r) => r.reason === "full"));
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM lessons").bind().all()).results[0].n, MAX_PER_REPO);
  const terms = searchTerms("webhook retries", "worker/src/webhook.js", "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau");
  assert.ok(terms.length <= 16 && terms.includes("webhook") && terms.includes("retries"));
});

test("the search index follows an edited lesson", async () => {
  const db = fakeD1();
  const m = createMemory(db);
  const { id } = await m.add({ repo: R, text: "Prefer early returns to nesting.", source: "maintainer", by: "a" });
  await db.prepare("UPDATE lessons SET text = ?1 WHERE id = ?2").bind("Prefer composition over inheritance.", id).run();
  assert.equal((await m.relevant({ repo: R, terms: ["early"], fill: 0 })).length, 0);
  assert.equal((await m.relevant({ repo: R, terms: ["composition"], fill: 0 })).length, 1);
});
