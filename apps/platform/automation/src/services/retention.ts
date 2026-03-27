import type { ExecutionRepository } from '../repositories/execution.repository.js';

export class RetentionService {
  constructor(private readonly repo: ExecutionRepository) {}

  async cleanup(): Promise<{ deleted: number }> {
    const retentionDays = parseInt(process.env['EXECUTION_LOG_RETENTION_DAYS'] ?? '90', 10);
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const deleted = await this.repo.deleteExecutionsBefore(cutoffDate);
    return { deleted };
  }

  start(intervalMs: number = 24 * 60 * 60 * 1000): () => void {
    void this.cleanup().catch((err: unknown) => {
      console.error('[RetentionService] cleanup error', err);
    });
    const timer = setInterval(() => {
      void this.cleanup().catch((err: unknown) => {
        console.error('[RetentionService] cleanup error', err);
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }
}
