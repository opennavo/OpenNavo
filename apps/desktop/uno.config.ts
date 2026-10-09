import { defineConfig, presetWind3 } from 'unocss';
import { presetOpenNavo } from '@opennavo/tokens/uno-preset';

export default defineConfig({
  presets: [presetWind3(), presetOpenNavo()]
});
