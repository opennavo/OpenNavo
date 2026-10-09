import { createApp, ref } from 'vue';
import '@unocss/reset/tailwind.css';
import '@fontsource-variable/inter/opsz.css';
import '@opennavo/tokens/tokens.css';
import '../../src/styles/base.css';
import 'virtual:uno.css';
import type { Locale } from '@opennavo/shared';
import { createOnUi } from '../../src';
import App from './App.vue';

const params = new URLSearchParams(location.search);
export const locale = ref<Locale>(params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US');

createApp(App).use(createOnUi({ locale })).mount('#app');
