/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APPLICATION_NAME: string;
  readonly VITE_DRAGON_PARTNER_GUID: string;
  readonly VITE_DRAGON_MEDICAL_SERVER_URL: string;
  readonly VITE_DRAGON_MEDICAL_SERVER_SCOPE: string;
  readonly VITE_DRAGON_ENVIRONMENT_ID: string;
  readonly VITE_ENTRA_CLIENT_ID: string;
  readonly VITE_ENTRA_TENANT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
