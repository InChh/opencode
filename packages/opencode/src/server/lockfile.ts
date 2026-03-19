import z from "zod"
import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import crypto from "crypto"
import { Global } from "@/global"

export namespace Lockfile {
  export const Schema = z.object({
    pid: z.number(),
    port: z.number(),
    token: z.string().nullable(),
    createdAt: z.number(),
  })

  export type Data = z.infer<typeof Schema>

  /** Encode an absolute directory path into a safe filename, truncated + SHA-256 suffix if over 255 bytes. */
  function encode(dir: string): string {
    const raw = dir.replace(/\//g, "_")
    if (Buffer.byteLength(raw) <= 200) return raw
    const hash = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 16)
    return raw.slice(0, 200) + "_" + hash
  }

  /** Resolve the lock directory for a given project directory. */
  export function lockdir(dir: string): string {
    return path.join(Global.Path.data, encode(dir))
  }

  /** Resolve the lock file path for a given project directory and PID. */
  export function filepath(dir: string, pid?: number): string {
    const id = pid ?? process.pid
    return path.join(lockdir(dir), `worker-${id}.lock`)
  }

  /** Atomically create a lock file. Returns true on success, false if file already exists. */
  export async function create(dir: string, data: Data): Promise<boolean> {
    const p = filepath(dir, data.pid)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    const content = JSON.stringify(data, null, 2)
    try {
      const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      fs.writeSync(fd, content)
      fs.closeSync(fd)
      return true
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "EEXIST") return false
      throw e
    }
  }

  /** Read and validate a specific lock file. Returns parsed data or undefined if not found or invalid. */
  async function readFile(filepath: string): Promise<Data | undefined> {
    try {
      const raw = await Bun.file(filepath).text()
      const parsed = Schema.safeParse(JSON.parse(raw))
      if (!parsed.success) return undefined
      return parsed.data
    } catch {
      return undefined
    }
  }

  /** Read the lock file for this process's PID. Returns parsed data or undefined. */
  export async function read(dir: string, pid?: number): Promise<Data | undefined> {
    return readFile(filepath(dir, pid))
  }

  /** Check if a process with the given PID is alive. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Read a lock file and check for staleness. If stale (process dead), clean up and return undefined. */
  export async function acquire(dir: string, pid?: number): Promise<Data | undefined> {
    const data = await read(dir, pid)
    if (!data) return undefined
    if (alive(data.pid)) return data
    await remove(dir, data.pid)
    return undefined
  }

  /** List all live lock files for a directory. Cleans up stale entries. */
  export async function list(dir: string): Promise<Data[]> {
    const d = lockdir(dir)
    let entries: string[]
    try {
      entries = await fsp.readdir(d)
    } catch {
      return []
    }
    const results: Data[] = []
    for (const entry of entries) {
      if (!entry.startsWith("worker-") || !entry.endsWith(".lock")) continue
      const data = await readFile(path.join(d, entry))
      if (!data) continue
      if (alive(data.pid)) {
        results.push(data)
      } else {
        // Clean up stale lock file
        try {
          await fsp.unlink(path.join(d, entry))
        } catch {}
      }
    }
    return results
  }

  /** Remove a lock file. If pid is given, removes that specific lock; otherwise removes this process's lock. */
  export async function remove(dir: string, pid?: number): Promise<void> {
    const p = filepath(dir, pid)
    try {
      await fsp.unlink(p)
    } catch {
      // ignore if already gone
    }
  }

  /** Remove all lock files for a directory. */
  export async function removeAll(dir: string): Promise<void> {
    const d = lockdir(dir)
    let entries: string[]
    try {
      entries = await fsp.readdir(d)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.startsWith("worker-") || !entry.endsWith(".lock")) continue
      try {
        await fsp.unlink(path.join(d, entry))
      } catch {}
    }
  }
}
