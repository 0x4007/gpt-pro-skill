import { isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

// Keep credentials and jobs outside versioned skill/plugin installation folders.
export function stateDirectory(explicit?: string): URL {
  if (explicit !== undefined && !isAbsolute(explicit)) {
    throw new Error("--state-dir must be an absolute path");
  }
  let path = explicit;
  if (path === undefined) {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    if (!home || !isAbsolute(home)) {
      throw new Error("HOME/USERPROFILE was unavailable; use --state-dir");
    }
    path = join(home, ".local", "share", "gpt-pro");
  }
  return pathToFileURL(path.endsWith(sep) ? path : path + sep);
}

export async function ensurePrivateState(directory: URL): Promise<void> {
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(directory);
  if (
    !info.isDirectory || info.isSymlink ||
    (info.mode !== null && (info.mode & 0o077) !== 0)
  ) throw new Error("GPT Pro state directory must be owner-only (mode 0700)");
}
