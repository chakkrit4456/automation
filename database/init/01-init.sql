-- PostgreSQL initialization for AI Social Automation.
-- This file runs once when the PostgreSQL Docker volume is created.

CREATE SCHEMA IF NOT EXISTS n8n;

-- Application tables are created by database/schema.sql.
-- n8n uses its own PostgreSQL schema so its tables do not mix with application tables.
