// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanProjects, findProject, readPackageSummary, IGNORED_DIRS } from '../src/projects/scanner.mjs';
import { tempDir, cleanupDir } from './helpers.mjs';

function fixture() {
  const root = tempDir('mikuhost-projects-');
  fs.mkdirSync(path.join(root, 'ourin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ourin', 'package.json'), JSON.stringify({ name: 'ourin', dependencies: { baileys: '6' } }));
  fs.mkdirSync(path.join(root, 'ourin', '.git'));
  fs.mkdirSync(path.join(root, 'lyppe-store', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lyppe-store', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'lyppe-store', 'vite.config.js'), 'export default {}');
  fs.mkdirSync(path.join(root, 'minecraft-bot'), { recursive: true });
  fs.writeFileSync(path.join(root, 'minecraft-bot', 'go.mod'), 'module bot');
  fs.mkdirSync(path.join(root, 'py-tool'), { recursive: true });
  fs.writeFileSync(path.join(root, 'py-tool', 'requirements.txt'), 'requests');
  fs.mkdirSync(path.join(root, 'not-a-project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'not-a-project', 'notes.txt'), 'hi');
  fs.mkdirSync(path.join(root, 'ourin', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ourin', 'node_modules', 'pkg', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'nested', 'deep', 'project'), { recursive: true });
  fs.writeFileSync(path.join(root, 'nested', 'deep', 'project', 'pyproject.toml'), '');
  return root;
}

test('projects: scans common project markers and skips dependencies', () => {
  const root = fixture();
  try {
    const scan = scanProjects(root, { maxDepth: 3 });
    const names = scan.projects.map((project) => project.relPath).sort();
    assert.deepEqual(names, ['lyppe-store', 'minecraft-bot', 'nested/deep/project', 'ourin', 'py-tool']);
    assert.equal(scan.projects.some((project) => project.relPath.includes('node_modules')), false);
    assert.equal(scan.projects.some((project) => project.relPath === 'not-a-project'), false);

    const ourin = scan.projects.find((project) => project.relPath === 'ourin');
    assert.equal(ourin.type, 'Node.js');
    assert.equal(ourin.hasGit, true);
    const lyppe = scan.projects.find((project) => project.relPath === 'lyppe-store');
    assert.equal(lyppe.type, 'Web');
    const go = scan.projects.find((project) => project.relPath === 'minecraft-bot');
    assert.equal(go.type, 'Go');
    const py = scan.projects.find((project) => project.relPath === 'py-tool');
    assert.equal(py.type, 'Python');
    assert.ok(IGNORED_DIRS.has('node_modules'));

    assert.equal(scan.truncated, false);
    assert.ok(scan.durationMs >= 0);
  } finally {
    cleanupDir(root);
  }
});

test('projects: depth and project limits are honoured', () => {
  const root = fixture();
  try {
    const shallow = scanProjects(root, { maxDepth: 1 });
    assert.equal(shallow.projects.some((project) => project.relPath === 'nested/deep/project'), false);

    const limited = scanProjects(root, { maxDepth: 4, maxProjects: 2 });
    assert.equal(limited.projects.length, 2);
    assert.equal(limited.truncated, true);
  } finally {
    cleanupDir(root);
  }
});

test('projects: lookup by exact, prefix and case-insensitive name', () => {
  const projects = [
    { relPath: 'ourin', name: 'ourin' },
    { relPath: 'ourin-old', name: 'ourin-old' },
    { relPath: 'lyppe-store', name: 'lyppe-store' },
  ];
  assert.equal(findProject(projects, 'OURIN').relPath, 'ourin');
  assert.equal(findProject(projects, 'lyppe').relPath, 'lyppe-store');
  assert.equal(findProject(projects, 'nope'), null);
  assert.equal(findProject(projects, ''), null);
});

test('projects: package.json summary is compact and bounded', () => {
  const root = fixture();
  try {
    const summary = readPackageSummary(path.join(root, 'ourin'));
    assert.equal(summary.name, 'ourin');
    assert.deepEqual(summary.dependencies, ['baileys']);
    assert.equal(readPackageSummary(path.join(root, 'not-a-project')), null);
  } finally {
    cleanupDir(root);
  }
});
