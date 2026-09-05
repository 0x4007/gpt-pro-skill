import { stateDirectory } from "./state.ts";
// Private local job state. Never store bearer tokens, cookies, or Sentinel data.
export const POLL_WINDOW_MS = 6 * 60 * 60 * 1000;
export type JobStatus =
  | "preparing"
  | "submitting"
  | "pending"
  | "completed"
  | "failed"
  | "uncertain"
  | "timed_out";
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
  answer?: string;
  lastError?: string;
  lastPollAt?: string;
  pollCount: number;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set([
  "preparing",
  "submitting",
  "pending",
  "completed",
  "failed",
  "uncertain",
  "timed_out",
]);
export class JobStore {
  constructor(
    readonly directory = new URL(".gpt-pro-jobs/", stateDirectory()),
  ) {}
  private path(id: string, suffix = ".json"): URL {
    if (!ID.test(id)) throw new Error("Invalid GPT Pro job ID");
    return new URL(id + suffix, this.directory);
  }
  private async initialize(): Promise<void> {
    await Deno.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await Deno.lstat(this.directory);
    if (
      !info.isDirectory || info.isSymlink ||
      (info.mode !== null && (info.mode & 0o077) !== 0)
    ) throw new Error("GPT Pro job directory must be owner-only (mode 0700)");
  }
  async create(prompt: string, account: string): Promise<ProJob> {
    await this.initialize();
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
    await Deno.writeTextFile(this.path(job.id), JSON.stringify(job, null, 2), {
      createNew: true,
      mode: 0o600,
    });
    return job;
  }
  async read(id: string): Promise<ProJob> {
    const path = this.path(id);
    const info = await Deno.lstat(path);
    if (
      !info.isFile || info.isSymlink ||
      (info.mode !== null && (info.mode & 0o077) !== 0)
    ) throw new Error("GPT Pro job file must be owner-only (mode 0600)");
    let job: ProJob;
    try {
      job = JSON.parse(await Deno.readTextFile(path));
    } catch {
      throw new Error("Could not decode GPT Pro job record");
    }
    if (
      job.version !== 1 || job.id !== id || !ID.test(job.messageId) ||
      job.model !== "gpt-6-pro" || !statuses.has(job.status) ||
      typeof job.account !== "string" || typeof job.prompt !== "string" ||
      !Number.isFinite(job.pollCount)
    ) throw new Error("Invalid GPT Pro job record");
    return job;
  }
  // Call under withLock. Rename makes a complete snapshot visible to --jobs.
  async save(job: ProJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    const temporary = this.path(job.id, `.${crypto.randomUUID()}.tmp`);
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
      await Deno.rename(temporary, this.path(job.id));
    } catch (error) {
      await Deno.remove(temporary);
      throw error;
    }
  }
  async withLock<T>(
    id: string,
    action: (job: ProJob) => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    const path = this.path(id, ".lock");
    const file = await Deno.open(path, {
      create: true,
      read: true,
      write: true,
      mode: 0o600,
    });
    try {
      // OS releases the lock after process death; no stale PID-file recovery.
      await file.lock(true);
      return await action(await this.read(id));
    } finally {
      file.close();
    }
  }
  async list(): Promise<ProJob[]> {
    await this.initialize();
    const jobs: ProJob[] = [];
    for await (const entry of Deno.readDir(this.directory)) {
      if (
        entry.isFile && entry.name.endsWith(".json") &&
        ID.test(entry.name.slice(0, -5))
      ) jobs.push(await this.read(entry.name.slice(0, -5)));
    }
    return jobs.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  }
}
