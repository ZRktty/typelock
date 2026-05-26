import ts from "typescript";

/**
 * Produces a deterministic, canonical string for a TypeScript type.
 *
 * The critical correctness property: two STRUCTURALLY equal types must produce
 * BYTE-IDENTICAL output, regardless of:
 *   - source-code ordering of union/intersection members (A | B === B | A)
 *   - object property declaration order
 *   - type aliases (we resolve them so `type X = string` compares as `string`)
 *
 * We normalize at the TYPE-OBJECT level, recursively, and only stringify the
 * leaves. We never split an already-rendered string on "|" — that approach
 * mis-handles nested unions like `(a | b)[]` and is the classic source of
 * false-positive diffs.
 */
export function canonicalizeType(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
): string {
  // Guard against pathological recursive types (e.g. type T = T[]).
  if (depth > 12) {
    return fallbackString(type, checker);
  }

  // --- Union: sort members, dedupe, join with " | " ---
  if (type.isUnion()) {
    const members = type.types
      .map((t) => canonicalizeType(t, checker, depth + 1))
      .sort();
    return dedupeSorted(members).join(" | ");
  }

  // --- Intersection: sort members, dedupe, join with " & " ---
  if (type.isIntersection()) {
    const members = type.types
      .map((t) => canonicalizeType(t, checker, depth + 1))
      .sort();
    return dedupeSorted(members).join(" & ");
  }

  // --- Object type with members: expand and sort by property name ---
  // We expand interfaces, type-literals, and named object types as long as
  // they are declared in the user's own source (not lib.d.ts / node_modules)
  // and aren't function/constructor types. This gives a structural signature
  // that is stable across machines (no absolute import paths) and across
  // source reordering.
  if (shouldExpandObject(type, checker)) {
    return canonicalizeObject(type, checker, depth);
  }

  // --- Leaf: primitives, literals, builtin/external refs, functions, etc. ---
  return fallbackString(type, checker);
}

/**
 * Stringify a type using strict format flags that strip aliases and never
 * truncate. Notably we do NOT use UseFullyQualifiedType: it emits absolute
 * `import("/abs/path").Name` strings that differ between machines and break
 * determinism. Structural expansion (above) handles user types; this fallback
 * is only for leaves and externals.
 */
function fallbackString(type: ts.Type, checker: ts.TypeChecker): string {
  const flags =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.WriteArrayAsGenericType |
    ts.TypeFormatFlags.InTypeAlias;
  return normalizeWhitespace(checker.typeToString(type, undefined, flags));
}

/**
 * Should we structurally expand this object type into sorted members?
 *
 * Yes when: it's an object type with no call/construct signatures, AND it is
 * declared in the user's own source (so we don't recursively expand Array,
 * Date, Promise, or anything from node_modules — those stay as named leaves).
 */
function shouldExpandObject(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  if (type.getCallSignatures().length > 0) return false;
  if (type.getConstructSignatures().length > 0) return false;

  const objectType = type as ts.ObjectType;
  const isAnon = (objectType.objectFlags & ts.ObjectFlags.Anonymous) !== 0;
  // Anonymous literals (e.g. `{ a: string }`) are always safe to expand.
  if (isAnon) return true;

  // Named types: only expand if declared in user source, not a builtin/external.
  const sym = type.getSymbol() ?? type.aliasSymbol;
  const decl = sym?.declarations?.[0];
  if (!decl) return false;
  const file = decl.getSourceFile();
  if (file.isDeclarationFile) return false; // lib.d.ts, .d.ts deps
  if (file.fileName.includes("node_modules")) return false;
  return true;
}

/** Render an anonymous object type with alphabetically sorted members. */
function canonicalizeObject(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): string {
  const props = checker.getPropertiesOfType(type);
  const rendered = props
    .map((prop) => {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getDeclaredTypeOfSymbol(prop);
      const optional =
        (prop.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      const readonly = isReadonlyProp(prop) ? "readonly " : "";
      const sig = canonicalizeType(propType, checker, depth + 1);
      return `${readonly}${prop.getName()}${optional}: ${sig}`;
    })
    .sort();

  // Index signatures, if present, are appended after named members.
  const indexSigs = renderIndexSignatures(type, checker, depth);
  const all = [...rendered, ...indexSigs].sort();

  return all.length === 0 ? "{}" : `{ ${all.join("; ")} }`;
}

function isReadonlyProp(prop: ts.Symbol): boolean {
  const decl = prop.declarations?.[0];
  if (!decl) return false;
  const modifiers = ts.canHaveModifiers(decl)
    ? ts.getModifiers(decl)
    : undefined;
  return (
    modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false
  );
}

function renderIndexSignatures(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): string[] {
  const out: string[] = [];
  const stringIndex = type.getStringIndexType();
  if (stringIndex) {
    out.push(`[key: string]: ${canonicalizeType(stringIndex, checker, depth + 1)}`);
  }
  const numberIndex = type.getNumberIndexType();
  if (numberIndex) {
    out.push(`[key: number]: ${canonicalizeType(numberIndex, checker, depth + 1)}`);
  }
  return out;
}

/** Remove duplicate adjacent entries from a sorted array. */
function dedupeSorted(sorted: string[]): string[] {
  const out: string[] = [];
  for (const s of sorted) {
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
}

/** Collapse runs of whitespace so formatting never affects the signature. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
