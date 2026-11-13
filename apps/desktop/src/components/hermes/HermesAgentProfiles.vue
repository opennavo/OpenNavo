<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { OnButton, OnIcon } from '@opennavo/ui';
import { useHermesStore } from '@/stores/hermes';
import { useHermesContent } from '@/composables/useHermesContent';
import { useHermesUiStore } from '@/stores/hermesUi';
import { useToasts } from '@/composables/useToasts';
import { IpcError } from '@/ipc/client';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const store = useHermesStore();
const content = useHermesContent();
const ui = useHermesUiStore();
const toasts = useToasts();

const selectedName = ref<string | null>(null);
const createOpen = ref(false);
const createName = ref('');
const cloneFrom = ref('default');
const createSoul = ref('');
const creating = ref(false);
const error = ref('');
const soul = ref('');
const soulOriginal = ref('');
const soulLoading = ref(false);
const soulSaving = ref(false);
const renameOpen = ref(false);
const renameName = ref('');

const selected = computed(
  () => store.agentProfiles.find(profile => profile.name === selectedName.value) ?? store.agentProfiles[0] ?? null
);
const canDelete = computed(() => Boolean(selected.value && !selected.value.isDefault));

function label(profile: { name: string; displayName: string | null }) {
  return profile.displayName || profile.name;
}

function color(name: string) {
  if (name === 'default') return '#2b2b2b';
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 58% 58%)`;
}

function details(cause: unknown) {
  return cause instanceof IpcError ? (cause.detail ?? cause.message) : String(cause);
}

async function refresh(select?: string) {
  await store.loadAgentProfiles();
  if (select) selectedName.value = select;
  if (!selectedName.value || !store.agentProfiles.some(profile => profile.name === selectedName.value)) {
    selectedName.value = store.activeAgentProfileName || store.agentProfiles[0]?.name || null;
  }
}

async function loadSoul() {
  if (!selected.value) return;
  soulLoading.value = true;
  error.value = '';
  try {
    soul.value = await store.loadAgentProfileSoul(selected.value.name);
    soulOriginal.value = soul.value;
  } catch (cause) {
    error.value = details(cause);
  } finally {
    soulLoading.value = false;
  }
}

watch(
  () => props.open,
  open => {
    if (!open) return;
    createOpen.value = false;
    renameOpen.value = false;
    error.value = '';
    void refresh();
  }
);

watch(selectedName, () => {
  if (props.open) void loadSoul();
});

async function create() {
  const name = createName.value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    error.value = content.value.agentProfiles.invalidName;
    return;
  }
  creating.value = true;
  error.value = '';
  try {
    await store.createAgentProfile(
      name,
      cloneFrom.value === '__none__' ? null : cloneFrom.value,
      createSoul.value.trim() || null
    );
    await refresh(name);
    createOpen.value = false;
    createName.value = '';
    createSoul.value = '';
  } catch (cause) {
    error.value = details(cause);
  } finally {
    creating.value = false;
  }
}

async function rename() {
  if (!selected.value) return;
  const name = renameName.value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    error.value = content.value.agentProfiles.invalidName;
    return;
  }
  try {
    await store.renameAgentProfile(selected.value.name, name);
    await refresh(name);
    renameOpen.value = false;
  } catch (cause) {
    error.value = details(cause);
  }
}

async function remove() {
  if (!selected.value || !canDelete.value) return;
  if (!window.confirm(content.value.agentProfiles.deleteConfirm)) return;
  try {
    await store.deleteAgentProfile(selected.value.name);
    await refresh('default');
  } catch (cause) {
    error.value = details(cause);
  }
}

async function saveSoul() {
  if (!selected.value) return;
  soulSaving.value = true;
  error.value = '';
  try {
    await store.saveAgentProfileSoul(selected.value.name, soul.value);
    soulOriginal.value = soul.value;
  } catch (cause) {
    error.value = details(cause);
  } finally {
    soulSaving.value = false;
  }
}

function useProfile() {
  if (!selected.value) return;
  store.switchAgentProfile(selected.value.name);
  emit('close');
}

function configureProfile() {
  if (!selected.value) return;
  if (selected.value.name !== store.activeAgentProfileName) store.switchAgentProfile(selected.value.name);
  ui.openSettings('model');
  emit('close');
}

async function exportProfile() {
  if (!selected.value) return;
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      defaultPath: `${selected.value.name}.tar.gz`,
      filters: [{ name: 'Hermes profile', extensions: ['tar.gz', 'tgz'] }]
    });
    if (!path) return;
    await store.exportAgentProfile(selected.value.name, path);
    toasts.push({ tone: 'success', title: 'Hermes', description: content.value.agentProfiles.exported });
  } catch (cause) {
    toasts.push({
      tone: 'danger',
      title: 'Hermes',
      description: `${content.value.agentProfiles.exportFailed} ${details(cause)}`
    });
  }
}

async function importProfile() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const archive = await open({
      multiple: false,
      filters: [{ name: 'Hermes profile', extensions: ['tar.gz', 'tgz'] }]
    });
    if (!archive || Array.isArray(archive)) return;
    await store.importAgentProfile(archive, null);
    await refresh();
    toasts.push({ tone: 'success', title: 'Hermes', description: content.value.agentProfiles.imported });
  } catch (cause) {
    toasts.push({
      tone: 'danger',
      title: 'Hermes',
      description: `${content.value.agentProfiles.importFailed} ${details(cause)}`
    });
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.open"
      class="fixed inset-0 z-700"
      role="dialog"
      aria-modal="true"
      :aria-label="content.agentProfiles.title"
    >
      <div class="absolute inset-0 bg-black/60 backdrop-blur-[3px]" aria-hidden="true" @click="emit('close')"></div>
      <aside
        class="absolute inset-y-0 right-0 flex w-560px max-w-full flex-col border-l border-l-solid border-line-strong bg-surface-base shadow-2xl"
      >
        <header
          class="flex shrink-0 items-start gap-12px border-b border-b-solid border-line-subtle px-20px pb-15px pt-20px"
        >
          <div class="min-w-0 flex-1">
            <h2 class="m-0 text-18px font-600 tracking-[-0.02em] text-ink-primary">
              {{ content.agentProfiles.title }}
            </h2>
            <p class="m-0 mt-5px max-w-430px text-11px leading-[1.55] text-ink-tertiary">
              {{ content.agentProfiles.subtitle }}
            </p>
          </div>
          <OnButton
            variant="ghost"
            size="sm"
            icon="lucide:x"
            icon-only
            :aria-label="content.agentProfiles.close"
            @click="emit('close')"
          />
        </header>

        <div class="min-h-0 flex flex-1">
          <div class="flex w-215px shrink-0 flex-col border-r border-r-solid border-line-subtle">
            <div class="min-h-0 flex-1 overflow-y-auto p-10px">
              <button
                v-for="profile in store.agentProfiles"
                :key="profile.name"
                type="button"
                class="mb-4px flex w-full items-center gap-8px rounded-small border border-solid px-8px py-7px text-left outline-none"
                :class="
                  profile.name === selected?.name
                    ? 'border-[rgba(145,135,255,0.35)] bg-[rgba(145,135,255,0.08)]'
                    : 'border-transparent hover:bg-surface-card'
                "
                @click="selectedName = profile.name"
              >
                <span class="h-22px w-22px shrink-0 rounded-[6px]" :style="{ background: color(profile.name) }"></span>
                <span class="min-w-0 flex-1">
                  <b class="block truncate text-11px font-500 text-ink-primary">{{ label(profile) }}</b>
                  <small class="block truncate text-9.5px text-ink-tertiary">{{
                    profile.isDefault ? content.agentProfiles.default : profile.name
                  }}</small>
                </span>
                <OnIcon
                  v-if="profile.name === store.activeAgentProfileName"
                  name="lucide:check"
                  :size="12"
                  class="text-status-success"
                />
              </button>
              <button
                type="button"
                class="mt-7px flex w-full items-center justify-center gap-5px rounded-small border border-dashed border-line-default py-7px text-10.5px text-ink-tertiary hover:border-line-strong hover:text-ink-secondary"
                @click="
                  createOpen = true;
                  error = '';
                "
              >
                <OnIcon name="lucide:plus" :size="12" />{{ content.agentProfiles.newProfile }}
              </button>
            </div>
          </div>

          <div class="min-w-0 flex-1 overflow-y-auto p-16px">
            <div
              v-if="error"
              class="mb-10px rounded-small border border-solid border-[rgba(255,107,107,0.28)] bg-[rgba(255,107,107,0.06)] p-8px text-10.5px leading-[1.5] text-status-danger"
            >
              {{ error }}
            </div>

            <form
              v-if="createOpen"
              class="mb-16px rounded-default border border-solid border-line-default bg-surface-card p-12px"
              @submit.prevent="create"
            >
              <h3 class="m-0 text-13px font-600 text-ink-primary">{{ content.agentProfiles.createTitle }}</h3>
              <p class="m-0 mt-4px text-10.5px leading-[1.5] text-ink-tertiary">
                {{ content.agentProfiles.createBody }}
              </p>
              <label class="mt-10px flex flex-col gap-4px text-10px text-ink-secondary"
                >{{ content.agentProfiles.name }}
                <input
                  v-model="createName"
                  class="h-32px rounded-small border border-solid border-line-default bg-surface-inset px-9px font-mono text-10.5px text-ink-primary outline-none focus-visible:shadow-focus-ring"
                  :placeholder="content.agentProfiles.namePlaceholder"
                />
                <small class="text-9.5px text-ink-tertiary">{{ content.agentProfiles.nameHint }}</small>
              </label>
              <label class="mt-9px flex flex-col gap-4px text-10px text-ink-secondary"
                >{{ content.agentProfiles.cloneFrom }}
                <select
                  v-model="cloneFrom"
                  class="h-32px rounded-small border border-solid border-line-default bg-surface-inset px-8px text-10.5px text-ink-primary outline-none focus-visible:shadow-focus-ring"
                >
                  <option value="__none__">{{ content.agentProfiles.cloneNone }}</option>
                  <option v-for="profile in store.agentProfiles" :key="profile.name" :value="profile.name">
                    {{ label(profile) }}
                  </option>
                </select>
              </label>
              <label class="mt-9px flex flex-col gap-4px text-10px text-ink-secondary"
                >{{ content.agentProfiles.soul }}
                <textarea
                  v-model="createSoul"
                  class="min-h-70px resize-y rounded-small border border-solid border-line-default bg-surface-inset px-9px py-7px font-mono text-10px leading-[1.5] text-ink-primary outline-none focus-visible:shadow-focus-ring"
                  :placeholder="content.agentProfiles.soulPlaceholder"
                ></textarea>
              </label>
              <div class="mt-10px flex justify-end gap-6px">
                <OnButton variant="ghost" size="sm" @click="createOpen = false">{{ content.common.cancel }}</OnButton>
                <OnButton variant="accent" size="sm" :disabled="creating" @click="create">{{
                  creating ? content.agentProfiles.creating : content.agentProfiles.create
                }}</OnButton>
              </div>
            </form>

            <template v-if="selected">
              <div class="flex items-start gap-10px">
                <span
                  class="mt-1px h-34px w-34px shrink-0 rounded-[9px]"
                  :style="{ background: color(selected.name) }"
                ></span>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-7px">
                    <h3 class="m-0 text-16px font-600 tracking-[-0.02em] text-ink-primary">{{ label(selected) }}</h3>
                    <span
                      v-if="selected.isDefault"
                      class="rounded-tiny border border-solid border-[rgba(87,201,138,0.22)] bg-[rgba(87,201,138,0.07)] px-5px py-1px text-9px text-status-success"
                      >{{ content.agentProfiles.default }}</span
                    >
                    <span
                      v-if="selected.name === store.activeAgentProfileName"
                      class="rounded-tiny border border-solid border-[rgba(145,135,255,0.2)] bg-[rgba(145,135,255,0.12)] px-5px py-1px text-9px text-[#d8d3ff]"
                      >{{ content.agentProfiles.current }}</span
                    >
                  </div>
                  <p class="m-0 mt-4px truncate font-mono text-9.5px text-ink-tertiary" :title="selected.path">
                    {{ selected.path }}
                  </p>
                </div>
                <OnButton
                  v-if="selected.name !== store.activeAgentProfileName"
                  variant="accent"
                  size="sm"
                  @click="useProfile"
                  >{{ content.agentProfiles.switch }}</OnButton
                >
              </div>

              <div
                v-if="!selected.model"
                class="mt-12px rounded-small border border-solid border-[rgba(232,180,90,0.24)] bg-[rgba(232,180,90,0.06)] p-10px text-10.5px leading-[1.55] text-[#e8c98a]"
              >
                <b class="block font-600 text-ink-primary">{{ content.agentProfiles.setupTitle }}</b>
                <p class="m-0 mt-3px text-[#d8c39a]">{{ content.agentProfiles.setupBody }}</p>
                <OnButton variant="ghost" size="sm" class="mt-6px" @click="configureProfile">{{
                  content.agentProfiles.configure
                }}</OnButton>
              </div>
              <div
                class="mt-14px grid grid-cols-2 gap-x-14px gap-y-7px rounded-small border border-solid border-line-subtle bg-surface-card p-10px text-10.5px"
              >
                <div class="flex justify-between gap-8px">
                  <span class="text-ink-tertiary">{{ content.agentProfiles.model }}</span
                  ><span class="truncate font-mono text-ink-secondary">{{
                    selected.model || content.agentProfiles.notSet
                  }}</span>
                </div>
                <div class="flex justify-between gap-8px">
                  <span class="text-ink-tertiary">{{ content.agentProfiles.provider }}</span
                  ><span class="truncate font-mono text-ink-secondary">{{
                    selected.provider || content.agentProfiles.notSet
                  }}</span>
                </div>
                <div class="flex justify-between gap-8px">
                  <span class="text-ink-tertiary">{{ content.agentProfiles.skills }}</span
                  ><span class="text-ink-secondary">{{ selected.skillCount }}</span>
                </div>
                <div class="flex justify-between gap-8px">
                  <span class="text-ink-tertiary">{{ content.agentProfiles.env }}</span
                  ><span class="text-ink-secondary">{{
                    selected.hasEnv ? content.agentProfiles.yes : content.agentProfiles.no
                  }}</span>
                </div>
              </div>

              <div class="mt-12px flex flex-wrap items-center gap-6px">
                <OnButton
                  variant="ghost"
                  size="sm"
                  icon="lucide:edit"
                  @click="
                    renameOpen = true;
                    renameName = selected.name;
                  "
                  >{{ content.agentProfiles.rename }}</OnButton
                >
                <OnButton variant="ghost" size="sm" icon="lucide:download" @click="exportProfile">{{
                  content.agentProfiles.export
                }}</OnButton>
                <OnButton variant="ghost" size="sm" icon="lucide:inbox" @click="importProfile">{{
                  content.agentProfiles.import
                }}</OnButton>
                <OnButton v-if="!selected.isDefault" variant="ghost" size="sm" icon="lucide:trash" @click="remove">{{
                  content.agentProfiles.delete
                }}</OnButton>
                <OnButton
                  v-if="store.activeAgentProfileName !== selected.name"
                  variant="ghost"
                  size="sm"
                  icon="lucide:pin"
                  @click="store.setAgentProfileDefault(selected.name)"
                  >{{ content.agentProfiles.setDefault }}</OnButton
                >
                <span class="ml-3px text-9.5px text-ink-tertiary">{{ content.agentProfiles.color }}</span>
                <button
                  v-for="swatch in ['#8f86ff', '#57c98a', '#e8b45a', '#ff7356', '#5aa9e8', '#d58cff']"
                  :key="swatch"
                  type="button"
                  class="h-15px w-15px rounded-full border border-solid border-white/20 outline-none focus-visible:shadow-focus-ring"
                  :style="{ background: swatch }"
                  :aria-label="content.agentProfiles.color"
                  @click="store.setAgentProfileColor(selected.name, swatch)"
                ></button>
                <button
                  type="button"
                  class="h-15px w-15px rounded-full border border-solid border-white/20 bg-surface-inset text-9px leading-none text-ink-tertiary"
                  :aria-label="content.agentProfiles.color"
                  @click="store.setAgentProfileColor(selected.name, null)"
                >
                  ×
                </button>
                <span class="ml-auto flex gap-4px">
                  <OnButton
                    variant="ghost"
                    size="xs"
                    icon="lucide:arrow-up"
                    icon-only
                    :aria-label="content.agentProfiles.moveUp"
                    @click="store.moveAgentProfile(selected.name, -1)"
                  />
                  <OnButton
                    variant="ghost"
                    size="xs"
                    icon="lucide:arrow-down"
                    icon-only
                    :aria-label="content.agentProfiles.moveDown"
                    @click="store.moveAgentProfile(selected.name, 1)"
                  />
                </span>
              </div>

              <form
                v-if="renameOpen"
                class="mt-10px flex items-end gap-6px rounded-small border border-solid border-line-default bg-surface-card p-9px"
                @submit.prevent="rename"
              >
                <label class="min-w-0 flex-1 text-10px text-ink-secondary"
                  >{{ content.agentProfiles.newName }}
                  <input
                    v-model="renameName"
                    class="mt-4px h-30px w-full rounded-small border border-solid border-line-default bg-surface-inset px-8px font-mono text-10.5px text-ink-primary outline-none focus-visible:shadow-focus-ring"
                  />
                </label>
                <OnButton variant="accent" size="sm" @click="rename">{{ content.agentProfiles.rename }}</OnButton>
              </form>

              <section class="mt-18px">
                <div class="flex items-baseline justify-between gap-8px">
                  <div>
                    <h4 class="m-0 text-11px font-600 text-ink-primary">{{ content.agentProfiles.soulTitle }}</h4>
                    <p class="m-0 mt-3px text-9.5px text-ink-tertiary">{{ content.agentProfiles.soulDesc }}</p>
                  </div>
                  <OnButton
                    variant="ghost"
                    size="sm"
                    :disabled="soulLoading || soulSaving || soul === soulOriginal"
                    @click="saveSoul"
                    >{{ soulSaving ? content.agentProfiles.savingSoul : content.agentProfiles.saveSoul }}</OnButton
                  >
                </div>
                <textarea
                  v-if="!soulLoading"
                  v-model="soul"
                  class="mt-7px min-h-220px w-full resize-y rounded-small border border-solid border-line-default bg-surface-inset px-10px py-8px font-mono text-10px leading-[1.55] text-ink-primary outline-none focus-visible:shadow-focus-ring"
                ></textarea>
                <p v-else class="mt-7px text-10px text-ink-tertiary">{{ content.agentProfiles.loadSoul }}</p>
              </section>
            </template>
          </div>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
