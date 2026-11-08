import { TOOLS } from '../../../worker/mcp';

interface Annotated {
  name: string;
  annotations: { readOnlyHint: boolean };
}

// The copy may say read-only only while every tool declares it, so a write tool fails the build.
export function toolAccess(tools: readonly Annotated[]): 'read-only' {
  const writers = tools.filter(({ annotations }) => !annotations.readOnlyHint);
  if (writers.length > 0 || tools.length === 0) {
    throw new Error(
      `the copy says the tools are read-only, but ${writers.map(({ name }) => name).join(', ') || 'no tool'} is not declared so`,
    );
  }
  return 'read-only';
}

export const MCP_ACCESS = toolAccess(TOOLS);
