<script setup lang="ts">
import { computed as computedFormattingLocale } from 'vue';
import { useAppStore as useFormattingAppStore } from '@/store/modules/app';
import { formatCount } from '@opennavo/shared';
import type { DataOf } from '@/typings/api/opennavo';
import { $t } from '@/locales';

const formattingAppStore = useFormattingAppStore();
const formattingLocale = computedFormattingLocale(() => formattingAppStore.locale);

defineOptions({ name: 'QueueCards' });

defineProps<{ queues: DataOf<'listQueues'> }>();

const FIELDS = ['pending', 'active', 'scheduled', 'retry', 'archived', 'processedToday', 'failedToday'] as const;
</script>

<template>
  <NGrid :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
    <NGi v-for="queue in queues" :key="queue.queue" span="24 s:12 l:6">
      <NCard :bordered="false" size="small" class="card-wrapper h-full" :title="queue.queue">
        <dl class="m-0 grid grid-cols-[repeat(4,minmax(0,1fr))] gap-y-10px">
          <div v-for="field in FIELDS" :key="field" class="flex-col gap-2px">
            <NText depth="3" tag="dt" class="text-12px">{{ $t(`page.ops.job.queueFields.${field}`) }}</NText>
            <dd
              class="m-0 text-16px font-600 tabular-nums"
              :class="{ 'text-error': (field === 'failedToday' || field === 'retry') && queue[field] > 0 }"
            >
              {{ formatCount(queue[field], { locale: formattingLocale }) }}
            </dd>
          </div>
        </dl>
      </NCard>
    </NGi>
  </NGrid>
</template>
