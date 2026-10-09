<script setup lang="ts">
import type { NuxtError } from '#app';
import { OnButton } from '@opennavo/ui';

const props = defineProps<{ error: NuxtError }>();

const { t } = useI18n();
const localePath = useLocalePath();

const notFound = computed(() => props.error.statusCode === 404);
const requestId = computed(() => {
  const data = props.error.data as { requestId?: string } | undefined;
  return data?.requestId;
});

useSeoMeta({ title: () => (notFound.value ? t('error.notFoundTitle') : t('error.serverTitle')), robots: 'noindex' });

function goHome() {
  clearError({ redirect: localePath('/') });
}
</script>

<template>
  <NuxtLayout>
    <section class="mx-auto flex max-w-560px flex-col items-center gap-14px px-24px py-96px text-center">
      <span class="text-hero text-ink-disabled">{{ error.statusCode }}</span>
      <h1 class="m-0 text-title1 text-ink-primary">
        {{ notFound ? t('error.notFoundTitle') : t('error.serverTitle') }}
      </h1>
      <p class="m-0 text-body text-ink-secondary">{{ notFound ? t('error.notFoundBody') : t('error.serverBody') }}</p>
      <p v-if="requestId" class="m-0 text-caption text-ink-tertiary">{{ t('error.requestId', { id: requestId }) }}</p>
      <div class="mt-10px flex gap-12px">
        <OnButton variant="primary" shape="round" @click="goHome">{{ t('error.backHome') }}</OnButton>
      </div>
    </section>
  </NuxtLayout>
</template>
