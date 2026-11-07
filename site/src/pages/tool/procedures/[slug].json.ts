import type { APIRoute, GetStaticPaths } from 'astro';

import { procedureSlugs, toolProcedureJson } from '../../../lib/tool-data';

export const getStaticPaths: GetStaticPaths = () =>
  procedureSlugs().map((slug) => ({ params: { slug } }));

export const GET: APIRoute = ({ params }) =>
  new Response(toolProcedureJson(params['slug'] ?? ''), {
    headers: { 'Content-Type': 'application/json' },
  });
