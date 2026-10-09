<script setup lang="ts">
import { computed } from 'vue';
import { useAuth } from '@/hooks/business/auth';

defineOptions({
  name: 'PermissionGate'
});

interface Props {
  /** Permission codes from getUserInfo buttons, e.g. catalog:package:edit; any match suffices. */
  code: string | string[];
}

const props = defineProps<Props>();

defineSlots<{ default?: () => unknown }>();

// Render nothing without permission, rather than disabling (07 §7 conventions).
const { hasAuth } = useAuth();
const allowed = computed(() => hasAuth(props.code));
</script>

<template>
  <slot v-if="allowed" />
</template>

<style scoped></style>
