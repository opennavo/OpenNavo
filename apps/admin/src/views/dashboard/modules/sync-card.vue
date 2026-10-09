<script setup lang="ts">
import { computed } from 'vue';
import { formatCount, formatRelativeTime } from '@opennavo/shared';
import type { DataOf } from '@/typings/api/opennavo';
import { useAppStore } from '@/store/modules/app';
import { $t } from '@/locales';

defineOptions({ name: 'SyncCard' });

const props = defineProps<{
  jobs: DataOf<'getDashboardOverview'>['jobs'];
  snapshot: DataOf<'getDashboardOverview'>['snapshot'];
}>();

const appStore = useAppStore();

// Late after three unfinished intervals (03 §16: catalog every 15 minutes, installs daily, snapshots hourly).
const LATE_AFTER = { catalog: 45 * 60_000, analytics: 30 * 3_600_000, snapshot: 3 * 3_600_000 } as const;
type SyncKey = keyof typeof LATE_AFTER;

const rows = computed(() => {
  const times: Record<SyncKey, string | null | undefined> = {
    catalog: props.jobs.lastCatalogSyncAt,
    analytics: props.jobs.lastAnalyticsSyncAt,
    snapshot: props.jobs.lastSnapshotAt
  };
  return (Object.keys(LATE_AFTER) as SyncKey[]).map(key => {
    const at = times[key];
    const state = !at ? 'never' : Date.now() - new Date(at).getTime() > LATE_AFTER[key] ? 'late' : 'ok';
    return {
      key,
      label: $t(`page.dashboard.syncItems.${key}`),
      every: $t(`page.dashboard.syncEvery.${key}`),
      time: at ? formatRelativeTime(at, { locale: appStore.locale }) : '',
      state,
      tag: state === 'ok' ? 'success' : 'warning'
    } as const;
  });
});
</script>

<template>
  <NCard :bordered="false" size="small" class="card-wrapper h-full" :title="$t('page.dashboard.sync')">
    <ul class="m-0 flex-col gap-12px p-0">
      <li v-for="row in rows" :key="row.key" class="flex items-center gap-8px">
        <span class="min-w-0 flex-1">
          <span class="block text-13px">{{ row.label }}</span>
          <NText depth="3" class="block text-12px">
            {{ row.every }}
            <template v-if="row.time">· {{ row.time }}</template>
          </NText>
        </span>
        <NTag :type="row.tag" size="small" :bordered="false">{{ $t(`page.dashboard.syncState.${row.state}`) }}</NTag>
      </li>
    </ul>
    <NText depth="3" tag="p" class="m-0 mt-8px text-12px">
      {{
        $t(
          'page.dashboard.snapshotInfo',
          { cursor: snapshot.cursor, count: formatCount(snapshot.itemCount, { locale: appStore.locale }) },
          { plural: snapshot.itemCount }
        )
      }}
    </NText>
    <NDivider class="my-12px!" />
    <div class="flex flex-wrap items-center justify-between gap-8px">
      <span class="min-w-0 text-13px">{{ $t('page.dashboard.failed24h') }}</span>
      <RouterLink to="/ops/job" class="flex shrink-0 items-center gap-8px">
        <span class="whitespace-nowrap text-20px font-600 tabular-nums" :class="jobs.failed24h ? 'text-error' : ''">
          {{ formatCount(jobs.failed24h, { locale: appStore.locale }) }}
        </span>
        <span class="text-12px text-primary">{{ $t('page.dashboard.viewJobs') }} →</span>
      </RouterLink>
    </div>
  </NCard>
</template>
