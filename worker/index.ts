export default {
  // Headers, redirects and the MCP route join here (ADR D7); for now it only serves the build.
  async fetch(request, env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
