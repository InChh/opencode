import path from "path"
import fs from "fs/promises"
import { Log } from "@/util/log"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import { Global } from "@/global"
import { Instance } from "@/project/instance"

export namespace MemoryStorage {
  const log = Log.create({ service: "memory.storage" })

  interface Store {
    memories: Record<string, any>
    meta: Record<string, number>
  }

  function projectDir(): string {
    try {
      const dir = Instance.directory
      return path.join(Global.Path.data, "memory", encodeURIComponent(dir))
    } catch {
      return path.join(Global.Path.data, "memory", "global")
    }
  }

  function filePath(): string {
    return path.join(projectDir(), "personal.json")
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(projectDir(), { recursive: true })
  }

  async function load(): Promise<Store> {
    try {
      const data = await Filesystem.readJson<Store>(filePath())
      return {
        memories: data.memories ?? {},
        meta: data.meta ?? {},
      }
    } catch {
      return { memories: {}, meta: {} }
    }
  }

  async function persist(store: Store): Promise<void> {
    await ensureDir()
    await Filesystem.writeJson(filePath(), store)
  }

  export async function save(memory: { id: string; [key: string]: any }): Promise<void> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    store.memories[memory.id] = memory
    await persist(store)
  }

  export async function get(id: string): Promise<any | undefined> {
    const fp = filePath()
    using _ = await Lock.read(fp)
    const store = await load()
    return store.memories[id]
  }

  export async function remove(id: string): Promise<boolean> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    if (!(id in store.memories)) return false
    delete store.memories[id]
    await persist(store)
    return true
  }

  export async function loadAll(): Promise<any[]> {
    const fp = filePath()
    using _ = await Lock.read(fp)
    const store = await load()
    return Object.values(store.memories)
  }

  export async function getMeta(key: string): Promise<number | undefined> {
    const fp = filePath()
    using _ = await Lock.read(fp)
    const store = await load()
    return store.meta[key]
  }

  export async function setMeta(key: string, value: number): Promise<void> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    const store = await load()
    store.meta[key] = value
    await persist(store)
  }

  /** Clear all data (for testing) */
  export async function clear(): Promise<void> {
    const fp = filePath()
    using _ = await Lock.write(fp)
    await persist({ memories: {}, meta: {} })
  }
}
