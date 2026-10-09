<script setup lang="ts">
import { useToasts } from '@/composables/useToasts';
import { useLoader } from '@/composables/useLoader';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { formatBytes, formatPercent, formatDate, formatList, formatVersion } from '@opennavo/shared';
import { OnAppIcon, OnButton, OnChip, OnEmpty, OnMenu, OnPageHeader, OnSearchField, OnTable } from '@opennavo/ui';
import type { OnChipTone, OnTableColumn, OnTableSort } from '@opennavo/ui';
import UninstallConfirm from '@/components/package/UninstallConfirm.vue';
import type { InstalledItem } from '@/ipc/bindings';
import { packageKey } from '@/ipc/client';
import { useAppLocale } from '@/composables/useAppLocale';
import { usePackageIdentity } from '@/composables/usePackageIdentity';
import { usePackageMenu } from '@/composables/usePackageMenu';
import { useLibraryStore, useTasksStore, useUpdatesStore } from '@/stores';

// Installed (mockup 06, 06 §6.7): name filtering, sortable table; apps only (ADR-018, store filters command-line tools); de-emphasize dependencies.
const { t } = useI18n();
const { appLocale } = useAppLocale();
const router = useRouter();
const library = useLibraryStore();
const updates = useUpdatesStore();
const tasks = useTasksStore();
const { displayName, icon } = usePackageIdentity();
const menu = usePackageMenu();

const filter = ref('');
const sort = ref<OnTableSort>({ key: 'size', order: 'desc' });

const totalBytes = computed(() => library.items.reduce((total, item) => total + (item.sizeBytes ?? 0), 0));

interface Status {
  label: string;
  tone: OnChipTone;
  icon?: string;
}

function statusOf(item: InstalledItem): Status {
  const task = tasks.forPackage(item.kind, item.token);
  if (task?.state === 'running')
    return {
      label:
        task.percent === null
          ? t('library.status.runningUnknown')
          : t('library.status.running', {
              percent: formatPercent((task.percent ?? 0) / 100, { locale: appLocale.value })
            }),
      tone: 'coral'
    };
  if (task?.state === 'queued') return { label: t('library.status.queued'), tone: 'neutral' };
  if (item.pinned) return { label: t('library.status.pinned'), tone: 'neutral', icon: 'pin' };
  if (updates.find(item.kind, item.token)) return { label: t('library.status.outdated'), tone: 'accent' };
  if (item.status === 'self_updated') return { label: t('library.status.latest'), tone: 'success' };
  if (item.status === 'unknown') return { label: t('library.status.unknown'), tone: 'neutral' };
  return { label: t('library.status.latest'), tone: 'success' };
}

const rows = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = library.items.filter(
    item => !q || item.token.includes(q) || displayName(item.kind, item.token).toLowerCase().includes(q)
  );
  const direction = sort.value.order === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(appLocale.value);
  const compare: Record<string, (a: InstalledItem, b: InstalledItem) => number> = {
    name: (a, b) => collator.compare(displayName(a.kind, a.token), displayName(b.kind, b.token)),
    size: (a, b) => (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1),
    installedAt: (a, b) => (a.installedAt ?? 0) - (b.installedAt ?? 0)
  };
  const by = compare[sort.value.key] ?? compare.name;
  return [...list].sort((a, b) => (by ? by(a, b) * direction : 0));
});

const columns = computed<OnTableColumn[]>(() => [
  { key: 'name', label: t('library.columns.name'), sortable: true },
  { key: 'version', label: t('library.columns.version'), mono: true, width: '130px' },
  { key: 'size', label: t('library.columns.size'), numeric: true, sortable: true, width: '96px' },
  { key: 'installedAt', label: t('library.columns.installedAt'), sortable: true, width: '120px' },
  { key: 'status', label: t('library.columns.status'), width: '140px' },
  { key: 'actions', label: t('library.columns.actions'), hideLabel: true, width: '48px' }
]);

function secondary(item: InstalledItem): string {
  if (!item.onRequest && item.requiredBy.length)
    return t('library.dependency', { names: formatList(item.requiredBy, { locale: appLocale.value }) });
  return item.token;
}

const select = (item: InstalledItem, key: string) =>
  menu.select(item.kind, item.token, displayName(item.kind, item.token), key);
const toasts = useToasts();
useLoader(() => library.load());
async function refreshInstalled() {
  try {
    await library.refresh();
    await library.loadStorage();
  } catch {
    toasts.push({ tone: 'danger', title: t('errors.actionFailed') });
  }
}
</script>

<template>
  <div>
    <OnPageHeader
      :title="t('library.title')"
      :subtitle="
        t(
          'library.summary',
          { count: library.items.length, size: formatBytes(totalBytes, { locale: appLocale }) },
          { plural: library.items.length }
        )
      "
    >
      <template #actions>
        <OnButton variant="secondary" icon="refresh-cw" :loading="library.refreshing" @click="refreshInstalled">
          {{ t('library.refresh') }}
        </OnButton>
      </template>
    </OnPageHeader>

    <div class="mb-16px flex flex-wrap items-center gap-14px">
      <OnSearchField v-model="filter" class="ml-auto w-280px" :placeholder="t('library.filterPlaceholder')" clearable />
    </div>

    <OnTable
      v-if="rows.length"
      v-model:sort="sort"
      :columns="columns"
      :rows="rows"
      :row-key="item => packageKey(item.kind, item.token)"
      :dimmed="item => !item.onRequest"
      :caption="t('library.title')"
      @row-click="(_, item) => router.push(`/package/cask/${item.token}`)"
    >
      <template #cell-name="{ row }">
        <span class="flex min-w-0 items-center gap-10px">
          <OnAppIcon v-bind="icon(row.kind, row.token)" :size="28" />
          <span class="min-w-0">
            <span class="block truncate text-13px font-600 text-ink-primary">{{
              displayName(row.kind, row.token)
            }}</span>
            <span class="block truncate text-11.5px text-ink-tertiary">{{ secondary(row) }}</span>
          </span>
        </span>
      </template>
      <template #cell-version="{ row }">{{ formatVersion(row.actualVersion ?? row.installedVersion) }}</template>
      <template #cell-size="{ row }">{{
        row.sizeBytes === null ? '—' : formatBytes(row.sizeBytes, { locale: appLocale })
      }}</template>
      <template #cell-installedAt="{ row }">
        {{ row.installedAt ? formatDate(row.installedAt, { locale: appLocale }) : '—' }}
      </template>
      <template #cell-status="{ row }">
        <OnChip :tone="statusOf(row).tone" :icon="statusOf(row).icon" :dot="!statusOf(row).icon">{{
          statusOf(row).label
        }}</OnChip>
      </template>
      <template #cell-actions="{ row }">
        <span @click.stop>
          <OnMenu
            :items="
              menu.itemsFor(row.kind, row.token, { open: true, update: Boolean(updates.find(row.kind, row.token)) })
            "
            :label="t('package.actions.label')"
            variant="ghost"
            size="sm"
            @select="key => select(row, key)"
          />
        </span>
      </template>
    </OnTable>
    <OnEmpty
      v-else-if="library.loaded"
      :title="library.items.length ? t('library.emptyFiltered') : t('library.empty')"
      icon="lucide:package"
    />

    <UninstallConfirm
      v-model:open="menu.uninstall.open"
      v-model:zap="menu.uninstall.zap"
      :kind="menu.uninstall.kind"
      :token="menu.uninstall.token"
      :name="menu.uninstall.name"
      @confirm="menu.confirmUninstall"
    />
  </div>
</template>
