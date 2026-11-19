// This repository is public, so GitHub-hosted runners are free and unlimited
// for it. The org's own runners (the Cloud Build fallback and the Cloud Run
// light lane) refuse public repositories: a job sent there would wait for
// ever, and a stranger's pull request must never run on them anyway.
//
// So every job in this repository's own workflows runs on ubuntu-latest,
// marked `# hosted-only` for the org's runner-policy lint. review.yml is the
// exception: other (private) repositories call it, and their jobs keep
// following the org's CI_RUNNER variable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
const read = (name) => readFileSync(`${DIR}${name}`, "utf8");

// The jobs of a workflow: each 2-space key under `jobs:`, with its lines.
function jobs(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  assert.ok(start >= 0, "no jobs: block");
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) out.push({ name: key[1], lines: [] });
    else if (/^\S/.test(line)) break;
    else if (out.length) out[out.length - 1].lines.push(line);
  }
  return out;
}

const OWN = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f) && f !== "review.yml");

test("every job in this repository's own workflows runs on a GitHub-hosted runner", () => {
  assert.ok(OWN.length >= 5, `found ${OWN.join(", ")}`);
  for (const file of OWN) {
    const found = jobs(read(file));
    assert.ok(found.length > 0, `${file} has no jobs`);
    for (const job of found) {
      const where = `${file}: job ${job.name}`;
      const runsOn = job.lines.find((l) => /^ {4}runs-on:/.test(l));
      const uses = job.lines.find((l) => /^ {4}uses:/.test(l));
      if (runsOn) {
        assert.match(runsOn, /^ {4}runs-on: ubuntu-latest\s+# hosted-only\b/, `${where} must run on ubuntu-latest, marked # hosted-only`);
      } else {
        // A job that calls a reusable workflow picks the runner through its runs-on input.
        assert.ok(uses, `${where} has neither runs-on nor uses`);
        assert.ok(job.lines.some((l) => /^ {6}runs-on: ubuntu-latest\s*$/.test(l)), `${where} must pass runs-on: ubuntu-latest to ${uses.trim()}`);
      }
      const text = job.lines.join("\n");
      assert.doesNotMatch(text, /CI_RUNNER|CI_LIGHT_RUNNER|tankster-light|tankster-gcb/, `${where} still names an org runner`);
    }
  }
});

test("review.yml, which private repositories call, still follows the org's runner variables", () => {
  const text = read("review.yml");
  assert.match(text, /inputs\.runs-on/);
  assert.match(text, /vars\.CI_RUNNER \|\| 'ubuntu-latest'/);
});
