<script setup lang="ts">
import { formatDate } from '~/utils/packageDate';
import { OnCodeText, parseInline } from '@opennavo/ui';
import { isValidLabel, labelPath } from '~/utils/backgroundItems';
import type { UninstallFact } from '~/utils/packageFacts';
import { aroundDate, isoDate, uninstallFacts } from '~/utils/packageFacts';
import type { PackagePage } from '~/utils/packageFacts';
import { packagePath } from '~/utils/packageView';
import { installLifecycle } from '~/utils/packageInstall';
import { uninstallPageOpen } from '~/utils/uninstallPage';

// Uninstall {name} and optional data cleanup (T2): the regular uninstall with what Homebrew's definition
// declares it also removes (background services, login items, installer receipts, files), then --zap as an
// optional clean-up of user data with its risks, and every path it would delete in full, collapsed but in the
// HTML. Declarations say what the definition intends, not what is on a given Mac. Background services, login
// items and receipts link to their background-items page (F1). Link apps never get a Homebrew command (T3);
// they only show declarations if facts list any.
// `guide`: link the standalone uninstall page (X2) when the server opens it; off on that page itself.
const props = withDefaults(
  defineProps<{
    pkg: PackagePage;
    homebrew: boolean;
    guide?: boolean;
    compact?: boolean;
    showChecked?: boolean;
  }>(),
  { guide: true, compact: false, showChecked: true }
);

const { t, locale } = useI18n();
const localePath = useLocalePath();
const toasts = useToasts();
const appLocale = computed(() => toAppLocale(locale.value));
// Homebrew-disabled packages hide uninstall / Deep clean commands (same guard as install).
const commandsAllowed = computed(() => installLifecycle(props.pkg, t).state !== 'disabled');

const KINDS = ['launchctl', 'login_item', 'pkgutil', 'zap'] as const;

function groups(items: UninstallFact[]) {
  return KINDS.flatMap(kind => {
    const values = [...new Set(items.filter(item => item.kind === kind).map(item => item.value))].map(value => ({
      value,
      // Labels have their own page; files do not.
      href: kind !== 'zap' && isValidLabel(value) ? labelPath(value, localePath('/')) : undefined
    }));
    return values.length ? [{ kind, label: t(`package.uninstall.kinds.${kind}`), values }] : [];
  });
}

const regular = computed(() => groups(uninstallFacts(props.pkg, 'uninstall')));
const cleanup = computed(() => groups(uninstallFacts(props.pkg, 'zap')));
const cleanupCount = computed(() => cleanup.value.reduce((sum, group) => sum + group.values.length, 0));
const codeClass = 'font-mono text-12px text-component-mono-text [overflow-wrap:anywhere]';
const zapWarning = computed(() => parseInline(t('package.guide.zap')));

// One source for all declarations: the Homebrew definition, as checked (or as of its last change).
const checked = computed(() => {
  const evidence = props.pkg.facts.uninstall.find(item => item.evidence.checkedAt)?.evidence;
  if (!evidence?.checkedAt) return null;
  return {
    iso: isoDate(evidence.checkedAt),
    date: formatDate(evidence.checkedAt, { locale: appLocale.value }),
    ...aroundDate(t, evidence.status === 'stale' ? 'package.uninstall.asOf' : 'package.uninstall.checked')
  };
});
const visible = computed(
  () =>
    (props.homebrew && commandsAllowed.value) ||
    regular.value.length > 0 ||
    (cleanup.value.length > 0 && commandsAllowed.value)
);
const guidePath = computed(() =>
  props.guide && uninstallPageOpen(props.pkg) ? localePath(packagePath(props.pkg.token, 'uninstall')) : null
);

function onCopied(command: string) {
  toasts.push({ tone: 'success', title: t('toast.copied'), description: command });
}
</script>

<template>
  <section
    v-if="visible"
    id="uninstall"
    :class="
      compact
        ? 'mt-16px border-t border-t-solid border-line-subtle pt-14px'
        : 'rounded-big border border-solid border-line-subtle bg-surface-card px-18px py-16px'
    "
    aria-labelledby="uninstall-title"
    data-testid="package-uninstall"
  >
    <h2 id="uninstall-title" class="m-0 text-13.5px font-600 text-ink-primary">
      {{ t('package.uninstall.title', { name: pkg.displayName }) }}
    </h2>
    <div v-if="homebrew && commandsAllowed" class="mt-10px flex flex-col gap-8px">
      <PackageCommand
        :command="`brew uninstall --cask ${pkg.token}`"
        :copy-label="t('package.copy.uninstall')"
        :title="t('package.guide.uninstallTitle')"
        @copied="onCopied"
      />
      <p class="m-0 text-12px leading-[1.6] text-ink-tertiary">
        {{ t('package.guide.uninstall') }}
      </p>
    </div>
    <div v-if="!compact && regular.length" class="mt-10px">
      <h3 class="m-0 text-12.5px font-600 text-ink-primary">{{ t('package.uninstall.also') }}</h3>
      <dl class="m-0 mt-6px flex flex-col gap-6px text-12.5px leading-[1.6]">
        <div v-for="group in regular" :key="group.kind">
          <dt class="text-ink-tertiary">{{ group.label }}</dt>
          <dd v-for="item in group.values" :key="item.value" class="m-0 text-ink-secondary">
            <NuxtLink v-if="item.href" :to="item.href" class="underline-offset-2 hover:underline"
              ><code :class="codeClass">{{ item.value }}</code></NuxtLink
            >
            <code v-else :class="codeClass">{{ item.value }}</code>
          </dd>
        </div>
      </dl>
    </div>
    <details v-if="cleanup.length && commandsAllowed" class="mt-12px flex flex-col gap-8px" data-testid="package-zap">
      <summary
        class="cursor-pointer text-12.5px font-600 text-ink-primary outline-none focus-visible:shadow-focus-ring"
      >
        {{ t('package.guide.zapTitle') }}
      </summary>
      <PackageCommand
        v-if="homebrew"
        :command="`brew uninstall --zap --cask ${pkg.token}`"
        :copy-label="t('package.copy.cleanup')"
        :title="t('package.guide.uninstallTitle')"
        @copied="onCopied"
      />
      <p class="m-0 text-12px leading-[1.6] text-ink-tertiary">
        <template v-for="(part, index) in zapWarning" :key="index">
          <code
            v-if="part.type === 'code'"
            class="rounded-tiny bg-surface-inset px-4px font-mono text-11.5px text-component-mono-text"
            ><OnCodeText :text="part.text"
          /></code>
          <template v-else>{{ part.text }}</template>
        </template>
      </p>
      <details v-if="!compact" id="uninstall-files" class="text-12.5px leading-[1.6]">
        <summary
          class="cursor-pointer text-ink-secondary outline-none hover:text-ink-primary focus-visible:shadow-focus-ring"
        >
          {{ t('package.uninstall.files', { name: pkg.displayName, count: cleanupCount }) }}
        </summary>
        <dl class="m-0 mt-6px flex flex-col gap-6px">
          <div v-for="group in cleanup" :key="group.kind">
            <dt class="text-ink-tertiary">{{ group.label }}</dt>
            <dd v-for="item in group.values" :key="item.value" class="m-0 text-ink-secondary">
              <NuxtLink v-if="item.href" :to="item.href" class="underline-offset-2 hover:underline"
                ><code :class="codeClass">{{ item.value }}</code></NuxtLink
              >
              <code v-else :class="codeClass">{{ item.value }}</code>
            </dd>
          </div>
        </dl>
      </details>
    </details>
    <p
      v-if="!compact && showChecked && checked && (regular.length || cleanup.length)"
      class="m-0 mt-10px text-11.5px text-ink-tertiary"
    >
      {{ checked.before }}<time :datetime="checked.iso">{{ checked.date }}</time
      >{{ checked.after }}
    </p>
    <p v-if="guidePath" class="m-0 mt-10px text-12.5px">
      <NuxtLink :to="guidePath" class="text-ink-secondary">{{
        t('package.uninstallPage.guideLink', { name: pkg.displayName })
      }}</NuxtLink>
    </p>
  </section>
</template>
