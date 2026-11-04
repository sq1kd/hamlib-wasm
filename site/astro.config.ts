import react from '@astrojs/react';
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';

import { hamlibLicensing } from './integrations/licensing';
import { measureDemoDownload } from './integrations/demo-size';

/*
 * Where the site is served from.
 *
 * GitHub Pages serves a project site at https://<owner>.github.io/<repo>/, and
 * the Actions runner exports GITHUB_REPOSITORY=<owner>/<repo>, so a Pages build
 * needs no configuration.  SITE_URL / SITE_BASE override either half; a local
 * build without them is served from the root.
 */
const repository = process.env.SITE_REPOSITORY ?? process.env.GITHUB_REPOSITORY;
const [owner, repo] = repository?.split('/') ?? [];
const site = process.env.SITE_URL ?? (owner === undefined ? undefined : `https://${owner}.github.io`);
const base = process.env.SITE_BASE ?? (repo === undefined ? '/' : `/${repo}/`);
const repositoryUrl = repository === undefined ? undefined : `https://github.com/${repository}`;

export default defineConfig({
  ...(site === undefined ? {} : { site }),
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
      customCss: ['./src/styles/site.css'],
      plugins: [
        starlightTypeDoc({
          entryPoints: [
            '../packages/hamlib-wasm/src/index.ts',
            '../packages/hamlib-wasm/src/hamlib.ts',
            '../packages/hamlib-wasm/src/react.ts',
            '../packages/hamlib-wasm/src/node.ts',
          ],
          tsconfig: '../packages/hamlib-wasm/tsconfig.json',
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
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Easy API', slug: 'guides/easy' },
            { label: '1:1 Hamlib API', slug: 'guides/hamlib' },
            { label: 'React hooks', slug: 'guides/react' },
            { label: 'Node and Electron', slug: 'guides/node' },
            { label: 'Supported rigs', slug: 'guides/rigs' },
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
    },
  },
  /* Bind explicitly: `localhost` resolves to ::1 on Node 17+.  `astro dev` and
   * `astro preview` share this; the package scripts pass their own ports. */
  server: { host: '127.0.0.1', port: 4176 },
});
