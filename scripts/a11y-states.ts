import type { Page } from 'playwright';

// The compare tool changes after a person acts, so each state is reached by acting, then audited.
const INPUT = '.js-combo-input';
const FIELD = '.js-tool-field';
const OPTION = '[role="option"]';
const SURGERY = 'knee';
const PLACE = 'Armidale';

async function pick(page: Page, field: number, text: string): Promise<void> {
  const input = page.locator(INPUT).nth(field);
  await input.fill(text);
  await page.locator(FIELD).nth(field).locator(OPTION).first().waitFor();
  await input.press('ArrowDown');
  await input.press('Enter');
}

export const TOOL_STATES: Record<string, (page: Page) => Promise<void>> = {
  '/compare/': async (page) => {
    await page.locator('.js-tool-form').waitFor();
  },
  '/compare/?state=options': async (page) => {
    await page.locator(INPUT).first().fill(SURGERY);
    await page.locator(OPTION).first().waitFor();
  },
  '/compare/?state=results': async (page) => {
    await pick(page, 0, SURGERY);
    await pick(page, 1, PLACE);
    // The keyboard keeps focus-visible on, as it would be for a person who used the keyboard.
    await page.locator('button[type="submit"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('.js-tool-results li').first().waitFor();
  },
};
