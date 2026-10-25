import { useEffect, useRef } from 'react';
import { StringDecoder } from 'node:string_decoder';

/**
 * Capture the exact stdin bytes for the key event Ink is about to deliver.
 *
 * Ink normalizes both Backspace (0x7f) and forward Delete (ESC[3~) to
 * `key.delete`, so the editor cannot tell them apart from flags alone. This
 * listener is registered before Ink's `useInput` listener (hooks run in order),
 * records the chunk, and the next `useInput` callback consumes it.
 */
export function useRawInput() {
  const pending = useRef(null);

  useEffect(() => {
    const stdin = process.stdin;
    if (!stdin || typeof stdin.on !== 'function') return undefined;
    const decoder = new StringDecoder('utf8');
    const onData = (chunk) => {
      if (typeof chunk === 'string') {
        pending.current = chunk;
        return;
      }
      const text = decoder.write(chunk);
      if (text) pending.current = text;
    };
    stdin.on('data', onData);
    return () => {
      stdin.off?.('data', onData);
    };
  }, []);

  return pending;
}
