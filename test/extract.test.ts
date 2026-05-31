import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "../src/extract.js";
import { diff } from "../src/diff.js";
import { serialize, parse } from "../src/format.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => path.join(here, "fixtures", name);

// Minimal snapshot with a single function export — used by classifier tests.
function fnSnap(signature: string) {
  return {
    formatVersion: 1 as const,
    typescriptVersion: "test",
    exports: [{ name: "fn", kind: "function" as const, signature }],
  };
}

// ── extract ───────────────────────────────────────────────────────────────────

describe("extract", () => {
  describe("canonicalization", () => {
    it("produces identical signatures regardless of union/property order", () => {
      const a = extract({ entry: fx("order-a.ts") });
      const b = extract({ entry: fx("order-b.ts") });
      const sigA = Object.fromEntries(a.exports.map((e) => [e.name, e.signature]));
      const sigB = Object.fromEntries(b.exports.map((e) => [e.name, e.signature]));
      expect(sigA.Mixed).toBe(sigB.Mixed);
      expect(sigA.Config).toBe(sigB.Config);
    });

    it("is deterministic across repeated runs", () => {
      const first = serialize(extract({ entry: fx("foldlib.ts") }));
      const second = serialize(extract({ entry: fx("foldlib.ts") }));
      expect(first).toBe(second);
    });

    it("resolves aliased re-exports (no `any`)", () => {
      const snap = extract({ entry: fx("reexport-barrel.ts") });
      const names = snap.exports.map((e) => e.name).sort();
      expect(names).toContain("Widget");
      expect(names).toContain("makeWidget");

      const widget = snap.exports.find((e) => e.name === "Widget")!;
      expect(widget.signature).toMatch(/id/);
      expect(widget.signature).toMatch(/label/);
      expect(widget.signature).not.toMatch(/\bany\b/);
    });
  });

  describe(".d.ts entry points", () => {
    it("expands interface members (not name-only)", () => {
      const snap = extract({ entry: fx("dts-lib.d.ts") });
      const pos = snap.exports.find((e) => e.name === "Position")!;
      expect(pos).toBeDefined();
      expect(pos.signature).toMatch(/start/);
      expect(pos.signature).toMatch(/end/);
      expect(pos.signature).not.toBe("Position");
    });

    it("expands class instance members", () => {
      const snap = extract({ entry: fx("dts-lib.d.ts") });
      const proc = snap.exports.find((e) => e.name === "Processor")!;
      expect(proc).toBeDefined();
      expect(proc.signature).toMatch(/process/);
      expect(proc.signature).toMatch(/count/);
      expect(proc.signature).not.toMatch(/^typeof/);
    });

    it("captures the constructor signature", () => {
      const snap = extract({ entry: fx("dts-lib.d.ts") });
      const proc = snap.exports.find((e) => e.name === "Processor")!;
      expect(proc.signature).toMatch(/new\(/);
      expect(proc.signature).toMatch(/options/);
    });
  });
});

// ── format ────────────────────────────────────────────────────────────────────

describe("format", () => {
  it("round-trips through serialize → parse", () => {
    const snap = extract({ entry: fx("foldlib.ts") });
    const reparsed = parse(serialize(snap));
    expect(reparsed.exports).toEqual(snap.exports);
  });
});

// ── diff ──────────────────────────────────────────────────────────────────────

describe("diff", () => {
  describe("exports added and removed", () => {
    it("flags a removed export as breaking", () => {
      const before = {
        formatVersion: 1 as const,
        typescriptVersion: "test",
        exports: [{ name: "gone", kind: "function" as const, signature: "() => void" }],
      };
      const after = { formatVersion: 1 as const, typescriptVersion: "test", exports: [] };
      const result = diff(before, after);
      expect(result.removed).toHaveLength(1);
      expect(result.breaking).toHaveLength(1);
      expect(result.breaking[0].name).toBe("gone");
    });
  });

  describe("object type changes", () => {
    it("detects required → optional as a change", () => {
      const before = extract({ entry: fx("foldlib.ts") });
      const after = extract({ entry: fx("foldlib-changed.ts") });
      const result = diff(before, after);
      expect(result.hasChanges).toBe(true);
      expect(result.changed.find((c) => c.name === "FoldOptions")).toBeDefined();
    });

    it("adding only optional fields is non-breaking", () => {
      const before = {
        formatVersion: 1 as const,
        typescriptVersion: "test",
        exports: [{ name: "O", kind: "type-alias" as const, signature: "{ a: string }" }],
      };
      const after = {
        formatVersion: 1 as const,
        typescriptVersion: "test",
        exports: [{ name: "O", kind: "type-alias" as const, signature: "{ a: string; b?: number }" }],
      };
      const result = diff(before, after);
      const change = result.changed.find((c) => c.name === "O")!;
      expect(change).toBeDefined();
      expect(change.breaking).toBe(false);
    });
  });

  describe("class and interface changes", () => {
    it("detects an interface member addition", () => {
      const before = extract({ entry: fx("dts-lib.d.ts") });
      const after = extract({ entry: fx("dts-lib-changed.d.ts") });
      const result = diff(before, after);
      expect(result.changed.find((c) => c.name === "Position")).toBeDefined();
    });

    it("flags a class method return-type change as breaking", () => {
      const before = extract({ entry: fx("dts-lib.d.ts") });
      const after = extract({ entry: fx("dts-lib-changed.d.ts") });
      const result = diff(before, after);
      const proc = result.changed.find((c) => c.name === "Processor")!;
      expect(proc).toBeDefined();
      expect(proc.breaking).toBe(true);
    });

    it("flags a constructor signature change as breaking", () => {
      const before = extract({ entry: fx("dts-lib.d.ts") });
      const after = extract({ entry: fx("dts-lib-changed.d.ts") });
      const result = diff(before, after);
      const proc = result.changed.find((c) => c.name === "Processor")!;
      expect(proc.breaking).toBe(true);
    });
  });

  describe("function signature classification", () => {
    describe("parameters", () => {
      it("adding an optional parameter is non-breaking", () => {
        const result = diff(fnSnap("(a: string) => void"), fnSnap("(a: string, b?: number) => void"));
        const change = result.changed.find((c) => c.name === "fn")!;
        expect(change).toBeDefined();
        expect(change.breaking).toBe(false);
      });

      it("adding a required parameter is breaking", () => {
        const result = diff(fnSnap("(a: string) => void"), fnSnap("(a: string, b: number) => void"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(true);
      });

      it("required → optional is non-breaking", () => {
        const result = diff(fnSnap("(a: string, b: number) => void"), fnSnap("(a: string, b?: number) => void"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(false);
      });

      it("removing a parameter is breaking", () => {
        const result = diff(fnSnap("(a: string, b: number) => void"), fnSnap("(a: string) => void"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(true);
      });

      it("adding multiple optional parameters is non-breaking", () => {
        const result = diff(fnSnap("(a: string) => void"), fnSnap("(a: string, b?: number, c?: boolean) => void"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(false);
      });
    });

    describe("return type", () => {
      it("any return type change is breaking", () => {
        const result = diff(fnSnap("() => string"), fnSnap("() => string | null"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(true);
      });
    });

    describe("parameter types", () => {
      it("a parameter type change is breaking (conservative)", () => {
        const result = diff(fnSnap("(a: string) => void"), fnSnap("(a: string | number) => void"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(true);
      });
    });

    describe("object-typed parameters", () => {
      it("adding an optional field to an object param is non-breaking", () => {
        const result = diff(
          fnSnap("(opts: { x: string }) => void"),
          fnSnap("(opts: { x: string; y?: number }) => void"),
        );
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(false);
      });

      it("optional → required on the param itself is breaking even when the object only gains optional fields", () => {
        const result = diff(
          fnSnap("(opts?: { x: string }) => void"),
          fnSnap("(opts: { x: string; y?: number }) => void"),
        );
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(true);
      });
    });

    describe("rest parameters", () => {
      it("adding an array rest param is non-breaking", () => {
        const result = diff(fnSnap("(a: string) => void"), fnSnap("(a: string, ...args: number[]) => void"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(false);
      });

      it("adding a tuple rest param is breaking (has required elements)", () => {
        const result = diff(fnSnap("(a: string) => void"), fnSnap("(a: string, ...args: [number]) => void"));
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(true);
      });
    });

    describe("higher-order functions", () => {
      it("adding an optional param to a HOF is non-breaking", () => {
        const result = diff(
          fnSnap("(cb: (x: string) => void) => void"),
          fnSnap("(cb: (x: string) => void, opts?: { timeout: number }) => void"),
        );
        expect(result.changed.find((c) => c.name === "fn")!.breaking).toBe(false);
      });
    });
  });
});

test("higher-order function: adding optional callback param is non-breaking", () => {
  const result = diff(
    fnSnap("(cb: (x: string) => void) => void"),
    fnSnap("(cb: (x: string) => void, opts?: { timeout: number }) => void"),
  );
  const change = result.changed.find((c) => c.name === "fn");
  assert.ok(change, "should register a change");
  assert.equal(change.breaking, false, "added optional param on HOF is non-breaking");
});

test("adding a rest parameter is non-breaking", () => {
  const result = diff(
    fnSnap("(a: string) => void"),
    fnSnap("(a: string, ...args: number[]) => void"),
  );
  const change = result.changed.find((c) => c.name === "fn");
  assert.ok(change, "should register a change");
  assert.equal(change.breaking, false, "added rest param is non-breaking");
});
