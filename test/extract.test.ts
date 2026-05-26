import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "../dist/extract.js";
import { diff } from "../dist/diff.js";
import { serialize, parse } from "../dist/format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(here, "fixtures", name);

test("union and property ordering is canonical (A|B === B|A)", () => {
  const a = extract({ entry: fx("order-a.ts") });
  const b = extract({ entry: fx("order-b.ts") });

  const sigA = Object.fromEntries(a.exports.map((e) => [e.name, e.signature]));
  const sigB = Object.fromEntries(b.exports.map((e) => [e.name, e.signature]));

  assert.equal(sigA.Mixed, sigB.Mixed, "union members must sort identically");
  assert.equal(sigA.Config, sigB.Config, "object props must sort identically");
});

test("extraction is deterministic across repeated runs", () => {
  const first = serialize(extract({ entry: fx("foldlib.ts") }));
  const second = serialize(extract({ entry: fx("foldlib.ts") }));
  assert.equal(first, second, "two runs must be byte-identical");
});

test("re-export barrel resolves aliased symbols (no `any`)", () => {
  const snap = extract({ entry: fx("reexport-barrel.ts") });
  const names = snap.exports.map((e) => e.name).sort();
  // Both the star re-export and the aliased `W` should appear, fully typed.
  assert.ok(names.includes("Widget"), "Widget should be re-exported");
  assert.ok(names.includes("makeWidget"), "makeWidget should be re-exported");

  const widget = snap.exports.find((e) => e.name === "Widget");
  assert.ok(
    widget.signature.includes("id") && widget.signature.includes("label"),
    `Widget should expand its members, got: ${widget.signature}`,
  );
  assert.ok(
    !/\bany\b/.test(widget.signature),
    "alias must resolve — signature must not be `any`",
  );
});

test("required → optional is detected as a change", () => {
  const before = extract({ entry: fx("foldlib.ts") });
  const after = extract({ entry: fx("foldlib-changed.ts") });
  const result = diff(before, after);

  assert.ok(result.hasChanges, "should detect changes");
  const foldOpts = result.changed.find((c) => c.name === "FoldOptions");
  assert.ok(foldOpts, "FoldOptions should be in the changed set");
});

test("adding only optional fields is non-breaking", () => {
  // Construct two snapshots by hand to isolate the classifier.
  const before = {
    formatVersion: 1,
    typescriptVersion: "test",
    exports: [{ name: "O", kind: "type-alias", signature: "{ a: string }" }],
  };
  const after = {
    formatVersion: 1,
    typescriptVersion: "test",
    exports: [
      { name: "O", kind: "type-alias", signature: "{ a: string; b?: number }" },
    ],
  };
  const result = diff(before, after);
  const change = result.changed.find((c) => c.name === "O");
  assert.ok(change, "should register a change");
  assert.equal(change.breaking, false, "added optional field is non-breaking");
});

test("removing an export is breaking", () => {
  const before = {
    formatVersion: 1,
    typescriptVersion: "test",
    exports: [{ name: "gone", kind: "function", signature: "() => void" }],
  };
  const after = { formatVersion: 1, typescriptVersion: "test", exports: [] };
  const result = diff(before, after);
  assert.equal(result.removed.length, 1);
  assert.equal(result.breaking.length, 1);
  assert.equal(result.breaking[0].name, "gone");
});

test(".typesnap round-trips through serialize/parse", () => {
  const snap = extract({ entry: fx("foldlib.ts") });
  const reparsed = parse(serialize(snap));
  assert.deepEqual(
    reparsed.exports,
    snap.exports,
    "parse(serialize(x)) must preserve exports",
  );
});
