<script setup lang="ts">
import AuditLogTable from '@/components/opennavo/audit-log-table.vue';

defineOptions({ name: 'AuditTab' });

// Package audit logs; hide tab without system:audit:view.
defineProps<{ entityType: string; entityId: string }>();
</script>

<template>
  <AuditLogTable :filters="{ entityType, entityId }" />
</template>
