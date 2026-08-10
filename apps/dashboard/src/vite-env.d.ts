/// <reference types="vite/client" />

/** The `VITE_*` vars documented in `.env.example`. All optional — every read
    site carries a default so a missing `.env` never breaks the dashboard. */
interface ImportMetaEnv {
  readonly VITE_HEALTHSCAN_BASE_URL?: string;
  readonly VITE_POLL_INTERVAL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
