/**
 * The canonical representation of a single exported declaration.
 * This is what gets written to the .typesnap file and diffed.
 */
export interface ExportEntry {
  /** The exported name, e.g. "fold", "FoldOptions". */
  name: string;
  /** What kind of thing this is. Drives how we compare it. */
  kind: ExportKind;
  /**
   * The canonical, normalized signature string.
   * Two structurally-equal types MUST produce byte-identical signatures here,
   * regardless of source formatting, import order, or alias naming.
   */
  signature: string;
}

export type ExportKind =
  | "function"
  | "variable"
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "namespace"
  | "unknown";

/** The full snapshot: an ordered, deterministic list of public exports. */
export interface Snapshot {
  /** Snapshot format version, so we can evolve the format later. */
  formatVersion: 1;
  /** The TypeScript version used to produce this snapshot (informational). */
  typescriptVersion: string;
  /** Exports sorted deterministically by name. */
  exports: ExportEntry[];
}

export interface ExtractOptions {
  /** Entry point file, e.g. "src/index.ts". */
  entry: string;
  /** Optional path to a tsconfig.json to inherit compiler options from. */
  tsconfig?: string;
}

/** A single difference between two snapshots. */
export interface Change {
  name: string;
  kind: ExportKind;
  /** What happened to this export. */
  type: "added" | "removed" | "changed";
  /** Whether this change is breaking for consumers (semver-major). */
  breaking: boolean;
  /** Previous signature, if any. */
  before?: string;
  /** New signature, if any. */
  after?: string;
}

export interface DiffResult {
  added: Change[];
  removed: Change[];
  changed: Change[];
  /** Convenience: every change flagged breaking, across all buckets. */
  breaking: Change[];
  /** True if there is any difference at all. */
  hasChanges: boolean;
  /** Render a human-readable, colorized-ish diff for the terminal. */
  format(): string;
}
