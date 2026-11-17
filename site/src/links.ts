/** URLs the content pages build, base-path aware. */

/** The GitHub repository, when the build knows it (see astro.config.ts). */
export const REPOSITORY_URL: string | null = __REPOSITORY_URL__;

/** A file the site itself serves, under the configured `base`. */
export function served(path: string): string {
  const base = import.meta.env.BASE_URL;

  return `${base.endsWith('/') ? base : `${base}/`}${path}`;
}

/** A file in the repository on GitHub, or the copy the site serves. */
export function repositoryFile(path: string, fallback: string): string {
  return REPOSITORY_URL === null ? served(fallback) : `${REPOSITORY_URL}/blob/main/${path}`;
}

/** A page of the repository on GitHub; no href when the build has no repository. */
export function repositoryPage(path: string): string | undefined {
  return REPOSITORY_URL === null ? undefined : `${REPOSITORY_URL}${path}`;
}
