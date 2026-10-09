<script setup lang="ts">
import { ref } from 'vue';
import type { SelectOption } from 'naive-ui';
import { useDebounceFn } from '@vueuse/core';
import { fetchPackageList } from '@/service/api';
import type { RecordOf } from '@/typings/api/opennavo';
import { useLocalizedPackage } from '@/hooks/business/localized';
import { $t } from '@/locales';

defineOptions({ name: 'PackagePicker' });

type Package = RecordOf<'listAdminPackages'>;

// Remote package picker for collection items/feature targets; emit the full selected row through pick.
withDefaults(defineProps<{ placeholder?: string; disabled?: boolean }>(), { placeholder: '', disabled: false });
const emit = defineEmits<{ pick: [item: Package] }>();

const { nameOf } = useLocalizedPackage();
const options = ref<SelectOption[]>([]);
const rows = new Map<number, Package>();
const loading = ref(false);

const search = useDebounceFn(async (query: string) => {
  const q = query.trim();
  if (!q) {
    options.value = [];
    return;
  }
  loading.value = true;
  const { data, error } = await fetchPackageList({ q, current: 1, size: 20, sort: 'popular' });
  loading.value = false;
  if (error) return;
  options.value = data.records.map(item => {
    rows.set(item.id, item);
    const name = nameOf(item);
    return {
      value: item.id,
      label: `${name} · ${item.token}${item.disabled ? ` · ${$t('page.shared.flags.disabled')}` : ''}`
    };
  });
}, 250);

function select(id: number) {
  const row = rows.get(id);
  if (row) emit('pick', row);
}
</script>

<template>
  <NSelect
    :value="null"
    :options="options"
    :loading="loading"
    :placeholder="placeholder"
    :disabled="disabled"
    filterable
    remote
    clear-filter-after-select
    @search="search"
    @update:value="select"
  />
</template>
