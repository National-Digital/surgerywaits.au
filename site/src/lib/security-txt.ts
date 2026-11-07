import { SITE } from './robots';

// Renewed by hand; security-txt.test.ts fails 30 days before this date. RFC 9116 allows at most a year ahead.
export const EXPIRES = '2027-09-30T00:00:00.000Z';

export const SECURITY_TXT_PATH = '/.well-known/security.txt';

// The same two channels as SECURITY.md.
export const CONTACTS: readonly string[] = [
  'mailto:security@nationaldigital.com.au',
  'https://github.com/National-Digital/surgerywaits.au/security/advisories/new',
];
export const POLICY = 'https://github.com/National-Digital/surgerywaits.au/blob/main/SECURITY.md';

export function securityTxt(): string {
  return [
    ...CONTACTS.map((contact) => `Contact: ${contact}`),
    `Expires: ${EXPIRES}`,
    'Preferred-Languages: en',
    `Canonical: ${SITE}${SECURITY_TXT_PATH}`,
    `Policy: ${POLICY}`,
    '',
  ].join('\n');
}
