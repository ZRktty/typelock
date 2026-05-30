# typesnapshot Roadmap

The vision: the simplest possible tool that reliably catches breaking TypeScript API changes in CI — the thing `@microsoft/api-extractor` does, but without the 30-minute setup tax and monorepo assumptions. A developer should be able to go from zero to protected in one `npx` command.

This roadmap is ordered by what matters most, not what is easiest to build.

---

## Phase 0 — Dogfood first

> **Before shipping any new feature, validate correctness on a real project.**

The tool has not yet been run against a real-world library. Unit tests against hand-crafted fixtures are necessary but not sufficient — real codebases have patterns (conditional types, mapped types, deeply nested generics, re-export barrels from `node_modules`, declaration merging) that fixtures don't cover.

**Goal**: Run `typesnapshot --update` on at least one production TypeScript library, commit the baseline, make a deliberate breaking change, and verify the diff output matches what a human reviewer would expect.

**Acceptance criteria**:

- Snapshot covers all exported symbols without missing any or producing `any` ✓ verified (accent-folding)
- `boolean` fields render as `boolean` (not `false | true`) ✓ fixed
- Optional fields render without `| undefined` ✓ fixed
- No spurious diffs across two clean runs on the same source
- A renamed required field is flagged as breaking
- A new optional field is flagged as safe
- The baseline file is readable and reviewable in a GitHub PR diff ✓ verified (accent-folding)
- Class method and interface member changes are detected ✗ **blocker** — requires Phase 1.3

**Real-world test (accent-folding v2.7.0)**: First dogfood run completed. Export removal and type alias structural changes are caught correctly. However, classes snapshot as `typeof ClassName` and interfaces snapshot as name-only — member-level changes (method signature changes, added/removed interface fields) are invisible. This makes the tool insufficient as a standalone API guard for libraries where the public API lives inside classes or interfaces (which is most libraries). **Phase 1.3 must land before Phase 0 can be declared complete.**

**What to watch for**: types that come from `node_modules` re-exports (e.g., a library that re-exports a React type), recursive types, conditional types (`T extends U ? V : W`), mapped types (`{ [K in keyof T]: ... }`), and template literal types. These are all edge cases that won't appear in the current fixtures.

---

## Phase 1 — Correctness (trust the tool)

This phase is the highest priority. A tool that misses breaking changes or false-positives on safe changes will be uninstalled within a week. Every item here affects the core guarantee.

### 1.1 Function signature breaking change classification

**Current state**: Any function signature change that isn't a pure object-shape delta is flagged as `breaking: true`. This is conservative (better than missing real breaks) but produces false positives that erode trust.

**The problem**: `classifyChange()` in [src/diff.ts](src/diff.ts) currently only understands object literal shapes. It has no model of function signatures. This means:

| Change | Should be | Currently |
|---|---|---|
| `(a: string) => void` → `(a: string, b?: number) => void` | Safe | ✗ Breaking |
| `() => string` → `() => string \| null` | Breaking (widened return) | Breaking (accidental) |
| `(a: string) => void` → `(a: string \| number) => void` | Safe (widened param) | ✗ Breaking |
| `(a: string) => void` → `(a: string, b: number) => void` | Breaking (new required param) | Breaking (accidental) |

**What needs to change**: Extend `classifyChange()` with a function-signature-aware path. Parse the canonical signature string to detect the arrow `=>`, extract parameter lists and return type, and apply these rules:

- New optional parameter appended → safe
- New required parameter → breaking
- Parameter type widened (original is subtype of new) → safe (contravariant input position)
- Parameter type narrowed → breaking
- Return type narrowed (new is subtype of original) → safe (covariant output position)
- Return type widened → breaking

The subtype check is the hard part. For the MVP of this fix, a heuristic approach is acceptable: detect the common safe cases (added `?` parameter, `| undefined` in parameter union) and leave everything else as breaking. The goal is to reduce noise, not to achieve full variance analysis.

**Acceptance criteria**:
- Adding an optional parameter to a function does not flag as breaking
- Removing a required parameter does not flag as safe
- All existing tests continue to pass
- New tests cover the matrix above

### 1.2 Generic type handling

**Current state**: Generic types are rendered by the TypeScript type checker's `typeToString()` fallback, which produces strings like `Array<string>` or `Map<K, V>`. The canonicalizer has no special handling for generic instantiations or generic declarations.

**The problems**:

1. **Generic constraints on exported functions/types**: `<T extends string>(x: T) => T` vs `<T>(x: T) => T` — adding a constraint is a breaking change (narrows what callers can pass). Removing one is safe. Currently both would diff as a string change and be flagged breaking.

2. **Generic type parameter count**: Adding a new required generic parameter is breaking (`Wrapper<T>` → `Wrapper<T, U>`). Adding one with a default is safe (`Wrapper<T, U = string>`).

3. **Instantiated generics**: A type like `Promise<User>` should render stably and not expand into Promise's full internal structure (it shouldn't — the `shouldExpandObject` guard handles this — but needs a test).

**What needs to change**:
- Add fixtures covering generic exported types and functions
- Verify current output for each and add tests that lock in correct behavior
- For constraint changes: treat as breaking by default, and document this explicitly
- For defaulted generic parameters: detect the `= ` pattern in the rendered string and classify addition as safe

**Acceptance criteria**:
- `<T extends string>` → `<T>` detected as safe (constraint removed, wider)
- `<T>` → `<T extends string>` detected as breaking (constraint added, narrower)
- `Wrapper<T>` → `Wrapper<T, U = string>` detected as safe (defaulted addition)
- Generic function signatures round-trip through serialize/parse without change

### 1.3 Class surface

**Current state**: Classes are classified as `"class"` kind but their signature is extracted the same way as any other type — via `getTypeOfSymbolAtLocation`, which returns the constructor type. This misses:

- **Static members**: `MyClass.create()` is part of the public API but lives on the constructor type, not the instance type
- **Constructor signature**: Adding a required constructor parameter is breaking
- **Protected members**: Technically part of the surface for subclasses — debatable whether to include, but needs a decision
- **Private members**: Should not appear in the snapshot
- **`implements` clauses**: The set of interfaces a class implements affects assignability

**What needs to change**: Add a dedicated `signatureForClass()` path in [src/extract.ts](src/extract.ts) that:
1. Extracts instance properties/methods via `checker.getPropertiesOfType(instanceType)`
2. Extracts static properties/methods separately from the constructor symbol
3. Renders as `{ instance: {...}; static: {...}; new: (...) => ClassName }`
4. Excludes private members (check `SymbolFlags.Private`)
5. Marks protected members with a `protected` modifier in the signature string

**Acceptance criteria**:
- A class with a static factory method shows the static method in the snapshot
- Adding a required constructor parameter flags as breaking
- Private members do not appear in the snapshot
- A class that gains a new public method flags as a safe addition
- Existing class-free tests still pass

### 1.4 Function overloads

**Current state**: TypeScript function overloads compile to a single implementation signature. When `getTypeOfSymbolAtLocation` is called on an overloaded function, it returns an intersection of the call signatures — which TypeScript renders as a single merged type. This may not faithfully represent what callers see.

**The problem**: The overload signatures (the ones callers use) are separate from the implementation signature. A library that adds an overload is adding a capability — that should be safe. A library that removes an overload or changes one is potentially breaking.

**What needs to change**:
- In `signatureForSymbol()`, check `type.getCallSignatures().length > 1`
- When multiple call signatures exist, render each separately as `overload 1: ...; overload 2: ...` in sorted order
- Diff them as a set: added overloads are safe, removed overloads are breaking, changed overloads are breaking

**Acceptance criteria**:
- A function with two overloads renders both in the snapshot
- Adding an overload is non-breaking
- Removing an overload is breaking

### 1.5 Conditional and mapped types

**Current state**: Conditional types (`T extends U ? V : W`) and mapped types (`{ [K in keyof T]: T[K] }`) are rendered via the fallback `typeToString()` path. This is probably fine for most cases, but needs validation.

**The concern**: The rendered strings may not be deterministic across TypeScript versions (the compiler may change how it prints these), and alias resolution may or may not inline them.

**What needs to change**:
- Add fixtures for both forms
- Verify output is stable across two runs
- If TypeScript version changes cause string-level churn on these, add a normalization pass

**Acceptance criteria**:
- Conditional type export produces a stable, non-empty signature
- Mapped type export produces a stable, non-empty signature
- Neither expands into infinite recursion

### 1.6 Declaration merging

**Current state**: TypeScript allows a namespace and an interface (or function) to share the same name, merging their declarations. The current extraction code calls `checker.getExportsOfModule()` which returns one symbol per name — the merged symbol. It's unclear whether the current canonicalizer correctly handles all cases.

**What needs to change**: Add a fixture with a merged namespace + interface, verify the output contains both the type shape and the namespace members.

---

## Phase 2 — Workflow (make it stick in CI)

Once the tool is trustworthy, these items maximize adoption and make it hard to bypass.

### 2.1 Official GitHub Action

The single highest-leverage distribution move. A one-liner that adds typesnapshot to any repo:

```yaml
- uses: ZRktty/typesnapshot-action@v1
  with:
    entry: src/index.ts        # optional, default: src/index.ts
    snapfile: api.typesnapshot # optional
```

The action should:
- Install the correct typesnapshot version (pinned in the action's `package.json`)
- Run `typesnapshot`
- On failure, output the diff as a GitHub Actions job summary (not just stderr)
- On `--update` mode, commit the updated baseline back to the branch (optional, configurable)

**Acceptance criteria**:
- Works in a fresh GitHub Actions Ubuntu runner with Node 18, 20, 22
- Job summary shows the diff when a breaking change is detected
- Action is published to the GitHub Marketplace

### 2.2 `--check-semver` flag

Cross-references the detected surface changes with the `version` field in `package.json`:

```bash
typesnapshot --check-semver
# ✗ Breaking changes detected but version bump is 1.2.3 → 1.2.4 (patch).
#   Breaking changes require a major version bump (2.0.0).
```

Rules:
- Breaking changes require a major bump
- Safe additions (new exports, new optional fields) allow minor or major
- No changes: any version bump is fine

**Acceptance criteria**:
- Exits 1 when breaking changes exist but version bump is patch or minor
- Exits 1 when safe additions exist but version bump is only patch
- Exits 0 when version bump matches the severity of detected changes
- Works in a CI pipeline after `npm version patch` runs

### 2.3 Multi-entry point support

Real packages frequently ship multiple entry points: `my-lib`, `my-lib/utils`, `my-lib/react`. Each needs its own snapshot.

**Config format** (in `package.json`):

```json
{
  "typesnapshot": {
    "entries": [
      { "entry": "src/index.ts",       "snapfile": "api/main.typesnapshot" },
      { "entry": "src/utils/index.ts", "snapfile": "api/utils.typesnapshot" },
      { "entry": "src/react/index.ts", "snapfile": "api/react.typesnapshot" }
    ]
  }
}
```

Or a standalone `typesnapshot.config.ts` file for projects that prefer it.

**Acceptance criteria**:
- `typesnapshot --update` writes all snapshot files when config lists multiple entries
- `typesnapshot` checks all entries and reports breaking changes across all
- Single-entry usage (no config file) is unchanged

### 2.4 `--format` flag

Output formats beyond the default human-readable text:

```bash
typesnapshot --format json   # machine-readable for custom tooling
typesnapshot --format md     # GitHub-flavored markdown for PR comments
```

The JSON format enables building custom reporters, Slack bots, PR comment bots, etc. without forking the tool.

---

## Phase 3 — Experience (make it delightful)

### 3.1 Colored terminal output

The current diff output is plain text. Colored output makes breaking changes immediately visible:

- Red for removed exports and breaking changes
- Green for added exports and safe changes
- Yellow for changed-but-safe
- Bold for export names

Use a zero-dependency color approach (ANSI escape codes directly, with `NO_COLOR` and `--no-color` respected). Do not add a runtime dependency just for colors.

### 3.2 Watch mode

```bash
typesnapshot --watch
```

Watches the source files for changes and re-runs the check on save. Designed for the tight edit → check loop during active development, so breaking changes surface immediately rather than at CI time.

Implementation: use Node's `fs.watch` (no extra deps). Debounce re-runs by 300ms to avoid thrashing during rapid saves.

### 3.3 Snapshot diff in PR comments (bot)

A companion GitHub Action step (or option in the main action) that posts the `api.typesnapshot` diff as an inline PR comment when the surface changes. Reviewers see the type surface change without having to read the snapshot file diff directly.

### 3.4 `--silent` and `--verbose` flags

- `--silent`: exits 0/1, no stdout output (for scripts that only care about exit code)
- `--verbose`: prints the full canonical signature for every export, not just the changed ones — useful for debugging why a signature looks the way it does

---

## Phase 4 — Ecosystem integrations

### 4.1 Changesets integration

Detect the surface diff and automatically generate a changeset entry:

```bash
typesnapshot --changeset
# Writes .changeset/typesnapshot-auto-XXXX.md
# major bump if breaking changes, minor if safe additions, nothing if no changes
```

Works with the [changesets](https://github.com/changesets/changesets) workflow used by most serious open-source monorepos.

### 4.2 semantic-release plugin

A `semantic-release` plugin that runs `typesnapshot` during the `verifyConditions` step and fails the release if breaking changes are being shipped as a minor or patch.

### 4.3 TypeScript version compatibility matrix in CI

A GitHub Actions matrix that tests `typesnapshot` itself against TypeScript 4.7, 5.0, 5.4, 5.5, 6.x on every push. Currently tested manually; this makes the guarantee continuous.

```yaml
strategy:
  matrix:
    typescript: ["4.7", "5.0", "5.4", "6.0"]
```

### 4.4 VS Code extension (stretch goal)

Inline API surface indicators in the editor:

- A gutter icon on exported symbols showing "in baseline" / "changed from baseline" / "new since baseline"
- A warning squiggle when a change to an exported symbol would be breaking
- Command palette: "Update typesnapshot baseline"

This is a significant investment and depends on the core tool being stable first.

---

## What is explicitly out of scope

**Full variance analysis**: Determining whether a type change is safe based on its position in the type graph (covariant, contravariant, invariant, bivariant) is equivalent to implementing a type system. The heuristic approach in Phase 1.1 covers 80% of real cases with 5% of the complexity. Full variance analysis is a research project.

**Runtime type checking**: typesnapshot is a static analysis tool. It does not validate that runtime values match the declared types. Use `zod`, `io-ts`, or similar for that.

**Cross-package compatibility checking**: Checking whether a downstream consumer's code still compiles after an upstream type change requires having the downstream source. Out of scope.

**Type coverage metrics**: Measuring how much of a codebase is typed. Different problem, different tool.

---

## Success metrics

The goal is not downloads — it is developers who commit `api.typesnapshot` to their repo and never remove it because it keeps catching real problems.

Milestones:
1. Tool runs correctly on 3 different real open-source TypeScript libraries without false positives
2. One real accidental breaking change caught in CI that would have shipped otherwise
3. GitHub Action published to Marketplace with >10 stars
4. `--check-semver` prevents at least one incorrect version bump in a real release
