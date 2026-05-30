import ts from "typescript";
import * as path from "node:path";
import { canonicalizeType } from "./canonicalize.js";
import type {
  ExtractOptions,
  Snapshot,
  ExportEntry,
  ExportKind,
} from "./types.js";

/**
 * Extract the public API type surface from an entry point.
 *
 * Walks every exported symbol of the entry module, resolves aliases (so
 * re-exports like `export * from './foo'` are followed to their real symbol),
 * canonicalizes each type, and returns a deterministically ordered snapshot.
 */
export function extract(options: ExtractOptions): Snapshot {
  const entry = path.resolve(options.entry);
  const compilerOptions = resolveCompilerOptions(options.tsconfig, entry);

  const program = ts.createProgram({
    rootNames: [entry],
    options: compilerOptions,
  });
  const checker = program.getTypeChecker();

  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) {
    throw new Error(`Could not load entry file: ${entry}`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    // A file with no exports still produces a valid (empty) snapshot.
    return emptySnapshot();
  }

  const exportSymbols = checker.getExportsOfModule(moduleSymbol);
  const entries: ExportEntry[] = [];

  for (const symbol of exportSymbols) {
    // CRITICAL: resolve aliases. Re-exported symbols are aliases pointing at
    // the real declaration; without this, types come back as `any` or fail.
    const resolved = resolveSymbol(symbol, checker);
    const name = symbol.getName();
    const kind = classifyKind(resolved);
    const signature = signatureForSymbol(resolved, kind, checker, sourceFile);
    entries.push({ name, kind, signature });
  }

  // Deterministic ordering: sort by name. Two runs always agree.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    formatVersion: 1,
    typescriptVersion: ts.version,
    exports: entries,
  };
}

/** Follow alias symbols to their underlying declaration. */
function resolveSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return symbol;
    }
  }
  return symbol;
}

function classifyKind(symbol: ts.Symbol): ExportKind {
  const f = symbol.flags;
  if (f & ts.SymbolFlags.Function) return "function";
  if (f & ts.SymbolFlags.Class) return "class";
  if (f & ts.SymbolFlags.Interface) return "interface";
  if (f & ts.SymbolFlags.TypeAlias) return "type-alias";
  if (f & ts.SymbolFlags.Enum) return "enum";
  if (f & (ts.SymbolFlags.Module | ts.SymbolFlags.NamespaceModule))
    return "namespace";
  if (f & (ts.SymbolFlags.Variable | ts.SymbolFlags.BlockScopedVariable))
    return "variable";
  return "unknown";
}

function signatureForSymbol(
  symbol: ts.Symbol,
  kind: ExportKind,
  checker: ts.TypeChecker,
  location: ts.Node,
): string {
  const decl = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? location;

  // For type aliases, interfaces, and classes use the declared type: this gives
  // the resolved shape (for aliases/interfaces) or the instance type (for classes).
  // The constructor/value type from getTypeOfSymbolAtLocation returns `typeof Foo`
  // for classes, which has construct signatures that block member expansion.
  if (kind === "type-alias" || kind === "interface" || kind === "class") {
    const declared = checker.getDeclaredTypeOfSymbol(symbol);
    return canonicalizeType(declared, checker);
  }

  const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
  return canonicalizeType(type, checker);
}

function emptySnapshot(): Snapshot {
  return { formatVersion: 1, typescriptVersion: ts.version, exports: [] };
}

/**
 * Resolve compiler options. If a tsconfig is given (or found), inherit from it;
 * otherwise fall back to sane modern defaults so zero-config still works.
 */
function resolveCompilerOptions(
  tsconfigPath: string | undefined,
  entry: string,
): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2021,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };

  const configPath =
    tsconfigPath ??
    ts.findConfigFile(path.dirname(entry), ts.sys.fileExists, "tsconfig.json");

  if (!configPath) return defaults;

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return defaults;

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    path.dirname(configPath),
  );
  return { ...parsed.options, noEmit: true };
}
