'use strict';

/**
 * Migration runner.
 *
 * Deliberately tiny and dependency-free: it reads numbered .sql files from
 * ../../migrations, applies the ones not yet recorded in `schema_migrations`, and
 * wraps each in its own transaction.
 *
 * Usage:
 *   npm run migrate           apply all pending
 *   npm run migrate:status    list applied / pending
 *   npm run migrate -- --dry  print what would run, change nothing
 *
 * Rules enforced here, because they are the rules that keep customer data alive:
 *   - A migration file is immutable once applied. Its checksum is recorded and
 *     re-verified; editing an applied migration is a hard error.
 *   - Migrations run in a transaction and in filename order.
 *   - A file whose name ends `.nontx.sql` runs outside a transaction (needed for
 *     CREATE INDEX CONCURRENTLY).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPool, query } = require('./index');
const { logger } = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version      text PRIMARY KEY,
  name         text NOT NULL,
  checksum     text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT NOW(),
  duration_ms  integer NOT NULL DEFAULT 0
);
`;

function checksum(contents) {
  return crypto.createHash('sha256').update(contents, 'utf8').digest('hex').slice(0, 32);
}

/** @returns {{version:string,name:string,file:string,contents:string,checksum:string,inTransaction:boolean}[]} */
function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    // 0000_baseline.sql is a captured production dump, never applied by this runner.
    .filter((f) => !f.startsWith('0000_'))
    .sort()
    .map((file) => {
      const match = /^(\d+)[_-](.+)\.sql$/.exec(file);
      if (!match) {
        throw new Error(
          `Migration "${file}" must be named NNNN_description.sql (e.g. 0002_core_tables.sql)`
        );
      }
      const contents = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      return {
        version: match[1],
        name: match[2].replace(/\.nontx$/, ''),
        file,
        contents,
        checksum: checksum(contents),
        inTransaction: !file.endsWith('.nontx.sql'),
      };
    });
}

async function getApplied() {
  await query(BOOTSTRAP_SQL);
  const res = await query(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version'
  );
  return new Map(res.rows.map((r) => [r.version, r]));
}

/**
 * Applies pending migrations.
 * @param {{dryRun?: boolean, target?: string}} [opts]
 */
async function migrate({ dryRun = false, target } = {}) {
  const files = loadMigrationFiles();
  const applied = await getApplied();

  // Immutability check: an applied migration must not have been edited.
  const drifted = [];
  for (const f of files) {
    const record = applied.get(f.version);
    if (record && record.checksum !== f.checksum) {
      drifted.push({ version: f.version, file: f.file });
    }
  }
  if (drifted.length) {
    throw new Error(
      `Applied migrations were modified after the fact: ${drifted
        .map((d) => d.file)
        .join(', ')}. Migrations are immutable — add a new one instead.`
    );
  }

  const pending = files.filter(
    (f) => !applied.has(f.version) && (!target || f.version <= target)
  );

  if (!pending.length) {
    logger.info({ applied: applied.size }, 'No pending migrations');
    return { applied: [], alreadyApplied: applied.size };
  }

  logger.info(
    { pending: pending.map((p) => p.file) },
    dryRun ? 'Migrations that would run' : 'Applying migrations'
  );
  if (dryRun) return { applied: [], pending: pending.map((p) => p.file), dryRun: true };

  const done = [];
  for (const m of pending) {
    const startedAt = Date.now();
    if (m.inTransaction) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query(m.contents);
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [m.version, m.name, m.checksum, Date.now() - startedAt]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error({ err, file: m.file }, 'Migration failed — rolled back');
        throw err;
      } finally {
        client.release();
      }
    } else {
      // Non-transactional (CREATE INDEX CONCURRENTLY). If this fails partway the
      // migration is NOT recorded, so it is safe to re-run — which is why every
      // .nontx.sql must use IF NOT EXISTS.
      //
      // Statements are sent ONE AT A TIME. Sending the whole file in a single
      // query would use the simple-query protocol, and Postgres executes a
      // multi-statement simple query as one implicit transaction — which defeats
      // the entire point of this branch and fails with
      // "CREATE INDEX CONCURRENTLY cannot run inside a transaction block".
      try {
        for (const statement of splitStatements(m.contents)) {
          await query(statement);
        }
        await query(
          `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
           VALUES ($1, $2, $3, $4)`,
          [m.version, m.name, m.checksum, Date.now() - startedAt]
        );
      } catch (err) {
        logger.error({ err, file: m.file }, 'Non-transactional migration failed');
        throw err;
      }
    }

    logger.info({ file: m.file, ms: Date.now() - startedAt }, 'Migration applied');
    done.push(m.file);
  }

  return { applied: done, alreadyApplied: applied.size };
}

async function status() {
  const files = loadMigrationFiles();
  const applied = await getApplied();
  return files.map((f) => {
    const rec = applied.get(f.version);
    return {
      version: f.version,
      file: f.file,
      applied: Boolean(rec),
      appliedAt: rec?.applied_at || null,
      drifted: Boolean(rec && rec.checksum !== f.checksum),
    };
  });
}

/**
 * Re-applies one already-applied migration.
 *
 * Needed because some migrations are deliberately designed to be run more than
 * once: 0007 skips any constraint whose data is not yet clean, so the intended
 * workflow is "resolve the rows listed in migration_conflicts, then run 0007 again".
 * Without this the runner would refuse, having already recorded it.
 *
 * Only migrations explicitly marked re-runnable are allowed, so this cannot be used
 * to replay a backfill by accident.
 *
 * @param {string} version e.g. '0007'
 */
const RERUNNABLE = new Set(['0005', '0006', '0007']);

/**
 * Splits a SQL file into individual statements.
 *
 * Only used for `.nontx.sql`, where each statement must reach Postgres on its own.
 * Aware of the three things that legitimately contain a semicolon: line comments,
 * block comments, and string/dollar-quoted literals. A naive `split(';')` would cut
 * a `$$ … ; … $$` function body in half.
 *
 * Transactional migrations are still sent whole, because a single multi-statement
 * query inside an explicit BEGIN is exactly what they want.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const rest = sql.slice(i);

    // Line comment
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Block comment
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Dollar-quoted string: $$ … $$ or $tag$ … $tag$
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // Single-quoted literal, honouring '' escaping
    if (rest.startsWith("'")) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }

    if (sql[i] === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i += 1;
      continue;
    }

    current += sql[i];
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  // A chunk that is only comments and whitespace is not a statement.
  return statements.filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim());
}

async function rerun(version) {
  if (!RERUNNABLE.has(version)) {
    throw new Error(
      `Migration ${version} is not marked re-runnable. Re-runnable: ${[...RERUNNABLE].join(', ')}. ` +
        'Other migrations are immutable once applied — write a new one instead.'
    );
  }

  const file = loadMigrationFiles().find((f) => f.version === version);
  if (!file) throw new Error(`No migration file for version ${version}`);

  logger.warn({ file: file.file }, 'Re-running migration');
  const startedAt = Date.now();

  if (file.inTransaction) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(file.contents);
      await client.query(
        `UPDATE schema_migrations
         SET checksum = $2, applied_at = NOW(), duration_ms = $3
         WHERE version = $1`,
        [file.version, file.checksum, Date.now() - startedAt]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    await query(file.contents);
    await query(
      `UPDATE schema_migrations SET checksum = $2, applied_at = NOW(), duration_ms = $3
       WHERE version = $1`,
      [file.version, file.checksum, Date.now() - startedAt]
    );
  }

  logger.info({ file: file.file, ms: Date.now() - startedAt }, 'Migration re-applied');
  return { rerun: file.file };
}

/** Lists unresolved backfill conflicts — what blocks 0007 from tightening constraints. */
async function conflicts() {
  const res = await query(
    `SELECT concern, reason, COUNT(*)::int AS count
       FROM migration_conflicts
      WHERE resolved_at IS NULL
      GROUP BY concern, reason
      ORDER BY count DESC`
  ).catch(() => ({ rows: [] }));
  return res.rows;
}

/* istanbul ignore next — CLI entrypoint */
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry') || args.includes('--dry-run');
  const isStatus = args.includes('--status');
  const isConflicts = args.includes('--conflicts');
  const rerunArg = args.find((a) => a.startsWith('--rerun='));
  const targetArg = args.find((a) => a.startsWith('--to='));
  const target = targetArg ? targetArg.split('=')[1] : undefined;

  (async () => {
    try {
      if (isStatus) {
        const rows = await status();
        if (!rows.length) {
          process.stdout.write('No migration files found.\n');
        }
        for (const r of rows) {
          const mark = r.drifted ? 'DRIFT!' : r.applied ? 'applied' : 'pending';
          process.stdout.write(`${mark.padEnd(8)} ${r.file}\n`);
        }
      } else if (isConflicts) {
        const rows = await conflicts();
        if (!rows.length) {
          process.stdout.write('No open migration conflicts. Constraints can be tightened.\n');
        } else {
          process.stdout.write('Open conflicts (these block migration 0007):\n\n');
          for (const r of rows) {
            process.stdout.write(`  ${String(r.count).padStart(5)}  ${r.concern}\n          ${r.reason}\n`);
          }
          process.stdout.write('\nResolve the underlying data, mark rows resolved, then: npm run migrate:rerun -- --rerun=0007\n');
        }
      } else if (rerunArg) {
        const result = await rerun(rerunArg.split('=')[1]);
        process.stdout.write(`Re-applied: ${result.rerun}\n`);
      } else {
        const result = await migrate({ dryRun, target });
        process.stdout.write(
          `${dryRun ? 'Would apply' : 'Applied'}: ${
            (result.applied?.length ? result.applied : result.pending || []).join(', ') || 'nothing'
          }\n`
        );
      }
      process.exitCode = 0;
    } catch (err) {
      process.stderr.write(`Migration error: ${err.message}\n`);
      process.exitCode = 1;
    } finally {
      const { close } = require('./index');
      await close().catch(() => {});
    }
  })();
}

module.exports = { migrate, status, rerun, conflicts, loadMigrationFiles };
