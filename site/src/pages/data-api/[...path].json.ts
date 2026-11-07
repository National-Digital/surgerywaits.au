import type { APIRoute, GetStaticPaths } from 'astro';

import { dataApiBody, dataApiPaths } from '../../lib/data-api';

export const getStaticPaths: GetStaticPaths = () =>
  dataApiPaths().map((path) => ({
    params: { path: path.slice(0, -'.json'.length) },
  }));

export const GET: APIRoute = ({ params }) =>
  new Response(dataApiBody(`${params['path'] ?? ''}.json`), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
