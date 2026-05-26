import type { Snapshot, Change, DiffResult, ExportEntry } from "./types.js";

/**
 * Compare a baseline snapshot against the current one.
 *
 * Classification (semver intent):
 *   - removed export        → breaking (consumers importing it break)
 *   - added export          → non-breaking (purely additive)
 *   - changed signature     → breaking by default; we refine known-safe cases
 *
 * The refinement of "changed" into safe vs breaking at the sub-signature level
 * (e.g. adding an optional param) is intentionally conservative in the MVP:
 * we only down-grade to non-breaking when we can prove safety. When in doubt,
 * we flag breaking — a false "breaking" warning is annoying; a missed breaking
 * change is the bug that makes the tool worthless.
 */
export function diff(baseline: Snapshot, current: Snapshot): DiffResult {
  const baseMap = toMap(baseline.exports);
  const currMap = toMap(current.exports);

  const added: Change[] = [];
  const removed: Change[] = [];
  const changed: Change[] = [];

  for (const [name, entry] of currMap) {
    if (!baseMap.has(name)) {
      added.push({
        name,
        kind: entry.kind,
        type: "added",
        breaking: false,
        after: entry.signature,
      });
    }
  }

  for (const [name, entry] of baseMap) {
    const curr = currMap.get(name);
    if (!curr) {
      removed.push({
        name,
        kind: entry.kind,
        type: "removed",
        breaking: true,
        before: entry.signature,
      });
      continue;
    }
    if (curr.signature !== entry.signature) {
      changed.push({
        name,
        kind: entry.kind,
        type: "changed",
        breaking: classifyChange(entry.signature, curr.signature),
        before: entry.signature,
        after: curr.signature,
      });
    }
  }

  sortByName(added);
  sortByName(removed);
  sortByName(changed);

  const breaking = [...removed, ...changed].filter((c) => c.breaking);
  const hasChanges =
    added.length + removed.length + changed.length > 0;

  return {
    added,
    removed,
    changed,
    breaking,
    hasChanges,
    format() {
      return formatDiff(this);
    },
  };
}

/**
 * Decide whether a signature change is breaking.
 *
 * MVP heuristic — provably-safe down-grades only:
 *   - a required property became optional on an INPUT is widening (safe),
 *     but on the surface string we can't always tell input from output, so
 *     we keep this conservative.
 *   - adding an optional member (the new signature is a superset where the
 *     extra members are all optional) is treated as non-breaking.
 * Everything else stays breaking.
 */
function classifyChange(before: string, after: string): boolean {
  // Adding an optional property: the only structural delta is new `name?:`
  // members. Cheap structural check on object-literal-ish signatures.
  if (isPurelyAddedOptional(before, after)) return false;

  // A required property becoming optional widens the accepted input set.
  // `name:` → `name?:` with nothing else changing.
  if (requiredBecameOptional(before, after)) return false;

  return true;
}

/** True if `after` equals `before` plus only new `... ?: ...` members. */
function isPurelyAddedOptional(before: string, after: string): boolean {
  const beforeMembers = extractMembers(before);
  const afterMembers = extractMembers(after);
  if (!beforeMembers || !afterMembers) return false;

  // Every baseline member must survive unchanged.
  for (const m of beforeMembers) {
    if (!afterMembers.has(m)) return false;
  }
  // Every NEW member must be optional.
  for (const m of afterMembers) {
    if (beforeMembers.has(m)) continue;
    // New member must be optional: it contains `?:` before the type.
    if (!/[\w$]+\?\s*:/.test(m)) {
      return false;
    }
  }
  return afterMembers.size > beforeMembers.size;
}

/** Detect the single transition `foo: T` → `foo?: T` with no other delta. */
function requiredBecameOptional(before: string, after: string): boolean {
  const b = extractMembers(before);
  const a = extractMembers(after);
  if (!b || !a || b.size !== a.size) return false;

  let transitions = 0;
  for (const member of b) {
    if (a.has(member)) continue;
    // member is `name: T`; its optional form is `name?: T`
    const optionalForm = member.replace(/^(\s*(?:readonly\s+)?[\w$]+)\s*:/, "$1?:");
    if (a.has(optionalForm)) {
      transitions++;
    } else {
      return false;
    }
  }
  return transitions > 0;
}

/** Pull `{ a: X; b?: Y }` apart into a set of member strings. Null if not an object literal. */
function extractMembers(sig: string): Set<string> | null {
  const trimmed = sig.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return new Set();
  // Split on top-level "; " only (depth-aware so nested objects survive).
  const members = splitTopLevel(inner, ";");
  return new Set(members.map((m) => m.trim()).filter(Boolean));
}

/** Split a string on `sep`, ignoring separators nested inside (), [], {}, <>. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function toMap(entries: ExportEntry[]): Map<string, ExportEntry> {
  return new Map(entries.map((e) => [e.name, e]));
}

function sortByName(arr: Change[]): void {
  arr.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function formatDiff(result: DiffResult): string {
  const lines: string[] = [];
  for (const c of result.removed) {
    lines.push(`  ✗ REMOVED  ${c.kind} ${c.name}  [breaking]`);
    lines.push(`      was: ${c.before}`);
  }
  for (const c of result.changed) {
    const tag = c.breaking ? "[breaking]" : "[safe]";
    lines.push(`  ~ CHANGED  ${c.kind} ${c.name}  ${tag}`);
    lines.push(`      before: ${c.before}`);
    lines.push(`      after:  ${c.after}`);
  }
  for (const c of result.added) {
    lines.push(`  + ADDED    ${c.kind} ${c.name}  [safe]`);
    lines.push(`      now: ${c.after}`);
  }
  if (lines.length === 0) return "  No changes to the public type surface.";
  return lines.join("\n");
}
