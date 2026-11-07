import type { APIRoute, GetStaticPaths } from 'astro';

import { stateChartFiles } from '../../lib/state-chart';

export const getStaticPaths: GetStaticPaths = () =>
  stateChartFiles().map(({ slug, svg }) => ({
    params: { slug },
    props: { svg },
  }));

export const GET: APIRoute = ({ props }) =>
  new Response(props['svg'] as string, {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
