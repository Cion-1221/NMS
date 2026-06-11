import { useEffect, useState } from 'react';

/**
 * Debounce a fast-changing value (e.g. text-filter inputs) so each keystroke
 * doesn't fire a server query.  Returns the value after it has been stable
 * for `delay` ms.
 */
export function useDebounced<T>(value: T, delay = 400): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
