export const SITE = 'https://surgerywaits.au';

// The Content Signals Policy form: search and AI answers allowed, model training not.
export const CONTENT_SIGNAL = 'Content-Signal: search=yes, ai-input=yes, ai-train=no';

// The AI crawlers the site names, in the order the file lists them.
export const NAMED_CRAWLERS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
];

export const SITEMAP_URL = `${SITE}/sitemap.xml`;

// A crawler that matches a named group ignores the * group, so each group repeats the rules.
const group = (agent: string): string => `User-agent: ${agent}\n${CONTENT_SIGNAL}\nAllow: /\n`;

export function robotsTxt(): string {
  const groups = ['*', ...NAMED_CRAWLERS].map(group).join('\n');
  return `# ${SITE}: public hospital waiting times for planned surgery in Australia.\n\n${groups}\nSitemap: ${SITEMAP_URL}\n`;
}
