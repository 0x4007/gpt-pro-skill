import { isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// `node:path` is provided by Deno, so under a TypeScript config that cannot resolve it these
// bindings come back as `any`. Binding the separator to a `string` keeps the concatenation typed.
const separator: string = sep;

function defaultStatePath(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  if (!home || !isAbsolute(home)) {
    throw new Error("HOME/USERPROFILE was unavailable; use --state-dir");
  }
  return join(home, ".local", "share", "gpt-pro");
}

function withTrailingSeparator(path: string): string {
  return path.endsWith(separator) ? path : path + separator;
}

export function stateDirectory(explicit?: string): URL {
  if (explicit !== undefined && !isAbsolute(explicit)) {
    throw new Error("--state-dir must be an absolute path");
  }
  return pathToFileURL(withTrailingSeparator(explicit ?? defaultStatePath()));
}

export async function ensurePrivateState(directory: URL): Promise<void> {
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(directory);
  if (!info.isDirectory || info.isSymlink || (info.mode !== null && (info.mode & 0o077) !== 0))
    throw new Error("GPT Pro state directory must be owner-only (mode 0700)");
}
