<script setup lang="ts">
import { useLoader } from '@/composables/useLoader';
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { OnCategoriesView, OnEmpty } from '@opennavo/ui';
import type { OnCategoriesItem } from '@opennavo/ui';
import { formatCount } from '@opennavo/shared';
import { useAppLocale } from '@/composables/useAppLocale';
import { useCatalogStore } from '@/stores';

// Categories (local catalog, available offline): top-level cards with subcategories; shared web view (ADR-017).
const { t } = useI18n();
const { appLocale } = useAppLocale();
const catalog = useCatalogStore();

const items = computed<OnCategoriesItem[]>(() =>
  catalog.categories
    .filter(category => !category.parent)
    .map(category => ({
      key: category.slug,
      name: category.name,
      icon: category.icon,
      count: t(
        'categories.packages',
        { count: formatCount(category.packageCount, { locale: appLocale.value }) },
        { plural: category.packageCount }
      ),
      children: catalog.categories.filter(child => child.parent === category.slug).map(child => child.name),
      href: `/categories/${category.slug}`
    }))
);
const { loading, error } = useLoader(() => catalog.loadCategories(), [appLocale]);
</script>

<template>
  <OnCategoriesView
    :title="t('categories.title')"
    :subtitle="
      !loading && !error ? t('categories.subtitle', { count: items.length }, { plural: items.length }) : undefined
    "
    :items="loading && !items.length ? null : items"
    :link-as="RouterLink"
  >
    <OnEmpty v-if="!loading && !error && !items.length" :title="t('common.empty')" />
  </OnCategoriesView>
</template>
