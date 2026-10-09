<script setup lang="ts">
import { useAppLocale as useFormattingLocale } from '@/composables/useAppLocale';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatBytes } from '@opennavo/shared';
import { OnButton, OnCard, OnChip, OnRailPanel, OnRailSection, OnStackBar } from '@opennavo/ui';
import BrewfileRestore from '@/components/library/BrewfileRestore.vue';
import type { BrewfilePreview, DoctorReport } from '@/ipc/bindings';
import { commands, unwrap } from '@/ipc/client';
import { usePackageState } from '@/composables/usePackageState';
import { useLoader } from '@/composables/useLoader';
import { useToasts } from '@/composables/useToasts';
import { useLibraryStore, useTasksStore } from '@/stores';
import { pickOpenPath, pickSavePath } from '@/utils/files';

const { appLocale: formattingLocale } = useFormattingLocale();

// Installed rail (mockup 06): storage breakdown, cleanup, Brewfile backup/migration, brew doctor health checks.
const { t } = useI18n();
const library = useLibraryStore();
const tasks = useTasksStore();
const toasts = useToasts();
const { errorText } = usePackageState();

const doctor = ref<DoctorReport | null>(null);
const doctorRunning = ref(false);
const restoreOpen = ref(false);
const preview = ref<BrewfilePreview | null>(null);

async function attempt<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    toasts.push({ tone: 'danger', title: t('errors.actionFailed'), description: errorText(error) });
    return undefined;
  }
}

useLoader(() => library.loadStorage(), [() => tasks.finished], undefined, []);
const { data: estimate } = useLoader(() => unwrap(commands.cleanupEstimate()), [() => tasks.finished], undefined, []);

const storage = computed(() => library.storage);
// Cask-only catalog (ADR-018): storage includes apps/download cache, excluding command-line tools.
const total = computed(() => (storage.value ? storage.value.appsBytes + storage.value.cacheBytes : 0));
const parts = computed(() =>
  storage.value
    ? [
        {
          key: 'apps',
          label: t('library.storage.apps'),
          value: storage.value.appsBytes,
          display: formatBytes(storage.value.appsBytes, { locale: formattingLocale.value })
        },
        {
          key: 'cache',
          label: t('library.storage.cache'),
          value: storage.value.cacheBytes,
          display: formatBytes(storage.value.cacheBytes, { locale: formattingLocale.value })
        }
      ]
    : []
);
const reclaimable = computed(() => estimate.value?.bytes ?? storage.value?.cacheBytes ?? 0);

async function cleanup() {
  await attempt(tasks.enqueue('cleanup', null));
}

async function exportBrewfile() {
  const path = await pickSavePath('Brewfile');
  if (!path) return;
  const count = await attempt(unwrap(commands.brewfileExport(path, null)));
  if (count !== undefined)
    toasts.push({ tone: 'success', title: t('library.backup.exported', { count }, { plural: count }) });
}

async function restoreBrewfile() {
  const path = await pickOpenPath();
  if (!path) return;
  const result = await attempt(unwrap(commands.brewfilePreview(path)));
  if (!result) return;
  preview.value = result;
  restoreOpen.value = true;
}

async function runDoctor() {
  doctorRunning.value = true;
  doctor.value = (await attempt(unwrap(commands.doctorRun()))) ?? doctor.value;
  doctorRunning.value = false;
}
</script>

<template>
  <OnRailPanel>
    <OnRailSection
      :title="t('library.storage.title')"
      :subtitle="t('library.storage.total', { size: storage ? formatBytes(total, { locale: formattingLocale }) : '—' })"
    >
      <OnCard padding="md">
        <p class="m-0 mb-12px text-26px font-600 leading-none text-ink-primary">
          {{ storage ? formatBytes(total, { locale: formattingLocale }) : '—' }}
        </p>
        <OnStackBar v-if="parts.length" :items="parts" :caption="t('library.storage.caption')" :format="formatBytes" />
      </OnCard>
    </OnRailSection>

    <OnCard padding="md" class="flex flex-col gap-10px">
      <h2 class="m-0 text-14px font-600 text-ink-primary">{{ t('library.cleanup.title') }}</h2>
      <p class="m-0 text-12.5px leading-[1.55] text-ink-tertiary">{{ t('library.cleanup.description') }}</p>
      <OnButton variant="secondary" icon="trash" :disabled="!reclaimable" @click="cleanup">
        {{
          reclaimable
            ? t('library.cleanup.button', { size: formatBytes(reclaimable, { locale: formattingLocale }) })
            : t('library.cleanup.none')
        }}
      </OnButton>
    </OnCard>

    <OnCard padding="md" class="flex flex-col gap-10px">
      <h2 class="m-0 text-14px font-600 text-ink-primary">{{ t('library.backup.title') }}</h2>
      <p class="m-0 text-12.5px leading-[1.55] text-ink-tertiary">{{ t('library.backup.description') }}</p>
      <div class="flex flex-wrap gap-8px">
        <OnButton
          class="max-w-full flex-1 !h-auto min-h-34px py-6px"
          variant="secondary"
          icon="cloud"
          @click="exportBrewfile"
        >
          <span class="min-w-0 whitespace-normal break-words">{{ t('library.backup.export') }}</span>
        </OnButton>
        <OnButton class="max-w-full flex-1 !h-auto min-h-34px py-6px" variant="secondary" @click="restoreBrewfile">
          <span class="min-w-0 whitespace-normal break-words">{{ t('library.backup.restore') }}</span>
        </OnButton>
      </div>
    </OnCard>

    <OnCard padding="md" class="flex flex-col gap-10px">
      <div class="flex items-center justify-between gap-8px">
        <h2 class="m-0 text-14px font-600 text-ink-primary">{{ t('library.health.title') }}</h2>
        <OnChip v-if="doctor && doctor.warnings.length" tone="warning" icon="triangle-alert">
          {{ t('library.health.warnings', { count: doctor.warnings.length }, { plural: doctor.warnings.length }) }}
        </OnChip>
        <OnChip v-else-if="doctor" tone="success" icon="check">{{ t('library.health.ok') }}</OnChip>
      </div>
      <ul v-if="doctor?.warnings.length" class="m-0 flex list-none flex-col gap-6px p-0">
        <li
          v-for="(warning, index) in doctor.warnings"
          :key="index"
          class="text-12.5px leading-[1.5] text-ink-secondary"
        >
          {{ warning.title }}
        </li>
      </ul>
      <OnButton variant="secondary" icon="shield-check" :loading="doctorRunning" @click="runDoctor">
        {{ doctorRunning ? t('library.health.running') : t('library.health.run') }}
      </OnButton>
    </OnCard>

    <BrewfileRestore v-model:open="restoreOpen" :preview="preview" />
  </OnRailPanel>
</template>
