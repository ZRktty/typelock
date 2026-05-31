Issue 1: boolean renders as false | true
The TS type checker internally represents boolean as a union of the two literal types true and false. When the canonicalizer walks unions and stringifies members recursively, it sees two members (true and false), sorts them alphabetically (false comes first), and joins them. Result:
ts// user wrote:
export interface FoldOptions {
  preserveCase: boolean
}

// .typelock shows:
interface FoldOptions: { preserveCase: false | true }
Technically correct, since boolean === true | false in the type system. But every user reading the snapshot expects boolean. They will assume the tool is broken or doing something weird. It also bloats diffs: a boolean field that becomes boolean | null shows as false | true going to false | null | true, which is harder to scan than boolean going to boolean | null.
Fix: in the union canonicalization, detect when the sorted members are exactly ["false", "true"] and collapse back to "boolean". Three lines of code in canonicalize.ts.
Issue 2: Optional fields carry redundant | undefined
When you declare locale?: string, the type checker's getTypeOfSymbolAtLocation returns the type as string | undefined, because an optional property can be missing (which is undefined at runtime). The canonicalizer currently writes both the ? modifier AND the | undefined:
ts// user wrote:
export interface FoldOptions {
  locale?: string
}

// .typelock shows:
interface FoldOptions: { locale?: string | undefined }
The ? and the | undefined express the same thing. Every TS user writes locale?: string and expects to see locale?: string back. The trailing | undefined is noise. Worse, it leaks into diffs: adding a second optional field shows the redundant suffix twice, making the diff visually heavier than the actual change.
Fix: when rendering an object member, if the property is optional, strip | undefined from the end of its signature before joining. Maybe ten lines total because you need to handle the case where undefined is in the middle of a union too (string | undefined | number should become string | number when the property is optional).


LLM review of PR #6

```
Looking at PR #6, you addressed both concerns I raised. Specifically:
The pnpm/Node inconsistency is resolved cleanly, and the way it's resolved is the right way. You dropped pnpm 11 for pnpm 10.34.1 (which supports Node >=18.12), restored a real Node matrix [20, 22, 24], and aligned engines.node to >=20 because Vitest 4 honestly requires it. That last bit is the move I like most: instead of claiming >=18 while only testing 22, you made the published contract match what the CI verifies. No hidden footguns for users. Adding Node 24 is also good forward-thinking since it becomes LTS in late 2026.
The 0.2.0 bump is correct, with a dedicated commit explaining the semver reasoning. The PR description is well-structured for a release post: Features / Bug fixes / DX / Docs / Package table / Test plan. If you want to recycle 80% of this as a release blog post or Show HN, it's already in that shape.
What's not here: the canonicalization fixes (boolean rendered as false | true, redundant | undefined on optional fields). They didn't make it into this PR. That's a deliberate choice and I think defensible, with one caveat.
The defense: this PR is already 19 commits, the function sig classification work is a coherent unit, and the canonicalization fixes are a different concern (output formatting in canonicalize.ts vs. classification logic in diff.ts). Bundling them now would delay 0.2.0 and inflate the diff for reviewers. Plus, in practical terms, you don't have real users yet, so the "two painful snapshot regenerations" cost I warned about is currently theoretical.
The caveat: do 0.3.0 with the canonicalization fixes before adoption picks up. Once a single library actually commits a .typelock baseline that includes false | true, the cost of fixing it goes up because their next CI run will diff and they will wonder if the tool is broken. Right now you have zero adoption pressure, which is the perfect time to fix it. The fixes themselves are small (~30-50 lines in canonicalize.ts), and they're isolated enough that you can ship 0.3.0 within a day or two of merging 0.2.0.
So my read: merge this PR as 0.2.0 once Copilot's review settles, tag/publish, then immediately open a release/0.3.0 branch with the two canonicalization fixes. Don't promote 0.2.0 publicly (Show HN, r/typescript, TS Discord) until 0.3.0 is out, because the noisy output will be the first thing anyone notices in a screenshot and it undermines the "deterministic, clean diffs" pitch.
One small thing I'd add to the PR if you want it tighter: under "Test plan", the line "CI green on Node 20, 22, 24" should link to the actual CI run once it passes. Reviewers (or future-you re-reading the PR description) will thank you. Not a blocker.
Want me to write the 0.3.0 canonicalization fixes now so they're ready to go the moment 0.2.0 lands?
```