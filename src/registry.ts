import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';

// Shared on-disk registry of every VS Code window's integrated-terminal PIDs.
// Each window's extension instance keeps its own entry up to date so external
// tools (notify.sh) can look up which window owns a given shell PID, bring
// that window to the foreground (via `code <workspace>`), and then dispatch
// the windowKey-gated focus URI so the right extension host focuses the
// right terminal.

const STALE_AGE_SECONDS = 24 * 60 * 60;

export interface RegistryEntry {
  windowKey: string;
  workspace: string;
  title: string;
  pids: number[];
  updatedAt: number;
}

interface Registry {
  windows: RegistryEntry[];
}

export function registryDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'code-terminal-focus');
}

export function registryPath(): string {
  return path.join(registryDir(), 'windows.json');
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(registryDir(), { recursive: true });
}

async function readRaw(): Promise<Registry> {
  try {
    const buf = await fs.readFile(registryPath(), 'utf8');
    const parsed = JSON.parse(buf) as Partial<Registry>;
    if (parsed && Array.isArray(parsed.windows)) {
      return { windows: parsed.windows };
    }
  } catch {
    // Missing or malformed — return fresh
  }
  return { windows: [] };
}

function pruneStale(reg: Registry, now: number): Registry {
  return {
    windows: reg.windows.filter((w) => now - w.updatedAt < STALE_AGE_SECONDS),
  };
}

// Acquire the lock, run the mutation, atomically rename a tmpfile into place.
// The lock file itself lives next to windows.json. proper-lockfile retries
// briefly on contention.
async function mutate(
  fn: (reg: Registry) => Registry,
): Promise<void> {
  await ensureDir();
  // Ensure the target file exists before locking (proper-lockfile requires it).
  try {
    await fs.access(registryPath());
  } catch {
    await fs.writeFile(registryPath(), JSON.stringify({ windows: [] }, null, 2));
  }
  const release = await lockfile.lock(registryPath(), {
    retries: { retries: 5, minTimeout: 20, maxTimeout: 200 },
    stale: 10_000,
    realpath: false,
  });
  try {
    const before = await readRaw();
    const after = fn(before);
    const tmp = registryPath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(after, null, 2));
    await fs.rename(tmp, registryPath());
  } finally {
    await release();
  }
}

export async function upsertEntry(entry: RegistryEntry): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await mutate((reg) => {
    const next = pruneStale(reg, now);
    const others = next.windows.filter((w) => w.windowKey !== entry.windowKey);
    others.push({ ...entry, updatedAt: now });
    return { windows: others };
  });
}

export async function removeEntry(windowKey: string): Promise<void> {
  await mutate((reg) => ({
    windows: reg.windows.filter((w) => w.windowKey !== windowKey),
  }));
}
