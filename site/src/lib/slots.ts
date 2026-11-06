const SLOT = /\{([a-z_]+)\}/g;

export function slotsOf(text: string): string[] {
  return [...new Set([...text.matchAll(SLOT)].map((m) => m[1] ?? ''))].sort();
}

// Content names its slots, so a slot with no value or a value with no slot is a bug in the page.
export function fill(text: string, values: Record<string, string>): string {
  const wanted = slotsOf(text);
  const given = Object.keys(values).sort();
  if (wanted.join() !== given.join()) {
    throw new RangeError(
      `the text needs the slots ${wanted.join(', ') || '(none)'} but was given ${given.join(', ') || '(none)'}`,
    );
  }
  return text.replaceAll(SLOT, (_, name: string) => values[name] ?? '');
}
