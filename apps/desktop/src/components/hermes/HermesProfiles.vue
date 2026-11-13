<script setup lang="ts">
import { computed } from 'vue';
import { OnButton, OnIcon } from '@opennavo/ui';
import { useHermesStore } from '@/stores/hermes';
import { useHermesContent } from '@/composables/useHermesContent';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; add: []; relogin: [profile: import('@/stores/hermes').HermesProfile] }>();
const store = useHermesStore();
const content = useHermesContent();

const localProfiles = computed(() => store.profiles.filter(profile => profile.kind === 'local'));
const remoteProfiles = computed(() => store.profiles.filter(profile => profile.kind !== 'local'));

function label(status: string) {
  if (status === 'error') return content.value.profiles.error;
  if (status === 'offline') return content.value.profiles.offline;
  if (status === 'connecting') return content.value.profiles.connecting;
  return content.value.profiles.connected;
}

function profileVersion(profileId: string, value: string) {
  if (value) return value;
  if (profileId === 'local') {
    return /(\d+\.\d+\.\d+)/.exec(store.runtime?.version ?? '')?.[1] ?? '—';
  }
  return '—';
}

function select(id: string) {
  store.switchProfile(id);
  emit('close');
}

async function remove(id: string) {
  if (!window.confirm(content.value.profiles.removeConfirm)) return;
  await store.removeProfile(id);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.open"
      class="fixed inset-0 z-700"
      role="dialog"
      aria-modal="true"
      :aria-label="content.profiles.title"
    >
      <div class="absolute inset-0 bg-black/60 backdrop-blur-[3px]" aria-hidden="true" @click="emit('close')"></div>
      <aside
        class="absolute inset-y-0 right-0 flex w-500px max-w-full flex-col border-l border-l-solid border-line-strong bg-surface-base shadow-2xl"
      >
        <header
          class="flex shrink-0 items-start gap-12px border-b border-b-solid border-line-subtle px-20px pb-15px pt-20px"
        >
          <div class="min-w-0 flex-1">
            <h2 class="m-0 text-18px font-600 tracking-[-0.02em] text-ink-primary">{{ content.profiles.title }}</h2>
            <p class="m-0 mt-5px max-w-360px text-11px leading-[1.55] text-ink-tertiary">
              {{ content.profiles.subtitle }}
            </p>
          </div>
          <OnButton
            variant="ghost"
            size="sm"
            icon="lucide:x"
            icon-only
            :aria-label="content.common.close"
            @click="emit('close')"
          />
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-16px py-15px">
          <h3 class="m-0 mb-8px text-10px font-600 uppercase tracking-[0.07em] text-ink-tertiary">
            {{ content.profiles.local }}
          </h3>
          <div
            v-for="profile in localProfiles"
            :key="profile.id"
            class="mb-8px flex w-full items-start gap-11px rounded-default border border-solid bg-surface-card p-11px text-left transition-colors"
            :class="
              profile.id === store.activeProfileId
                ? 'border-[rgba(145,135,255,0.42)] bg-[rgba(145,135,255,0.065)]'
                : 'border-line-subtle hover:border-line-default'
            "
            role="button"
            tabindex="0"
            @click="select(profile.id)"
            @keydown.enter="select(profile.id)"
          >
            <span
              class="flex h-32px w-32px shrink-0 items-center justify-center rounded-small border border-solid border-[rgba(87,201,138,0.17)] bg-[rgba(87,201,138,0.07)] text-status-success"
            >
              <OnIcon name="lucide:hard-drive" :size="16" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-7px">
                <b class="text-12px font-600 text-ink-primary">{{ profile.name }}</b>
                <span
                  v-if="profile.id === store.activeProfileId"
                  class="rounded-tiny border border-solid border-[rgba(145,135,255,0.2)] bg-[rgba(145,135,255,0.12)] px-5px py-1px text-9px text-[#d8d3ff]"
                  >{{ content.profiles.current }}</span
                >
              </span>
              <span class="mt-4px flex flex-wrap items-center gap-6px text-10px text-ink-tertiary">
                <i
                  class="h-6px w-6px rounded-full"
                  :class="profile.status === 'connected' ? 'bg-status-success' : 'bg-status-warning'"
                ></i>
                {{ label(profile.status) }}
                <span class="font-mono text-9.5px">{{ content.profiles.localRuntime }}</span>
              </span>
              <span class="mt-7px flex flex-wrap items-center gap-10px text-9.5px text-ink-tertiary">
                <span class="inline-flex items-center gap-4px"
                  ><OnIcon name="lucide:cloud" :size="11" />{{ profileVersion(profile.id, profile.version) }}</span
                >
                <span class="inline-flex items-center gap-4px"
                  ><OnIcon name="lucide:zap" :size="11" />{{
                    profile.kind === 'local' ? content.profiles.localCapabilities : content.profiles.remoteCapabilities
                  }}</span
                >
              </span>
            </span>
            <OnButton
              v-if="profile.id !== store.activeProfileId"
              variant="ghost"
              size="xs"
              @click.stop="select(profile.id)"
              >{{ content.profiles.switch }}</OnButton
            >
            <span v-else class="self-center text-10px text-ink-tertiary">{{ content.profiles.current }}</span>
          </div>

          <h3 class="m-0 mb-8px mt-18px text-10px font-600 uppercase tracking-[0.07em] text-ink-tertiary">
            {{ content.profiles.remote }}
          </h3>
          <div
            v-if="!remoteProfiles.length"
            class="rounded-small border border-dashed border-line-default p-14px text-11px leading-[1.6] text-ink-tertiary"
          >
            {{ content.profiles.noProfiles }}
          </div>
          <div
            v-for="profile in remoteProfiles"
            :key="profile.id"
            class="mb-8px flex w-full items-start gap-11px rounded-default border border-solid bg-surface-card p-11px text-left transition-colors"
            :class="
              profile.id === store.activeProfileId
                ? 'border-[rgba(145,135,255,0.42)] bg-[rgba(145,135,255,0.065)]'
                : 'border-line-subtle hover:border-line-default'
            "
            role="button"
            tabindex="0"
            @click="select(profile.id)"
            @keydown.enter="select(profile.id)"
          >
            <span
              class="flex h-32px w-32px shrink-0 items-center justify-center rounded-small border border-solid border-[rgba(145,135,255,0.18)] bg-[rgba(145,135,255,0.09)] text-[#c7c1ff]"
            >
              <OnIcon name="lucide:cloud" :size="16" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-7px">
                <b class="text-12px font-600 text-ink-primary">{{ profile.name }}</b>
                <span
                  v-if="profile.id === store.activeProfileId"
                  class="rounded-tiny border border-solid border-[rgba(145,135,255,0.2)] bg-[rgba(145,135,255,0.12)] px-5px py-1px text-9px text-[#d8d3ff]"
                  >{{ content.profiles.current }}</span
                >
                <span
                  class="rounded-tiny border border-solid border-line-subtle px-5px py-1px text-9px text-ink-tertiary"
                  >{{ content.profiles.remoteOnly }}</span
                >
              </span>
              <span class="mt-4px flex flex-wrap items-center gap-6px text-10px text-ink-tertiary">
                <i
                  class="h-6px w-6px rounded-full"
                  :class="
                    profile.status === 'connected'
                      ? 'bg-status-success'
                      : profile.status === 'error'
                        ? 'bg-status-danger'
                        : 'bg-status-warning'
                  "
                ></i>
                {{ label(profile.status) }}
                <span v-if="profile.latency" class="font-mono text-9.5px"
                  >{{ profile.latency }} {{ content.profiles.ms }}</span
                >
                <span class="max-w-250px truncate font-mono text-9.5px">{{ profile.endpoint }}</span>
              </span>
              <span class="mt-7px flex flex-wrap items-center gap-10px text-9.5px text-ink-tertiary">
                <span class="inline-flex items-center gap-4px"
                  ><OnIcon name="lucide:cloud" :size="11" />{{ profileVersion(profile.id, profile.version) }}</span
                >
                <span class="inline-flex items-center gap-4px"
                  ><OnIcon name="lucide:zap" :size="11" />{{
                    content.profiles.models.replace('{count}', String(profile.models))
                  }}</span
                >
                <span class="inline-flex items-center gap-4px"
                  ><OnIcon name="lucide:shield" :size="11" />{{ content.profiles.remoteCapabilities }}</span
                >
              </span>
              <span v-if="profile.error" class="mt-6px flex items-center gap-5px text-10px text-status-danger">
                <OnIcon name="lucide:circle-alert" :size="11" />{{ profile.error }}
              </span>
            </span>
            <span class="flex shrink-0 flex-col items-end gap-5px">
              <OnButton
                v-if="profile.kind === 'panel' && profile.status !== 'connected'"
                variant="ghost"
                size="xs"
                @click.stop="emit('relogin', profile)"
                >{{ content.profiles.relogin }}</OnButton
              >
              <span v-if="profile.id === store.activeProfileId" class="text-10px text-ink-tertiary">{{
                content.profiles.current
              }}</span>
              <OnButton
                v-if="profile.id !== store.activeProfileId"
                variant="ghost"
                size="xs"
                @click.stop="select(profile.id)"
                >{{ content.profiles.switch }}</OnButton
              >
              <OnButton
                variant="ghost"
                size="xs"
                icon="lucide:trash"
                icon-only
                :aria-label="content.profiles.remove"
                @click.stop="remove(profile.id)"
              />
            </span>
          </div>
          <div
            class="mt-9px flex items-start gap-8px rounded-small border border-solid border-[rgba(145,135,255,0.14)] bg-[rgba(145,135,255,0.045)] p-9px text-10px leading-[1.55] text-[#b7b1df]"
          >
            <OnIcon name="lucide:shield" :size="13" class="mt-1px shrink-0" />
            <span>{{ content.profiles.tokenHint }}</span>
          </div>
        </div>
        <footer class="flex shrink-0 border-t border-t-solid border-line-subtle p-12px">
          <OnButton variant="accent" class="w-full justify-center" icon="lucide:plus" @click="emit('add')">{{
            content.profiles.add
          }}</OnButton>
        </footer>
      </aside>
    </div>
  </Teleport>
</template>
