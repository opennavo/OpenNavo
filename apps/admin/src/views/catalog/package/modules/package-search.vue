<script setup lang="ts">
import { computed } from 'vue';
import { useCategoryTree } from '@/hooks/business/category';
import { booleanOptions } from '@/utils/opennavo';
import { $t } from '@/locales';
import type { PackageFilters } from './filters';

defineOptions({ name: 'PackageSearch' });

const filters = defineModel<PackageFilters>('filters', { required: true });
const emit = defineEmits<{ search: []; reset: [] }>();

const { options: categoryOptions, readable: categoryReadable } = useCategoryTree();

const translationOptions = computed(() =>
  (['none', 'source', 'machine', 'manual', 'pending', 'failed'] as const).map(value => ({
    value,
    label: $t(`page.shared.translationStatus.${value}`)
  }))
);
const sortOptions = computed(() =>
  (['popular', 'updated', 'name', 'created'] as const).map(value => ({
    value,
    label: $t(`page.catalog.package.sortOptions.${value}`)
  }))
);
const yesNo = computed(() => booleanOptions($t('page.shared.yes'), $t('page.shared.no')));
const flagFields = computed(
  () =>
    [
      { key: 'hidden', label: $t('page.shared.flags.hidden') },
      { key: 'editorChoice', label: $t('page.shared.flags.editorChoice') },
      { key: 'deprecated', label: $t('page.shared.flags.deprecated') },
      { key: 'disabled', label: $t('page.shared.flags.disabled') },
      { key: 'isFont', label: $t('page.shared.flags.font') }
    ] as const
);
</script>

<template>
  <NCard :bordered="false" size="small" class="card-wrapper">
    <NForm :model="filters" label-placement="left" :label-width="80" :show-feedback="false">
      <NGrid responsive="screen" item-responsive :x-gap="16" :y-gap="12">
        <NFormItemGi span="24 s:12 m:6" :label="$t('page.catalog.package.keyword')">
          <NInput
            v-model:value="filters.q"
            :placeholder="$t('page.catalog.package.keywordPlaceholder')"
            clearable
            @keyup.enter="emit('search')"
          />
        </NFormItemGi>
        <NFormItemGi v-if="categoryReadable" span="24 s:12 m:6" :label="$t('page.catalog.package.category')">
          <NTreeSelect
            v-model:value="filters.categoryId"
            :options="categoryOptions"
            :placeholder="$t('page.shared.any')"
            clearable
            filterable
          />
        </NFormItemGi>
        <NFormItemGi span="24 s:12 m:6" :label="$t('page.catalog.package.translationStatus')">
          <NSelect
            v-model:value="filters.translationStatus"
            :options="translationOptions"
            :placeholder="$t('page.shared.any')"
            clearable
          />
        </NFormItemGi>
        <NFormItemGi v-for="field in flagFields" :key="field.key" span="12 s:8 m:4" :label="field.label">
          <NSelect v-model:value="filters[field.key]" :options="yesNo" :placeholder="$t('page.shared.any')" clearable />
        </NFormItemGi>
        <NFormItemGi span="24 s:12 m:6" :label="$t('page.catalog.package.hasIcon')">
          <NSelect
            v-model:value="filters.hasIcon"
            :options="
              booleanOptions(
                $t('page.catalog.package.hasIconOptions.yes'),
                $t('page.catalog.package.hasIconOptions.no')
              )
            "
            :placeholder="$t('page.shared.any')"
            clearable
          />
        </NFormItemGi>
        <NFormItemGi span="24 s:12 m:6" :label="$t('page.catalog.package.sort')">
          <NSelect v-model:value="filters.sort" :options="sortOptions" />
        </NFormItemGi>
        <NGi span="24 m:12" class="flex items-center justify-end gap-12px">
          <NButton @click="emit('reset')">
            <template #icon>
              <icon-ic-round-refresh class="text-icon" />
            </template>
            {{ $t('common.reset') }}
          </NButton>
          <NButton type="primary" ghost @click="emit('search')">
            <template #icon>
              <icon-ic-round-search class="text-icon" />
            </template>
            {{ $t('common.search') }}
          </NButton>
        </NGi>
      </NGrid>
    </NForm>
  </NCard>
</template>
