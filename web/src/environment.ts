function required(name: string, value: string | undefined): string {
  if (!value) {
    console.warn(`[environment] Missing ${name} — set it in web/.env.local (see .env.example).`);
  }
  return value ?? '';
}

export const env = {
  applicationName: import.meta.env.VITE_APPLICATION_NAME || 'Doctor Robbie',
  partnerGuid: required('VITE_DRAGON_PARTNER_GUID', import.meta.env.VITE_DRAGON_PARTNER_GUID),
  dragonMedicalServer: {
    url: required('VITE_DRAGON_MEDICAL_SERVER_URL', import.meta.env.VITE_DRAGON_MEDICAL_SERVER_URL),
    scope: required('VITE_DRAGON_MEDICAL_SERVER_SCOPE', import.meta.env.VITE_DRAGON_MEDICAL_SERVER_SCOPE),
  },
  environmentId: import.meta.env.VITE_DRAGON_ENVIRONMENT_ID || undefined,
  entra: {
    clientId: required('VITE_ENTRA_CLIENT_ID', import.meta.env.VITE_ENTRA_CLIENT_ID),
    tenantId: required('VITE_ENTRA_TENANT_ID', import.meta.env.VITE_ENTRA_TENANT_ID),
  },
};
