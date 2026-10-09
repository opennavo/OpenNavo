<script setup lang="ts">
import { computed as computedFormattingLocale } from 'vue';
import { useAppStore as useFormattingAppStore } from '@/store/modules/app';
import { computed } from 'vue';
import { formatCount, formatCurrency, formatPercent } from '@opennavo/shared';
import type { DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';

const formattingAppStore = useFormattingAppStore();
const formattingLocale = computedFormattingLocale(() => formattingAppStore.locale);

defineOptions({ name: 'LlmCard' });

const props = defineProps<{ llm: DataOf<'getDashboardOverview'>['llm']; feedbackOpen: number }>();

const percent = computed(() =>
  props.llm.monthTokenBudget
    ? Math.min(100, Math.round((props.llm.monthTokens / props.llm.monthTokenBudget) * 1000) / 10)
    : 0
);
// Use warning color above 80% of budget (07 §7.1).
const status = computed(() => (percent.value > 80 ? 'warning' : 'default'));
const spend = computed(() => {
  const { monthSpendUsd, monthBudgetUsd } = props.llm;
  if (monthSpendUsd === null || monthSpendUsd === undefined) return '';
  return $t('page.dashboard.llmSpend', {
    spend: formatCurrency(monthSpendUsd, { locale: formattingLocale.value }),
    budget:
      monthBudgetUsd === null || monthBudgetUsd === undefined
        ? '—'
        : formatCurrency(monthBudgetUsd, { locale: formattingLocale.value })
  });
});

const counters = computed(() => [
  { key: 'pendingPackages', label: $t('page.dashboard.pendingPackages'), value: props.llm.pendingPackages },
  { key: 'pendingReleases', label: $t('page.dashboard.pendingReleases'), value: props.llm.pendingReleases },
  {
    key: 'needsReview',
    label: $t('page.dashboard.needsReview'),
    value: props.llm.needsReview,
    to: '/changelog/review',
    link: $t('page.dashboard.viewReview')
  }
]);
</script>

<template>
  <div class="h-full flex-col gap-16px">
    <NCard :bordered="false" size="small" class="card-wrapper" :title="$t('page.dashboard.llm')">
      <template #header-extra>
        <NText depth="3" class="text-12px">{{ $t('page.dashboard.llmModel', { model: llm.model }) }}</NText>
      </template>
      <div class="flex-col gap-6px">
        <NText depth="2" class="text-13px">{{ $t('page.dashboard.llmTokens') }}</NText>
        <span class="text-20px font-600 tabular-nums">
          {{ formatCount(llm.monthTokens, { locale: formattingLocale }) }}
        </span>
        <NProgress type="line" :percentage="percent" :status="status" :height="8" :show-indicator="false" />
        <NText depth="3" class="text-12px">
          {{
            $t('page.dashboard.llmBudget', { budget: formatCount(llm.monthTokenBudget, { locale: formattingLocale }) })
          }}
          · {{ formatPercent(percent / 100, { locale: formattingLocale, digits: 1 }) }}
          <template v-if="spend">· {{ spend }}</template>
        </NText>
      </div>
      <NDivider class="my-12px!" />
      <ul class="m-0 flex-col gap-8px p-0">
        <li v-for="item in counters" :key="item.key" class="flex items-center justify-between text-13px">
          <span>{{ item.label }}</span>
          <RouterLink v-if="item.to" :to="item.to" class="flex items-center gap-8px">
            <span class="font-600 tabular-nums">{{ formatCount(item.value, { locale: formattingLocale }) }}</span>
            <span class="text-12px text-primary">{{ item.link }} →</span>
          </RouterLink>
          <span v-else class="font-600 tabular-nums">{{ formatCount(item.value, { locale: formattingLocale }) }}</span>
        </li>
      </ul>
    </NCard>
    <NCard :bordered="false" size="small" class="card-wrapper" :title="$t('page.dashboard.todo')">
      <div class="flex items-center justify-between text-13px">
        <span>{{ $t('page.dashboard.feedbackOpen') }}</span>
        <RouterLink to="/ops/feedback" class="flex items-center gap-8px">
          <span class="text-20px font-600 tabular-nums">
            {{ formatCount(feedbackOpen, { locale: formattingLocale }) }}
          </span>
          <span class="text-12px text-primary">{{ $t('page.dashboard.viewFeedback') }} →</span>
        </RouterLink>
      </div>
    </NCard>
  </div>
</template>
