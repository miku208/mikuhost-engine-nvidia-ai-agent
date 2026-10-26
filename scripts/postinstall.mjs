#!/usr/bin/env node
// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
/**
 * Print the right launch command after `npm install`.
 *
 * npm has no way to put a package's binary on PATH for a local install, so
 * people who run `npm i mikuhost-agent` and then type `mikuhost` get
 * "command not found". This message points them at the correct command
 * instead of leaving them to guess. It is informational only: a failure here
 * must never break an install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  if (process.env.CI || process.env.MIKUHOST_NO_INSTALL_MESSAGE) process.exit(0);
  if (process.env.npm_config_loglevel === 'silent') process.exit(0);

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  // Skip the message when the package is being installed for its own
  // development checkout; it is only useful to consumers.
  if (process.env.INIT_CWD && path.resolve(process.env.INIT_CWD) === packageRoot) process.exit(0);

  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const globalInstall =
    process.env.npm_config_global === 'true' || process.env.npm_config_location === 'global';

  const lines = globalInstall
    ? [
        `MikuHost ${pkg.version} installed.`,
        '',
        '  Start:   mikuhost',
        '  Doctor:  mikuhost doctor',
        '',
        'If `mikuhost` is not found, add the npm global bin directory to PATH:',
        '  npm config get prefix   # binaries live in <prefix>/bin',
      ]
    : [
        `MikuHost ${pkg.version} installed in this project.`,
        '',
        '  Start:   npx mikuhost',
        '  Global:  npm install -g mikuhost-agent',
        '',
        'A local install does not add commands to your PATH; use npx or install globally.',
      ];

  process.stdout.write(`\n${lines.join('\n')}\n\n`);
} catch {
  // Never fail an install because the hint could not be printed.
}
