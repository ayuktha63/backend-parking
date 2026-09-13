'use strict';

/**
 * Secret scanner.
 *
 * Run in CI and before every commit. Exists because the previous codebase shipped a
 * production database connection string, a live payment key and a WhatsApp provider
 * key directly in source — all of which are in git history and can never be
 * un-published, only rotated.
 *
 * Usage: npm run check:secrets
 * Exits non-zero on any finding.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
  'dist',
  'tmp',
]);

// Files that legitimately describe the shapes being searched for.
const ALLOWLIST = new Set([
  'scripts/check-secrets.js',
  '.env.example',
]);

const PATTERNS = [
  {
    name: 'Postgres connection string with credentials',
    re: /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/i,
    // The example file documents the shape with placeholder values.
    allowIf: (m) => /:(password|<password>|user:password)@/i.test(m),
  },
  {
    name: 'Razorpay live key',
    re: /\brzp_live_[A-Za-z0-9]{10,}/,
  },
  {
    name: 'Razorpay test key',
    re: /\brzp_test_[A-Za-z0-9]{10,}/,
    warnOnly: true,
  },
  {
    name: 'Neon database host with embedded credentials',
    re: /npg_[A-Za-z0-9]{8,}/,
  },
  {
    name: 'AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'Google API key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: 'Private key block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: 'JWT secret assigned inline',
    re: /(?:JWT_\w*SECRET|jwtSecret)\s*[:=]\s*['"][^'"]{16,}['"]/,
  },
  {
    name: 'Hardcoded authkey header value',
    re: /authkey['"]?\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/i,
  },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.sql', '.md', '.yml', '.yaml',
  '.env', '.example', '.sh', '.txt', '.dart',
]);

function isTextFile(file) {
  const ext = path.extname(file);
  if (TEXT_EXT.has(ext)) return true;
  return path.basename(file).startsWith('.env');
}

function main() {
  const findings = [];
  const warnings = [];

  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (ALLOWLIST.has(rel)) continue;
    if (!isTextFile(file)) continue;

    let contents;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const lines = contents.split('\n');
    for (const pattern of PATTERNS) {
      lines.forEach((line, idx) => {
        const match = pattern.re.exec(line);
        if (!match) return;
        if (pattern.allowIf && pattern.allowIf(match[0])) return;

        const finding = {
          file: rel,
          line: idx + 1,
          name: pattern.name,
          // Never print the value itself, even in the tool that hunts for it.
          preview: `${match[0].slice(0, 6)}…${match[0].length} chars`,
        };
        (pattern.warnOnly ? warnings : findings).push(finding);
      });
    }
  }

  for (const w of warnings) {
    process.stdout.write(`WARN  ${w.file}:${w.line}  ${w.name} (${w.preview})\n`);
  }

  if (findings.length === 0) {
    process.stdout.write(`\n✓ No secrets found (${warnings.length} warning(s))\n`);
    process.exit(0);
  }

  process.stderr.write('\nSECRETS DETECTED — do not commit:\n\n');
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.line}\n    ${f.name} (${f.preview})\n`);
  }
  process.stderr.write(
    '\nMove the value to an environment variable, then ROTATE it — anything ' +
      'that reached git history must be treated as disclosed.\n'
  );
  process.exit(1);
}

main();
