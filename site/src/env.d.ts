/** The GitHub repository URL, or null when the build does not know it. */
declare const __REPOSITORY_URL__: string | null;

/** Bytes the live demo's Hamlib module costs; see integrations/demo-size.ts. */
declare const __DEMO_DOWNLOAD__: {
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
};
