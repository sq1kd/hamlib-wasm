import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  /* Starlight always reads the i18n collection, and Astro warns on every
   * build when it is missing or empty.  The site is English-only with no UI
   * string overrides, so it holds one empty entry: Starlight's defaults. */
  i18n: defineCollection({ loader: () => [{ id: 'en' }], schema: i18nSchema() }),
};
