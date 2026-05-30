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

test("interface members from a .d.ts entry are expanded (not name-only)", () => {
  const snap = extract({ entry: fx("dts-lib.d.ts") });
  const pos = snap.exports.find((e) => e.name === "Position");
  assert.ok(pos, "Position should be extracted");
  assert.ok(
    pos.signature.includes("start") && pos.signature.includes("end"),
    `Position members must be expanded, got: ${pos.signature}`,
  );
  assert.notEqual(pos.signature, "Position", "must not be name-only");
});

test("class instance members from a .d.ts entry are expanded", () => {
  const snap = extract({ entry: fx("dts-lib.d.ts") });
  const proc = snap.exports.find((e) => e.name === "Processor");
  assert.ok(proc, "Processor should be extracted");
  assert.ok(
    proc.signature.includes("process") && proc.signature.includes("count"),
    `Processor members must be expanded, got: ${proc.signature}`,
  );
  assert.ok(
    !proc.signature.startsWith("typeof"),
    "must not render as typeof constructor",
  );
});

test("class method signature change is detected as breaking", () => {
  const before = extract({ entry: fx("dts-lib.d.ts") });
  const after = extract({ entry: fx("dts-lib-changed.d.ts") });
  const result = diff(before, after);
  const proc = result.changed.find((c) => c.name === "Processor");
  assert.ok(proc, "Processor should appear in changed");
  assert.equal(proc.breaking, true, "method return type change is breaking");
});

test("interface member addition is detected as a change", () => {
  const before = extract({ entry: fx("dts-lib.d.ts") });
  const after = extract({ entry: fx("dts-lib-changed.d.ts") });
  const result = diff(before, after);
  const pos = result.changed.find((c) => c.name === "Position");
  assert.ok(pos, "Position should appear in changed");
});

test("constructor signature is captured in class snapshot", () => {
  const snap = extract({ entry: fx("dts-lib.d.ts") });
  const proc = snap.exports.find((e) => e.name === "Processor");
  assert.ok(proc, "Processor should be extracted");
  assert.ok(
    proc.signature.includes("new("),
    `Constructor must appear in snapshot, got: ${proc.signature}`,
  );
  assert.ok(
    proc.signature.includes("options"),
    `Constructor param must be named, got: ${proc.signature}`,
  );
});

test("constructor signature change is detected as breaking", () => {
  const before = extract({ entry: fx("dts-lib.d.ts") });
  const after = extract({ entry: fx("dts-lib-changed.d.ts") });
  const result = diff(before, after);
  const proc = result.changed.find((c) => c.name === "Processor");
  assert.ok(proc, "Processor should appear in changed");
  assert.equal(proc.breaking, true, "adding a required constructor param is breaking");
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
