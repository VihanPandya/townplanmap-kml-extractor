#!/usr/bin/env node
/**
 * Apply the PostGIS schema.
 *
 * Usage:  DATABASE_URL=postgres://... npm run db:init
 *
 * The schema is idempotent (CREATE ... IF NOT EXISTS throughout), so this is
 * safe to re-run against an existing database.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'src', 'lib', 'db', 'schema.sql');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Point it at a PostgreSQL database with PostGIS available.');
  process.exit(1);
}

const schema = await readFile(schemaPath, 'utf8');
const client = new pg.Client({ connectionString });

try {
  await client.connect();
  await client.query(schema);
  console.log('Schema applied successfully.');
} catch (error) {
  console.error('Failed to apply the schema:', error instanceof Error ? error.message : error);
  if (String(error).includes('postgis')) {
    console.error(
      '\nThe PostGIS extension must be available to this database. On a managed provider this is usually ' +
        'enabled from the console; locally, install the postgis package for your PostgreSQL version.',
    );
  }
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
