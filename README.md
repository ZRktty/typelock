# typelock

> Lock your TypeScript API. Ship with confidence.

`typelock` creates snapshots of your TypeScript public type surface — the way Jest snapshots catch accidental value changes — commits them as a diffable baseline, and fails CI when the surface changes unexpectedly.

A refactor that changes **no runtime behavior** can still break downstream consumers at the type level. Your unit tests stay green, `tsc` stays green, the build passes — and a patch release silently breaks someone.

```ts
// "innocent" refactor
export interface FoldOptions {
-  preserveCase: boolean
+  preserveCase?: boolean   // now optional — BREAKING for anyone extending this type
+  locale?: string          // additive — safe
}
```

**New here?** See the [step-by-step tutorial](tutorial.md) for a full workflow walkthrough, CI setup, and a decision flowchart. For what's coming next, see the [roadmap](ROADMAP.md).

## Install

```bash
npm install --save-dev @zrktty/typelock
```

## Usage

```bash
# 1. Create the baseline (commit api.typelock to your repo)
npx typelock --update

# 2. In CI, check the current types against the baseline
npx typelock
#   exit 0 → unchanged, or only non-breaking additions
#   exit 1 → breaking change detected

# 3. When a change is intentional, regenerate and commit
npx typelock --update
```

The reviewer sees the type-surface change as a normal git diff on `api.typelock`. A breaking change becomes a deliberate, reviewed decision instead of an accident.

## Programmatic API

```ts
import { extract, diff, parse } from "@zrktty/typelock";
import { readFileSync } from "node:fs";

const current = extract({ entry: "src/index.ts" });
const baseline = parse(readFileSync("api.typelock", "utf8"));
const result = diff(baseline, current);

if (result.breaking.length > 0) {
  console.error(result.format());
  process.exit(1);
}
```

## How it differs from existing tools

- **expect-type / tsd** — manual type assertions you write by hand. typelock auto-generates the baseline (`--update`), like Jest. No hand-written assertions.
- **typescript-breaking-change-detector** — AST-based, so it false-positives on alias renames. typelock uses the TypeScript **type checker**, which resolves aliases: structurally identical types produce identical signatures.
- **@microsoft/api-extractor** — powerful but heavy and monorepo-oriented, with a substantial setup. typelock is `npx typelock` with zero config.

## What it tracks

Every exported symbol gets a fully resolved structural signature:

- **Type aliases** — expanded to their resolved shape (`Record<string, string>` → `{ [key: string]: string }`)
- **Interfaces** — all declared members, sorted by name
- **Classes** — instance members (methods and properties) and explicit constructor signature (`new(param: T, ...)`), sorted by name; static members are not yet tracked (see roadmap)
- **Functions** — parameter and return types
- **Enums and namespaces** — member names and values

Works with `.ts` source files and hand-authored `.d.ts` declaration files (the pattern used by JS libraries that ship a separate type file).

## How it works

The make-or-break property is **determinism**: two runs over unchanged source must produce byte-identical output, and a TypeScript version bump must not cause spurious diffs.

To get there, typelock normalizes at the type-object level (not on rendered strings): union and intersection members are sorted and de-duplicated recursively, object properties are sorted by name, type aliases are resolved, and re-exported (aliased) symbols are followed to their real declaration. User-defined types are expanded structurally; builtins and `node_modules` types stay as named leaves so the whole world isn't inlined.

## Known limitations (MVP)

This is an early MVP. The following are out of scope for now: class static members, variance analysis at the parameter level (contravariant inputs vs covariant outputs), a `--check-semver` flag that validates against your `package.json` version bump, multi-entry-point / monorepo support, and a GitHub Action wrapper.

## License

MIT
