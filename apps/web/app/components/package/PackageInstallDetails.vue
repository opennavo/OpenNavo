<script setup lang="ts">
import type { PackageKind } from '@opennavo/shared';
import { detailsDescription } from '~/utils/seoTitles';
import PackageInstallDetailsContent from './PackageInstallDetailsContent.vue';

// Installation details page (08 §10.8): the shared body keeps the install command, requirements,
// downloads/checksums, caveats and the remaining facts in one place. The overview renders the same
// body when the server consolidates this page there (indexing.detailsRedirect).
const props = defineProps<{ kind: PackageKind }>();

const { t } = useI18n();
const { data: pkg, token } = await usePackage(props.kind);
// Link apps have no Homebrew definition; the layout hides this tab for them (usePackage resolves the kind).
if (pkg.value?.kind === 'link') throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true });

usePageSeo({
  title: () => t('package.details.metaTitle', { name: pkg.value?.displayName ?? token.value }),
  description: () => detailsDescription(pkg.value?.displayName ?? token.value, t)
});
</script>

<template>
  <PackageInstallDetailsContent v-if="pkg" :pkg="pkg" />
</template>
