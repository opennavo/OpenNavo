<script setup lang="ts">
import { ref, watch } from 'vue';
import { deleteCategory, reorderCategories } from '@/service/api';
import type { Schemas } from '@/typings/api/opennavo';
import { useAuth } from '@/hooks/business/auth';
import { useCategoryTree } from '@/hooks/business/category';
import { $t } from '@/locales';
import CategoryForm from './modules/category-form.vue';
import CategoryRows from './modules/category-rows.vue';

defineOptions({ name: 'CatalogCategory' });

type Node = Schemas['AdminCategoryNode'];

// Categories (07 §7.4): tree table, sibling drag sort submitted together; create/edit/delete use dialogs and confirmation.
const { hasAuth } = useAuth();
const editable = hasAuth('catalog:category:edit');
const { tree, reload, nameOf } = useCategoryTree();

const nodes = ref<Node[]>([]);
const loading = ref(false);
const moved = ref(false);
const savingOrder = ref(false);
const formOpen = ref(false);
const editing = ref<Node | null>(null);
const parentId = ref<number | null>(null);

const clone = (list: Node[]): Node[] => list.map(node => ({ ...node, children: clone(node.children) }));
watch(
  tree,
  value => {
    nodes.value = clone(value);
    moved.value = false;
  },
  { immediate: true }
);

async function refresh() {
  loading.value = true;
  await reload();
  loading.value = false;
}
void refresh();

function openForm(node: Node | null, parent: number | null = null) {
  editing.value = node;
  parentId.value = parent;
  formOpen.value = true;
}

function remove(node: Node) {
  window.$dialog?.warning({
    title: $t('common.delete'),
    content: $t('page.catalog.category.deleteConfirm', { name: nameOf(node) }),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: async () => {
      const { error } = await deleteCategory(node.id);
      if (error) return;
      window.$message?.success($t('common.deleteSuccess'));
      await refresh();
    }
  });
}

async function saveOrder() {
  const items: { id: number; parentId: number | null; sort: number }[] = [];
  const walk = (list: Node[], parent: number | null) =>
    list.forEach((node, index) => {
      items.push({ id: node.id, parentId: parent, sort: (index + 1) * 10 });
      walk(node.children, node.id);
    });
  walk(nodes.value, null);
  savingOrder.value = true;
  const { error } = await reorderCategories({ items });
  savingOrder.value = false;
  if (error) return;
  window.$message?.success($t('page.shared.saved'));
  await refresh();
}
</script>

<template>
  <NCard :title="$t('page.catalog.category.title')" :bordered="false" size="small" class="card-wrapper">
    <template #header-extra>
      <div class="flex items-center gap-8px">
        <NText v-if="moved" depth="3" class="text-12px">{{ $t('page.catalog.category.orderChanged') }}</NText>
        <NButton v-if="moved" size="small" type="primary" :loading="savingOrder" @click="saveOrder">
          {{ $t('page.catalog.category.saveOrder') }}
        </NButton>
        <NButton v-if="editable" size="small" type="primary" ghost @click="openForm(null)">
          {{ $t('page.catalog.category.addRoot') }}
        </NButton>
        <NButton size="small" :loading="loading" @click="refresh">{{ $t('common.refresh') }}</NButton>
      </div>
    </template>
    <NSpin :show="loading">
      <div class="overflow-x-auto">
        <div class="min-w-1100px">
          <div class="category-row grid items-center gap-12px border-b border-base-text/10 px-12px py-8px font-600">
            <span>{{ $t('page.catalog.category.columns.icon') }}</span>
            <span>{{ $t('page.catalog.category.columns.name') }}</span>
            <span>{{ $t('page.catalog.category.columns.languages') }}</span>
            <span>{{ $t('page.catalog.category.columns.slug') }}</span>
            <span>{{ $t('page.catalog.category.columns.appliesTo') }}</span>
            <span class="text-right">{{ $t('page.catalog.category.columns.packageCount') }}</span>
            <span>{{ $t('page.catalog.category.columns.visible') }}</span>
            <span>{{ $t('page.catalog.category.columns.hiddenByDefault') }}</span>
            <span v-if="editable" class="text-right">{{ $t('common.operate') }}</span>
          </div>
          <CategoryRows
            v-model="nodes"
            :editable="editable"
            @moved="moved = true"
            @edit="node => openForm(node)"
            @add-child="node => openForm(null, node.id)"
            @remove="remove"
          />
          <NEmpty v-if="!nodes.length && !loading" class="py-32px" />
        </div>
      </div>
    </NSpin>
    <CategoryForm v-model:show="formOpen" :node="editing" :parent-id="parentId" @saved="refresh" />
  </NCard>
</template>

<style scoped>
.category-row {
  grid-template-columns: 96px minmax(120px, 1.2fr) minmax(120px, 1.2fr) minmax(120px, 1fr) 72px 64px 64px 80px 220px;
}
</style>
