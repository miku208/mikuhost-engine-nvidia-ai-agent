import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { h } from './h.mjs';
import { theme, SYMBOLS } from './theme.mjs';
import { applyTextInput } from './input-edit.mjs';
import { useRawInput } from './hooks/use-raw-input.mjs';
import { NvidiaProvider } from '../providers/nvidia.mjs';
import { ModelRegistry } from '../models/registry.mjs';
import { validateKeyFormat } from '../credentials/storage.mjs';
import { Workspace } from '../security/workspace.mjs';
import { paths } from '../config/paths.mjs';
import { maskTyped, maskKey } from '../util/text.mjs';

const STEPS = ['welcome', 'key', 'model', 'workspace', 'shell'];

function Hint({ children, color = theme.dim }) {
  return h(Text, { color }, children);
}

export function SetupWizard({ config, credentials, initialWorkspace, initialModel, version, onComplete, width = 80, height = 24 }) {
  const { exit } = useApp();
  const models = useMemo(() => {
    const registry = new ModelRegistry({
      userModels: config.get().models,
      defaultModel: config.get().defaultModel,
    });
    return registry.list();
  }, [config]);

  const [step, setStep] = useState('welcome');
  const [keyValue, setKeyValue] = useState('');
  const [keyCursor, setKeyCursor] = useState(0);
  const [modelIndex, setModelIndex] = useState(() => {
    const index = models.findIndex((model) => model.id === (initialModel ?? config.get().defaultModel));
    return index === -1 ? 0 : index;
  });
  const [wsValue, setWsValue] = useState(initialWorkspace?.root ?? '/root');
  const [wsCursor, setWsCursor] = useState((initialWorkspace?.root ?? '/root').length);
  const [shellIndex, setShellIndex] = useState(config.get().permissions?.shell === 'allow' ? 1 : 0);
  const [error, setError] = useState(null);
  const [busyMessage, setBusyMessage] = useState(null);
  const [verified, setVerified] = useState(false);
  const mounted = useRef(true);
  const completing = useRef(false);
  const rawInputRef = useRawInput();

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const model = models[modelIndex] ?? models[0];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  async function validateKey() {
    const check = validateKeyFormat(keyValue);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setError(null);
    setStep('validating');
    setBusyMessage('Validating NVIDIA API key…');
    const provider = new NvidiaProvider({ baseUrl: config.baseUrl, apiKey: keyValue });
    const result = await provider.validateKey(keyValue, { signal: AbortSignal.timeout(25_000) });
    if (!mounted.current) return;
    setBusyMessage(null);
    if (result.valid) {
      setVerified(true);
      setStep('model');
      return;
    }
    if (result.offline) {
      setError('Network unreachable. The key could not be verified.');
      setStep('offline');
      return;
    }
    setError(result.error?.message ?? 'The provider rejected this key.');
    setStep('keyError');
  }

  async function finish() {
    if (completing.current) return;
    completing.current = true;
    setStep('saving');
    setBusyMessage('Saving configuration…');
    try {
      const workspace = new Workspace(wsValue.trim() || initialWorkspace.root);
      const existing = credentials.findByKey(keyValue);
      let entry = existing;
      if (existing) {
        credentials.setStatus(existing.id, verified ? 'ready' : 'unverified');
        credentials.setActive(existing.id);
      } else {
        entry = credentials.add({ name: 'Personal', key: keyValue, status: verified ? 'ready' : 'unverified' });
        credentials.setActive(entry.id);
      }
      const shellMode = shellIndex === 1 ? 'allow' : 'ask';
      config.update({
        setupComplete: true,
        workspace: workspace.root,
        defaultModel: model.id,
        permissions: { shell: shellMode },
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (!mounted.current) return;
      onComplete({ workspace, modelId: model.id, shellMode });
    } catch (saveError) {
      setBusyMessage(null);
      setError(saveError.message);
      setStep('fatal');
    }
  }

  useInput((input, key) => {
    const rawInput = rawInputRef.current;
    rawInputRef.current = null;
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (busyMessage && step !== 'saving') return;

    const advance = () => setError(null);

    switch (step) {
      case 'welcome':
        if (key.return) {
          advance();
          setStep('key');
        } else if (key.escape) {
          exit();
        }
        return;

      case 'key': {
        if (key.return) {
          validateKey();
          return;
        }
        if (key.escape) {
          advance();
          setStep('welcome');
          return;
        }
        const next = applyTextInput(keyValue, keyCursor, input, key, rawInput);
        if (next.changed) {
          setKeyValue(next.value);
          setKeyCursor(next.cursor);
        }
        return;
      }

      case 'keyError':
        if (input.toLowerCase() === 'r' || key.return) {
          advance();
          setStep('key');
        } else if (input.toLowerCase() === 'p') {
          advance();
          setKeyValue('');
          setKeyCursor(0);
          setVerified(false);
          setStep('key');
        } else if (key.escape) {
          exit();
        }
        return;

      case 'offline':
        if (input.toLowerCase() === 'y') {
          advance();
          setStep('model');
        } else if (input.toLowerCase() === 'r' || key.return) {
          advance();
          validateKey();
        } else if (key.escape) {
          exit();
        }
        return;

      case 'model':
        if (key.upArrow) setModelIndex((index) => (index - 1 + models.length) % models.length);
        else if (key.downArrow) setModelIndex((index) => (index + 1) % models.length);
        else if (key.return) {
          advance();
          setStep('workspace');
        } else if (key.escape) {
          advance();
          setStep('key');
        }
        return;

      case 'workspace': {
        if (key.return) {
          try {
            const workspace = new Workspace(wsValue.trim());
            setWsValue(workspace.root);
            setWsCursor(workspace.root.length);
            setError(null);
            setStep('shell');
          } catch (workspaceError) {
            setError(workspaceError.message);
          }
          return;
        }
        if (key.escape) {
          advance();
          setStep('model');
          return;
        }
        const next = applyTextInput(wsValue, wsCursor, input, key, rawInput);
        if (next.changed) {
          setWsValue(next.value);
          setWsCursor(next.cursor);
        }
        return;
      }

      case 'shell':
        if (key.upArrow || key.downArrow) setShellIndex((index) => (index === 0 ? 1 : 0));
        else if (key.return) {
          if (shellIndex === 1) setStep('allowConfirm');
          else finish();
        } else if (key.escape) {
          advance();
          setStep('workspace');
        }
        return;

      case 'allowConfirm':
        if (input.toLowerCase() === 'y' || key.return) {
          finish();
        } else if (input.toLowerCase() === 'n' || key.escape) {
          setStep('shell');
        }
        return;

      case 'fatal':
        if (key.escape || key.return) exit();
        return;

      default:
        return;
    }
  });

  const stepNumber = STEPS.includes(step)
    ? STEPS.indexOf(step) + 1
    : step === 'validating'
      ? 2
      : step === 'keyError' || step === 'offline'
        ? 2
        : step === 'allowConfirm'
          ? 5
          : 5;

  const content = [];
  if (step === 'welcome') {
    content.push(
      h(Text, { color: theme.accent, bold: true }, 'Welcome to MikuHost Agent'),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(Hint, null, 'An AI coding agent for your terminal. It reads, searches and edits'),
        h(Hint, null, 'projects inside one workspace, and runs shell commands only with'),
        h(Hint, null, 'your approval. Everything stays local except NVIDIA API calls.'),
      ),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(Hint, null, `Workspace   ${initialWorkspace?.root ?? '/root'}`),
        h(Hint, null, `Provider    NVIDIA (OpenAI-compatible)`),
        h(Hint, null, `Model       ${model?.name ?? 'unknown'}`),
        h(Hint, null, `Config      ${paths.dir()}`),
      ),
      h(Box, { marginTop: 1 }, h(Text, { color: theme.green, bold: true }, '[Enter] Start setup'), h(Hint, null, '    [Esc] Exit')),
    );
  } else if (step === 'key' || step === 'validating') {
    content.push(
      h(Text, { color: theme.accent, bold: true }, 'NVIDIA API KEY'),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(Hint, null, 'Get a key from build.nvidia.com. It is stored locally with mode 0600'),
        h(Hint, null, 'and is only ever shown masked. It is never sent anywhere except NVIDIA.'),
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: theme.yellow }, '> '),
        step === 'validating'
          ? h(Text, { color: theme.dim }, maskKey(keyValue))
          : h(
              Box,
              {},
              h(Text, { color: theme.text }, maskTyped(keyValue.slice(0, keyCursor))),
              h(Text, { backgroundColor: theme.accent, color: '#0d1117' }, keyCursor < keyValue.length ? '•' : ' '),
              h(Text, { color: theme.text }, maskTyped(keyValue.slice(keyCursor + 1))),
            ),
      ),
      error ? h(Text, { color: theme.red }, error) : null,
      busyMessage ? h(Text, { color: theme.yellow }, busyMessage) : null,
      h(Box, { marginTop: 1 },
        step === 'validating'
          ? h(Hint, null, 'Checking the key against the NVIDIA model catalogue…')
          : h(Box, {}, h(Text, { color: theme.green, bold: true }, '[Enter] Continue'), h(Hint, null, '    [Esc] Back')),
      ),
    );
  } else if (step === 'keyError') {
    content.push(
      h(Text, { color: theme.red, bold: true }, 'KEY COULD NOT BE USED'),
      h(Box, { marginTop: 1 }, h(Text, { color: theme.text, wrap: 'wrap' }, error ?? 'The provider rejected this key.')),
      h(Hint, null, `Key: ${maskKey(keyValue)}`),
      h(Box, { marginTop: 1 },
        h(Text, { color: theme.green, bold: true }, '[R] Retry'),
        h(Hint, null, '    [P] Replace key'),
        h(Hint, null, '    [Esc] Exit'),
      ),
    );
  } else if (step === 'offline') {
    content.push(
      h(Text, { color: theme.yellow, bold: true }, 'NETWORK UNREACHABLE'),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(Hint, null, 'The key could not be verified because NVIDIA is unreachable.'),
        h(Hint, null, 'You can save it as UNVERIFIED. It will not be marked valid, and the'),
        h(Hint, null, 'agent will fail cleanly at request time if the key is wrong.'),
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: theme.green, bold: true }, '[Y] Save as unverified'),
        h(Hint, null, '    [R] Retry'),
        h(Hint, null, '    [Esc] Exit'),
      ),
    );
  } else if (step === 'model') {
    content.push(
      h(Text, { color: theme.accent, bold: true }, 'SELECT DEFAULT MODEL'),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        ...models.map((entry, index) =>
          h(
            Box,
            { key: entry.id },
            h(Text, { color: index === modelIndex ? theme.accent : theme.faint, bold: index === modelIndex }, index === modelIndex ? '❯ ' : '  '),
            h(Text, { color: index === modelIndex ? theme.text : theme.dim }, `${index + 1}. ${entry.name}`),
            h(Text, { color: theme.faint }, `   ${entry.id}`),
          ),
        ),
      ),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(Text, { color: theme.faint }, 'Capabilities are unverified. Models without native tool calling use a text tool protocol.'),
        h(Text, { color: theme.faint }, 'Availability is checked the first time you send a message.'),
      ),
      h(Box, { marginTop: 1 }, h(Text, { color: theme.green, bold: true }, '↑↓ Navigate'), h(Hint, null, '    [Enter] Continue'), h(Hint, null, '    [Esc] Back')),
    );
  } else if (step === 'workspace') {
    content.push(
      h(Text, { color: theme.accent, bold: true }, 'CONFIRM WORKSPACE'),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(Hint, null, 'MikuHost can read and edit any project inside this directory. It will'),
        h(Hint, null, 'refuse paths outside it, even when invoked as root.'),
      ),
      h(Box, { marginTop: 1 },
        h(Text, { color: theme.yellow }, '> '),
        h(Text, { color: theme.text }, wsValue.slice(0, wsCursor)),
        h(Text, { backgroundColor: theme.accent, color: '#0d1117' }, wsValue.slice(wsCursor, wsCursor + 1) || ' '),
        h(Text, { color: theme.text }, wsValue.slice(wsCursor + 1)),
      ),
      error ? h(Text, { color: theme.red }, error) : null,
      h(Box, { marginTop: 1 }, h(Text, { color: theme.green, bold: true }, '[Enter] Confirm'), h(Hint, null, '    [Esc] Back')),
    );
  } else if (step === 'shell' || step === 'allowConfirm') {
    content.push(
      h(Text, { color: theme.accent, bold: true }, 'SHELL EXECUTION PERMISSION'),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(
          Box,
          {},
          h(Text, { color: shellIndex === 0 ? theme.green : theme.faint, bold: true }, `${shellIndex === 0 ? '●' : '○'} Always Ask `),
          h(Hint, null, '   every command needs your approval (recommended)'),
        ),
        h(
          Box,
          {},
          h(Text, { color: shellIndex === 1 ? theme.yellow : theme.faint, bold: true }, `${shellIndex === 1 ? '●' : '○'} Always Allow `),
          h(Hint, null, ' read-only and project test/build commands run automatically'),
        ),
      ),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        h(Text, { color: theme.faint }, 'Guarded commands (installers, network egress, inline code, credential access)'),
        h(Text, { color: theme.faint }, 'and destructive commands always require explicit approval.'),
        isRoot ? h(Text, { color: theme.yellow }, 'Running as root: auto-executed commands have full system privileges.') : null,
      ),
      step === 'allowConfirm'
        ? h(Box, { marginTop: 1, flexDirection: 'column' },
            h(Text, { color: theme.yellow, bold: true }, 'ENABLE ALWAYS ALLOW?'),
            h(Text, { color: theme.dim }, 'This applies immediately and is saved to config.json.'),
            h(Box, { marginTop: 1 }, h(Text, { color: theme.green, bold: true }, '[Y] Enable'), h(Hint, null, '    [N] Cancel')),
          )
        : h(Box, { marginTop: 1 }, h(Text, { color: theme.green, bold: true }, '↑↓ Navigate'), h(Hint, null, '    [Enter] Continue'), h(Hint, null, '    [Esc] Back')),
    );
  } else if (step === 'saving') {
    content.push(
      h(Text, { color: theme.accent, bold: true }, 'SAVING'),
      h(Hint, null, busyMessage ?? 'Writing configuration…'),
    );
  } else if (step === 'fatal') {
    content.push(
      h(Text, { color: theme.red, bold: true }, 'SETUP FAILED'),
      h(Text, { color: theme.text, wrap: 'wrap' }, error ?? 'Unknown error'),
      h(Box, { marginTop: 1 }, h(Hint, null, '[Esc] Exit')),
    );
  }

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1, width, height, overflow: 'hidden' },
    h(
      Box,
      { borderStyle: 'round', borderColor: theme.border, paddingX: 1, flexDirection: 'column', flexShrink: 0 },
      h(
        Box,
        { justifyContent: 'space-between' },
        h(Text, { color: theme.accent, bold: true }, 'MIKUHOST AGENT'),
        h(Text, { color: theme.yellow }, `${SYMBOLS.bullet} SETUP ${stepNumber}/${STEPS.length}`),
      ),
      h(Text, { color: theme.dim }, 'FIRST TIME SETUP'),
    ),
    h(
      Box,
      {
        borderStyle: 'round',
        borderColor: theme.borderActive,
        paddingX: 1,
        flexDirection: 'column',
        marginTop: 1,
        flexGrow: 1,
        overflow: 'hidden',
      },
      ...content.filter(Boolean),
    ),
    h(
      Box,
      { marginTop: 1, justifyContent: 'space-between' },
      h(Text, { color: theme.faint }, `MikuHost Agent v${version ?? ''}`),
      h(Text, { color: theme.faint }, step === 'welcome' ? 'Esc exits' : 'Your key never leaves this machine'),
    ),
  );
}
