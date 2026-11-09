import { describe, expect, it } from 'vitest';

import { markdownTwin } from './markdown';

const PAGE = new URL('https://surgerywaits.au/x/');
const md = (html: string): string => {
  const twin = markdownTwin(`<html><head></head><body><main>${html}</main></body></html>`, PAGE);
  return twin.replace(/^Canonical URL: <[^>]*>\n\n/u, '');
};

describe('the Markdown of a paragraph', () => {
  it('escapes a leading number, dash, plus and hash so the line stays a sentence', () => {
    expect(md('<p>1. one</p>')).toBe('1\\. one\n');
    expect(md('<p>2) two</p>')).toBe('2\\) two\n');
    expect(md('<p>- one</p>')).toBe('\\- one\n');
    expect(md('<p>+ one</p>')).toBe('\\+ one\n');
    expect(md('<p># one</p>')).toBe('\\# one\n');
    expect(md('<p>2026 was a year</p>')).toBe('2026 was a year\n');
  });

  it('escapes the pipe and the star in text', () => {
    expect(md('<p>a | b * c</p>')).toBe('a \\| b \\* c\n');
  });

  it('writes the superscript as text that follows its base with no space', () => {
    expect(md('<p>a<sup>2</sup></p>')).toBe('a 2\n');
  });

  it('skips hidden parts and drawings', () => {
    expect(
      md('<p>shown<span hidden>secret</span></p><svg><text>chart</text></svg><p>end</p>'),
    ).toBe('shown\n\nend\n');
  });

  it('skips a part marked as shown only when scripts are off', () => {
    expect(md('<p>shown</p><nav data-twin-skip><p>links</p></nav><p>end</p>')).toBe(
      'shown\n\nend\n',
    );
  });
});

describe('the Markdown of text that would read as syntax', () => {
  it('escapes an ampersand that starts a character reference', () => {
    expect(md('<p>&amp;lt; and &amp;#60; and &amp;amp; but AT&amp;T and a &amp; b</p>')).toBe(
      '\\&lt; and \\&#60; and \\&amp; but AT&T and a & b\n',
    );
  });

  it('escapes a tilde fence at the start of a paragraph', () => {
    expect(md('<p>~~~ js</p>')).toBe('\\~~~ js\n');
    expect(md('<p>a ~~~ b</p>')).toBe('a ~~~ b\n');
  });

  it('escapes the start of every line after a break', () => {
    expect(md('<p>one<br>1. two<br># three<br>- four<br>~~~<br>five</p>')).toBe(
      'one  \n1\\. two  \n\\# three  \n\\- four  \n\\~~~  \nfive\n',
    );
  });
});

describe('the Markdown of code', () => {
  it('keeps a star and a pipe as they are in code outside a table', () => {
    expect(md('<p>use <code>a|b*c</code> here</p>')).toBe('use `a|b*c` here\n');
  });

  it('escapes the pipe in code inside a table cell', () => {
    expect(md('<table><tr><td><code>a|b*c</code></td><td>x | y</td></tr></table>')).toBe(
      '|  |  |\n| --- | --- |\n| `a\\|b*c` | x \\| y |\n',
    );
  });

  it('lengthens the fence when the code holds a backtick', () => {
    expect(md('<p><code>a`b</code></p>')).toBe('``a`b``\n');
    expect(md('<p><code>`a`</code></p>')).toBe('`` `a` ``\n');
    expect(md('<pre>a ``` b</pre>')).toBe('````\na ``` b\n````\n');
  });
});

describe('the Markdown of a table', () => {
  it('uses a first row of only th cells as the header when there is no thead', () => {
    expect(md('<table><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table>')).toBe(
      '| a | b |\n| --- | --- |\n| c | d |\n',
    );
  });

  it('writes an empty header row when the table has no thead', () => {
    expect(md('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')).toBe(
      '|  |  |\n| --- | --- |\n| a | b |\n| c | d |\n',
    );
  });

  it('pads a colspan with empty cells so every row has the same count', () => {
    expect(
      md(
        '<table><thead><tr><th colspan="2">Group</th><th>C</th></tr></thead><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table>',
      ),
    ).toBe('| Group |  | C |\n| --- | --- | --- |\n| a | b | c |\n');
  });

  it('writes the caption in bold above the table', () => {
    expect(
      md(
        '<table><caption>Waits</caption><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
      ),
    ).toBe('**Waits**\n\n| A |\n| --- |\n| 1 |\n');
  });
});

describe('the Markdown of lists and links', () => {
  it('indents a nested list under its item', () => {
    expect(md('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>')).toBe('- a\n\n  - b\n- c\n');
    expect(md('<ol start="3"><li>a<ol><li>b</li></ol></li></ol>')).toBe('3. a\n\n   1. b\n');
  });

  it('writes brackets and spaces in an address as percent escapes and escapes the text', () => {
    expect(md('<p><a href="/a_(b)/c d">go (now)</a></p>')).toBe(
      '[go (now)](https://surgerywaits.au/a_%28b%29/c%20d)\n',
    );
  });
});
