// The Nu checker's filter file opens with a header comment, then holds one pattern a line.
// Each pattern needs a reason comment of its own directly above it; the header is never a reason.
export function unreasonedFilters(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trim());
  const headerEnd = lines.findIndex((l) => !l.startsWith('#'));
  return lines.flatMap((line, i) => {
    if (line === '' || line.startsWith('#')) {
      return [];
    }
    const above = lines[i - 1] ?? '';
    const reason = above.startsWith('#') && above.slice(1).trim() !== '' && i - 1 >= headerEnd;
    return reason ? [] : [`line ${String(i + 1)}: ${line}`];
  });
}
