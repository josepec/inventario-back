import { D1Database } from '@cloudflare/workers-types';

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export async function paginate<T>(
  db: D1Database,
  table: string,
  where: string,
  params: unknown[],
  page: number,
  limit: number,
  orderBy = 'created_at DESC'
): Promise<PaginatedResult<T>> {
  const offset = (page - 1) * limit;

  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM ${table} ${where}`)
    .bind(...params)
    .first<{ count: number }>();

  const rows = await db
    .prepare(`SELECT * FROM ${table} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all<T>();

  return {
    data: rows.results,
    total: countResult?.count ?? 0,
    page,
    limit,
  };
}

export function buildWhere(filters: Record<string, unknown>): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      if (key === 'search') {
        // search se maneja aparte
        continue;
      }
      conditions.push(`${key} = ?`);
      params.push(value);
    }
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { sql, params };
}

export function now(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
