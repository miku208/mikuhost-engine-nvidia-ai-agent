#!/usr/bin/env node
/**
 * MikuHost Agent — global CLI entrypoint.
 * `npm link` exposes this file as the `mikuhost` command.
 */
import process from 'node:process';

const argv = process.argv.slice(2);
if (argv.includes('--no-color')) process.env.NO_COLOR = '1';

process.title = 'mikuhost';

// Piping into `head` or another short-lived consumer should not look like a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
  });
}

const { main } = await import('../src/cli/commands.mjs');

let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  process.exitCode = typeof code === 'number' ? code : 0;
};

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`\nMikuHost internal error: ${message}\n`);
  if (process.env.MIKUHOST_DEBUG && reason instanceof Error) process.stderr.write(`${reason.stack}\n`);
  finish(1);
});

process.on('uncaughtException', (error) => {
  process.stderr.write(`\nMikuHost internal error: ${error?.message ?? error}\n`);
  if (process.env.MIKUHOST_DEBUG && error?.stack) process.stderr.write(`${error.stack}\n`);
  finish(1);
});

try {
  const code = await main(argv);
  finish(code);
} catch (error) {
  process.stderr.write(`\nMikuHost failed: ${error?.message ?? error}\n`);
  if (process.env.MIKUHOST_DEBUG && error?.stack) process.stderr.write(`${error.stack}\n`);
  finish(1);
}
