// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import fs from 'node:fs';
import path from 'node:path';

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '.nuxt',
  'vendor',
  '.turbo',
  '.svelte-kit',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.terraform',
  'site-packages',
  '.expo',
  'tmp',
  'temp',
]);

const MARKERS = [
  { file: 'package.json', type: 'Node.js' },
  { file: 'pyproject.toml', type: 'Python' },
  { file: 'requirements.txt', type: 'Python' },
  { file: 'Cargo.toml', type: 'Rust' },
  { file: 'go.mod', type: 'Go' },
  { file: 'composer.json', type: 'PHP' },
  { file: 'pom.xml', type: 'Java' },
  { file: 'build.gradle', type: 'Java' },
  { file: 'Gemfile', type: 'Ruby' },
  { file: 'mix.exs', type: 'Elixir' },
  { file: 'deno.json', type: 'Deno' },
];

const WEB_MARKERS = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'vite.config.js', 'vite.config.ts', 'svelte.config.js', 'nuxt.config.ts', 'astro.config.mjs'];

export const SCAN_DEFAULTS = Object.freeze({
  maxDepth: 3,
  maxProjects: 80,
  maxEntries: 6000,
  timeoutMs: 5000,
});

/**
 * Breadth-first project discovery under the workspace root. Skips dependency
 * and build directories, and hard-stops on depth/entry/time budgets so a huge
 * /root can never freeze the UI.
 */
export function scanProjects(root, options = {}) {
  const { maxDepth, maxProjects, maxEntries, timeoutMs } = { ...SCAN_DEFAULTS, ...options };
  const startedAt = Date.now();
  const projects = [];
  const queue = [{ dir: root, depth: 0 }];
  let entriesSeen = 0;
  let truncated = false;

  while (queue.length) {
    if (Date.now() - startedAt > timeoutMs) {
      truncated = true;
      break;
    }
    if (entriesSeen > maxEntries || projects.length >= maxProjects) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entriesSeen += entries.length;

    const names = new Set(entries.map((entry) => entry.name));
    const info = classifyDirectory(names, dir);
    if (info && depth > 0) {
      projects.push({
        name: path.basename(dir),
        path: dir,
        relPath: path.relative(root, dir) || '.',
        type: info.type,
        hasGit: names.has('.git'),
        markers: info.markers,
        depth,
      });
      if (projects.length >= maxProjects) {
        truncated = true;
        break;
      }
    }

    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.config') continue;
      // A project directory is still descended into (monorepos), but hidden
      // and dependency directories are pruned above.
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  projects.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return {
    projects,
    truncated,
    scannedEntries: entriesSeen,
    durationMs: Date.now() - startedAt,
    root,
  };
}

function classifyDirectory(names, dir) {
  const markers = [];
  let type = null;

  for (const marker of MARKERS) {
    if (names.has(marker.file)) {
      markers.push(marker.file);
      type = type ?? marker.type;
    }
  }
  if (type === 'Node.js' || type === 'Deno') {
    if (WEB_MARKERS.some((file) => names.has(file))) type = 'Web';
  }
  if (!type && names.has('index.html') && (names.has('assets') || names.has('src') || names.has('public'))) {
    type = 'Web';
    markers.push('index.html');
  }
  if (!type && names.has('.git')) {
    type = 'Repository';
    markers.push('.git');
  }
  if (!type) return null;
  return { type, markers };
}

export function findProject(projects, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return null;
  const scored = projects
    .map((project) => {
      const name = project.name.toLowerCase();
      const rel = project.relPath.toLowerCase();
      let score = -1;
      if (name === needle || rel === needle) score = 100;
      else if (name.startsWith(needle) || rel.startsWith(needle)) score = 80;
      else if (name.includes(needle) || rel.includes(needle)) score = 60;
      return { project, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.project ?? null;
}

const MAX_PACKAGE_BYTES = 256 * 1024;

/** Compact package.json summary used for context and `--projects` output. */
export function readPackageSummary(projectDir) {
  const file = path.join(projectDir, 'package.json');
  try {
    const stat = fs.statSync(file);
    if (stat.size > MAX_PACKAGE_BYTES) return { error: 'package.json is too large to summarise' };
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      path: file,
      name: json.name ?? null,
      version: json.version ?? null,
      type: json.type ?? null,
      main: json.main ?? null,
      scripts: json.scripts && typeof json.scripts === 'object' ? json.scripts : {},
      dependencies: Object.keys(json.dependencies ?? {}),
      devDependencies: Object.keys(json.devDependencies ?? {}),
      engines: json.engines ?? null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { error: `Could not read package.json: ${error.message}` };
  }
}
