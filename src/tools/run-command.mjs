import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { resolveToolPath, truncateOutput, relativeInside, ToolError } from './util.mjs';
import { evaluateShellCommand } from '../security/permissions.mjs';
import { describeRisk } from '../security/permissions.mjs';

const MAX_CAPTURE_BYTES = 512 * 1024;

function safeEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^MIKUHOST_.*(KEY|SECRET|TOKEN)$/i.test(key)) delete env[key];
  }
  delete env.MIKUHOST_ENCRYPTION_KEY;
  return env;
}

function killProcessTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      /* already gone */
    }
  }, 2000).unref?.();
}

export const runCommandTool = {
  name: 'run_command',
  description:
    'Run a shell command in a workspace directory. Returns exit code, stdout and stderr. Destructive or unverifiable commands (rm -rf, git reset --hard, sudo, installers, network egress, inline interpreter code) always require explicit approval, even in Always Allow mode.',
  permission: 'command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute.', minLength: 1, maxLength: 4000 },
      cwd: { type: 'string', description: 'Working directory inside the workspace (default: focused project).' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: 600000, description: 'Timeout in milliseconds (default from config, 30s).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const command = String(input.command ?? '').trim();
    if (!command) throw new ToolError('command must not be empty.', 'INVALID_INPUT');
    if (command.length > ctx.limits.maxCommandLength) {
      throw new ToolError(`Command is longer than ${ctx.limits.maxCommandLength} characters.`, 'TOO_LONG');
    }

    const cwd = resolveToolPath(ctx, input.cwd ?? '.', { mustExist: true });
    if (!fs.statSync(cwd).isDirectory()) throw new ToolError('cwd must be a directory inside the workspace.', 'NOT_A_DIRECTORY');

    const mode = ctx.permissions.shell === 'allow' ? 'allow' : 'ask';
    const verdict = evaluateShellCommand({ command, mode, workspaceRoot: ctx.workspace.root });
    const relCwd = relativeInside(ctx.workspace, cwd);

    if (verdict.requiresApproval) {
      const approved = await ctx.requestApproval({
        kind: 'command',
        command,
        cwd: relCwd,
        absoluteCwd: cwd,
        mode,
        risk: verdict.risk,
        riskLabel: describeRisk(verdict.risk),
        reasons: verdict.reasons,
        elevated: ctx.isRootUser,
      });
      if (!approved) {
        throw new ToolError(
          `Permission denied: the user did not approve running this command. (${verdict.reasons.join('; ') || 'requires approval'})`,
          'PERMISSION_DENIED',
        );
      }
    }

    const configTimeout = Number(ctx.config?.get?.().agent?.commandTimeoutMs) || 30_000;
    const timeoutMs = Math.min(
      ctx.limits.maxCommandTimeoutMs,
      Math.max(1000, Number(input.timeout_ms) || configTimeout),
    );

    ctx.activity(`Running: ${command}`);
    const startedAt = Date.now();

    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const child = spawn(command, {
        cwd,
        shell: process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh',
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeEnvironment(),
      });

      child.stdout.on('data', (chunk) => {
        if (stdoutBytes >= MAX_CAPTURE_BYTES) return;
        stdoutBytes += chunk.length;
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        if (stderrBytes >= MAX_CAPTURE_BYTES) return;
        stderrBytes += chunk.length;
        stderr += chunk.toString('utf8');
      });

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener?.('abort', onAbort);
        resolve(payload);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);

      const onAbort = () => {
        aborted = true;
        killProcessTree(child);
      };
      ctx.signal?.addEventListener?.('abort', onAbort, { once: true });

      child.on('error', (error) => {
        finish({ exitCode: null, signal: null, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`, timedOut, aborted, spawnError: true });
      });

      child.on('close', (code, signal) => {
        finish({ exitCode: code, signal, stdout, stderr, timedOut, aborted });
      });
    });

    const durationMs = Date.now() - startedAt;
    const stdout = truncateOutput(result.stdout, ctx.limits.maxCommandOutputBytes);
    const stderr = truncateOutput(result.stderr, ctx.limits.maxCommandOutputBytes);

    let statusLine;
    if (result.timedOut) statusLine = `timed out after ${timeoutMs}ms (process killed)`;
    else if (result.aborted) statusLine = 'cancelled (process killed)';
    else if (result.spawnError) statusLine = 'failed to start';
    else statusLine = `exit code ${result.exitCode}${result.signal ? ` (signal ${result.signal})` : ''}`;

    ctx.activity(`Finished: ${command} — ${statusLine}`);

    const output = [
      `$ ${command}`,
      `cwd: ${relCwd}`,
      `status: ${statusLine}`,
      `duration: ${durationMs}ms`,
      '',
      '--- stdout ---',
      stdout.text || '(empty)',
      '',
      '--- stderr ---',
      stderr.text || '(empty)',
    ].join('\n');

    return {
      output,
      meta: {
        command,
        cwd: relCwd,
        exitCode: result.exitCode,
        signal: result.signal ?? null,
        timedOut: Boolean(result.timedOut),
        aborted: Boolean(result.aborted),
        durationMs,
        outputTruncated: stdout.truncated || stderr.truncated,
      },
      display: {
        title: command.length > 80 ? `${command.slice(0, 77)}…` : command,
        detail: `${relCwd} · ${statusLine}`,
        ok: result.exitCode === 0 && !result.timedOut && !result.aborted,
      },
    };
  },
};
