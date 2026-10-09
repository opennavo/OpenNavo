/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API URL; when unset, browser mode uses Prism (4010), otherwise the local backend. */
  readonly VITE_API_BASE?: string;
  /** Desktop version (X-Client-Version request header), injected by the release pipeline. */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
