<script setup lang="ts">
import { VueDraggable } from 'vue-draggable-plus';
import type { RecordOf } from '@/typings/api/opennavo';
import PackageIcon from '@/components/opennavo/package-icon.vue';
import PackagePicker from '@/components/opennavo/package-picker.vue';
import { useLocalizedPackage } from '@/hooks/business/localized';
import { $t } from '@/locales';
import { blankTexts, localeName } from '@/utils/content-locale';
import type { ContentLocale } from '@/utils/content-locale';
import type { EditableItem } from './types';

defineOptions({ name: 'ItemsEditor' });

// Collection items: remote search, drag sorting, source recommendations with AI translations; disabled packages marked red and hidden publicly.
const props = defineProps<{ sourceLocale: ContentLocale }>();
const MAX = 100;
const items = defineModel<EditableItem[]>({ required: true });
const { nameOf } = useLocalizedPackage();

function noteOf(item: EditableItem): string {
  return item.notes[item.sourceLocale]?.note ?? '';
}

function setNote(item: EditableItem, value: string) {
  item.notes[item.sourceLocale] = { note: value };
}

function add(row: RecordOf<'listAdminPackages'>) {
  if (items.value.length >= MAX) {
    window.$message?.warning($t('page.content.collectionDetail.maxItems'));
    return;
  }
  if (items.value.some(item => item.packageId === row.id)) {
    window.$message?.info($t('page.content.collectionDetail.duplicate'));
    return;
  }
  items.value = [
    ...items.value,
    {
      packageId: row.id,
      kind: row.kind,
      token: row.token,
      name: nameOf(row),
      iconUrl: row.iconUrl ?? null,
      disabled: row.disabled,
      // New item recommendations use the collection's source language.
      sourceLocale: props.sourceLocale,
      notes: blankTexts(['note'], props.sourceLocale),
      original: {}
    }
  ];
}

function remove(packageId: number) {
  items.value = items.value.filter(item => item.packageId !== packageId);
}
</script>

<template>
  <div class="flex-col gap-12px">
    <div class="flex items-center gap-12px">
      <PackagePicker
        :placeholder="$t('page.content.collectionDetail.addPackage')"
        data-picker="collection-items"
        class="max-w-420px"
        @pick="add"
      />
      <NText depth="3" class="text-12px">
        {{ $t('page.content.collectionDetail.itemsHint') }} · {{ items.length }} / {{ MAX }}
      </NText>
    </div>
    <NEmpty v-if="!items.length" :description="$t('page.content.collectionDetail.emptyItems')" />
    <VueDraggable v-else v-model="items" :animation="150" handle=".drag-handle" class="flex-col gap-8px">
      <NCard v-for="item in items" :key="item.packageId" size="small" embedded :data-token="item.token">
        <div class="flex items-start gap-12px">
          <icon-lucide-grip-vertical class="drag-handle mt-10px shrink-0 cursor-grab text-16px opacity-60" />
          <PackageIcon :url="item.iconUrl" :name="item.name" :kind="item.kind" :size="36" />
          <div class="min-w-0 flex-1 flex-col gap-6px">
            <div class="flex flex-wrap items-center gap-8px">
              <span class="font-600">{{ item.name }}</span>
              <NText depth="3" class="font-mono text-12px">{{ item.token }}</NText>
              <NTag v-if="item.disabled" size="small" type="error" :bordered="false">
                {{ $t('page.content.collectionDetail.disabledPackage') }}
              </NTag>
            </div>
            <NInput
              :value="noteOf(item)"
              size="small"
              :maxlength="160"
              show-count
              :placeholder="$t('page.content.collectionDetail.note', { locale: localeName(item.sourceLocale) })"
              @update:value="value => setNote(item, value)"
            />
          </div>
          <NButton size="small" quaternary type="error" @click="remove(item.packageId)">
            {{ $t('common.delete') }}
          </NButton>
        </div>
      </NCard>
    </VueDraggable>
  </div>
</template>
