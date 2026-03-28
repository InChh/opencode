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
})
