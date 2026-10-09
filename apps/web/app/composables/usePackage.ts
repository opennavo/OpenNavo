import { ApiError, unwrap } from '@opennavo/api';
import { isValidToken } from '@opennavo/shared';
import type { PackageKind } from '@opennavo/shared';

/**
 * Detail data (05 §3): parent route and tabs share one key/request.
 * Invalid tokens or API 404 (missing/Homebrew-removed packages) render a 404 page.
 */
export async function usePackage(kind: PackageKind) {
  const { locale } = useI18n();
  const api = useApi();
  const route = useRoute();
  const token = computed(() => String(route.params.token ?? ''));

  if (!isValidToken(token.value))
    throw createError({ statusCode: 404, statusMessage: 'Package not found', fatal: true });

  const result = await useAsyncData(
    () => `package:${kind}:${token.value}:${locale.value}`,
    () =>
      unwrap(api.GET('/packages/{kind}/{token}', { params: { path: { kind, token: token.value } } })).catch(
        (error: unknown) => {
          // Convert business 404s into page 404s; other errors remain retryable page states.
          if (error instanceof ApiError && (error.isNotFound || error.status === 404))
            throw createError({ statusCode: 404, statusMessage: 'Package not found' });
          throw error;
        }
      )
  );

  if (result.error.value?.statusCode === 404)
    throw createError({ statusCode: 404, statusMessage: 'Package not found', fatal: true });

  return { ...result, token };
}
