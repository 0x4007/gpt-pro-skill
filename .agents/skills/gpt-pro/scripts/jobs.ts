import { stateDirectory } from "./state.ts";
export const POLL_WINDOW_MS = 6 * 60 * 60 * 1000;
export type JobStatus = "preparing" | "submitting" | "pending" | "completed" | "failed" | "uncertain" | "timed_out";
export interface ProJob {
  version: 1;
  id: string;
  messageId: string;
  model: "gpt-6-pro";
  account: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  conversationId?: string;
  submissionAttemptedAt?: string;
  answer?: string;
  lastError?: string;
  lastPollAt?: string;
  pollCount: number;
  rateLimitCount?: number;
  nextPollAt?: string;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(["preparing", "submitting", "pending", "completed", "failed", "uncertain", "timed_out"]);

function isOptionalRateLimitCount(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalPollTimestamp(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// Job records are read back from disk as untrusted JSON, so the checks below run against an
// unknown property bag rather than against the `ProJob` shape they are validating. Reading the
// same fields in the same order keeps a corrupt record failing exactly as it did before.
function isJobRecord(value: unknown, id: string): value is ProJob {
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    record.id === id &&
    typeof record.messageId === "string" &&
    ID.test(record.messageId) &&
    record.model === "gpt-6-pro" &&
    typeof record.status === "string" &&
    statuses.has(record.status) &&
    typeof record.account === "string" &&
    typeof record.prompt === "string" &&
    Number.isFinite(record.pollCount) &&
    isOptionalRateLimitCount(record.rateLimitCount) &&
    isOptionalPollTimestamp(record.nextPollAt)
  );
}

export class JobStore {
  constructor(readonly directory = new URL(".gpt-pro-jobs/", stateDirectory())) {}
  private _path(id: string, suffix = ".json"): URL {
    if (!ID.test(id)) throw new Error("Invalid GPT Pro job ID");
    return new URL(id + suffix, this.directory);
  }
  private async _initialize(): Promise<void> {
    await Deno.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(this.directory);
    if (!info.isDirectory || info.isSymlink || (info.mode !== null && (info.mode & 0o077) !== 0))
      throw new Error("GPT Pro job directory must be owner-only (mode 0700)");
  }
  async create(prompt: string, account: string): Promise<ProJob> {
    await this._initialize();
    const now = new Date().toISOString();
    const job: ProJob = {
      version: 1,
      id: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      model: "gpt-6-pro",
      account,
      prompt,
      status: "preparing",
      createdAt: now,
      updatedAt: now,
      pollCount: 0,
    };
    await Deno.writeTextFile(this._path(job.id), JSON.stringify(job, null, 2), {
      createNew: true,
      mode: 0o600,
    });
    return job;
  }
  async read(id: string): Promise<ProJob> {
    const path = this._path(id);
    const info = await Deno.lstat(path);
    if (!info.isFile || info.isSymlink || (info.mode !== null && (info.mode & 0o077) !== 0)) throw new Error("GPT Pro job file must be owner-only (mode 0600)");
    let value: unknown;
    try {
      value = JSON.parse(await Deno.readTextFile(path));
    } catch {
      throw new Error("Could not decode GPT Pro job record");
    }
    if (!isJobRecord(value, id)) throw new Error("Invalid GPT Pro job record");
    return value;
  }
  async save(job: ProJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    const temporary = this._path(job.id, `.${crypto.randomUUID()}.tmp`);
    const file = await Deno.open(temporary, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(job, null, 2));
      let offset = 0;
      while (offset < bytes.length) {
        offset += await file.write(bytes.subarray(offset));
      }
      await file.sync();
    } finally {
      file.close();
    }
    try {
      await Deno.rename(temporary, this._path(job.id));
    } catch (error) {
      await Deno.remove(temporary);
      throw error;
    }
  }
  async withLock<T>(id: string, action: (job: ProJob) => Promise<T>): Promise<T> {
    await this._initialize();
    const path = this._path(id, ".lock");
    const file = await Deno.open(path, {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    });
    try {
      await file.lock(true);
      return await action(await this.read(id));
    } finally {
      file.close();
    }
  }
  async list(): Promise<ProJob[]> {
    await this._initialize();
    const jobs: ProJob[] = [];
    for await (const entry of Deno.readDir(this.directory)) {
      if (entry.isFile && entry.name.endsWith(".json") && ID.test(entry.name.slice(0, -5))) jobs.push(await this.read(entry.name.slice(0, -5)));
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}
