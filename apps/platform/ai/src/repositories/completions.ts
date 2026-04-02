import { Pool } from 'pg';

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    options: '-c search_path=platform_ai',
  });
}

export interface CompletionsRepository {
  findByKey(cacheKey: string): Promise<{ response_text: string } | null>;
  upsert(row: {
    cache_key: string;
    prompt_id: string;
    model: string;
    response_text: string;
    expires_at: Date;
  }): Promise<void>;
  deleteExpired(): Promise<void>;
}

export function createCompletionsRepository(pool: Pool): CompletionsRepository {
  return {
    async findByKey(cacheKey: string): Promise<{ response_text: string } | null> {
      const result = await pool.query<{ response_text: string }>(
        'SELECT response_text FROM ai_completions WHERE cache_key = $1 AND expires_at > NOW()',
        [cacheKey],
      );
      return result.rows[0] ?? null;
    },

    async upsert(row): Promise<void> {
      await pool.query(
        `INSERT INTO ai_completions (cache_key, prompt_id, model, response_text, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cache_key) DO UPDATE
         SET response_text = EXCLUDED.response_text, expires_at = EXCLUDED.expires_at`,
        [row.cache_key, row.prompt_id, row.model, row.response_text, row.expires_at],
      );
    },

    async deleteExpired(): Promise<void> {
      await pool.query(
        "DELETE FROM ai_completions WHERE expires_at < NOW() - INTERVAL '1 hour'",
      );
    },
  };
}
