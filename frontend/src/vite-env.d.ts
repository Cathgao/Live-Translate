/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SEGMENT_COMMIT_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}