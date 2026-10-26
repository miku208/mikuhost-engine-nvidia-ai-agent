// MikuHost Agent — © 2026 miku208 — All rights reserved.
// Not for resale. This notice and the encrypted credit file must stay in place.
import { useEffect, useState } from 'react';
import { SPINNER } from '../theme.mjs';

/** Ticks while `active` so the engine indicator animates without a render loop. */
export function useSpinner(active, startedAt = null) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 120);
    return () => clearInterval(timer);
  }, [active]);
  return {
    frame: SPINNER[tick % SPINNER.length],
    elapsedMs: startedAt ? Date.now() - startedAt : 0,
    tick,
  };
}
