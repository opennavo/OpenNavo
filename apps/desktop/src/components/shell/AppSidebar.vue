<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { OnSidebar } from '@opennavo/ui';
import type { OnSidebarGroup, OnSidebarItem } from '@opennavo/ui';
import { useBrewfileStore } from '@/stores/brewfile';
import { refreshPage } from '@/composables/usePageRefresh';
import { useLibraryStore, useUpdatesStore } from '@/stores';

// Use shared @opennavo/ui OnSidebar (ADR-017); provide desktop groups and local counts here.
const { t } = useI18n();
const route = useRoute();
const brewfile = useBrewfileStore();
const library = useLibraryStore();
const updates = useUpdatesStore();

const item = (name: string, icon: string, label: string, extra: Partial<OnSidebarItem> = {}): OnSidebarItem => ({
  key: name,
  label,
  icon,
  href: `/${name}`,
  active: route.meta.nav === name,
  ...extra
});

const groups = computed<OnSidebarGroup[]>(() => [
  {
    key: 'browse',
    label: t('nav.browse'),
    items: [
      item('discover', 'lucide:compass', t('nav.discover')),
      item('categories', 'lucide:layout-grid', t('nav.categories')),
      item('rankings', 'lucide:chart-no-axes-column', t('nav.rankings'))
    ]
  },
  {
    key: 'lists',
    label: t('nav.lists'),
    items: [
      item('collections', 'lucide:library', t('collections.title')),
      item('brewfile', 'lucide:file-text', t('brewfile.title'), { count: brewfile.items.length || undefined })
    ]
  },
  {
    key: 'mine',
    label: t('nav.mine'),
    items: [
      item('installed', 'lucide:package', t('nav.installed'), { count: library.items.length || undefined }),
      item('updates', 'lucide:circle-arrow-down', t('nav.updates'), {
        badge: updates.actionable.length || undefined,
        badgeLabel: t('nav.updatesBadge', { count: updates.actionable.length }, { plural: updates.actionable.length })
      })
    ]
  }
]);

const footer = computed(() => [item('settings', 'lucide:sliders-horizontal', t('nav.settings'))]);
const emit = defineEmits<{ reselect: [] }>();
function reselect(event: MouseEvent) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (route.path === '/discover' && link?.getAttribute('href')?.endsWith('/discover')) {
    emit('reselect');
    void refreshPage();
  }
}
</script>

<template>
  <OnSidebar
    :groups="groups"
    :footer-items="footer"
    :label="t('app.name')"
    drag-region
    :link-as="RouterLink"
    @click="reselect"
  />
</template>
