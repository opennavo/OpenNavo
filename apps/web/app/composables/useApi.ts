import type { PublicClient } from '@opennavo/api';

/** Injected public API client. */
export function useApi(): PublicClient {
  return useNuxtApp().$api;
}
