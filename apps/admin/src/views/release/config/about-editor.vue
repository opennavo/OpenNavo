<script setup lang="ts">
import { computed } from 'vue';
import { DEFAULT_LOCALE, LOCALE_METADATA } from '@opennavo/shared';
import { $t } from '@/locales';

type Section = { key: string; title: string; paragraphs: string[]; draft: boolean };
type About = { sourceLocale?: string | null; locales: Record<string, Section[]>; modules: unknown[] };
const model = defineModel<string>({ required: true });
const content = computed(() => JSON.parse(model.value) as About);
const sourceLocale = computed(() => content.value.sourceLocale || DEFAULT_LOCALE);
function update(locale: string, index: number, patch: Partial<Section>) {
  const value = JSON.parse(model.value) as About;
  value.sourceLocale = sourceLocale.value;
  Object.assign(value.locales[locale]![index]!, patch);
  model.value = JSON.stringify(value, null, 2);
}
</script>

<template>
  <NTabs type="line" :default-value="sourceLocale" animated>
    <NTabPane
      v-for="(sections, locale) in content.locales"
      :key="locale"
      :name="locale"
      :tab="LOCALE_METADATA[locale as keyof typeof LOCALE_METADATA]?.name ?? locale"
    >
      <div class="max-h-60vh overflow-auto pr-12px">
        <section v-for="(section, index) in sections" :key="section.key" class="mb-20px">
          <NFormItem :label="$t('page.release.config.sectionTitle')">
            <NInput
              :disabled="locale !== (section.key === 'openSource' ? 'en-US' : sourceLocale)"
              :value="section.title"
              @update:value="title => update(locale, index, { title })"
            />
          </NFormItem>
          <NFormItem :label="$t('page.release.config.paragraphs')">
            <NInput
              :disabled="locale !== (section.key === 'openSource' ? 'en-US' : sourceLocale)"
              type="textarea"
              :autosize="{ minRows: 3, maxRows: 8 }"
              :value="section.paragraphs.join('\n\n')"
              @update:value="value => update(locale, index, { paragraphs: value.split(/\n\s*\n/).filter(Boolean) })"
            />
          </NFormItem>
          <NCheckbox
            :disabled="locale !== sourceLocale"
            :checked="section.draft"
            @update:checked="draft => update(locale, index, { draft })"
          >
            {{ $t('page.release.config.draft') }}
          </NCheckbox>
        </section>
      </div>
    </NTabPane>
  </NTabs>
  <NText depth="3">{{ $t('page.release.config.moduleCount', { count: content.modules.length }) }}</NText>
</template>
