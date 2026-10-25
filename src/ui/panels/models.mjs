import { Box, Text } from 'ink';
import { h } from '../h.mjs';
import { theme } from '../theme.mjs';
import { PanelFrame, PanelRow, PanelHint, EmptyState } from '../components/panel-frame.mjs';

function capabilityText(capabilities) {
  const tools = capabilities.tools === null ? 'tools unverified' : capabilities.tools ? 'tools' : 'chat only';
  const vision = capabilities.vision === null ? 'vision unverified' : capabilities.vision ? 'vision' : null;
  const context = capabilities.contextWindow ? `${capabilities.contextWindow} ctx` : 'ctx unknown';
  return [tools, vision, context].filter(Boolean).join(' · ');
}

function availabilityText(availability) {
  if (!availability) return { text: '', color: theme.faint };
  if (availability.status === 'available') return { text: 'available', color: theme.green };
  if (availability.status === 'unavailable') return { text: 'unavailable', color: theme.red };
  return { text: 'unverified', color: theme.faint };
}

export function ModelsPanel({ models, selected, activeId, width, statusMessage, refreshError }) {
  const current = models[selected] ?? null;
  return h(
    PanelFrame,
    {
      title: 'SELECT MODEL',
      subtitle: current?.id ?? null,
      width,
      footer: '↑↓ Navigate   [Enter] Select   [R] Refresh catalogue   [Esc] Back',
    },
    models.length === 0
      ? h(EmptyState, { text: 'No models configured.' })
      : models.map((model, index) =>
          h(PanelRow, {
            key: model.id,
            selected: index === selected,
            marker: { text: model.id === activeId ? '●' : '○', color: model.id === activeId ? theme.green : theme.faint },
            label: model.name,
            detail: model.id === activeId ? 'active' : availabilityText(model.availability).text,
            detailColor: model.id === activeId ? theme.green : availabilityText(model.availability).color,
          }),
        ),
    current
      ? h(
          Box,
          { flexDirection: 'column', marginTop: 1 },
          h(Text, { color: theme.dim }, current.id),
          h(Text, { color: theme.faint }, capabilityText(current.capabilities)),
          current.availability?.status === 'unavailable'
            ? h(Text, { color: theme.red }, `Model unavailable for current NVIDIA credential. ${current.availability.reason ?? ''}`)
            : null,
        )
      : null,
    statusMessage ? h(PanelHint, { color: theme.yellow }, statusMessage) : null,
    refreshError ? h(PanelHint, { color: theme.red }, refreshError) : null,
    h(PanelHint, { color: theme.faint }, 'Capabilities are unverified until the provider catalogue is checked; the agent falls back to a text tool protocol when a model has no native tool calling.'),
  );
}
