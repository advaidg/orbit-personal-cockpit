import { pool } from './pool.js';
import { COLLECTION_TABLES, type CollectionTable } from './migrations.js';

export interface Owned {
  id: string;
  userId: string;
  createdAt: string;
}

export type WhereValue = string | number | boolean | Array<string | number | boolean>;
export type Where = Record<string, WhereValue>;

export interface ListOptions {
  where?: Where;
  limit?: number;
  offset?: number;
  /** Defaults to newest first. */
  order?: 'asc' | 'desc';
}

interface MemoryRow<T> {
  item: T;
  uniqueKey?: string;
}

const memoryTables = new Map<string, Map<string, MemoryRow<Owned>>>();
const FIELD = /^[A-Za-z][A-Za-z0-9_]*$/;

function memoryTable(table: string): Map<string, MemoryRow<Owned>> {
  let rows = memoryTables.get(table);
  if (!rows) {
    rows = new Map();
    memoryTables.set(table, rows);
  }
  return rows;
}

/** Test helper: wipes every in-memory collection. */
export function resetMemoryCollections(): void {
  memoryTables.clear();
}

/** Removes every collection row owned by the user (memory mode; Postgres relies on ON DELETE CASCADE). */
export function purgeMemoryUser(userId: string): void {
  for (const rows of memoryTables.values()) {
    for (const [id, row] of rows) if (row.item.userId === userId) rows.delete(id);
  }
}

function matches(item: Owned, where?: Where): boolean {
  if (!where) return true;
  const record = item as unknown as Record<string, unknown>;
  return Object.entries(where).every(([key, expected]) => {
    const actual = String(record[key]);
    return Array.isArray(expected) ? expected.map(String).includes(actual) : String(expected) === actual;
  });
}

function whereSql(where: Where | undefined, params: unknown[]): string {
  if (!where) return '';
  const clauses: string[] = [];
  for (const [key, expected] of Object.entries(where)) {
    if (!FIELD.test(key)) throw new Error(`Invalid collection field: ${key}`);
    params.push(Array.isArray(expected) ? expected.map(String) : [String(expected)]);
    clauses.push(`data->>'${key}' = ANY($${params.length}::text[])`);
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

/**
 * A small typed document store used by the agent runtime. Postgres rows keep the whole record in a JSONB
 * column; memory mode keeps the same semantics in a Map so both storage modes behave identically.
 */
export class Collection<T extends Owned> {
  constructor(readonly table: CollectionTable) {
    if (!(COLLECTION_TABLES as readonly string[]).includes(table)) throw new Error(`Unknown collection table: ${table}`);
  }

  async get(userId: string, id: string): Promise<T | null> {
    if (!pool) {
      const row = memoryTable(this.table).get(id);
      return row && row.item.userId === userId ? ({ ...row.item } as T) : null;
    }
    const { rows } = await pool.query(`SELECT data FROM ${this.table} WHERE id=$1 AND user_id=$2`, [id, userId]);
    return (rows[0]?.data as T) ?? null;
  }

  /**
   * Primary-key lookup without an owner. Only for capability-token endpoints that prove access by another means
   * (a pact link); callers must verify the secret before using the record.
   */
  async getAnyOwner(id: string): Promise<T | null> {
    if (!pool) {
      const row = memoryTable(this.table).get(id);
      return row ? ({ ...row.item } as T) : null;
    }
    const { rows } = await pool.query(`SELECT data FROM ${this.table} WHERE id=$1`, [id]);
    return (rows[0]?.data as T) ?? null;
  }

  async findByUniqueKey(userId: string, uniqueKey: string): Promise<T | null> {
    if (!pool) {
      for (const row of memoryTable(this.table).values()) if (row.item.userId === userId && row.uniqueKey === uniqueKey) return { ...row.item } as T;
      return null;
    }
    const { rows } = await pool.query(`SELECT data FROM ${this.table} WHERE user_id=$1 AND unique_key=$2`, [userId, uniqueKey]);
    return (rows[0]?.data as T) ?? null;
  }

  async list(userId: string, options: ListOptions = {}): Promise<T[]> {
    const direction = options.order === 'asc' ? 'asc' : 'desc';
    if (!pool) {
      const items = [...memoryTable(this.table).values()]
        .map((row) => row.item as T)
        .filter((item) => item.userId === userId && matches(item, options.where))
        .sort((a, b) => (direction === 'asc' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)));
      const start = options.offset ?? 0;
      return items.slice(start, options.limit ? start + options.limit : undefined).map((item) => ({ ...item }));
    }
    const params: unknown[] = [userId];
    let sql = `SELECT data FROM ${this.table} WHERE user_id=$1${whereSql(options.where, params)} ORDER BY created_at ${direction}, id ${direction}`;
    if (options.limit) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (options.offset) {
      params.push(options.offset);
      sql += ` OFFSET $${params.length}`;
    }
    const { rows } = await pool.query(sql, params);
    return rows.map((row) => row.data as T);
  }

  /** Lists matching rows across every owner. Used only by system schedulers and retention pruning. */
  async listAllOwners(options: ListOptions = {}): Promise<T[]> {
    if (!pool) {
      const items = [...memoryTable(this.table).values()].map((row) => row.item as T).filter((item) => matches(item, options.where));
      return items.slice(0, options.limit).map((item) => ({ ...item }));
    }
    const params: unknown[] = [];
    let sql = `SELECT data FROM ${this.table} WHERE TRUE${whereSql(options.where, params)} ORDER BY created_at ASC`;
    if (options.limit) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const { rows } = await pool.query(sql, params);
    return rows.map((row) => row.data as T);
  }

  async count(userId: string, where?: Where): Promise<number> {
    if (!pool) return (await this.list(userId, { where })).length;
    const params: unknown[] = [userId];
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${this.table} WHERE user_id=$1${whereSql(where, params)}`, params);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Inserts the item. When `uniqueKey` collides for the same owner, nothing is written and the
   * existing record is returned with `created: false`; this is the idempotency primitive.
   */
  async insert(item: T, uniqueKey?: string): Promise<{ item: T; created: boolean }> {
    if (!pool) {
      const rows = memoryTable(this.table);
      if (uniqueKey) {
        const existing = await this.findByUniqueKey(item.userId, uniqueKey);
        if (existing) return { item: existing, created: false };
      }
      rows.set(item.id, { item: { ...item }, uniqueKey });
      return { item: { ...item }, created: true };
    }
    const { rows } = await pool.query(
      `INSERT INTO ${this.table}(id,user_id,unique_key,data,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT (user_id, unique_key) WHERE unique_key IS NOT NULL DO NOTHING RETURNING data`,
      [item.id, item.userId, uniqueKey ?? null, JSON.stringify(item), item.createdAt]
    );
    if (rows[0]) return { item: rows[0].data as T, created: true };
    const existing = await this.findByUniqueKey(item.userId, uniqueKey as string);
    if (!existing) throw new Error(`Insert into ${this.table} conflicted but no existing record was found`);
    return { item: existing, created: false };
  }

  /** Shallow-merges `patch` into the stored record. */
  async update(userId: string, id: string, patch: Partial<T>): Promise<T | null> {
    if (!pool) {
      const row = memoryTable(this.table).get(id);
      if (!row || row.item.userId !== userId) return null;
      row.item = { ...row.item, ...stripUndefined(patch) } as Owned;
      return { ...row.item } as T;
    }
    const { rows } = await pool.query(`UPDATE ${this.table} SET data = data || $3::jsonb, updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING data`, [id, userId, JSON.stringify(patch)]);
    return (rows[0]?.data as T) ?? null;
  }

  /**
   * Atomic compare-and-set: applies `patch` only if every field in `where` currently matches. Returns null
   * when the record is missing or no longer matches, so concurrent callers cannot both win. The memory path
   * has no await between the check and the write, which keeps it atomic within one process.
   */
  async updateIf(userId: string, id: string, where: Where, patch: Partial<T>): Promise<T | null> {
    if (!pool) {
      const row = memoryTable(this.table).get(id);
      if (!row || row.item.userId !== userId || !matches(row.item, where)) return null;
      row.item = { ...row.item, ...stripUndefined(patch) } as Owned;
      return { ...row.item } as T;
    }
    const params: unknown[] = [id, userId, JSON.stringify(patch)];
    const { rows } = await pool.query(`UPDATE ${this.table} SET data = data || $3::jsonb, updated_at=NOW() WHERE id=$1 AND user_id=$2${whereSql(where, params)} RETURNING data`, params);
    return (rows[0]?.data as T) ?? null;
  }

  /** Atomic compare-and-set on the `status` field (see updateIf). */
  async transition(userId: string, id: string, from: string[], patch: Partial<T>): Promise<T | null> {
    return this.updateIf(userId, id, { status: from }, patch);
  }

  async delete(userId: string, id: string): Promise<boolean> {
    if (!pool) {
      const row = memoryTable(this.table).get(id);
      if (!row || row.item.userId !== userId) return false;
      memoryTable(this.table).delete(id);
      return true;
    }
    const result = await pool.query(`DELETE FROM ${this.table} WHERE id=$1 AND user_id=$2`, [id, userId]);
    return (result.rowCount ?? 0) > 0;
  }

  async deleteWhere(userId: string, where: Where): Promise<number> {
    if (!pool) {
      const rows = memoryTable(this.table);
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.item.userId === userId && matches(row.item, where)) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    }
    const params: unknown[] = [userId];
    const result = await pool.query(`DELETE FROM ${this.table} WHERE user_id=$1${whereSql(where, params)}`, params);
    return result.rowCount ?? 0;
  }

  /** Deletes records created before `cutoff` (all owners). Returns the number removed. */
  async pruneBefore(cutoff: Date, where?: Where): Promise<number> {
    if (!pool) {
      const rows = memoryTable(this.table);
      let removed = 0;
      for (const [id, row] of rows) {
        if (row.item.createdAt < cutoff.toISOString() && matches(row.item, where)) {
          rows.delete(id);
          removed += 1;
        }
      }
      return removed;
    }
    const params: unknown[] = [cutoff.toISOString()];
    const result = await pool.query(`DELETE FROM ${this.table} WHERE created_at < $1${whereSql(where, params)}`, params);
    return result.rowCount ?? 0;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
