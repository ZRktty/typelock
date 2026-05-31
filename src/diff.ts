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
 * Conservative by design: only down-grade to non-breaking when we can prove
 * safety. A false "breaking" warning is annoying; a missed breaking change is
 * the bug that makes the tool worthless.
 */
function classifyChange(before: string, after: string): boolean {
  if (isPurelyAddedOptional(before, after)) return false;
  if (requiredBecameOptional(before, after)) return false;
  if (isFunctionSafeChange(before, after)) return false;
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

/**
 * True if `after` is a function type that is a safe evolution of `before`.
 *
 * Safe cases detected:
 *   - appending optional parameters
 *   - a required parameter becoming optional
 *
 * Conservative non-cases (treated as breaking):
 *   - return type changes (widening or narrowing — we can't tell without a
 *     subtype check, so we stay safe)
 *   - parameter type changes (same reason)
 *   - removing parameters
 *   - adding required parameters
 */
function isFunctionSafeChange(before: string, after: string): boolean {
  const b = parseFunctionSig(before);
  const a = parseFunctionSig(after);
  if (!b || !a) return false;

  if (b.returnType !== a.returnType) return false;
  if (a.params.length < b.params.length) return false;

  for (let i = 0; i < b.params.length; i++) {
    const bp = b.params[i];
    const ap = a.params[i];
    if (bp === ap) continue;
    if (isParamRequiredToOptional(bp, ap)) continue;
    if (isParamObjectTypeExpanded(bp, ap)) continue;
    return false;
  }

  for (let i = b.params.length; i < a.params.length; i++) {
    if (!isOptionalParam(a.params[i])) return false;
  }

  return true;
}

/** Parse `(p1, p2) => ReturnType` into its parts. Returns null if not a function type. */
function parseFunctionSig(sig: string): { params: string[]; returnType: string } | null {
  const trimmed = sig.trim();
  if (!trimmed.startsWith("(")) return null;

  // Walk to the matching close-paren at depth 0.
  let depth = 0;
  let closeParen = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      if (ch === ">" && i > 0 && trimmed[i - 1] === "=") continue; // part of `=>`, not a generic closer
      depth--;
      if (depth === 0) { closeParen = i; break; }
    }
  }
  if (closeParen === -1) return null;

  const rest = trimmed.slice(closeParen + 1).trimStart();
  if (!rest.startsWith("=>")) return null;

  const returnType = rest.slice(2).trim();
  const paramsStr = trimmed.slice(1, closeParen);
  const params = paramsStr
    ? splitTopLevel(paramsStr, ",").map((p) => p.trim()).filter(Boolean)
    : [];

  return { params, returnType };
}

/** True if the parameter is optional: `name?: Type` shape or a rest param with an array type. */
function isOptionalParam(param: string): boolean {
  const p = param.trim();
  if (/^[\w$]+\?:/.test(p)) return true;
  // Rest params are optional only when the type is an array (zero-or-more).
  // Tuple rest params like `...args: [number]` have required elements and are NOT optional.
  if (p.startsWith("...")) {
    const type = p.replace(/^\.\.\.[\w$]+\??\s*:\s*/, "");
    return type.endsWith("[]");
  }
  return false;
}

/** True if `after` is `before` with `name:` → `name?:` and nothing else changed. */
function isParamRequiredToOptional(before: string, after: string): boolean {
  const optionalized = before.trim().replace(/^([\w$]+)\s*:/, "$1?:");
  return optionalized === after.trim();
}

/**
 * True if `before` and `after` are the same param name but the object type in
 * `after` has only gained optional members (e.g. `opts: { x: string }` →
 * `opts: { x: string; y?: number }`).
 *
 * The param's own optionality must not decrease: optional→required is breaking
 * even when the object shape only gains optional fields.
 */
function isParamObjectTypeExpanded(before: string, after: string): boolean {
  const isOptional = (param: string) => /^[\w$]+\?:/.test(param.trim());
  if (isOptional(before) && !isOptional(after)) return false; // optional→required is breaking
  const typeOf = (param: string) => param.trim().replace(/^[\w$]+\??\s*:\s*/, "");
  return isPurelyAddedOptional(typeOf(before), typeOf(after));
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
  let prev = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      if (ch !== ">" || prev !== "=") depth--; // skip `>` that is part of `=>`
    }
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
    prev = ch;
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
