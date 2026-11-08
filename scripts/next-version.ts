// Chooses the release number from the latest v-tag and the Conventional Commits subject of a commit.
import { execFileSync } from 'node:child_process';

export type Version = readonly [number, number, number];
export type Bump = 'major' | 'minor' | 'patch';

export const BASE: Version = [1, 0, 0];
const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SUBJECT = /^\s*([a-z]+)(\([^)]*\))?(!)?:/iu;

export function parseTag(tag: string): Version | null {
  const m = TAG.exec(tag.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function formatVersion(v: Version): string {
  return v.join('.');
}

// The tag with the highest number; tags that are not v<major>.<minor>.<patch> are ignored.
export function latestVersion(tags: readonly string[]): Version | null {
  const found = tags.map(parseTag).filter((v): v is Version => v !== null);
  found.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  return found[0] ?? null;
}

// The message is the whole commit message, whose first line is the pull request's title.
export function bumpFor(message: string): Bump {
  const subject = message.split('\n')[0] ?? '';
  const m = SUBJECT.exec(subject);
  if (m?.[3] !== undefined || /^BREAKING[ -]CHANGE:/mu.test(message)) {
    return 'major';
  }
  if (m === null) {
    return 'patch';
  }
  return m[1]?.toLowerCase() === 'feat' ? 'minor' : 'patch';
}

export function bump(from: Version, kind: Bump): Version {
  if (kind === 'major') {
    return [from[0] + 1, 0, 0];
  }
  if (kind === 'minor') {
    return [from[0], from[1] + 1, 0];
  }
  return [from[0], from[1], from[2] + 1];
}

export function nextVersion(tags: readonly string[], message: string): Version {
  return bump(latestVersion(tags) ?? BASE, bumpFor(message));
}

// A commit that already has a v-tag keeps that version, so a re-run never takes the next number.
export function releaseFor(
  headTags: readonly string[],
  tags: readonly string[],
  message: string,
): Version {
  return latestVersion(headTags) ?? nextVersion(tags, message);
}

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();
const tagsOf = (...args: string[]): string[] =>
  git('tag', '--list', 'v*.*.*', ...args)
    .split('\n')
    .filter(Boolean);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };
  const tags = tagsOf();
  const headTags = tagsOf('--points-at', 'HEAD');
  if (args.includes('--print-current')) {
    out(formatVersion(latestVersion(tags) ?? BASE));
  } else if (args.includes('--tagged')) {
    // The version of HEAD's own tag, or nothing when HEAD is not a release.
    const tagged = latestVersion(headTags);
    out(tagged === null ? '' : formatVersion(tagged));
  } else {
    const message = args.find((a) => !a.startsWith('--')) ?? git('log', '-1', '--format=%B');
    out(formatVersion(releaseFor(headTags, tags, message)));
  }
}
