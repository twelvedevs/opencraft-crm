-- Create all service schemas upfront so migration services can run in any order
-- without "schema does not exist" errors.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE SCHEMA IF NOT EXISTS platform_identity;
CREATE SCHEMA IF NOT EXISTS platform_ai;
CREATE SCHEMA IF NOT EXISTS platform_analytics;
CREATE SCHEMA IF NOT EXISTS platform_audience;
CREATE SCHEMA IF NOT EXISTS platform_automation;
CREATE SCHEMA IF NOT EXISTS platform_email;
CREATE SCHEMA IF NOT EXISTS platform_integrations;
CREATE SCHEMA IF NOT EXISTS platform_messaging;
CREATE SCHEMA IF NOT EXISTS platform_notifications;
CREATE SCHEMA IF NOT EXISTS platform_nurturing;
CREATE SCHEMA IF NOT EXISTS platform_templates;
CREATE SCHEMA IF NOT EXISTS platform_media;

CREATE SCHEMA IF NOT EXISTS crm_leads;
CREATE SCHEMA IF NOT EXISTS crm_pipeline;
CREATE SCHEMA IF NOT EXISTS crm_conversations;
CREATE SCHEMA IF NOT EXISTS crm_campaigns;
CREATE SCHEMA IF NOT EXISTS crm_referrals;
CREATE SCHEMA IF NOT EXISTS crm_reporting;
CREATE SCHEMA IF NOT EXISTS crm_imports;
