import { describe, expect, it } from 'vitest';

import { TOOLS } from '../../../worker/mcp';
import { MCP_ACCESS, toolAccess } from './mcp-facts';

const tool = (
  name: string,
  readOnlyHint: boolean,
): { name: string; annotations: { readOnlyHint: boolean } } => ({
  name,
  annotations: { readOnlyHint },
});

describe('toolAccess', () => {
  it('says read-only when every tool declares it', () => {
    expect(toolAccess([tool('a', true), tool('b', true)])).toBe('read-only');
  });

  it('throws and names the tool when one does not declare it', () => {
    expect(() => toolAccess([tool('a', true), tool('b', false)])).toThrow(/\bb\b/u);
  });

  it('throws when there are no tools to declare anything', () => {
    expect(() => toolAccess([])).toThrow(/no tool/u);
  });

  it('holds for the Worker tools', () => {
    expect(MCP_ACCESS).toBe('read-only');
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const { annotations } of TOOLS) {
      expect(annotations.readOnlyHint).toBe(true);
    }
  });
});
