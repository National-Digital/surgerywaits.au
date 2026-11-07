import { toolFiguresJson } from '../../lib/tool-data';

export function GET(): Response {
  return new Response(toolFiguresJson(), { headers: { 'Content-Type': 'application/json' } });
}
