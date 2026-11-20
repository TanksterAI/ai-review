import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORY_LABEL, headerLine, parseHeader } from "../src/labels.js";
import { findingIdOf, nitpickFinding, severeFinding } from "../src/addressed.js";

test("the header line is CodeRabbit's: severity · category · effort, and parses back", () => {
  const h = headerLine({ severity: "major", category: "security", effort: "quick" });
  assert.equal(h, "**🟠 Major** · **Security & Privacy** · **Quick win**");
  assert.deepEqual(parseHeader(h), { severity: "major", category: "security", effort: "quick" });
  assert.equal(headerLine({ severity: "minor", category: "reliability" }), "**🟡 Minor** · **Stability & Availability**");
  assert.deepEqual(parseHeader("**🟡 Minor** · **Stability & Availability**"), { severity: "minor", category: "reliability", effort: null });
  // Six names, and every internal key has one.
  assert.equal(new Set(Object.values(CATEGORY_LABEL)).size, 6);
  for (const k of ["bug", "security", "reliability", "integrity", "performance", "tests", "maintainability"]) assert.ok(CATEGORY_LABEL[k], k);
});

test("the old label line still parses, so threads posted before the change keep working", () => {
  assert.deepEqual(parseHeader("**Major (security): x**"), { severity: "major", category: "security", effort: null });
  assert.equal(parseHeader("quoted **Major (bug): x**"), null);
  assert.equal(parseHeader("**Major** · **Made Up Category**"), null);
});

test("severity, nitpick and id are read from the new layout as from the old", () => {
  const mk = (header, type) => `${header}\n<sub>${type} · finding \`ab12cd34\`</sub>\n\n**Title**\n\nbody`;
  assert.equal(findingIdOf(mk("**🟠 Major** · **Functional Correctness**", "Potential issue")), "ab12cd34");
  assert.equal(severeFinding(mk("**🟠 Major** · **Functional Correctness**", "Potential issue")), true);
  assert.equal(severeFinding(mk("**🟡 Minor** · **Security & Privacy**", "Potential issue")), true);
  assert.equal(severeFinding(mk("**🟡 Minor** · **Functional Correctness**", "Potential issue")), false);
  assert.equal(nitpickFinding(mk("**🔵 Trivial** · **Functional Correctness**", "Potential issue")), true);
  assert.equal(nitpickFinding(mk("**🟡 Minor** · **Functional Correctness**", "Nitpick")), true);
  assert.equal(nitpickFinding(mk("**🟠 Major** · **Functional Correctness**", "Nitpick")), false);
  assert.equal(nitpickFinding(mk("**🟡 Minor** · **Security & Privacy**", "Nitpick")), false);
});
