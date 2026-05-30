#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { extract } from "./extract.js";
import { diff } from "./diff.js";
import { serialize, parse } from "./format.js";

interface Args {
  entry: string;
  snapfile: string;
  update: boolean;
  tsconfig?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    entry: "src/index.ts",
    snapfile: "api.typesnapshot",
    update: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update" || a === "-u") args.update = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--entry" || a === "-e") args.entry = argv[++i];
    else if (a === "--snapfile" || a === "-s") args.snapfile = argv[++i];
    else if (a === "--tsconfig") args.tsconfig = argv[++i];
    else if (!a.startsWith("-")) args.entry = a;
  }
  return args;
}

const HELP = `
typesnapshot — snapshot your TypeScript public API surface

Usage:
  typesnapshot [entry] [options]

Options:
  -e, --entry <file>      Entry point (default: src/index.ts)
  -s, --snapfile <file>   Snapshot file (default: api.typesnapshot)
  -u, --update            Write/overwrite the snapshot baseline
      --tsconfig <file>   tsconfig.json to inherit compiler options from
  -h, --help              Show this help

Examples:
  typesnapshot --update                 Create the baseline (commit api.typesnapshot)
  typesnapshot                          Check current types against baseline
  typesnapshot -e src/public.ts -u      Snapshot a custom entry point
`;

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const entryPath = path.resolve(args.entry);
  if (!fs.existsSync(entryPath)) {
    process.stderr.write(`Error: entry file not found: ${args.entry}\n`);
    process.exit(2);
  }

  const current = extract({ entry: entryPath, tsconfig: args.tsconfig });
  const snapPath = path.resolve(args.snapfile);

  if (args.update) {
    fs.writeFileSync(snapPath, serialize(current), "utf8");
    process.stdout.write(
      `✓ Wrote ${current.exports.length} exports to ${args.snapfile}\n`,
    );
    process.exit(0);
  }

  if (!fs.existsSync(snapPath)) {
    process.stderr.write(
      `Error: no snapshot at ${args.snapfile}. Run with --update to create one.\n`,
    );
    process.exit(2);
  }

  const baseline = parse(fs.readFileSync(snapPath, "utf8"));
  const result = diff(baseline, current);

  if (!result.hasChanges) {
    process.stdout.write("✓ Public type surface unchanged.\n");
    process.exit(0);
  }

  process.stdout.write("\nPublic type surface changed:\n\n");
  process.stdout.write(result.format() + "\n\n");

  if (result.breaking.length > 0) {
    process.stderr.write(
      `✗ ${result.breaking.length} breaking change(s) detected.\n` +
        `  If intentional, run \`typesnapshot --update\` and commit the new baseline.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `Only non-breaking additions detected.\n` +
      `  Run \`typesnapshot --update\` to accept them into the baseline.\n`,
  );
  process.exit(0);
}

main();
