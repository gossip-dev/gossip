import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class OperationJournal {
  private readonly db: DatabaseSync;
  constructor(
    directory: string,
    private readonly wallet: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, "operations.sqlite");
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations (wallet TEXT, id TEXT, fingerprint TEXT NOT NULL, result TEXT, PRIMARY KEY(wallet,id));
      CREATE TABLE IF NOT EXISTS reservations (wallet TEXT, id TEXT, day TEXT, PRIMARY KEY(wallet,id,day));`);
  }
  begin(
    id: string,
    tool: string,
    args: Record<string, unknown>,
    budget: number | null,
  ): unknown | undefined {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new Error(
        "Use a stable operation ID of 1-128 letters, digits, underscores or hyphens.",
      );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ tool, args }))
      .digest("hex");
    const day = new Date().toISOString().slice(0, 10);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare(
          "SELECT fingerprint,result FROM operations WHERE wallet=? AND id=?",
        )
        .get(this.wallet, id);
      if (previous && previous.fingerprint !== fingerprint)
        throw new Error(
          "This operation ID already represents different content.",
        );
      if (previous?.result) {
        this.db.exec("COMMIT");
        return JSON.parse(String(previous.result));
      }
      if (budget !== null) {
        const reserved = this.db
          .prepare(
            "SELECT 1 FROM reservations WHERE wallet=? AND id=? AND day=?",
          )
          .get(this.wallet, id, day);
        const used = this.db
          .prepare(
            "SELECT count(*) AS count FROM reservations WHERE wallet=? AND day=?",
          )
          .get(this.wallet, day)!;
        if (budget === 0 || (!reserved && Number(used.count) >= budget))
          throw new Error(
            "Daily earned-credit budget exhausted or not authorized. Legacy engines cannot guarantee standard-only consultations.",
          );
        this.db
          .prepare("INSERT OR IGNORE INTO reservations VALUES(?,?,?)")
          .run(this.wallet, id, day);
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO operations(wallet,id,fingerprint) VALUES(?,?,?)",
        )
        .run(this.wallet, id, fingerprint);
      this.db.exec("COMMIT");
      return undefined;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  complete(id: string, result: unknown): void {
    this.db
      .prepare("UPDATE operations SET result=? WHERE wallet=? AND id=?")
      .run(JSON.stringify(result), this.wallet, id);
  }
  close(): void {
    this.db.close();
  }
}
