<script setup lang="ts">
import { computed } from 'vue';
import { $t } from '@/locales';

defineOptions({ name: 'AuditDiff' });

const props = defineProps<{ before?: Record<string, unknown> | null; after?: Record<string, unknown> | null }>();

// Show only changed fields by JSON comparison, displaying values in monospace.
const rows = computed(() => {
  const before = props.before ?? {};
  const after = props.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const show = (value: unknown) => (value === undefined ? '—' : JSON.stringify(value, null, 2));
  return keys
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => ({ key, before: show(before[key]), after: show(after[key]) }));
});
</script>

<template>
  <NTable v-if="rows.length" size="small" :single-line="false">
    <thead>
      <tr>
        <th class="w-160px"></th>
        <th>{{ $t('page.catalog.packageDetail.audit.before') }}</th>
        <th>{{ $t('page.catalog.packageDetail.audit.after') }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.key">
        <td class="font-mono text-12px">{{ row.key }}</td>
        <td>
          <pre class="m-0 whitespace-pre-wrap break-all font-mono text-12px">{{ row.before }}</pre>
        </td>
        <td>
          <pre class="m-0 whitespace-pre-wrap break-all font-mono text-12px">{{ row.after }}</pre>
        </td>
      </tr>
    </tbody>
  </NTable>
  <NEmpty v-else />
</template>
