import pg, { type Pool, type PoolClient, type QueryResultRow } from "pg";
import { newDb } from "pg-mem";

type Queryable = Pick<Pool | PoolClient, "query">;

export type DatabaseResult<T> = {
  results: T[];
  success: true;
  meta: { changes: number };
};

function parameters(sql: string) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

export class PreparedStatement<T extends QueryResultRow = QueryResultRow> {
  constructor(
    public readonly sql: string,
    public readonly values: unknown[] = [],
    private readonly queryable?: Queryable,
  ) {}

  bind(...values: unknown[]) {
    return new PreparedStatement<T>(this.sql, values, this.queryable);
  }

  withQueryable(queryable: Queryable) {
    return new PreparedStatement<T>(this.sql, this.values, queryable);
  }

  private async execute(queryable?: Queryable) {
    const target = queryable ?? this.queryable;
    if (!target) throw new Error("Database statement has no connection.");
    return target.query<T>(parameters(this.sql), this.values);
  }

  async first<R extends QueryResultRow = T>(): Promise<R | null> {
    const result = await this.execute();
    return (result.rows[0] ?? null) as unknown as R | null;
  }

  async all<R extends QueryResultRow = T>(): Promise<DatabaseResult<R>> {
    const result = await this.execute();
    return {
      results: result.rows as unknown as R[],
      success: true,
      meta: { changes: result.rowCount ?? 0 },
    };
  }

  async run(): Promise<DatabaseResult<T>> {
    const result = await this.execute();
    return {
      results: result.rows,
      success: true,
      meta: { changes: result.rowCount ?? 0 },
    };
  }
}

export class Database {
  constructor(private readonly pool: Pool) {}

  prepare<T extends QueryResultRow = QueryResultRow>(sql: string) {
    return new PreparedStatement<T>(sql, [], this.pool);
  }

  async batch(statements: PreparedStatement[]) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results: DatabaseResult<QueryResultRow>[] = [];
      for (const statement of statements) {
        const sql = statement.sql.trimStart();
        results.push(
          /^SELECT\b|^WITH\b/i.test(sql)
            ? await statement.withQueryable(client).all()
            : await statement.withQueryable(client).run(),
        );
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async transaction<T>(work: (database: Database) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const scoped = new Database(client as unknown as Pool);
      const value = await work(scoped);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

type DatabaseGlobal = typeof globalThis & {
  __EAGLE_DATABASE__?: Database;
};

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    return new pg.Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      ssl:
        process.env.DATABASE_SSL === "disable"
          ? false
          : process.env.NODE_ENV === "production"
            ? { rejectUnauthorized: false }
            : undefined,
    });
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_IN_MEMORY_DB !== "true") {
    throw new Error("DATABASE_URL is required in production.");
  }
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({
    name: "current_database",
    implementation: () => "eagle_shield_test",
  });
  const adapter = memory.adapters.createPg();
  return new adapter.Pool() as unknown as Pool;
}

export function getDatabase() {
  const root = globalThis as DatabaseGlobal;
  if (!root.__EAGLE_DATABASE__) root.__EAGLE_DATABASE__ = new Database(createPool());
  return root.__EAGLE_DATABASE__;
}

export async function resetDatabaseForTests() {
  const root = globalThis as DatabaseGlobal;
  if (root.__EAGLE_DATABASE__) await root.__EAGLE_DATABASE__.close();
  root.__EAGLE_DATABASE__ = undefined;
}
