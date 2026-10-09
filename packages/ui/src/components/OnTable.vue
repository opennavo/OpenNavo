<script setup lang="ts" generic="Row">
import { computed, ref } from 'vue';
import { interpolate } from '@opennavo/shared';
import { useUiMessages } from '../composables/locale';

export interface OnTableColumn {
  key: string;
  label: string;
  /** Numeric column: right-aligned tabular numerals. */
  numeric?: boolean;
  /** Monospace, e.g. version numbers. */
  mono?: boolean;
  sortable?: boolean;
  /** CSS width. */
  width?: string;
  /** Screen-reader-only header for actions. */
  hideLabel?: boolean;
}

export type OnTableSortOrder = 'asc' | 'desc';

export interface OnTableSort {
  key: string;
  order: OnTableSortOrder;
}

export interface OnTableProps<R> {
  columns: readonly OnTableColumn[];
  /** Data already sorted by sort; component only displays sort state. */
  rows: readonly R[];
  rowKey: (row: R) => string;
  /** Default cell content, otherwise read the column key. */
  cellValue?: (row: R, key: string) => unknown;
  sort?: OnTableSort | null;
  selectedKey?: string | null;
  /** De-emphasized dependency rows at 55% opacity. */
  dimmed?: (row: R) => boolean;
  caption?: string;
  /** Fixed-height scrolling with sticky header; virtualize above 200 rows. */
  height?: number;
}

const props = defineProps<OnTableProps<Row>>();

const emit = defineEmits<{
  'update:sort': [sort: OnTableSort];
  rowClick: [key: string, row: Row];
}>();

// Custom cells: #cell-{column key}="{ row, value }".
defineSlots<Record<string, (props: { row: Row; value: unknown }) => unknown>>();

const messages = useUiMessages();

const ROW_HEIGHT = 44;
const OVERSCAN = 10;
const VIRTUAL_FROM = 200;

const scrollTop = ref(0);
const virtual = computed(() => props.height !== undefined && props.rows.length > VIRTUAL_FROM);

const range = computed(() => {
  if (!virtual.value || props.height === undefined) return { start: 0, end: props.rows.length };
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(props.rows.length, Math.ceil((scrollTop.value + props.height) / ROW_HEIGHT) + OVERSCAN);
  return { start, end };
});

const visible = computed(() =>
  props.rows.slice(range.value.start, range.value.end).map((row, offset) => ({
    row,
    index: range.value.start + offset,
    key: props.rowKey(row)
  }))
);

function valueOf(row: Row, key: string): unknown {
  if (props.cellValue) return props.cellValue(row, key);
  return (row as Record<string, unknown>)[key];
}

function display(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function ariaSort(column: OnTableColumn) {
  if (props.sort?.key !== column.key) return column.sortable ? 'none' : undefined;
  return props.sort.order === 'asc' ? 'ascending' : 'descending';
}

// Click current column to reverse; new numeric columns default descending.
function toggleSort(column: OnTableColumn) {
  const order: OnTableSortOrder =
    props.sort?.key === column.key ? (props.sort.order === 'asc' ? 'desc' : 'asc') : column.numeric ? 'desc' : 'asc';
  emit('update:sort', { key: column.key, order });
}

function onScroll(event: Event) {
  scrollTop.value = (event.target as HTMLElement).scrollTop;
}

const sticky = computed(() => props.height !== undefined);
</script>

<template>
  <div class="box-border overflow-hidden rounded-big border border-solid border-line-subtle bg-surface-card font-sans">
    <div
      class="overflow-auto"
      :style="height === undefined ? undefined : { maxHeight: `${height}px` }"
      :tabindex="height === undefined ? undefined : 0"
      @scroll="onScroll"
    >
      <table class="w-full border-separate border-spacing-0 text-12.5px">
        <caption v-if="caption" class="sr-only">
          {{
            caption
          }}
        </caption>
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              scope="col"
              class="box-border h-38px whitespace-nowrap border-b border-b-solid border-line-subtle px-12px font-500 text-11.5px text-ink-tertiary"
              :class="[
                column.numeric ? 'text-right' : 'text-left',
                sticky ? 'sticky top-0 z-sticky bg-surface-card' : ''
              ]"
              :style="column.width ? { width: column.width } : undefined"
              :aria-sort="ariaSort(column)"
            >
              <span v-if="column.hideLabel" class="sr-only">{{ column.label }}</span>
              <button
                v-else-if="column.sortable"
                type="button"
                class="m-0 inline-flex items-center gap-2px rounded-tiny border-none bg-transparent p-0 font-sans font-500 text-11.5px text-ink-tertiary outline-none transition-colors duration-fast hover:text-ink-secondary focus-visible:shadow-focus-ring"
                :aria-label="interpolate(messages.table.sortBy, { label: column.label })"
                @click="toggleSort(column)"
              >
                {{ column.label }}
                <span v-if="sort?.key === column.key" class="text-ink-secondary" aria-hidden="true">{{
                  sort.order === 'asc' ? '▴' : '▾'
                }}</span>
              </button>
              <template v-else>{{ column.label }}</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="virtual && range.start > 0" aria-hidden="true">
            <td :colspan="columns.length" :style="{ height: `${range.start * ROW_HEIGHT}px` }" class="p-0"></td>
          </tr>
          <tr
            v-for="item in visible"
            :key="item.key"
            class="cursor-default"
            :class="item.key === selectedKey ? 'on-table-selected' : ''"
            @click="emit('rowClick', item.key, item.row)"
          >
            <td
              v-for="column in columns"
              :key="column.key"
              class="box-border h-44px whitespace-nowrap px-12px text-ink-secondary"
              :class="[
                item.index > 0 ? 'border-t border-t-solid border-surface-card-alt' : '',
                column.numeric ? 'text-right tabular-nums' : '',
                column.mono ? 'font-mono text-11.5px text-component-mono-text' : '',
                dimmed?.(item.row) ? 'opacity-55' : '',
                item.key === selectedKey ? 'bg-surface-card-alt' : ''
              ]"
            >
              <slot :name="`cell-${column.key}`" :row="item.row" :value="valueOf(item.row, column.key)">
                {{ display(valueOf(item.row, column.key)) }}
              </slot>
            </td>
          </tr>
          <tr v-if="virtual && range.end < rows.length" aria-hidden="true">
            <td
              :colspan="columns.length"
              :style="{ height: `${(rows.length - range.end) * ROW_HEIGHT}px` }"
              class="p-0"
            ></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
