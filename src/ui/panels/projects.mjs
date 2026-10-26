// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { PanelFrame, PanelRow, PanelHint, EmptyState } from '../components/panel-frame.mjs';

export function ProjectsPanel({ projects, selected, width, focused, truncated, durationMs }) {
  return h(
    PanelFrame,
    {
      title: 'PROJECTS',
      subtitle: `${projects.length} found${truncated ? ' (scan truncated)' : ''}${durationMs ? ` · ${durationMs}ms` : ''}`,
      width,
      footer: '[Enter] Focus project   [A] Clear focus   [R] Rescan   [Esc] Back',
    },
    projects.length === 0
      ? h(EmptyState, { text: 'No projects detected in this workspace.' })
      : projects.map((project, index) =>
          h(PanelRow, {
            key: project.path,
            selected: index === selected,
            marker: { text: focused === project.relPath ? '●' : '○', color: focused === project.relPath ? theme.green : theme.faint },
            label: project.name,
            detail: `${project.type.padEnd(10)} ${project.relPath}`,
            detailColor: theme.faint,
          }),
        ),
    h(PanelHint, { color: theme.faint }, 'Project focus only changes where relative paths resolve; the workspace boundary stays the same.'),
  );
}
