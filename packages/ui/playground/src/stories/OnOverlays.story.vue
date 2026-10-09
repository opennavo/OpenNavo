<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  OnButton,
  OnCommandPalette,
  OnConfirm,
  OnMenu,
  OnModal,
  OnSheet,
  OnToast,
  OnToastRegion,
  createToastQueue
} from '../../../src';
import type { OnCommandGroup, OnCommandItem, OnMenuItem } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const modalOpen = ref(false);
const confirmOpen = ref(false);
const dangerOpen = ref(false);
const sheetOpen = ref(false);
const paletteOpen = ref(false);
const query = ref('dock');
const last = ref('—');

const toasts = createToastQueue();

const menuItems: OnMenuItem[] = [
  { key: 'finder', label: 'Show in Finder', icon: 'folder' },
  { key: 'copy', label: 'Copy installation command', icon: 'copy', shortcut: '⌘C' },
  { key: 'homepage', label: 'Visit homepage', icon: 'arrow-up-right' },
  { key: 'pin', label: 'Pin version', icon: 'pin' },
  { key: 'ignore', label: 'Ignore this version', icon: 'x', disabled: true },
  { key: 'uninstall', label: 'Uninstall', icon: 'trash', danger: true, separator: true }
];

// Command-K example from mockup 07-minis.
const apps: OnCommandItem[] = [
  {
    key: 'docker-desktop',
    label: 'Docker Desktop',
    description: 'App · Installed 4.92.1',
    app: { kind: 'cask', token: 'docker-desktop', name: 'Docker Desktop', accent: '#1D63ED' },
    badge: 'Update available',
    hint: '↵ Open'
  },
  {
    key: 'docker',
    label: 'docker',
    description: 'Command line · container engine client',
    app: { kind: 'formula', token: 'docker', name: 'docker' },
    hint: '⌘↵ Install'
  },
  {
    key: 'docker-compose',
    label: 'docker-compose',
    description: 'Command line · multi-container orchestration',
    app: { kind: 'formula', token: 'docker-compose', name: 'docker-compose' }
  }
];
const actions: OnCommandItem[] = [
  {
    key: 'update',
    label: 'Updates Docker Desktop',
    description: '4.92.1 → 4.93.0',
    icon: 'refresh-cw',
    iconTone: 'accent'
  },
  { key: 'reveal', label: 'Show in Finder Docker.app', icon: 'folder' }
];

const groups = computed<OnCommandGroup[]>(() => {
  const q = query.value.trim().toLowerCase();
  const match = (item: OnCommandItem) => !q || item.label.toLowerCase().includes(q);
  return [
    { key: 'apps', label: 'Apps and tools', items: apps.filter(match) },
    { key: 'actions', label: 'Actions', items: actions.filter(match) }
  ];
});

function onSelect(item: OnCommandItem, { meta }: { meta: boolean }) {
  last.value = `${meta ? '⌘↵' : '↵'} ${item.label}`;
  paletteOpen.value = false;
}

function pushToast(kind: 'success' | 'danger' | 'info') {
  if (kind === 'success')
    toasts.push({ tone: 'success', title: 'Updated Visual Studio Code', description: '1.139.1 → 1.140.0' });
  else if (kind === 'danger')
    toasts.push({
      tone: 'danger',
      title: 'Failed to update Docker Desktop',
      description: 'Installation requires administrator privileges and was canceled outside the terminal.',
      actionLabel: 'View',
      duration: 0
    });
  else toasts.push({ tone: 'info', title: 'Copied', description: 'brew install --cask visual-studio-code' });
}
</script>

<template>
  <StorySection
    title="OnModal / OnConfirm / OnSheet / OnToast / OnMenu / OnCommandPalette"
    spec="08 §8.22–§8.26"
    description="Overlays mount on body, move focus inside on open, trap Tab, and restore focus on close. Escape closes them except for destructive confirmations."
  >
    <StoryRow label="Dialogs">
      <OnButton @click="modalOpen = true">Open dialog</OnButton>
      <OnButton @click="confirmOpen = true">Deep-link installation confirmation</OnButton>
      <OnButton variant="danger" @click="dangerOpen = true">Uninstall confirmation</OnButton>
      <OnButton @click="sheetOpen = true">Log sheet</OnButton>
    </StoryRow>
    <StoryRow label="Menu">
      <OnMenu :items="menuItems" @select="last = $event" />
      <OnMenu
        :items="menuItems"
        align="start"
        variant="ghost"
        size="sm"
        label="More (left aligned)"
        @select="last = $event"
      />
      <span class="text-caption text-ink-tertiary">Last action: {{ last }}</span>
    </StoryRow>
    <StoryRow label="Command palette">
      <OnButton icon="command" @click="paletteOpen = true">Open command palette</OnButton>
    </StoryRow>
    <StoryRow label="Notifications">
      <div class="flex flex-col gap-10px">
        <OnToast tone="success" title="Updated Visual Studio Code" description="1.139.1 → 1.140.0" time="Now" />
        <OnToast
          tone="danger"
          title="Failed to update Docker Desktop"
          description="Installation requires administrator privileges and was canceled outside the terminal."
          action-label="View"
        />
        <OnToast tone="warning" title="Homebrew needs an update" description="Currently 4.4.0; run brew update." />
      </div>
      <div class="flex gap-8px">
        <OnButton size="sm" @click="pushToast('success')">Success</OnButton>
        <OnButton size="sm" @click="pushToast('danger')">Failure</OnButton>
        <OnButton size="sm" @click="pushToast('info')">Copy</OnButton>
      </div>
    </StoryRow>

    <OnModal
      v-model:open="modalOpen"
      title="Report a problem"
      description="Describe the problem and we will respond within three business days."
    >
      <p class="m-0">Package: Visual Studio Code (visual-studio-code)</p>
      <template #footer>
        <OnButton variant="ghost" @click="modalOpen = false">Cancel</OnButton>
        <OnButton variant="primary" @click="modalOpen = false">Submit</OnButton>
      </template>
    </OnModal>
    <OnConfirm
      v-model:open="confirmOpen"
      title="Install Ghostty in OpenNavo?"
      description="Installation request from the web; runs brew install --cask ghostty."
      confirm-label="Install"
      @confirm="confirmOpen = false"
    />
    <OnConfirm
      v-model:open="dangerOpen"
      tone="danger"
      title="Uninstall Docker Desktop？"
      description="Quits the app and removes /Applications/Docker.app while preserving preferences."
      confirm-label="Uninstall"
      @confirm="dangerOpen = false"
    />
    <OnSheet v-model:open="sheetOpen" title="Update Docker Desktop · Log">
      <pre class="m-0 whitespace-pre-wrap font-mono text-12px leading-[1.6] text-ink-secondary">
==> Downloading https://desktop.docker.com/mac/main/arm64/Docker.dmg
==> Upgrading docker-desktop
==> Purging files for version 4.92.1 of Cask docker-desktop
🍺  docker-desktop was successfully upgraded!</pre
      >
      <template #footer>
        <OnButton variant="ghost" icon="copy">Copy all</OnButton>
      </template>
    </OnSheet>
    <OnCommandPalette
      v-model:open="paletteOpen"
      v-model:query="query"
      :groups="groups"
      @select="onSelect"
      @copy="last = `⌘C ${$event.label}`"
    />
    <OnToastRegion :items="toasts.items.value" @dismiss="toasts.dismiss" @action="last = `View ${$event}`" />
  </StorySection>
</template>
