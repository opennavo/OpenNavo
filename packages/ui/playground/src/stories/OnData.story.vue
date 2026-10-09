<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  OnAppIcon,
  OnCard,
  OnChip,
  OnHBarChart,
  OnLogViewer,
  OnMenu,
  OnProgressMeter,
  OnStackBar,
  OnTable,
  OnTaskCard
} from '../../../src';
import type { OnTableColumn, OnTableSort } from '../../../src';
import type { PackageKind } from '@opennavo/shared';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

// Running task from mockup 05-updates.
const taskLog = [
  'docker-desktop 4.92.1,239800 -> 4.93.0,240920',
  '==> Upgrading docker-desktop',
  '==> Downloading https://desktop.docker.com/mac/main/arm64/240920/Docker.dmg',
  '############################################               62.4%'
];
const logExpanded = ref(true);

const fullLog = Array.from({ length: 600 }, (_, index) =>
  index % 50 === 0
    ? `==> Step ${index / 50 + 1}`
    : index === 599
      ? '🍺  docker-desktop was successfully upgraded!'
      : `line ${index}`
);

// Installed list from mockup 06-library.
interface Installed {
  kind: PackageKind;
  token: string;
  name: string;
  subtitle: string;
  version: string;
  size: number;
  installedAt: string;
  status: 'updating' | 'outdated' | 'latest' | 'pinned';
  dependency?: boolean;
  accent?: string;
}

const installed: Installed[] = [
  {
    kind: 'cask',
    token: 'docker-desktop',
    name: 'Docker Desktop',
    subtitle: 'docker-desktop',
    version: '4.92.1',
    size: 2100,
    installedAt: '2025-12-03',
    status: 'updating',
    accent: '#1D63ED'
  },
  {
    kind: 'cask',
    token: 'google-chrome',
    name: 'Google Chrome',
    subtitle: 'google-chrome',
    version: '153.0.7982',
    size: 1400,
    installedAt: '2025-11-18',
    status: 'outdated',
    accent: '#4285F4'
  },
  {
    kind: 'cask',
    token: 'visual-studio-code',
    name: 'Visual Studio Code',
    subtitle: 'visual-studio-code',
    version: '1.139.1',
    size: 652,
    installedAt: '2026-03-02',
    status: 'outdated',
    accent: '#0A84FF'
  },
  {
    kind: 'cask',
    token: 'raycast',
    name: 'Raycast',
    subtitle: 'raycast',
    version: '2.6.1.2',
    size: 318,
    installedAt: '2025-08-21',
    status: 'pinned',
    accent: '#FF5F57'
  },
  {
    kind: 'formula',
    token: 'node',
    name: 'node',
    subtitle: 'JavaScript runtime',
    version: '26.9.0',
    size: 98,
    installedAt: '2026-09-12',
    status: 'outdated'
  },
  {
    kind: 'formula',
    token: 'ripgrep',
    name: 'ripgrep',
    subtitle: 'Faster searching than grep',
    version: '15.2.0',
    size: 6.1,
    installedAt: '2026-07-30',
    status: 'latest'
  },
  {
    kind: 'formula',
    token: 'pcre2',
    name: 'pcre2',
    subtitle: 'Dependency · used by ripgrep and git',
    version: '10.49',
    size: 4.2,
    installedAt: '2026-07-30',
    status: 'latest',
    dependency: true
  }
];

const columns: OnTableColumn[] = [
  { key: 'name', label: 'Name', sortable: true },
  { key: 'kind', label: 'Type', width: '88px' },
  { key: 'version', label: 'Version', mono: true },
  { key: 'size', label: 'Size', numeric: true, sortable: true },
  { key: 'installedAt', label: 'Installed on', sortable: true },
  { key: 'status', label: 'State' },
  { key: 'more', label: 'Actions', hideLabel: true, width: '44px' }
];

const sort = ref<OnTableSort>({ key: 'size', order: 'desc' });
const selected = ref<string | null>('visual-studio-code');

const sorted = computed(() => {
  const { key, order } = sort.value;
  const direction = order === 'asc' ? 1 : -1;
  return [...installed].sort((a, b) => {
    const left = a[key as keyof Installed] ?? '';
    const right = b[key as keyof Installed] ?? '';
    return (left > right ? 1 : left < right ? -1 : 0) * direction;
  });
});

function formatSize(megabytes: number) {
  return megabytes >= 1000 ? `${(megabytes / 1000).toFixed(1)} GB` : `${megabytes} MB`;
}

const STATUS = {
  updating: { label: 'Updating 62%', tone: 'coral' },
  outdated: { label: 'Update available', tone: 'accent' },
  latest: { label: 'Latest', tone: 'success' },
  pinned: { label: 'Pinned', tone: 'neutral' }
} as const;

const menu = [
  { key: 'finder', label: 'Show in Finder', icon: 'folder' },
  { key: 'uninstall', label: 'Uninstall', icon: 'trash', danger: true, separator: true }
];
</script>

<template>
  <StorySection
    title="OnTaskCard / OnProgressMeter / OnLogViewer / OnHBarChart / OnStackBar / OnTable"
    spec="08 §8.16、§8.17、§8.20、§8.21、§11"
    description="Task cards follow 05-updates; charts follow 03-detail and 06-library; tables use virtual scrolling above 200 rows."
  >
    <StoryRow label="Task cards">
      <div class="w-712px">
        <OnTaskCard
          v-model:log-expanded="logExpanded"
          title="Updating Docker Desktop"
          subtitle="4.92.1 → 4.93.0 · Step 2 of 4: Download"
          :pkg="{ kind: 'cask', token: 'docker-desktop', name: 'Docker Desktop', accent: '#1D63ED' }"
          :progress="62"
          transferred="372 MB"
          total="600 MB"
          speed="18.4 MB/s"
          remaining="About 13 seconds remaining"
          :log="taskLog"
          :queue="[
            { kind: 'formula', token: 'node', name: 'node' },
            { kind: 'formula', token: 'ffmpeg', name: 'ffmpeg' }
          ]"
          queue-note="brew runs one task at a time"
        />
      </div>
    </StoryRow>
    <StoryRow label="Progress bars">
      <div class="flex w-320px flex-col gap-12px">
        <OnProgressMeter :value="62" label="Download" />
        <OnProgressMeter label="Extract" />
        <OnProgressMeter :value="30" size="sm" label="Menu bar" />
      </div>
    </StoryRow>
    <StoryRow label="Full log">
      <OnLogViewer class="w-640px" :lines="fullLog" :height="180" />
    </StoryRow>
    <StoryRow label="Charts">
      <OnCard class="w-316px">
        <p class="m-0 text-headline text-ink-primary">Average monthly installs</p>
        <p class="m-0 mt-2px text-12px text-ink-tertiary">
          Recent installations are slowing; most existing users use the built-in updater.
        </p>
        <OnHBarChart
          class="mt-12px"
          caption="Average monthly installs"
          :items="[
            {
              key: '30d',
              label: 'Last 30 days',
              value: 17394,
              display: '17.4K',
              full: '17,394 installs',
              emphasis: true
            },
            { key: '90d', label: '90-day monthly average', value: 34210, display: '34.2K', full: '34,210 installs' },
            { key: '365d', label: 'Yearly monthly average', value: 40012, display: '40.0K', full: '40,012 installs' }
          ]"
        />
      </OnCard>
      <OnCard class="w-316px">
        <p class="m-0 text-stat text-ink-primary">18.6 <span class="text-13px text-ink-tertiary">GB</span></p>
        <OnStackBar
          class="mt-12px"
          caption="Storage usage"
          :items="[
            { key: 'app', label: 'App', value: 12.1, display: '12.1 GB' },
            { key: 'cli', label: 'Command line', value: 4.2, display: '4.2 GB' },
            { key: 'cache', label: 'Download cache', value: 2.3, display: '2.3 GB' }
          ]"
        />
      </OnCard>
    </StoryRow>
    <StoryRow label="Installed table">
      <OnTable
        v-model:sort="sort"
        class="w-full"
        caption="Installed"
        :columns="columns"
        :rows="sorted"
        :row-key="row => row.token"
        :selected-key="selected"
        :dimmed="row => Boolean(row.dependency)"
        @row-click="selected = $event"
      >
        <template #cell-name="{ row }">
          <span class="flex items-center gap-10px">
            <OnAppIcon :kind="row.kind" :token="row.token" :name="row.name" :accent="row.accent" :size="28" />
            <span class="min-w-0">
              <span class="block font-600 text-ink-primary">{{ row.name }}</span>
              <span class="block text-11px text-ink-tertiary">{{ row.subtitle }}</span>
            </span>
          </span>
        </template>
        <template #cell-kind="{ row }">
          <OnChip size="md">{{ row.kind === 'cask' ? 'App' : 'Command line' }}</OnChip>
        </template>
        <template #cell-size="{ row }">{{ formatSize(row.size) }}</template>
        <template #cell-status="{ row }">
          <OnChip :tone="STATUS[row.status].tone" dot size="md">{{ STATUS[row.status].label }}</OnChip>
        </template>
        <template #cell-more>
          <OnMenu :items="menu" variant="ghost" size="sm" />
        </template>
      </OnTable>
    </StoryRow>
  </StorySection>
</template>
