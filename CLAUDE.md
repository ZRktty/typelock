# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@zrktty/typelock` is a CLI + library that snapshots a TypeScript package's **public type surface** and fails CI when that surface changes in a breaking way — like Jest snapshots, but for types instead of values. Built for library authors whose published `.d.ts` is the contract consumers depend on.

## Commands

Package manager is **pnpm** (`pnpm@10.34.1`). Node `>=20.19.0`.

```bash
pnpm run build          # tsc → dist/ (postbuild chmod +x dist/cli.js)
pnpm test               # vitest run (one-shot)
pnpm run test:watch     # vitest watch
pnpm run coverage       # vitest with v8 coverage (CI gate: 80% lines)
pnpm run lint           # eslint src/ test/
pnpm run format         # prettier --write
pnpm run format:check   # prettier --check (CI uses this)
```

Run a single test file or test by name:

```bash
pnpm exec vitest run test/extract.test.ts
pnpm exec vitest run -t "produces identical signatures"
```

Tests import source directly via `.js` specifiers (e.g. `../src/extract.js`); vitest's `extensionAlias` maps `.js` → `.ts`, so **no build is needed to run tests**.

## Architecture

The pipeline is three pure stages, wired together by `cli.ts` and re-exported from `index.ts`:

```
extract(entry) → Snapshot ──serialize──> api.typelock (committed baseline)
                                              │
baseline ──parse──> Snapshot ──┐             │
current  ──extract──> Snapshot ─┴── diff ──> DiffResult (breaking[] drives exit code)
```

- **[src/extract.ts](src/extract.ts)** — builds a `ts.Program`, walks `getExportsOfModule`, resolves alias symbols (re-exports), classifies each export's kind, and produces a deterministically name-sorted `Snapshot`. Owns compiler-option resolution (inherits a found/given tsconfig, else modern defaults).
- **[src/canonicalize.ts](src/canonicalize.ts)** — the core. Turns a `ts.Type` into a canonical signature string. **This is where determinism lives.**
- **[src/diff.ts](src/diff.ts)** — compares two snapshots and classifies each change as breaking or safe (semver intent). Also renders the human-readable diff.
- **[src/format.ts](src/format.ts)** — `serialize`/`parse` for the line-delimited `api.typelock` file format (`<kind> <name>: <signature>`, one per line, git-diffable).
- **[src/cli.ts](src/cli.ts)** — arg parsing and exit codes. Excluded from unit coverage (`vitest.config.ts`).
- **[src/types.ts](src/types.ts)** — shared interfaces (`Snapshot`, `ExportEntry`, `Change`, `DiffResult`).

### Two invariants that govern most decisions here

1. **Determinism (canonicalize.ts).** Two runs over unchanged source — and ideally across TypeScript version bumps — must produce **byte-identical** output. This is enforced structurally, not textually:
   - Normalize at the **type-object level**, recursively; only stringify leaves. Never split an already-rendered string on `|` (breaks on nested unions like `(a | b)[]`).
   - Union/intersection members are sorted + deduped; object props sorted by name; `false | true` collapses to `boolean`; optional members strip the implicit `| undefined`.
   - **Expand user types, leave externals as named leaves.** `isExternalFile()` decides this via `sourceFile.hasNoDefaultLib` + a `node_modules` path check — *not* path heuristics alone — so it survives global tsc, Yarn PnP, and pnpm stores. Builtins (`Array`, `Date`, `Promise`) and node_modules types stay as named refs so the whole world isn't inlined.
   - The fallback stringifier deliberately omits `UseFullyQualifiedType` because it emits machine-specific absolute `import("/abs/path").Name` strings.

2. **Conservative breaking-change classification (diff.ts).** A false "breaking" warning is annoying; a *missed* breaking change makes the tool worthless. So `classifyChange` only down-grades to non-breaking when it can **prove** safety: purely-added optional members, required→optional transitions, and a small set of safe function-signature evolutions (appended optional params, a param becoming optional). Everything else — removed exports, return-type changes, param-type changes — is breaking. Removed export = breaking; added export = safe.

The diff classifier parses the canonical signature strings (depth-aware `splitTopLevel` on `;`/`,` respecting `()[]{}<>` and `=>`). When you change the canonical string format in `canonicalize.ts`, the regex/parse logic in `diff.ts` must stay in sync.

## What the surface tracks

Per exported symbol: type aliases (resolved shape), interfaces (sorted members), classes (instance members + explicit `new(...)` constructor sigs + static members), functions (params + return), enums, namespaces, index signatures. Works on both `.ts` source and hand-authored `.d.ts`. Test fixtures live in [test/fixtures/](test/fixtures/) — add a `*-changed.ts` counterpart when testing a diff scenario.

> Note: README "Known limitations" still lists class static members as out of scope, but `canonicalize.ts` (`renderStaticMembers`) now tracks them. Keep docs in sync when changing surface coverage.

## Release

`main` is auto-released by **semantic-release** ([.github/workflows/release.yml](.github/workflows/release.yml)) on push: commit-analyzer determines the version from Conventional Commits, publishes to npm with provenance, commits the bumped `package.json` with `[skip ci]`. **Commit messages must follow Conventional Commits** (`feat:`, `fix:`, `chore:`, etc.) — they drive the version bump.

npm publishing uses **OIDC trusted publishing**, which requires **npm >= 11.5.1**; the release job installs `npm@^11.5.1` over the npm that ships with Node 22.14 (10.9.2). Pinned to `11.x` deliberately — see the workflow comment in [.github/workflows/release.yml](.github/workflows/release.yml).
