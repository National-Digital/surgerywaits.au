import type { APIRoute, GetStaticPaths } from 'astro';

import { canonicalJson } from '../../lib/data-api';
import { contractSchemas } from '../../lib/dist';

export const getStaticPaths: GetStaticPaths = () =>
  contractSchemas().map(([name, schema]) => ({
    params: { name },
    props: { schema },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response(canonicalJson(props['schema']), {
    headers: { 'Content-Type': 'application/schema+json; charset=utf-8' },
  });
