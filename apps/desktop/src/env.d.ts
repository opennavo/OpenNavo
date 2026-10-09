/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API URL; when unset, browser mode uses Prism (4010), otherwise the local backend. */
  readonly VITE_API_BASE?: string;
  /** Desktop version (X-Client-Version request header), injected by the release pipeline. */
  readonly VITE_APP_VERSION?: string;
  /** Development-only update-dialog preview; never enables downloads or installation. */
  readonly VITE_OPENNAVO_UPDATE_PREVIEW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
