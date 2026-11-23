export const frontendEnv = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? '',
  appName: 'PulseQueue',
} as const;
