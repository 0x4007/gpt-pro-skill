import { isAbsolute } from "node:path";
import { ChatSession, importWebSession, parseWebSession, type WebSession } from "./session.ts";
import { CHATGPT_ORIGIN, errorText, redactSensitiveText } from "./shared.ts";
import { ensurePrivateState, stateDirectory } from "./state.ts";

class TransferError extends Error {}

const DEFAULT_REMOTE_STATE = "$HOME/.local/share/gpt-pro";
const SSH_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 30_000;
const SOURCE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$/;

interface Options {
  directory?: string;
  from?: string;
  fromStateDirectory?: string;
  fromFile?: string;
  replaceAccount: boolean;
  dryRun: boolean;
  help: boolean;
}

export interface TransferResult {
  transferred: boolean;
  dryRun: boolean;
  accountFingerprint: string;
  accountChanged: boolean;
  backupPath?: string;
  verificationHttpStatus: number;
}

const HELP = [
  "Usage: transfer-session.ts --from <user@host> [options]",
  "       transfer-session.ts --from-file /absolute/path/.env [options]",
  "",
  "Reads a completed GPT Pro web session from another host or a local export,",
  "verifies it, and installs it into this host's private state.",
  "",
  "Options:",
  "  --state-dir /absolute/path       destination state directory",
  "  --from-state-dir /absolute/path  source state directory on the SSH host",
  "  --replace-account                allow replacing a different saved account",
  "  --dry-run                        verify and compare without writing state",
  "  --help                           show this text",
  "",
  "The default state directory is ~/.local/share/gpt-pro on both hosts.",
  "SSH runs with BatchMode=yes; configure any jump host in your SSH config.",
].join("\n");

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function invalidPath(value: string, label: string): void {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new TransferError(label + " must be an absolute path without control characters");
  }
}

export function remoteSessionCommand(state: string | undefined): string {
  if (state !== undefined) invalidPath(state, "--from-state-dir");
  const file = state === undefined ? '"' + DEFAULT_REMOTE_STATE + '/.env"' : shellQuote(state + "/.env");
  return "base64 < " + file;
}

function valueAfter(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value) throw new TransferError(name + " requires a value");
  return value;
}

function validateOptions(options: Options): void {
  if (Boolean(options.from) === Boolean(options.fromFile)) {
    throw new TransferError("Choose exactly one of --from or --from-file");
  }
  if (options.fromStateDirectory !== undefined && options.from === undefined) {
    throw new TransferError("--from-state-dir requires --from");
  }
  if (options.directory !== undefined) invalidPath(options.directory, "--state-dir");
  if (options.fromStateDirectory !== undefined) invalidPath(options.fromStateDirectory, "--from-state-dir");
  if (options.fromFile !== undefined) invalidPath(options.fromFile, "--from-file");
  if (options.from !== undefined && !SOURCE.test(options.from)) {
    throw new TransferError("--from must be user@host; configure aliases and jump hosts in SSH config");
  }
}

function parseOptions(args: string[]): Options {
  const options: Options = { replaceAccount: false, dryRun: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    switch (name) {
      case "--help":
        options.help = true;
        break;
      case "--replace-account":
        options.replaceAccount = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--state-dir":
        options.directory = valueAfter(args, index, name);
        index++;
        break;
      case "--from-state-dir":
        options.fromStateDirectory = valueAfter(args, index, name);
        index++;
        break;
      case "--from":
        options.from = valueAfter(args, index, name);
        index++;
        break;
      case "--from-file":
        options.fromFile = valueAfter(args, index, name);
        index++;
        break;
      default:
        throw new TransferError("Unknown option: " + name);
    }
  }
  if (!options.help) validateOptions(options);
  return options;
}

async function readLocalSession(path: string): Promise<string> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new TransferError("--from-file does not exist");
    throw error;
  }
  if (!info.isFile || info.isSymlink || (info.mode !== null && (info.mode & 0o077) !== 0)) {
    throw new TransferError("--from-file must be an owner-only regular file (mode 0600)");
  }
  return await Deno.readTextFile(path);
}

async function readRemoteSession(source: string, state: string | undefined): Promise<string> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("ssh", {
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", source, remoteSessionCommand(state)],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(SSH_TIMEOUT_MS),
    }).output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new TransferError("ssh was not found; install OpenSSH or use --from-file");
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new TransferError("SSH transfer timed out; no state was changed");
    }
    throw new TransferError("Could not start the SSH transfer; no state was changed");
  }
  if (!output.success) {
    throw new TransferError("Could not read the source session over SSH (exit " + String(output.code) + "); no state was changed");
  }
  try {
    const encoded = new TextDecoder().decode(output.stdout).replace(/\s/g, "");
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
  } catch {
    throw new TransferError("The source did not return a readable session file");
  }
}

function subject(token: string): string {
  try {
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error();
    return claims.sub;
  } catch {
    throw new TransferError("Incoming session has no account identity");
  }
}

async function fingerprint(session: WebSession, label = "Incoming session"): Promise<string> {
  let value: string;
  try {
    value = subject(session.accessToken);
  } catch {
    throw new TransferError(label + " has no account identity");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readExisting(directory: URL): Promise<WebSession | undefined> {
  const path = new URL(".env", directory);
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  if (!info.isFile || info.isSymlink || (info.mode !== null && (info.mode & 0o077) !== 0)) {
    throw new TransferError("Existing .env is not an owner-only regular file; no state was changed");
  }
  try {
    return parseWebSession(await Deno.readTextFile(path), true);
  } catch {
    throw new TransferError("Existing .env is invalid; move it aside before transferring");
  }
}

async function verify(session: WebSession): Promise<number> {
  const client = new ChatSession(session);
  let response: Response;
  try {
    response = await client.fetch(CHATGPT_ORIGIN + "/backend-api/models", {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch {
    throw new TransferError("Incoming session verification failed before a response; no state was changed");
  }
  await response.body?.cancel();
  if (!response.ok) {
    throw new TransferError("Incoming session verification returned HTTP " + String(response.status) + "; no state was changed");
  }
  session.cookie = client.cookies.header();
  return response.status;
}

async function backup(directory: URL): Promise<string> {
  const destination = new URL(".env.backup-" + crypto.randomUUID(), directory);
  await Deno.copyFile(new URL(".env", directory), destination);
  await Deno.chmod(destination, 0o600);
  return destination.pathname;
}

export async function transferSession(
  incomingText: string,
  directory: URL,
  options: { replaceAccount?: boolean; dryRun?: boolean; verifySession?: (session: WebSession) => Promise<number> } = {}
): Promise<TransferResult> {
  let incoming: WebSession;
  try {
    incoming = parseWebSession(incomingText);
  } catch {
    throw new TransferError("Incoming session is invalid or expired; run authenticate.ts on the source first");
  }
  const incomingFingerprint = await fingerprint(incoming);
  const existing = await readExisting(directory);
  let existingFingerprint: string | undefined;
  if (existing) {
    try {
      existingFingerprint = await fingerprint(existing, "Existing session");
    } catch (error) {
      if (!options.replaceAccount) throw error;
    }
  }
  const accountChanged = existing !== undefined && existingFingerprint !== incomingFingerprint;
  if (accountChanged && !options.replaceAccount) {
    throw new TransferError(
      "Incoming session belongs to a different account (existing " +
        (existingFingerprint?.slice(0, 16) ?? "unknown") +
        ", incoming " +
        incomingFingerprint.slice(0, 16) +
        "); rerun with --replace-account only if that replacement is intended"
    );
  }
  const verificationHttpStatus = await (options.verifySession ?? verify)(incoming);
  if (verificationHttpStatus < 200 || verificationHttpStatus >= 300) {
    throw new TransferError("Incoming session verification returned HTTP " + String(verificationHttpStatus) + "; no state was changed");
  }
  if (options.dryRun) {
    return { transferred: false, dryRun: true, accountFingerprint: incomingFingerprint, accountChanged, verificationHttpStatus };
  }
  await ensurePrivateState(directory);
  let backupPath: string | undefined;
  if (accountChanged) backupPath = await backup(directory);
  await importWebSession(JSON.stringify(incoming), directory);
  return { transferred: true, dryRun: false, accountFingerprint: incomingFingerprint, accountChanged, backupPath, verificationHttpStatus };
}

async function main(args: string[]): Promise<void> {
  const options = parseOptions(args);
  if (options.help) {
    console.log(HELP);
    return;
  }
  let incoming: string;
  if (options.from) incoming = await readRemoteSession(options.from, options.fromStateDirectory);
  else if (options.fromFile) incoming = await readLocalSession(options.fromFile);
  else throw new TransferError("Choose exactly one of --from or --from-file");
  const result = await transferSession(incoming, stateDirectory(options.directory), {
    replaceAccount: options.replaceAccount,
    dryRun: options.dryRun,
  });
  console.log(
    JSON.stringify({
      ...result,
      source: options.from ? "ssh" : "file",
      modelSubmission: false,
      submissionEligibility: "not_tested",
    })
  );
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(redactSensitiveText(errorText(error)));
    Deno.exitCode = 1;
  }
}
