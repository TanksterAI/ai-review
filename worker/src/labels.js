// How a finding is labelled on a pull request: CodeRabbit's header line,
// "<icon> Severity · Category · Effort", with its six category names. Our
// internal category keys stay (a finding's id hashes its key, so ids do not
// change); the label is only what people read. parseHeader reads both this
// line and the older "**Major (security): title**", so threads posted before
// the change keep working.

export const CATEGORY_LABEL = {
  bug: "Functional Correctness",
  security: "Security & Privacy",
  reliability: "Stability & Availability",
  integrity: "Data Integrity & Integration",
  performance: "Performance & Scalability",
  maintainability: "Maintainability & Code Quality",
  tests: "Maintainability & Code Quality",
};
export const SEVERITY_LABEL = { critical: "Critical", major: "Major", minor: "Minor", trivial: "Trivial", info: "Info" };
const ICON = { critical: "🔴", major: "🟠", minor: "🟡", trivial: "🔵", info: "⚪" };
// Only the effort CodeRabbit is seen to show: a quick win.
export const EFFORTS = ["quick", "moderate", "large"];
const EFFORT_LABEL = { quick: "Quick win" };

const KEY_OF = new Map();
for (const [key, label] of Object.entries(CATEGORY_LABEL)) if (!KEY_OF.has(label)) KEY_OF.set(label, key);
const SEVERITY_OF = Object.fromEntries(Object.entries(SEVERITY_LABEL).map(([k, v]) => [v, k]));

export function headerLine({ severity, category, effort = null }) {
  const parts = [`**${ICON[severity]} ${SEVERITY_LABEL[severity]}**`, `**${CATEGORY_LABEL[category] ?? CATEGORY_LABEL.bug}**`];
  if (EFFORT_LABEL[effort]) parts.push(`**${EFFORT_LABEL[effort]}**`);
  return parts.join(" · ");
}

/** {severity, category, effort} from a comment's first line, or null. */
export function parseHeader(body) {
  const first = String(body ?? "").split("\n")[0];
  const next = /^\*\*(?:\p{Extended_Pictographic}️? )?(Critical|Major|Minor|Trivial|Info)\*\* · \*\*([^*]+)\*\*(?: · \*\*([^*]+)\*\*)?$/u.exec(first);
  if (next) {
    const category = KEY_OF.get(next[2]);
    if (!category) return null;
    return { severity: SEVERITY_OF[next[1]], category, effort: next[3] === EFFORT_LABEL.quick ? "quick" : null };
  }
  const old = /^\*\*(Critical|Major|Minor|Trivial|Info) \((\w+)\): /.exec(first);
  return old ? { severity: SEVERITY_OF[old[1]], category: old[2], effort: null } : null;
}
