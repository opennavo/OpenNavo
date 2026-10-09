<script setup lang="ts">
import { computed as computedFormattingLocale } from 'vue';
import { useAppStore as useFormattingAppStore } from '@/store/modules/app';
import { watch } from 'vue';
import dayjs from 'dayjs';
import { color } from '@opennavo/tokens';
import { formatCount } from '@opennavo/shared';
import type { DataOf } from '@/typings/api/opennavo';
import { useEcharts } from '@/hooks/common/echarts';
import { useAppStore } from '@/store/modules/app';
import { $t } from '@/locales';

const formattingAppStore = useFormattingAppStore();
const formattingLocale = computedFormattingLocale(() => formattingAppStore.locale);

defineOptions({ name: 'UsageChart' });

const props = defineProps<{ usage: DataOf<'getLlmUsage'> }>();

const appStore = useAppStore();
// Only content translation still uses LLMs; retain two retired jobs for six-month usage history.
const TASKS = ['translate_content', 'enrich_package', 'translate_release'] as const;

// Six-month usage bars grouped by task (chart.series1/2 with legend); missing months display zero.
function build() {
  const months = Array.from({ length: 6 }, (_, index) =>
    dayjs()
      .subtract(5 - index, 'month')
      .format('YYYY-MM')
  );
  const total = (month: string, task: (typeof TASKS)[number]) =>
    props.usage
      .filter(item => item.month === month && item.task === task)
      .reduce((sum, item) => sum + item.promptTokens + item.completionTokens, 0);
  return {
    color: [color.chart.series1, color.chart.series2],
    tooltip: {
      trigger: 'axis' as const,
      axisPointer: { type: 'shadow' as const },
      valueFormatter: (value: unknown) => formatCount(Number(value), { locale: formattingLocale.value })
    },
    legend: { top: 0, data: TASKS.map(task => $t(`page.dashboard.usageSeries.${task}`)) },
    grid: { left: 8, right: 8, bottom: 0, top: 40, containLabel: true },
    xAxis: { type: 'category' as const, data: months },
    yAxis: {
      type: 'value' as const,
      minInterval: 1,
      axisLabel: { formatter: (value: number) => formatCount(value, { locale: formattingLocale.value }) }
    },
    series: TASKS.map(task => ({
      name: $t(`page.dashboard.usageSeries.${task}`),
      type: 'bar' as const,
      barMaxWidth: 18,
      itemStyle: { borderRadius: [4, 4, 0, 0] },
      data: months.map(month => total(month, task))
    }))
  };
}

const { domRef, updateOptions } = useEcharts(build);

watch([() => props.usage, () => appStore.locale], () => updateOptions((_, factory) => factory()));
</script>

<template>
  <NCard :bordered="false" size="small" class="card-wrapper h-full" :title="$t('page.dashboard.usage')">
    <div ref="domRef" class="h-300px overflow-hidden"></div>
  </NCard>
</template>
