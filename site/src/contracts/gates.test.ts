import { describe, it } from 'vitest';

describe('Contract: dist files', () => {
  it.todo('validate against their JSON Schemas in contract/');
  it.todo("the site reads only the pipeline's dist output");
});

describe('Suppressed values', () => {
  it.todo(
    "render 'not published' with the reason taken from the publisher's marker (<5, -, NP); an unknown marker fails the build",
  );
});

describe('Suppressed cells', () => {
  it.todo('a suppressed cell is never rendered blank or as 0');
  it.todo(
    "'not peered' shows as 'not published: no peer group comparison' and only in place of the peer-group columns",
  );
});

describe('Reference period and release date', () => {
  it.todo('every rendered figure shows its reference period and the data release date');
});

describe('Ranking', () => {
  it.todo('a hospital with suppressed or stale figures is never ranked');
});

describe('Private hospitals', () => {
  it.todo('private hospitals are excluded and the page states the exclusion');
});

describe('Determinism', () => {
  it.todo('building the site twice gives byte-identical output');
});

describe('Static pages', () => {
  it.todo('static pages ship zero JavaScript');
  it.todo("every hospital's figures are reachable without script");
});

describe('Privacy', () => {
  it.todo('the site sets no cookies and uses no localStorage or sessionStorage');
  it.todo('the compare tool puts no search state in the URL or history');
  it.todo('the page-view count sets no cookie and sends nothing a person enters');
  it.todo('the privacy check allows exactly the Web Analytics beacon and report hosts');
});

describe('Page weight', () => {
  it.todo('every page stays within the page-weight budget set when the site lands');
});

describe('HTML validity', () => {
  it.todo('the W3C Nu Html Checker passes with --Werror');
  it.todo('the Nu checker version is pinned and every filter line carries a reason');
});

describe('Accessibility', () => {
  it.todo('axe passes at WCAG 2.2 AAA in light mode');
  it.todo('axe passes at WCAG 2.2 AAA in dark mode');
  it.todo('text a person reads is at or above a set minimum size');
  it.todo('no paragraph averages more than 80 characters a line');
  it.todo('every link, button and field meets a minimum target size');
  it.todo('no link is named by a word that does not say where it goes');
  it.todo('no page scrolls sideways at 320 CSS pixels wide');
  it.todo('with the WCAG text-spacing settings forced, nothing is cut off');
  it.todo("every size is relative, so a reader's own browser text size applies");
  it.todo('colour is never the only carrier of meaning');
  it.todo('each accessibility check is proven to fire on a page built to fail it');
  it.todo('an accessibility exception that no longer matches anything fails the check');
});

describe('Contrast', () => {
  it.todo('all text and meaningful graphics meet AAA contrast in light and dark');
});

describe('Copy', () => {
  it.todo("'elective' appears only where the methodology quotes a source");
  it.todo("no 'best hospital' or practitioner-promotion language appears");
  it.todo('copy lives in typed content files');
  it.todo('a missing or unknown content slot fails the build');
  it.todo('no literal user-visible text appears in components; copy lives in YAML under content/');
  it.todo('the credit line uses the citation publicdata.au publishes with each version');
});

describe('Repository', () => {
  it.todo('no data snapshot is committed to git');
  it.todo('the data licence stays in its own file, apart from the code licence');
});

describe('OpenAPI', () => {
  it.todo('a schema and the generated OpenAPI description never disagree');
});

describe('Delivery', () => {
  it.todo('CSP and security headers are set on every response');
  it.todo('every redirect reaches a 200');
  it.todo('every internal link resolves');
  it.todo('the sitemap lists every indexable page and only those');
});
