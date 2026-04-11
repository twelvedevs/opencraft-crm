// This file is loaded via vitest setupFiles before any test imports modules.
// Sets environment variables required by config.ts before module evaluation.
process.env['LEAD_SERVICE_URL'] = 'http://lead:3000';
process.env['PIPELINE_SERVICE_URL'] = 'http://pipeline:3000';
process.env['CONVERSATION_SERVICE_URL'] = 'http://conv:3000';
process.env['CAMPAIGN_SERVICE_URL'] = 'http://campaign:3000';
process.env['REFERRAL_SERVICE_URL'] = 'http://referral:3000';
process.env['REPORTING_SERVICE_URL'] = 'http://reporting:3000';
process.env['IMPORT_SERVICE_URL'] = 'http://import:3000';
process.env['NOTIFICATION_SERVICE_URL'] = 'http://notif:3000';
process.env['IDENTITY_SERVICE_URL'] = 'http://identity:3000';
process.env['LEAD_SERVICE_API_KEY'] = 'lead-api-key';
process.env['INTERNAL_API_SECRET'] = 'internal-secret';
process.env['LOG_LEVEL'] = 'silent';
