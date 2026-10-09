import { createOnUi } from '@opennavo/ui';

// Component default copy follows i18n.
export default defineNuxtPlugin(nuxtApp => {
  const locale = computed(() => toAppLocale(nuxtApp.$i18n.locale.value));
  nuxtApp.vueApp.use(createOnUi({ locale }));
});
