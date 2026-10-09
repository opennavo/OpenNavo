<script setup lang="ts">
import { computed, useAttrs } from 'vue';
import { Icon } from '@iconify/vue';
import { interfaceIcons } from './interface-icons';
import { localIcons } from './local-icons';

defineOptions({ name: 'SvgIcon', inheritAttrs: false });

/**
 * Props
 *
 * - Support iconify and local svg icon
 * - If icon and localIcon are passed at the same time, localIcon will be rendered first
 */
interface Props {
  /** Iconify icon name */
  icon?: string;
  /** Local svg icon name */
  localIcon?: string;
}

const props = defineProps<Props>();

const attrs = useAttrs();

const bindAttrs = computed<{ class: string; style: string }>(() => ({
  class: (attrs.class as string) || '',
  style: (attrs.style as string) || ''
}));

const localComponent = computed(() => {
  const name = props.localIcon || 'no-icon';
  return Object.hasOwn(localIcons, name) ? localIcons[name] : localIcons['no-icon'];
});

/** If localIcon is passed, render localIcon first */
const renderLocalIcon = computed(() => props.localIcon || !props.icon);
const interfaceComponent = computed(() =>
  props.icon && Object.hasOwn(interfaceIcons, props.icon) ? interfaceIcons[props.icon] : undefined
);
</script>

<template>
  <template v-if="renderLocalIcon">
    <component :is="localComponent" aria-hidden="true" width="1em" height="1em" v-bind="bindAttrs" />
  </template>
  <template v-else-if="interfaceComponent">
    <component :is="interfaceComponent" aria-hidden="true" width="1em" height="1em" v-bind="bindAttrs" />
  </template>
  <template v-else>
    <Icon v-if="icon" :icon="icon" v-bind="bindAttrs" />
  </template>
</template>

<style scoped></style>
