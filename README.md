# typesnapshot

> Snapshot testing for your TypeScript public API surface. Catch accidental type-breaking changes in CI — the way Jest snapshots catch accidental value changes.

A refactor that changes **no runtime behavior** can still break downstream consumers at the type level. Your unit tests stay green, `tsc` stays green, the build passes — and a patch release silently breaks someone.

```ts
// "innocent" refactor
export interface FoldOptions {
-  preserveCase: boolean
+  preserveCase?: boolean   // now optional — BREAKING for anyone extending this type
+  locale?: string          // additive — safe
}
```

`typesnapshot` extracts a canonical signature of your public exports, commits it as a diffable baseline, and fails CI when the surface changes unexpectedly.

## Install

```bash
npm install --save-dev typesnapshot
```

## Usage

```bash
# 1. Create the baseline (commit api.typesnap to your repo)
npx typesnapshot --update

# 2. In CI, check the current types against the baseline
npx typesnapshot
#   exit 0 → unchanged, or only non-breaking additions
#   exit 1 → breaking change detected

# 3. When a change is intentional, regenerate and commit
npx typesnapshot --update
```

The reviewer sees the type-surface change as a normal git diff on `api.typesnap`. A breaking change becomes a deliberate, reviewed decision instead of an accident.

## Programmatic API

```ts
import { extract, diff, parse } from "typesnapshot";
import { readFileSync } from "node:fs";

const current = extract({ entry: "src/index.ts" });
const baseline = parse(readFileSync("api.typesnap", "utf8"));
const result = diff(baseline, current);

if (result.breaking.length > 0) {
  console.error(result.format());
  process.exit(1);
}
```

## How it differs from existing tools

- **expect-type / tsd** — manual type assertions you write by hand. typesnapshot auto-generates the baseline (`--update`), like Jest. No hand-written assertions.
- **typescript-breaking-change-detector** — AST-based, so it false-positives on alias renames. typesnapshot uses the TypeScript **type checker**, which resolves aliases: structurally identical types produce identical signatures.
- **@microsoft/api-extractor** — powerful but heavy and monorepo-oriented, with a substantial setup. typesnapshot is `npx typesnapshot` with zero config.

## How it works

The make-or-break property is **determinism**: two runs over unchanged source must produce byte-identical output, and a TypeScript version bump must not cause spurious diffs.

To get there, typesnapshot normalizes at the type-object level (not on rendered strings): union and intersection members are sorted and de-duplicated recursively, object properties are sorted by name, type aliases are resolved, and re-exported (aliased) symbols are followed to their real declaration. User-defined object types are expanded structurally; builtins and `node_modules` types stay as named leaves so the whole world isn't inlined.

## Known limitations (MVP)

This is an early MVP. Two canonicalization refinements are pending:

1. **`boolean` renders as `false | true`** — the type checker decomposes the boolean union internally. A normalization pass should re-collapse `true | false` back to `boolean`.
2. **Optional members carry a redundant `| undefined`** — an optional `locale?: string` currently renders as `locale?: string | undefined`. When the `?` modifier is present, the trailing `| undefined` should be stripped to keep diffs clean.

Neither affects correctness of breaking-change detection, but both add noise to diffs and should be fixed before a 1.0.

Also out of scope for now: variance analysis at the parameter level (contravariant inputs vs covariant outputs), a `--check-semver` flag that validates against your `package.json` version bump, multi-entry-point / monorepo support, and a GitHub Action wrapper.

## License

MIT
