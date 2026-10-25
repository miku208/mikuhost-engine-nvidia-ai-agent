import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export function useTerminalSize(fallback = { columns: 80, rows: 24 }) {
  const { stdout } = useStdout();
  const read = () => ({
    columns: stdout?.columns || fallback.columns,
    rows: stdout?.rows || fallback.rows,
  });
  const [size, setSize] = useState(read);

  useEffect(() => {
    if (!stdout) return undefined;
    const update = () => setSize(read());
    update();
    stdout.on('resize', update);
    return () => {
      stdout.off?.('resize', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return size;
}
