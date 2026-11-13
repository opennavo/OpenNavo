<script setup lang="ts">
// Profile switcher for the right rail: one row per profile so the name is readable, which
// the old horizontal avatar strip could not do (two-letter chips plus a tooltip).
import { computed, nextTick, ref } from 'vue';
import { OnIcon, OnRailSection } from '@opennavo/ui';
import { useHermesStore } from '@/stores/hermes';
import { useHermesUiStore } from '@/stores/hermesUi';
import { useHermesContent } from '@/composables/useHermesContent';

const store = useHermesStore();
const ui = useHermesUiStore();
const content = useHermesContent();
// Only the active connection's profiles: switching connection switches this list, which
// matches what the chat actually talks to.
const profiles = computed(() => store.agentProfiles);
const total = computed(() => profiles.value.length);
const menuProfile = ref<string | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuStyle = ref({ left: '0px', top: '0px' });
const swatches = ['#8f86ff', '#57c98a', '#e8b45a', '#ff7356', '#5aa9e8', '#d58cff'];

function color(name: string) {
  const custom = store.profileColors[name];
  if (custom) return custom;
  if (name === 'default') return '#2b2b2b';
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 58% 58%)`;
}

function label(profile: { name: string; displayName: string | null }) {
  return profile.displayName || profile.name;
}

function short(profile: { name: string; displayName: string | null }) {
  const value = label(profile).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '');
  return value.slice(0, 2).toUpperCase() || 'P';
}

function isActive(profile: string) {
  return profile === store.activeAgentProfileName;
}

/**
 * Anchor the menu to the row that opened it, then flip it above the row when the viewport
 * has no room below. The height is measured after mount because the menu's action list
 * changes (switch/set-default rows appear conditionally).
 */
async function openMenu(profile: string, event: MouseEvent | KeyboardEvent) {
  menuProfile.value = profile;
  // A keyboard activation has no pointer position, so fall back to the row itself.
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  const anchorLeft = rect ? rect.left : 'clientX' in event ? event.clientX : 0;
  const anchorTop = rect ? rect.top : 'clientY' in event ? event.clientY : 0;
  const anchorBottom = rect ? rect.bottom : anchorTop;
  const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max));

  menuStyle.value = {
    left: `${clamp(anchorLeft, window.innerWidth - 236)}px`,
    top: `${clamp(anchorBottom + 4, window.innerHeight - 60)}px`
  };
  await nextTick();

  const height = menuEl.value?.offsetHeight ?? 0;
  const width = menuEl.value?.offsetWidth ?? 220;
  const fitsBelow = window.innerHeight - anchorBottom >= height + 12;
  const top = fitsBelow ? anchorBottom + 4 : anchorTop - height - 4;
  menuStyle.value = {
    left: `${clamp(anchorLeft, window.innerWidth - width - 8)}px`,
    top: `${clamp(top, window.innerHeight - height - 8)}px`
  };
}

function closeMenu() {
  menuProfile.value = null;
}

async function rename() {
  const name = menuProfile.value;
  if (!name) return;
  const current = store.agentProfiles.find(profile => profile.name === name);
  const next = window.prompt(content.value.agentProfiles.newName, current ? label(current) : name);
  if (!next || next.trim() === name) return;
  await store.renameAgentProfile(name, next.trim());
  closeMenu();
}

async function remove() {
  const name = menuProfile.value;
  if (!name || name === 'default') return;
  if (!window.confirm(content.value.agentProfiles.deleteConfirm)) return;
  await store.deleteAgentProfile(name);
  closeMenu();
}
</script>

<template>
  <OnRailSection :title="content.agentProfiles.title">
    <template #actions>
      <button
        type="button"
        class="flex h-24px w-24px items-center justify-center rounded-[6px] border border-dashed border-line-default text-ink-tertiary outline-none hover:border-line-strong hover:text-ink-secondary focus-visible:shadow-focus-ring"
        :aria-label="content.agentProfiles.newProfile"
        :title="content.agentProfiles.newProfile"
        @click="ui.openAgentProfiles()"
      >
        <OnIcon name="lucide:plus" :size="13" />
      </button>
    </template>

    <div class="flex max-h-272px flex-col gap-4px overflow-y-auto pr-2px">
      <div
        v-for="profile in profiles"
        :key="profile.name"
        class="group/row flex items-center rounded-small border border-solid"
        :class="
          isActive(profile.name) ? 'border-line-strong bg-surface-inset' : 'border-transparent hover:bg-surface-control'
        "
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-9px rounded-small px-8px py-6px text-left outline-none focus-visible:shadow-focus-ring"
          :class="isActive(profile.name) ? 'text-ink-primary' : 'text-ink-secondary'"
          :aria-pressed="isActive(profile.name)"
          @click="store.switchAgentProfile(profile.name)"
          @contextmenu.prevent="openMenu(profile.name, $event)"
        >
          <span
            class="flex h-22px w-22px shrink-0 items-center justify-center rounded-[6px] border border-solid border-white/20 text-9.5px font-600 text-white"
            :style="{ background: color(profile.name) }"
          >
            <OnIcon v-if="profile.isDefault" name="lucide:hard-drive" :size="12" />
            <span v-else class="leading-none">{{ short(profile) }}</span>
          </span>
          <span class="min-w-0 flex-1 truncate text-12px">{{ label(profile) }}</span>
          <span
            v-if="profile.isDefault"
            class="shrink-0 rounded-tiny border border-solid border-line-default px-4px text-9px text-ink-tertiary"
            >{{ content.agentProfiles.default }}</span
          >
        </button>
        <button
          type="button"
          class="mr-5px flex h-20px w-20px shrink-0 items-center justify-center rounded-tiny text-13px leading-none text-ink-tertiary opacity-0 outline-none hover:text-ink-secondary focus-visible:opacity-100 focus-visible:shadow-focus-ring group-focus-within/row:opacity-100 group-hover/row:opacity-100"
          :class="isActive(profile.name) ? 'opacity-100' : ''"
          :aria-label="content.agentProfiles.profileActions"
          :title="content.agentProfiles.profileActions"
          @click.stop="openMenu(profile.name, $event)"
        >
          ⋯
        </button>
      </div>

      <div
        v-if="!profiles.length && store.agentProfilesLoading"
        class="flex items-center gap-5px px-8px py-6px text-11px text-ink-tertiary"
      >
        <OnIcon name="lucide:loader-circle" :size="12" class="animate-spin" />{{ content.agentProfiles.loading }}
      </div>
      <div v-else-if="!profiles.length" class="px-8px py-6px text-11px text-ink-tertiary">
        {{ content.agentProfiles.empty }}
      </div>

      <span v-if="store.profileSwitching" class="flex items-center gap-4px px-8px pt-6px text-10px text-ink-tertiary">
        <OnIcon name="lucide:loader-circle" :size="12" class="animate-spin" />{{ content.agentProfiles.loading }}
      </span>
      <span
        v-else-if="store.profileSwitchError"
        class="truncate px-8px pt-6px text-10px text-status-danger"
        :title="store.profileSwitchError"
        >{{ store.profileSwitchError }}</span
      >
    </div>

    <div class="mt-2px flex items-center justify-between gap-10px border-t border-t-solid border-line-subtle pt-8px">
      <span class="text-10.5px text-ink-tertiary">{{
        content.agentProfiles.count.replace('{count}', String(total))
      }}</span>
      <button
        type="button"
        class="flex items-center gap-4px text-10.5px text-ink-tertiary outline-none hover:text-ink-secondary focus-visible:shadow-focus-ring"
        @click="ui.openAgentProfiles()"
      >
        <OnIcon name="lucide:settings" :size="12" />{{ content.agentProfiles.manage }}
      </button>
    </div>
  </OnRailSection>

  <Teleport to="body">
    <div v-if="menuProfile" class="fixed inset-0 z-800" @click="closeMenu" @contextmenu.prevent="closeMenu">
      <div
        ref="menuEl"
        class="absolute w-220px rounded-default border border-solid border-line-strong bg-surface-raised p-5px shadow-modal"
        :style="menuStyle"
        @click.stop
      >
        <div class="px-8px py-5px text-9px font-600 uppercase tracking-[0.07em] text-ink-tertiary">
          {{ menuProfile }}
        </div>
        <button
          v-if="menuProfile !== store.activeAgentProfileName"
          type="button"
          class="flex w-full items-center gap-7px rounded-tiny px-8px py-6px text-left text-11px text-ink-secondary hover:bg-surface-control"
          @click="
            store.switchAgentProfile(menuProfile);
            closeMenu();
          "
        >
          <OnIcon name="lucide:check" :size="13" />{{ content.agentProfiles.switch }}
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-7px rounded-tiny px-8px py-6px text-left text-11px text-ink-secondary hover:bg-surface-control"
          @click="
            store.setAgentProfileDefault(menuProfile);
            closeMenu();
          "
        >
          <OnIcon name="lucide:pin" :size="13" />{{ content.agentProfiles.setDefault }}
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-7px rounded-tiny px-8px py-6px text-left text-11px text-ink-secondary hover:bg-surface-control"
          @click="rename"
        >
          <OnIcon name="lucide:edit" :size="13" />{{ content.agentProfiles.rename }}
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-7px rounded-tiny px-8px py-6px text-left text-11px text-ink-secondary hover:bg-surface-control"
          @click="
            ui.openAgentProfiles();
            closeMenu();
          "
        >
          <OnIcon name="lucide:settings" :size="13" />{{ content.agentProfiles.manage }}
        </button>
        <div class="my-4px h-1px bg-line-subtle"></div>
        <div class="flex items-center gap-5px px-8px py-5px">
          <span class="mr-2px text-9px text-ink-tertiary">{{ content.agentProfiles.color }}</span>
          <button
            v-for="swatch in swatches"
            :key="swatch"
            type="button"
            class="h-13px w-13px rounded-full border border-solid border-white/20"
            :style="{ background: swatch }"
            @click="
              store.setAgentProfileColor(menuProfile, swatch);
              closeMenu();
            "
          ></button>
        </div>
        <button
          v-if="menuProfile !== 'default'"
          type="button"
          class="flex w-full items-center gap-7px rounded-tiny px-8px py-6px text-left text-11px text-status-danger hover:bg-surface-control"
          @click="remove"
        >
          <OnIcon name="lucide:trash" :size="13" />{{ content.agentProfiles.delete }}
        </button>
        <div v-else class="px-8px py-6px text-11px leading-[1.45] text-ink-tertiary">
          {{ content.agentProfiles.defaultLocked }}
        </div>
      </div>
    </div>
  </Teleport>
</template>
