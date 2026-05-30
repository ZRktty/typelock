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

  // --- Union: sort members, dedupe, collapse `false | true` → `boolean` ---
  if (type.isUnion()) {
    const members = type.types
      .map((t) => canonicalizeType(t, checker, depth + 1))
      .sort();
    return dedupeSorted(collapseBooleanLiterals(members)).join(" | ");
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
  if (file.fileName.includes("node_modules")) return false;
  return true;
}

/** Render an anonymous object type with alphabetically sorted members. */
function canonicalizeObject(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): string {
  // Exclude properties declared in node_modules (lib.d.ts built-ins, inherited
  // Object methods, etc.) so class instance types don't pollute with toString/valueOf.
  const props = checker.getPropertiesOfType(type).filter((prop) => {
    const d = prop.valueDeclaration ?? prop.declarations?.[0];
    if (!d) return true;
    return !d.getSourceFile().fileName.includes("node_modules");
  });
  const rendered = props
    .map((prop) => {
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = decl
        ? checker.getTypeOfSymbolAtLocation(prop, decl)
        : checker.getDeclaredTypeOfSymbol(prop);
      const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
      const optional = isOptional ? "?" : "";
      const readonly = isReadonlyProp(prop) ? "readonly " : "";
      const sig = isOptional
        ? canonicalizeOptionalPropType(propType, checker, depth + 1)
        : canonicalizeType(propType, checker, depth + 1);
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

/**
 * Replace the pair ["false", "true"] with "boolean" in a sorted member list.
 * Handles the TypeScript internals that decompose `boolean` into its literal
 * constituents before we ever see the type.
 */
function collapseBooleanLiterals(sorted: string[]): string[] {
  if (!sorted.includes("false") || !sorted.includes("true")) return sorted;
  const without = sorted.filter((m) => m !== "false" && m !== "true");
  return dedupeSorted([...without, "boolean"].sort());
}

/**
 * Canonicalize a property type for an optional member, stripping the implicit
 * `| undefined` that TypeScript adds internally. The `?` modifier already
 * communicates optionality; the extra `undefined` is noise in diffs.
 */
function canonicalizeOptionalPropType(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
): string {
  if (type.isUnion()) {
    const nonUndef = type.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Undefined),
    );
    if (nonUndef.length === 0) return "undefined";
    if (nonUndef.length === 1) return canonicalizeType(nonUndef[0], checker, depth);
    const members = nonUndef
      .map((t) => canonicalizeType(t, checker, depth + 1))
      .sort();
    return dedupeSorted(collapseBooleanLiterals(members)).join(" | ");
  }
  return canonicalizeType(type, checker, depth);
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
