<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import { loginModuleRecord } from '@/constants/app';
import { useAppStore } from '@/store/modules/app';
import { useThemeStore } from '@/store/modules/theme';
import { $t } from '@/locales';
import PwdLogin from './modules/pwd-login.vue';

interface Props {
  /** The login module */
  module?: UnionKey.LoginModule;
}

const props = defineProps<Props>();

const appStore = useAppStore();
const themeStore = useThemeStore();

interface LoginModule {
  label: App.I18n.I18nKey;
  component: Component;
}

// Keep only account/password login (07 §5).
const moduleMap: Record<UnionKey.LoginModule, LoginModule> = {
  'pwd-login': { label: loginModuleRecord['pwd-login'], component: PwdLogin }
};

const activeModule = computed(() => moduleMap[props.module || 'pwd-login']);
</script>

<template>
  <div class="relative size-full flex-center overflow-hidden bg-layout">
    <div v-if="themeStore.darkMode" class="login-glow" aria-hidden="true"></div>
    <NCard :bordered="false" class="relative z-4 w-auto rd-14px">
      <div class="w-380px lt-sm:w-300px">
        <header class="flex-y-center gap-12px">
          <SystemLogo :size="40" class="size-40px shrink-0" inline />
          <div class="min-w-0 flex-1">
            <h1 class="text-20px font-600 leading-28px">{{ $t('system.title') }}</h1>
            <NText depth="3" class="block text-13px">{{ $t('page.login.common.subtitle') }}</NText>
          </div>
          <div class="i-flex-col">
            <ThemeSchemaSwitch
              :theme-schema="themeStore.themeScheme"
              :show-tooltip="false"
              class="text-20px lt-sm:text-18px"
              @switch="themeStore.toggleThemeScheme"
            />
            <LangSwitch
              v-if="themeStore.header.multilingual.visible"
              :lang="appStore.locale"
              :lang-options="appStore.localeOptions"
              :show-tooltip="false"
              @change-lang="appStore.changeLocale"
            />
          </div>
        </header>
        <main class="pt-28px">
          <h2 class="sr-only">{{ $t(activeModule.label) }}</h2>
          <component :is="activeModule.component" />
        </main>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
/* Dark-mode brand glow (08 §3.2 violet), decorative only, conveying no information. */
.login-glow {
  position: absolute;
  top: -360px;
  left: 50%;
  width: 960px;
  height: 960px;
  transform: translateX(-50%);
  background: var(--on-effect-cover-glow);
  opacity: 0.45;
  pointer-events: none;
}
</style>
