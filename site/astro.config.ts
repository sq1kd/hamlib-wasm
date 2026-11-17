import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

import { hamlibLicensing } from './integrations/licensing';
import { readCatalogue } from './integrations/catalogue';
import { measureDemoDownload } from './integrations/demo-size';
import { ENTRIES, TSCONFIG } from './typedoc/entries';

/*
 * Where the site is served from.
 *
 * GitHub Pages serves a project site at https://<owner>.github.io/<repo>/, and
 * the Actions runner exports GITHUB_REPOSITORY=<owner>/<repo>, so a Pages build
 * needs no configuration.  SITE_URL / SITE_BASE override either half; a local
 * build without them is served from the root of the preview server, which is
 * also the origin the sitemap then names.
 */
const repository = process.env.SITE_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
const [owner, repo] = repository?.split('/') ?? [];
const site = process.env.SITE_URL
  ?? (owner === undefined ? 'http://127.0.0.1:4176' : `https://${owner}.github.io`);
const base = process.env.SITE_BASE ?? (repo === undefined ? '/' : `/${repo}/`);
const repositoryUrl = repository === undefined ? undefined : `https://github.com/${repository}`;

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'hamlib-wasm',
      description:
        'Hamlib CAT control compiled to WebAssembly: Web Serial in the browser, serialport in Node and Electron.',
      ...(repositoryUrl === undefined
        ? {}
        : {
          social: [{ icon: 'github', label: 'GitHub', href: repositoryUrl }],
          editLink: { baseUrl: `${repositoryUrl}/edit/main/site/` },
        }),
      logo: { src: './src/assets/logo.svg' },
      components: { Hero: './src/components/Hero.astro' },
      /* Code blocks take the site's box corners from site.css. */
      expressiveCode: { styleOverrides: { borderRadius: 'var(--hw-radius)' } },
      customCss: [
        '@fontsource/ibm-plex-sans/latin-400.css',
        '@fontsource/ibm-plex-sans/latin-600.css',
        '@fontsource/ibm-plex-mono/latin-400.css',
        './src/styles/site.css',
      ],
      disable404Route: true,
      plugins: [
        starlightTypeDoc({
          entryPoints: ENTRIES.map((entry) => entry.source),
          tsconfig: TSCONFIG,
          output: 'api',
          sidebar: { label: 'API reference', collapsed: true },
          typeDoc: {
            /* Name each module after the specifier a consumer imports. */
            plugin: ['./typedoc/entry-names.ts'],
            /* A configured readme also keeps each module's overview page. */
            readme: './typedoc/README.md',
            excludePrivate: true,
            excludeInternal: true,
            sourceLinkTemplate: repositoryUrl === undefined
              ? undefined
              : `${repositoryUrl}/blob/main/{path}#L{line}`,
            disableSources: repositoryUrl === undefined,
          },
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Live demo', slug: 'demo' },
            { label: 'How it works', slug: 'how-it-works' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Rig API', slug: 'guides/rig-api' },
            { label: 'Raw API', slug: 'guides/raw-api' },
            { label: 'React hooks', slug: 'guides/react' },
            { label: 'Node and Electron', slug: 'guides/node' },
            { label: 'Supported rigs', slug: 'guides/rigs' },
            { label: 'Troubleshooting', slug: 'guides/troubleshooting' },
            { label: 'Licensing', slug: 'guides/licensing' },
          ],
        },
        typeDocSidebarGroup,
      ],
    }),
    react(),
    hamlibLicensing(),
  ],
  vite: {
    /* hamlib-wasm is a linked workspace package: pre-bundling it in dev would
     * break its `new URL(..., import.meta.url)` wasm lookup. */
    optimizeDeps: { exclude: ['hamlib-wasm'] },
    define: {
      __REPOSITORY_URL__: JSON.stringify(repositoryUrl ?? null),
      __DEMO_DOWNLOAD__: JSON.stringify(measureDemoDownload()),
      __CATALOGUE__: JSON.stringify(await readCatalogue()),
    },
  },
  /* Bind explicitly: `localhost` resolves to ::1 on Node 17+.  `astro dev` and
   * `astro preview` share this; the package scripts pass their own ports. */
  server: { host: '127.0.0.1', port: 4176 },
});
