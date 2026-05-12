-- Extensions required for Supabase GoTrue
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA public;

-- Create all service schemas upfront so migration services can run in any order
-- without "schema does not exist" errors.

-- CREATE SCHEMA IF NOT EXISTS auth;

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


-- Создаем роли, которые требует GoTrue

-- 1. Создаем роль postgres, если её вдруг нет (частая проблема в кастомных образах)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'postgres') THEN
        CREATE ROLE postgres SUPERUSER LOGIN PASSWORD 'postgres';
    END IF;
END
$$;

-- 2. Создаем остальные роли для Supabase
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin NOINHERIT CREATEROLE LOGIN PASSWORD 'SecretPass123';
    END IF;
END
$$;


-- CREATE ROLE supabase_auth_admin NOINHERIT CREATEROLE LOGIN PASSWORD 'SecretPass123';

CREATE ROLE anon NOINHERIT;
CREATE ROLE authenticated NOINHERIT;
CREATE ROLE service_role NOINHERIT;

-- Создаем схему для Auth (GoTrue сам создаст таблицы, но роль должна иметь права)
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;

-- Даем права пользователю, под которым будет работать GoTrue

-- 3. Настраиваем схему
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT ALL PRIVILEGES ON DATABASE ortho TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON SCHEMA auth TO supabase_auth_admin;

ALTER ROLE supabase_auth_admin WITH PASSWORD 'SecretPass123';
