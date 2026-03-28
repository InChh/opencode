import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import path from "path"
import { readFileSync, readdirSync } from "fs"
import { Database } from "../../src/storage/db"
import { resetDatabase } from "../fixture/db"

function time(name: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function entries() {
  return readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(import.meta.dirname, "../../migration", entry.name, "migration.sql"), "utf-8"),
      timestamp: time(entry.name),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

describe("database migrations", () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  afterEach(async () => {
    await resetDatabase()
  })

  test("repairs missing headers migration journal entry", () => {
    const all = entries()
    const hit = all.find((item) => item.sql.includes("ALTER TABLE `llm_log_request` ADD `headers` text;"))
    if (!hit) throw new Error("missing headers migration")

    const sqlite = new BunDatabase(Database.Path)
    migrate(
      drizzle({ client: sqlite }),
      all.filter((item) => item.timestamp < hit.timestamp),
    )
    sqlite.exec("ALTER TABLE llm_log_request ADD headers text")
    sqlite.close()

    expect(() => Database.Client()).not.toThrow()
    Database.close()

    const check = new BunDatabase(Database.Path, { readonly: true })
    const row = check
      .query("select count(*) as count from __drizzle_migrations where created_at = ?")
      .get(hit.timestamp) as { count: number }
    const cols = check.query("pragma table_info('llm_log_request')").all() as { name: string }[]
    check.close()

    expect(row.count).toBe(1)
    expect(cols.filter((item) => item.name === "headers")).toHaveLength(1)
  })

  test("repairs partial add-column migrations before replay", () => {
    const all = entries()
    const hit = all.find((item) =>
      item.sql.includes("ALTER TABLE `message` ADD `update_seq` integer DEFAULT 0 NOT NULL;"),
    )
    if (!hit) throw new Error("missing update_seq migration")

    const sqlite = new BunDatabase(Database.Path)
    migrate(
      drizzle({ client: sqlite }),
      all.filter((item) => item.timestamp < hit.timestamp),
    )
    sqlite.exec("ALTER TABLE message ADD update_seq integer DEFAULT 0 NOT NULL")
    sqlite.close()

    const result = Database.repair()

    const check = new BunDatabase(Database.Path, { readonly: true })
    const row = check
      .query("select count(*) as count from __drizzle_migrations where created_at = ?")
      .get(hit.timestamp) as { count: number }
    const message = check.query("pragma table_info('message')").all() as { name: string }[]
    const part = check.query("pragma table_info('part')").all() as { name: string }[]
    const session = check.query("pragma table_info('session')").all() as { name: string }[]
    check.close()

    expect(result.add.map((item) => `${item.table}.${item.column}`)).toEqual(["part.update_seq", "session.update_seq"])
    expect(result.journal).toEqual([hit.timestamp])
    expect(row.count).toBe(1)
    expect(message.filter((item) => item.name === "update_seq")).toHaveLength(1)
    expect(part.filter((item) => item.name === "update_seq")).toHaveLength(1)
    expect(session.filter((item) => item.name === "update_seq")).toHaveLength(1)
  })
})
