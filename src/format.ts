import type { Snapshot, ExportEntry, ExportKind } from "./types.js";

const HEADER = "// @typelock v1";

/**
 * Serialize a snapshot to the .typelock text format.
 *
 * Line-delimited and diffable in git, so a reviewer sees exactly which part
 * of the public surface moved in a PR. One export per line:
 *
 *   // @typelock v1
 *   // typescript 5.4.5
 *
 *   function fold: (input: string) => string
 *   interface FoldOptions: { preserveCase: boolean }
 */
export function serialize(snapshot: Snapshot): string {
  const lines: string[] = [HEADER, `// typescript ${snapshot.typescriptVersion}`, ""];
  for (const e of snapshot.exports) {
    lines.push(`${e.kind} ${e.name}: ${e.signature}`);
  }
  return lines.join("\n") + "\n";
}

/** Parse a .typesnap file back into a Snapshot for diffing. */
export function parse(text: string): Snapshot {
  const lines = text.split(/\r?\n/);
  const exports: ExportEntry[] = [];
  let typescriptVersion = "unknown";

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "") continue;
    if (line.startsWith("// typescript ")) {
      typescriptVersion = line.slice("// typescript ".length).trim();
      continue;
    }
    if (line.startsWith("//")) continue;

    // `<kind> <name>: <signature>`
    const firstSpace = line.indexOf(" ");
    const colon = line.indexOf(": ");
    if (firstSpace === -1 || colon === -1 || colon < firstSpace) continue;

    const kind = line.slice(0, firstSpace) as ExportKind;
    const name = line.slice(firstSpace + 1, colon);
    const signature = line.slice(colon + 2);
    exports.push({ kind, name, signature });
  }

  return { formatVersion: 1, typescriptVersion, exports };
}
