import type { Knex } from 'knex';
import cron from 'node-cron';
import { createLogger } from '@ortho/logger';

const logger = createLogger('platform-media');

export function registerCleanupJob(knex: Knex): void {
  cron.schedule('0 * * * *', async () => {
    logger.info('Cleanup job started');
    try {
      await knex.transaction(async (trx) => {
        // Step 1: Delete variants for files linked to expired upload intents
        const variantsDeleted = await trx('platform_media.media_variants')
          .whereIn('file_id', function () {
            this.select('file_id')
              .from('platform_media.media_upload_intents')
              .where('expires_at', '<', trx.fn.now());
          })
          .del();
        logger.info({ count: variantsDeleted }, 'Deleted expired media variants');

        // Step 2: Delete pending media files linked to expired upload intents
        const filesDeleted = await trx('platform_media.media_files')
          .where('status', 'pending')
          .whereIn('id', function () {
            this.select('file_id')
              .from('platform_media.media_upload_intents')
              .where('expires_at', '<', trx.fn.now());
          })
          .del();
        logger.info({ count: filesDeleted }, 'Deleted expired pending media files');

        // Step 3: Delete expired upload intents
        const intentsDeleted = await trx('platform_media.media_upload_intents')
          .where('expires_at', '<', trx.fn.now())
          .del();
        logger.info({ count: intentsDeleted }, 'Deleted expired upload intents');
      });
      logger.info('Cleanup job completed');
    } catch (err) {
      logger.error({ err }, 'Cleanup job failed');
    }
  });
}
