<script setup lang="ts">
import { computed } from 'vue';
import { formatDate } from '~/utils/packageDate';
import { OnChip } from '@opennavo/ui';
import { officialDownload } from '~/utils/packageFacts';
import type { PackagePage } from '~/utils/packageFacts';
const props = defineProps<{ pkg: PackagePage }>();
const { t, locale } = useI18n();
const appLocale = computed(() => toAppLocale(locale.value));
const download = computed(() => officialDownload(props.pkg));
</script>

<template>
  <details v-if="download" class="group flex flex-col items-start">
    <summary
      class="cursor-pointer list-none rounded-small outline-none focus-visible:shadow-focus-ring [&::-webkit-details-marker]:hidden"
      :title="t('package.verifiedDetails')"
    >
      <OnChip tone="success" icon="shield-check">{{ t('package.verified') }}</OnChip>
    </summary>
    <div class="mt-6px flex flex-col items-start gap-4px">
      <a
        :href="download.url"
        rel="nofollow noopener noreferrer"
        class="rounded-default text-12px text-ink-secondary underline-offset-2 hover:underline focus-visible:shadow-focus-ring"
        >{{ t('package.officialDownload.label', { host: download.host }) }}</a
      >
      <p
        v-if="download.checksum || download.active || download.checkedAt"
        class="m-0 max-w-320px text-11px text-ink-tertiary"
      >
        <template v-if="download.checksum">{{ t('package.officialDownload.checksum') }} · </template>
        <template v-if="download.active">{{ t('package.officialDownload.active') }}</template>
        <template v-if="download.checkedAt">
          · {{ t('package.price.checked') }}
          <time :datetime="download.checkedAt">{{ formatDate(download.checkedAt, { locale: appLocale }) }}</time>
        </template>
      </p>
    </div>
  </details>
</template>
