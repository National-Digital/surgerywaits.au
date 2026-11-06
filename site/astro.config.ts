import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  site: 'https://surgerywaits.au',
  trailingSlash: 'always',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
});
