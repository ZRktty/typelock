# typesnapshot v0.1.1 — Real-World Integration Findings

Tested against [`accent-folding`](https://github.com/ZRktty/accent-folding) v2.7.0, a published npm library with a hand-authored `index.d.ts` and no TypeScript source (JS library + separate `.d.ts`).

---

## Setup

```
typesnapshot -e index.d.ts --update
```

Generated baseline (`api.typesnapshot`):

```
// @typesnapshot v1
// typescript 5.9.3

type-alias AccentMap: { [x: string]: string; }
interface MatchPosition: MatchPosition
class default: typeof AccentFolding
```

Three top-level exports captured correctly. The non-default source entry (`-e index.d.ts`) worked well.

---

## What it catches ✓

### 1. Removed export
```diff
- export interface MatchPosition { ... }
```
```
✗ REMOVED  interface MatchPosition  [breaking]
      was: MatchPosition
```
**Verdict:** Clear error, correct breaking classification.

### 2. Type alias structural change
```diff
- export type AccentMap = Record<string, string>;
+ export type AccentMap = Record<string, string | null>;
```
```
~ CHANGED  type-alias AccentMap  [breaking]
    before: { [x: string]: string; }
    after:  { [x: string]: string | null; }
```
**Verdict:** Full structural diff, correct breaking classification. This is excellent — the resolved type is serialized, not just the alias name.

---

## What it misses ✗

### 3. Class method signature change
```diff
  class AccentFolding {
-   replace(text: string): string;
+   replace(text: string): string | null;
  }
```
```
✓ Public type surface unchanged.
```
**Verdict:** Not caught. The class is snapshotted as `typeof AccentFolding` without resolving member signatures.

### 4. New method added to class
```diff
  class AccentFolding {
    highlightMatch(...): string;
+   newMethod(): void;
  }
```
```
✓ Public type surface unchanged.
```
**Verdict:** Not caught. Additive class changes are invisible.

### 5. Interface member change
```diff
  interface MatchPosition {
    start: number;
    end: number;
+   length: number;
  }
```
```
✓ Public type surface unchanged.
```
**Verdict:** Not caught. Interfaces are snapshotted as `MatchPosition` (the name) with no member resolution, unlike type aliases which are fully serialized.

---

## Root cause

The snapshot format treats **type aliases** and **classes/interfaces** differently:

| Export kind    | Snapshot content               | Members resolved? |
|----------------|-------------------------------|-------------------|
| `type`         | Fully resolved structure       | ✓                 |
| `interface`    | Name only (`MatchPosition`)    | ✗                 |
| `class`        | `typeof ClassName`             | ✗                 |

For a library like `accent-folding`, most breaking changes happen inside the class (method parameter/return type changes) or interface members — and none of those are currently detected.

---

## Suggested improvement

Serialize the resolved structure of interfaces and classes the same way type aliases are already handled. For example:

```
// current
interface MatchPosition: MatchPosition
class default: typeof AccentFolding

// proposed
interface MatchPosition: { start: number; end: number; }
class default: { new(newMap?: AccentMap | null): AccentFolding; replace(text: string): string; matchPositions(str: string, fragment: string): MatchPosition[]; highlightMatch(str: string, fragment: string, wrapTag?: string): string; convertAccentMapToArray(accentMap: AccentMap): [string, string][]; }
```

This would bring class and interface parity with how type aliases are already diffed, making the tool genuinely comprehensive for library authors.

---

## Overall assessment

The tool works well for its current scope (export-level tracking), and the type alias diffing is solid. Extending resolution to class and interface members would make it a complete API stability guard for published TypeScript libraries — right now those two export kinds are the most common sources of breaking changes.

# Asked Claued Code on repo: is it still valueble to keep it or not?

```md
Honest answer: not worth keeping for this project right now.

The gap matters here specifically because:

test-types.ts already covers every method signature explicitly with typed assertions — it catches everything typesnapshot misses (method return types, param types, overloads)
Export removal would also fail tsc + test-types.ts anyway (it imports MatchPosition and AccentFolding directly)
AccentMap is the only export that typesnapshot catches better than what's already in place — and it's the least likely to change
So right now typesnapshot adds a dependency but no unique safety net for this codebase. The existing setup already covers the ground more thoroughly.

Worth revisiting once class/interface member diffing lands in typesnapshot — at that point it would complement test-types.ts (snapshot = "API didn't change", type tests = "API works correctly"), and the report you have is exactly the right input to drive that improvement.
```
