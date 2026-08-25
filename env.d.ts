/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Filled in at build time by the primitiveEnv() plugin from the selected
  // Primitive environment in .primitive/config.json — do not author these in
  // a .env file.
  readonly VITE_APP_ID: string;
  readonly VITE_API_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_APP_NAME?: string;
  /** Which Primitive environment this build resolved. */
  readonly VITE_PRIMITIVE_ENV?: string;

  // App behavior, authored in .env / .env.<mode>.
  /**
   * Opt-in: the Primitive environment this mode is meant to run against. A run
   * that resolves a different one fails at startup.
   */
  readonly VITE_EXPECTED_PRIMITIVE_ENV?: string;
  readonly VITE_OAUTH_REDIRECT_URI: string;
  readonly VITE_ENABLE_AUTH_PROXY?: string;
  readonly VITE_LOG_LEVEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  >;
  export default component;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.toml?raw" {
  const content: string;
  export default content;
}
