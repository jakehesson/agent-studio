import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { BoardSchema, type Board } from "../schema/board.js";

export interface BoardLockOptions {
  /** Maximum time to wait for lock acquisition (ms). Default: 10_000. */
  timeoutMs?: number;
  /** Age after which an existing lockfile is considered stale and recovered (ms). Default: 30_000. */
  staleMs?: number;
  /** Base polling delay between acquisition attempts (ms). Default: 15. */
  retryDelayMs?: number;
}

export interface DefaultBoardOptions {
  projectId: string;
  milestoneId?: string;
  milestoneName?: string;
  sprintId?: string;
  sprintGoal?: string;
  suites?: Record<string, string[]>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrno(err: unknown, ...codes: string[]): boolean {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && codes.includes(code);
}

async function renameWithRetry(src: string, dest: string): Promise<void> {
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err) {
      if (isErrno(err, "EPERM", "EACCES", "EBUSY") && attempt < maxAttempts) {
        await sleep(15 * attempt);
        continue;
      }
      throw err;
    }
  }
}

export async function readBoard(boardPath: string): Promise<Board> {
  let rawText: string;
  try {
    rawText = await fs.readFile(boardPath, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) {
      throw new Error(`board.json missing: ${boardPath}`);
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(rawText);
  return BoardSchema.parse(parsed);
}

export async function writeBoardAtomic(
  boardPath: string,
  board: Board,
): Promise<void> {
  const validated = BoardSchema.parse(board);
  await fs.mkdir(path.dirname(boardPath), { recursive: true });
  const tmpPath = `${boardPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(validated, null, 2) + "\n";

  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await renameWithRetry(tmpPath, boardPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

export function getBoardLockPath(boardPath: string): string {
  return `${boardPath}.lock`;
}

export async function withBoardLock<T>(
  boardPath: string,
  fn: (board: Board) => T | Promise<T>,
  options?: BoardLockOptions,
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const staleMs = options?.staleMs ?? 30_000;
  const retryDelayMs = options?.retryDelayMs ?? 15;
  const lockPath = getBoardLockPath(boardPath);

  await fs.mkdir(path.dirname(boardPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const fd = await fs.open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      try {
        const meta = JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        });
        await fd.writeFile(meta, "utf8");
      } finally {
        await fd.close();
      }
      acquired = true;
    } catch (err) {
      const isWinDeletePending =
        process.platform === "win32" && isErrno(err, "EPERM", "EBUSY");
      if (!isErrno(err, "EEXIST") && !isWinDeletePending) {
        throw err;
      }

      if (isWinDeletePending) {
        if (Date.now() >= deadline) {
          throw err;
        }
        await sleep(retryDelayMs);
        continue;
      }

      // Check for stale lockfile and recover safely.
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch (statErr) {
        if (isErrno(statErr, "ENOENT")) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`board.json lock timeout after ${timeoutMs}ms: ${lockPath}`);
      }

      const jitter = Math.floor(Math.random() * Math.max(5, retryDelayMs));
      await sleep(retryDelayMs + jitter);
    }
  }

  try {
    const board = await readBoard(boardPath);
    const result = await fn(board);
    await writeBoardAtomic(boardPath, board);
    return result;
  } finally {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

export function createDefaultBoard(options: DefaultBoardOptions): Board {
  const sprintId = options.sprintId ?? "S1";
  const suites = options.suites ?? {
    smoke: ["CP0", "CP1"],
    full: ["CP0", "CP1", "CP2"],
  };
  const finalSuite = suites.full ? "full" : Object.keys(suites)[0] ?? "smoke";

  return BoardSchema.parse({
    project: options.projectId,
    milestone: {
      id: options.milestoneId ?? "M1",
      name: options.milestoneName ?? `${options.projectId} — Initial Milestone`,
      sprints: [sprintId],
      final_suite: finalSuite,
    },
    active_sprint: sprintId,
    sprints: {
      [sprintId]: {
        goal: options.sprintGoal ?? "Initial delivery sprint",
        status: "active",
        started_at: new Date().toISOString(),
      },
    },
    suites,
    items: [],
    builds: [],
    testruns: [],
    kv: {},
  });
}

export async function initBoardFile(
  boardPath: string,
  options: DefaultBoardOptions,
): Promise<Board> {
  const board = createDefaultBoard(options);
  await writeBoardAtomic(boardPath, board);
  return board;
}
