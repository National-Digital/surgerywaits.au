import type { APIRoute } from 'astro';

import { canonicalJson } from '../../lib/data-api';
import { openApiDocument } from '../../lib/openapi';

export const GET: APIRoute = () =>
  new Response(canonicalJson(openApiDocument()), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
