<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { createAgentToken, updateAgentToken } from '@/service/api';
import type { DataOf, Schemas } from '@/typings/api/opennavo';
import { $t } from '@/locales';
import { groupLabel, groupPermissions, permissionLabel } from './permissions';
import type { AgentPermission } from './permissions';
import { buildTokenBody } from './token';
import type { TokenForm } from './token';

defineOptions({ name: 'AgentTokenForm' });

// Create/edit tokens (11 §2.2): individual permissions (all selected initially), deletion allowed by default, expiry (90 days), source IPs.
const props = defineProps<{
  clientId: number | null;
  token: Schemas['AgentToken'] | null;
  grantable: AgentPermission[];
}>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ saved: []; created: [result: DataOf<'createAgentToken'>] }>();

const model = reactive<TokenForm>({
  name: '',
  permissions: [],
  allowDelete: true,
  expiry: 'default',
  expiresAt: null,
  ipAllowlist: []
});
const saving = ref(false);
const editing = computed(() => Boolean(props.token));
const groups = computed(() => groupPermissions(props.grantable));

watch(show, open => {
  if (!open) return;
  const token = props.token;
  if (token) {
    Object.assign(model, {
      name: token.name,
      permissions: [...token.permissions],
      allowDelete: token.allowDelete,
      expiry: token.expiresAt ? 'custom' : 'never',
      expiresAt: token.expiresAt ? new Date(token.expiresAt).getTime() : null,
      ipAllowlist: [...token.ipAllowlist]
    });
  } else {
    Object.assign(model, {
      name: '',
      permissions: [...props.grantable],
      allowDelete: true,
      expiry: 'default',
      expiresAt: null,
      ipAllowlist: []
    });
  }
}, { immediate: true });

const expiryOptions = computed(() =>
  (editing.value ? (['custom', 'never'] as const) : (['default', 'custom', 'never'] as const)).map(value => ({
    value,
    label: $t(`page.system.agent.expiry.${value}`)
  }))
);

function groupState(codes: AgentPermission[]) {
  const picked = codes.filter(code => model.permissions.includes(code)).length;
  return { checked: picked === codes.length, indeterminate: picked > 0 && picked < codes.length };
}

function toggleGroup(codes: AgentPermission[], checked: boolean) {
  const rest = model.permissions.filter(code => !codes.includes(code));
  model.permissions = checked ? [...rest, ...codes] : rest;
}

const allState = computed(() => groupState(props.grantable));

async function save() {
  if (!model.name.trim()) {
    window.$message?.warning($t('page.system.agent.tokenNameRequired'));
    return;
  }
  if (model.expiry === 'custom' && (!model.expiresAt || model.expiresAt <= Date.now())) {
    window.$message?.warning($t('page.system.agent.expiryInvalid'));
    return;
  }
  saving.value = true;
  const body = buildTokenBody(model);
  if (props.token) {
    const { error } = await updateAgentToken(props.token.id, body);
    saving.value = false;
    if (error) return;
    window.$message?.success($t('page.shared.saved'));
    show.value = false;
    emit('saved');
    return;
  }
  if (props.clientId === null) {
    saving.value = false;
    return;
  }
  const { data, error } = await createAgentToken(props.clientId, body);
  saving.value = false;
  if (error) return;
  show.value = false;
  emit('created', data);
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="editing ? $t('page.system.agent.editToken') : $t('page.system.agent.addToken')"
    class="w-780px"
  >
    <NForm label-placement="left" label-width="auto">
      <NFormItem :label="$t('page.system.agent.tokenName')" required>
        <NInput v-model:value="model.name" :maxlength="128" :placeholder="$t('page.system.agent.tokenNamePlaceholder')" />
      </NFormItem>
      <NFormItem :label="$t('page.system.agent.permissions')">
        <div class="w-full flex-col gap-12px">
          <div class="flex items-center gap-12px">
            <NCheckbox
              :checked="allState.checked"
              :indeterminate="allState.indeterminate"
              @update:checked="(value: boolean) => toggleGroup([...grantable], value)"
            >
              {{ $t('page.system.agent.selectAll') }}
            </NCheckbox>
            <NText depth="3" class="text-12px">
              {{ $t('page.system.agent.permissionCount', { picked: model.permissions.length, total: grantable.length }) }}
            </NText>
          </div>
          <div v-for="group in groups" :key="group.key" class="flex-col gap-6px">
            <NCheckbox
              :checked="groupState(group.codes).checked"
              :indeterminate="groupState(group.codes).indeterminate"
              @update:checked="(value: boolean) => toggleGroup(group.codes, value)"
            >
              <span class="font-600">{{ groupLabel(group.key) }}</span>
            </NCheckbox>
            <NCheckboxGroup v-model:value="model.permissions">
              <div class="grid grid-cols-2 gap-x-16px gap-y-6px pl-24px lt-sm:grid-cols-1">
                <NCheckbox v-for="code in group.codes" :key="code" :value="code">
                  <div class="flex-col leading-[1.4]">
                    <span>{{ permissionLabel(code) }}</span>
                    <span class="text-11px font-mono opacity-60">{{ code }}</span>
                  </div>
                </NCheckbox>
              </div>
            </NCheckboxGroup>
          </div>
          <NText depth="3" class="text-12px">{{ $t('page.system.agent.permissionsHint') }}</NText>
        </div>
      </NFormItem>
      <NFormItem :label="$t('page.system.agent.allowDelete')">
        <div class="flex items-center gap-12px">
          <NSwitch v-model:value="model.allowDelete" />
          <NText depth="3" class="text-12px">{{ $t('page.system.agent.allowDeleteHint') }}</NText>
        </div>
      </NFormItem>
      <NFormItem :label="$t('page.system.agent.expiresAt')">
        <div class="flex flex-wrap items-center gap-12px">
          <NRadioGroup v-model:value="model.expiry">
            <NRadio v-for="option in expiryOptions" :key="option.value" :value="option.value">{{ option.label }}</NRadio>
          </NRadioGroup>
          <NDatePicker
            v-if="model.expiry === 'custom'"
            v-model:value="model.expiresAt"
            type="datetime"
            :is-date-disabled="(ts: number) => ts < Date.now() - 86_400_000"
            class="w-220px"
          />
        </div>
      </NFormItem>
      <NFormItem :label="$t('page.system.agent.ipAllowlist')">
        <div class="flex-col gap-4px">
          <NDynamicTags v-model:value="model.ipAllowlist" :max="100" :input-props="{ maxlength: 64 }" />
          <NText depth="3" class="text-12px">{{ $t('page.system.agent.ipAllowlistHint') }}</NText>
        </div>
      </NFormItem>
    </NForm>
    <template #footer>
      <div class="flex justify-end gap-12px">
        <NButton @click="show = false">{{ $t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="save">{{ $t('common.confirm') }}</NButton>
      </div>
    </template>
  </NModal>
</template>
