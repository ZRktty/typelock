# typelock DX Roadmap

Developer-experience improvements that make the tool easier to work on, safer to change, and faster to release. These are internal concerns — they don't change what users get, but they determine how quickly and confidently we can ship things that do.

---

## DX-1 — Migrate to Vitest ✦ certain

**Current state**: Tests run with Node's built-in `--test` runner via `--experimental-strip-types`. This works but the runner has limited output, no built-in watch mode, and no coverage support without extra plumbing.

**What to do**: Replace `node --test` with Vitest. Keep the test files as-is — Vitest understands the same `test()` / `assert` style or its own `expect()`, and it runs `.ts` files natively without the experimental flag.

```bash
npm install --save-dev vitest
# package.json scripts:
"test":       "vitest run",
"test:watch": "vitest"
```

**Why Vitest specifically over Jest**: Zero-config TypeScript support, ESM-first (matches this project's `"type": "module"`), faster cold starts, and watch mode that re-runs only the affected tests. Jest requires `ts-jest` or Babel for TypeScript and has significant ESM friction.

**Acceptance criteria**:
- `npm test` runs the full suite via Vitest
- `npm run test:watch` starts interactive watch mode
- All 25 existing tests pass unchanged

---

## DX-2 — Coverage reporting ✦ certain

**Current state**: No coverage data. It is unknown which lines of `src/diff.ts` and `src/extract.ts` are exercised by tests.

**What to do**: Add `@vitest/coverage-v8` (uses Node's native V8 coverage, zero native deps, fastest option). Gate CI on a minimum threshold.

```bash
npm install --save-dev @vitest/coverage-v8
# vitest.config.ts:
coverage: { provider: "v8", thresholds: { lines: 90 }, include: ["src/**"] }
```

```bash
npm run coverage   # generates HTML report + exits 1 if below threshold
```

**Why V8 over Istanbul**: No instrumentation step, same process, faster. Istanbul is better for edge cases around synthetic code but unnecessary here.

**Acceptance criteria**:
- `npm run coverage` produces an HTML report in `coverage/`
- CI fails if line coverage drops below 90%
- Coverage report excludes `dist/` and `test/`

---

## DX-3 — CI pipeline ✦ certain

**Current state**: No automated checks run on PRs. Reviews depend on contributors running `npm test` locally.

**What to do**: Add a GitHub Actions workflow that runs on every push and PR to `main` and `release/*`.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main, "release/*"]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}" }
      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm run coverage
```

**Extras worth adding immediately**:
- `typecheck` script (`tsc --noEmit`) — runs the type checker without emitting, so type errors in tests or source catch before build
- `publint` check (see DX-5) to prevent publishing a broken package

**Acceptance criteria**:
- PRs to `main` and `release/*` are blocked without a passing CI run
- Matrix covers Node 18, 20, 22 (the supported range per `engines`)
- Build + test + typecheck all run

---

## DX-4 — Code quality toolchain ◆ likely

**Current state**: No linter, no formatter. Style is enforced by convention only.

**Recommended stack** (all zero-config for a TypeScript ESM project):

| Tool | Purpose | Config effort |
|---|---|---|
| **ESLint** + `typescript-eslint` | Catch logic errors, enforce consistent patterns | Low — extend `recommended` |
| **Prettier** | Formatting (tabs vs spaces, quotes, trailing commas) | Zero — one `.prettierrc` line |
| `eslint-config-prettier` | Disable ESLint formatting rules that conflict with Prettier | Zero |

**What to add**:
```bash
npm install --save-dev eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser prettier eslint-config-prettier
```

`eslint.config.mjs` (flat config):
```js
import tseslint from "typescript-eslint";
export default tseslint.config(
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "warn" } }
);
```

**Acceptance criteria**:
- `npm run lint` exits 0 on clean code and 1 on violations
- `npm run format` auto-formats all `.ts` files
- Both run in CI (lint failures block merge; format is check-only in CI)

**What is intentionally excluded**: Stricter type-aware lint rules (e.g. `no-unsafe-*`) — they require `parserOptions.project` and add significant CI time for marginal gain at this codebase size.

---

## DX-5 — Package quality and publishing tools ◆ recommended

These are lightweight, one-time-setup tools that catch a class of silent bugs specific to npm packages.

### publint

Validates that `package.json` exports, `main`, `types`, and `files` are consistent and that the package can actually be imported by consumers. Catches the "works locally, broken for users" class of bug.

```bash
npm install --save-dev publint
# add to CI: npx publint
```

Catches: wrong `exports` conditions, missing `types` field, broken subpath exports, `files` that excludes dist.

### @arethetypeswrong/cli (attw)

Checks that TypeScript types are accessible under all the module resolution modes consumers might use (`node16`, `bundler`, `classic`). Important once the package has more than one entry point.

```bash
npm install --save-dev @arethetypeswrong/cli
# add to CI: npx attw --pack
```

### knip

Finds unused exports, dead files, and undeclared dependencies. Particularly useful before a release to ensure the public API surface in `dist/` matches what `src/index.ts` actually exports.

```bash
npm install --save-dev knip
# add to CI or run manually pre-release: npx knip
```

### Renovate (or Dependabot)

Automated PRs when `typescript`, `@types/node`, or Vitest have new versions. Renovate is more configurable (auto-merge patch bumps, group devDeps); Dependabot is zero-config. Either works. Recommend Renovate for a TypeScript-heavy project where TS version bumps need to be tested before merging.

---

## DX-6 — Automated publishing with semantic-release ✦ certain

**Current state**: Releases are manual — bump version, build, `npm publish`. No changelog, no tag, no link between commits and what shipped.

**What to do**: Use `semantic-release` to fully automate the release pipeline. On every merge to `main`, it reads conventional commit messages, determines the next semver version, generates a changelog, publishes to npm, and creates a GitHub release — zero human steps.

### How it works

`semantic-release` maps commit prefixes to version bumps:

| Commit prefix | Version bump | Example |
|---|---|---|
| `fix:` | patch (`0.1.3` → `0.1.4`) | `fix: handle > in => arrow` |
| `feat:` | minor (`0.1.4` → `0.2.0`) | `feat: generic type handling` |
| `BREAKING CHANGE:` in footer | major (`0.2.0` → `1.0.0`) | any commit with breaking footer |

This aligns exactly with the commit style already used in this repo.

### Setup

```bash
npm install --save-dev semantic-release \
  @semantic-release/changelog \
  @semantic-release/git \
  @semantic-release/github
```

`.releaserc.json`:
```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { "changelogFile": "CHANGELOG.md" }],
    "@semantic-release/npm",
    ["@semantic-release/git", {
      "assets": ["CHANGELOG.md", "package.json"],
      "message": "chore(release): ${nextRelease.version} [skip ci]"
    }],
    "@semantic-release/github"
  ]
}
```

### GitHub Actions workflow

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # push CHANGELOG.md + tag
      issues: write          # close issues referenced in commits
      pull-requests: write   # comment on merged PRs
      id-token: write        # npm provenance

    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # full history — semantic-release needs tags
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: "https://registry.npmjs.org" }
      - run: npm ci
      - run: npm run build
      - run: npx semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Required secrets**: `NPM_TOKEN` (granular access token scoped to this package, publish-only).

### npm provenance

With `id-token: write` and `registry-url` set, npm will record a cryptographic link between the published package and the exact GitHub Actions run that built it. Consumers can verify the package was built from this repo and not tampered with. Free, zero extra config.

### What you keep manual

- Merging PRs — semantic-release only runs after merge to `main`
- Writing good commit messages — the release quality mirrors commit quality
- `npm deprecate` for yanking a bad release — no automation for that

**Acceptance criteria**:

- Merging a `fix:` commit to `main` automatically publishes a patch release and creates a GitHub release with changelog
- Merging a `feat:` commit bumps minor
- A commit with `BREAKING CHANGE:` in the footer bumps major
- `CHANGELOG.md` is committed back to `main` after each release
- npm package has provenance attestation

---

## DX-7 — Git hooks ◆ optional

**Lefthook** (not Husky — no npm install side effects, no shell scripts, faster):

```yaml
# lefthook.yml
pre-commit:
  commands:
    typecheck:
      run: npx tsc --noEmit
    lint:
      run: npx eslint src/ test/
```

Runs typecheck + lint before every commit. Low overhead, skippable in emergencies with `--no-verify`.

---

## Recommended sequencing

```
DX-3 (CI)  →  DX-1 (Vitest)  →  DX-2 (Coverage)  →  DX-5 (publint/attw)  →  DX-6 (semantic-release)  →  DX-4 (ESLint/Prettier)  →  DX-7 (hooks)
```

CI first so every subsequent change is automatically validated. Vitest before coverage because coverage depends on it. publint/attw before releasing because they catch package bugs. semantic-release before style tooling — shipping reliably matters more than formatting. Hooks last, optional quality-of-life on top of the CI safety net.
