<script setup lang="ts">
import { VueDraggable } from 'vue-draggable-plus';
import type { Schemas } from '@/typings/api/opennavo';
import { useCategoryTree } from '@/hooks/business/category';
import { $t } from '@/locales';
import { CONTENT_LOCALES, localeName } from '@/utils/content-locale';

defineOptions({ name: 'CategoryRows' });

type Node = Schemas['AdminCategoryNode'];

// One tree-table level: reorder siblings only, recursively indent children below.
defineProps<{ depth?: number; editable: boolean }>();
const nodes = defineModel<Node[]>({ required: true });
const emit = defineEmits<{ moved: []; edit: [node: Node]; addChild: [node: Node]; remove: [node: Node] }>();

const { nameOf } = useCategoryTree();

// Language column: source language and populated locale count / 6.
function languages(node: Node) {
  const count = CONTENT_LOCALES.filter(code => node.i18n[code]).length;
  const source = node.sourceLocale ? localeName(node.sourceLocale) : '—';
  return `${source} · ${count}/${CONTENT_LOCALES.length}`;
}
</script>

<template>
  <VueDraggable
    v-model="nodes"
    :animation="150"
    :disabled="!editable"
    handle=".drag-handle"
    :group="`level-${depth ?? 0}-${nodes[0]?.parentId ?? 'root'}`"
    @end="emit('moved')"
  >
    <div v-for="node in nodes" :key="node.id">
      <div class="category-row grid items-center gap-12px border-b border-base-text/10 px-12px py-8px">
        <span class="flex items-center gap-6px" :style="{ paddingLeft: `${(depth ?? 0) * 24}px` }">
          <icon-lucide-grip-vertical v-if="editable" class="drag-handle shrink-0 cursor-grab text-16px opacity-60" />
          <SvgIcon :icon="node.icon" class="shrink-0 text-18px" />
        </span>
        <span class="truncate font-500">{{ nameOf(node) }}</span>
        <span class="truncate text-12px opacity-80">{{ languages(node) }}</span>
        <span class="truncate font-mono text-12px">{{ node.slug }}</span>
        <span>{{ $t(`page.catalog.category.appliesTo.${node.appliesTo}`) }}</span>
        <span class="text-right tabular-nums">{{ node.packageCount }}</span>
        <span>
          <NTag size="small" :bordered="false" :type="node.visible ? 'success' : 'default'">
            {{ node.visible ? $t('page.shared.yes') : $t('page.shared.no') }}
          </NTag>
        </span>
        <span>{{ node.hiddenByDefault ? $t('page.shared.yes') : $t('page.shared.no') }}</span>
        <span v-if="editable" class="flex justify-end gap-4px">
          <NButton size="tiny" quaternary type="primary" @click="emit('edit', node)">{{ $t('common.edit') }}</NButton>
          <NButton v-if="!node.parentId" size="tiny" quaternary @click="emit('addChild', node)">
            {{ $t('page.catalog.category.addChild') }}
          </NButton>
          <NButton size="tiny" quaternary type="error" @click="emit('remove', node)">{{ $t('common.delete') }}</NButton>
        </span>
      </div>
      <CategoryRows
        v-if="node.children.length"
        v-model="node.children"
        :depth="(depth ?? 0) + 1"
        :editable="editable"
        @moved="emit('moved')"
        @edit="child => emit('edit', child)"
        @add-child="child => emit('addChild', child)"
        @remove="child => emit('remove', child)"
      />
    </div>
  </VueDraggable>
</template>

<style scoped>
.category-row {
  grid-template-columns: 96px minmax(120px, 1.2fr) minmax(120px, 1.2fr) minmax(120px, 1fr) 72px 64px 64px 80px 220px;
}
</style>
