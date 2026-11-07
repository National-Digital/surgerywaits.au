// The Nu checker's filter file holds one pattern a line, and each needs a comment above it that says why.
export function unreasonedFilters(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim());
  return lines.flatMap((line, i) => {
    if (line === '' || line.startsWith('#')) {
      return [];
    }
    const above = lines[i - 1] ?? '';
    return above.startsWith('#') && above.slice(1).trim() !== ''
      ? []
      : [`line ${String(i + 1)}: ${line}`];
  });
}
