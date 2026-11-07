import { existsSync, readFileSync } from 'node:fs';

// An assets binding over a directory of the data files, recording each path it is asked for.
export interface Assets {
  fetch(input: Request | string | URL): Promise<Response>;
}
export function assetsOver(root: URL, asked: string[] = []): Assets {
  return {
    fetch: (input: Request | string | URL): Promise<Response> => {
      const { pathname, origin } = new URL(input instanceof Request ? input.url : input);
      asked.push(`${origin}${pathname}`);
      const file = new URL(`.${pathname.replace(/^\/data-api\//u, '/')}`, root);
      return Promise.resolve(
        existsSync(file)
          ? new Response(readFileSync(file, 'utf8'), {
              headers: { 'Content-Type': 'application/json' },
            })
          : new Response('{"error":"not found"}', { status: 404 }),
      );
    },
  };
}
