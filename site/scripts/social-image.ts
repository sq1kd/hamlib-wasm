/**
 * Capture the landing page's hero as the link-preview image (`mise run social-image`).
 *
 * Serves the built site, renders the hero in dark mode with reduced motion and
 * writes the frame to `public/`.  The site header and the code sample are
 * hidden: the image is the headline, the facts and the radio panel.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { SOCIAL_IMAGE } from '../integrations/social.ts';

const SITE_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = fileURLToPath(new URL(`../public/${SOCIAL_IMAGE.file}`, import.meta.url));
const PORT = 4392;
const ORIGIN = `http://127.0.0.1:${PORT}/`;
const HIDDEN = 'header.header, .hw-code { display: none !important; }';

async function serve(): Promise<ChildProcess> {
  const server = spawn('npx', ['astro', 'preview', '--port', String(PORT), '--host', '127.0.0.1', '--ignore-lock'], {
    cwd: SITE_DIR,
    stdio: 'ignore',
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(ORIGIN).then((response) => response.ok, () => false)) {
      return server;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  server.kill();
  throw new Error(`the site preview did not answer at ${ORIGIN}; run build-site first`);
}

const server = await serve();
const browser = await chromium.launch();

try {
  const page = await browser.newPage({
    viewport: { width: SOCIAL_IMAGE.width, height: 900 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });

  await page.goto(ORIGIN);
  await page.addStyleTag({ content: HIDDEN });
  await page.evaluate(() => document.fonts.ready);

  const hero = await page.locator('.hw-hero').boundingBox();

  if (hero === null) {
    throw new Error('the landing page has no .hw-hero');
  }

  const top = Math.max(0, Math.round(hero.y + (hero.height - SOCIAL_IMAGE.height) / 2));

  await page.screenshot({
    path: OUTPUT,
    clip: { x: 0, y: top, width: SOCIAL_IMAGE.width, height: SOCIAL_IMAGE.height },
  });
  console.log(`[social-image] wrote ${OUTPUT}`);
} finally {
  await browser.close();
  server.kill();
}
