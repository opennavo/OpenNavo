<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '@opennavo/api';
import { OnErrorState } from '@opennavo/ui';
import { refreshPage } from '@/composables/usePageRefresh';

const props = defineProps<{ error: unknown }>();
const { t } = useI18n();
const missing = computed(() => props.error instanceof ApiError && props.error.status === 404);
const requestId = computed(() => (props.error instanceof ApiError ? props.error.requestId : null));
</script>

<template>
  <OnErrorState
    :title="missing ? t('common.notFound') : undefined"
    :request-id="requestId"
    :retryable="!missing"
    @retry="refreshPage()"
  />
</template>
