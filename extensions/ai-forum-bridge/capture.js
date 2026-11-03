// Chrome serializes this function; it intentionally has no outside dependencies.
export function readSelectedText() { return String(window.getSelection()?.toString() || ''); }
