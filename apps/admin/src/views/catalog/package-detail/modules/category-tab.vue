<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatDecimal } from '@opennavo/shared';
import { useAppStore } from '@/store/modules/app';
import { setPackageCategories } from '@/service/api';
import type { DataOf, Schemas } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { useCategoryTree } from '@/hooks/business/category';
import { $t } from '@/locales';

defineOptions({ name: 'CategoryTab' });

const props = defineProps<{ detail: DataOf<'getAdminPackage'> }>();
const emit = defineEmits<{ saved: [] }>();

type Assignment = Schemas['PackageCategoryAssignment'];
// Up to three categories, one primary (07 §7.3); save replaces all and marks source manual.
const MAX = 3;

const { hasAuth } = useAuth();
const appStore = useAppStore();
const editable = computed(() => hasAuth('catalog:package:edit'));
const { options, names } = useCategoryTree();

const items = ref<Assignment[]>([]);
const adding = ref<number | null>(null);
const saving = ref(false);

watch(
  () => props.detail,
  detail => {
    items.value = detail.categories.map(item => ({ ...item }));
  },
  { immediate: true }
);

const primary = computed({
  get: () => items.value.find(item => item.isPrimary)?.categoryId ?? null,
  set: id => {
    items.value = items.value.map(item => ({ ...item, isPrimary: item.categoryId === id }));
  }
});

const nameOf = (item: Assignment) =>
  names.value.get(item.categoryId) ?? item.name ?? item.slug ?? String(item.categoryId);

function add(id: number | null) {
  adding.value = null;
  if (id === null || items.value.some(item => item.categoryId === id) || items.value.length >= MAX) return;
  items.value = [
    ...items.value,
    { categoryId: id, isPrimary: items.value.length === 0, source: 'human', confidence: null }
  ];
}

function remove(id: number) {
  const next = items.value.filter(item => item.categoryId !== id);
  if (next.length && !next.some(item => item.isPrimary)) next[0] = { ...next[0]!, isPrimary: true };
  items.value = next;
}

async function save() {
  if (items.value.length && !items.value.some(item => item.isPrimary)) {
    window.$message?.warning($t('page.catalog.packageDetail.categories.needPrimary'));
    return;
  }
  saving.value = true;
  const { error } = await setPackageCategories(props.detail.id, {
    items: items.value.map(item => ({ categoryId: item.categoryId, isPrimary: item.isPrimary }))
  });
  saving.value = false;
  if (error) return;
  window.$message?.success($t('page.shared.saved'));
  emit('saved');
}
</script>

<template>
  <div class="max-w-720px flex-col gap-12px">
    <NText depth="3" class="text-13px">{{ $t('page.catalog.packageDetail.categories.hint') }}</NText>
    <NRadioGroup v-if="items.length" v-model:value="primary" :disabled="!editable">
      <NList bordered>
        <NListItem v-for="item in items" :key="item.categoryId">
          <div class="flex items-center gap-12px">
            <span class="min-w-0 flex-1 font-500">{{ nameOf(item) }}</span>
            <NTag size="small" :bordered="false">
              {{ $t(`page.catalog.packageDetail.categories.sources.${item.source}`) }}
            </NTag>
            <NText v-if="item.confidence !== null && item.confidence !== undefined" depth="3" class="text-12px">
              {{
                $t('page.catalog.packageDetail.categories.confidence', {
                  value: formatDecimal(item.confidence, { locale: appStore.locale })
                })
              }}
            </NText>
            <NRadio :value="item.categoryId">{{ $t('page.catalog.packageDetail.categories.primary') }}</NRadio>
            <NButton v-if="editable" size="small" quaternary type="error" @click="remove(item.categoryId)">
              {{ $t('common.delete') }}
            </NButton>
          </div>
        </NListItem>
      </NList>
    </NRadioGroup>
    <NEmpty v-if="!items.length" :description="$t('page.catalog.packageDetail.categories.empty')" />
    <PermissionGate code="catalog:package:edit">
      <div class="flex items-center gap-12px">
        <NTreeSelect
          :value="adding"
          :options="options"
          :disabled="items.length >= MAX"
          :placeholder="
            items.length >= MAX
              ? $t('page.catalog.packageDetail.categories.max')
              : $t('page.catalog.packageDetail.categories.add')
          "
          filterable
          class="max-w-320px"
          @update:value="add"
        />
        <NButton type="primary" :loading="saving" class="ml-auto" @click="save">
          {{ $t('page.catalog.packageDetail.categories.save') }}
        </NButton>
      </div>
    </PermissionGate>
  </div>
</template>
