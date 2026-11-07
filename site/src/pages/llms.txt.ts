import { llmsTxt } from '../lib/llms';

export function GET(): Response {
  return new Response(llmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
