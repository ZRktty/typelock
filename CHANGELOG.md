# Changelog

All notable changes to typesnapshot are documented here.

## [0.1.2] — 2026-05-30

### Fixed

- **Class instance members now fully resolved.** Classes were previously snapshotted as `typeof ClassName` (the constructor type), making method signature changes and new instance methods invisible to the diff. Classes now serialize their public instance members: `{ count: () => number; process: (input: string) => string; }`.

- **Interface members now resolved from `.d.ts` entry files.** Interfaces declared in hand-authored `.d.ts` files (the pattern used by JS libraries that ship a separate type declaration file) were snapshotted as a bare name (`MatchPosition`) rather than their members. All interface members are now expanded regardless of whether the entry file is `.ts` or `.d.ts`.

- **Inherited `Object` methods excluded from class snapshots.** The expansion fix above could have polluted class signatures with inherited methods like `toString` and `valueOf` from `lib.d.ts`. These are now filtered out; only members declared in user source appear.

These three fixes close the Phase 0 blocker found during real-world testing against [`accent-folding`](https://github.com/ZRktty/accent-folding): method-level changes to classes and interfaces were not detected at all before this release.

---

## [0.1.1] — 2025-04-xx

### Fixed

- Support TypeScript 6; widen peer dependency range to `>=4.7`.
- Make `dist/cli.js` executable via `postbuild` chmod.

## [0.1.0] — 2025-04-xx

Initial release.

- `typesnapshot --update` to generate/regenerate baseline
- `typesnapshot` to check against baseline in CI
- Canonical serialization: unions sorted, object props sorted, aliases resolved
- `boolean` normalized (no `false | true` split)
- Optional props rendered without implicit `| undefined`
- Re-export barrels followed to real declaration (no `any`)
