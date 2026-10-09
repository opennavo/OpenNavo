/* Generated from tokens.json by packages/tokens/scripts/generate.ts; do not edit. After changing tokens.json, run `pnpm --filter @opennavo/tokens gen`. */
import type { GlobalThemeOverrides } from 'naive-ui';

/** Admin brand/status colors (08 §3.5): primaryLight in light mode, primaryDark in dark mode. */
export const adminColors = {
  "primaryLight": "#D04528",
  "primaryDark": "#FF7356",
  "info": "#66A4FA",
  "success": "#3FCF6C",
  "warning": "#FAB219",
  "error": "#FF5D51",
  "layoutDark": "#131313",
  "containerDark": "#1A1A1A",
  "textDark": "#EDEDED"
} as const;

/** Dark NaiveUI overrides: surfaces, text, borders, fonts, dark text on colored buttons. */
export const naiveDarkOverrides: GlobalThemeOverrides = {
  "common": {
    "fontFamily": "var(--on-font-family-sans)",
    "fontFamilyMono": "\"SF Mono\", \"JetBrains Mono\", ui-monospace, Menlo, Consolas, \"Liberation Mono\", monospace",
    "bodyColor": "#131313",
    "cardColor": "#1A1A1A",
    "modalColor": "#1A1A1A",
    "popoverColor": "#262626",
    "tableColor": "#1A1A1A",
    "tableHeaderColor": "#1F1F1F",
    "inputColor": "#1F1F1F",
    "actionColor": "#1F1F1F",
    "tagColor": "#2A2A2A",
    "textColorBase": "#EDEDED",
    "textColor1": "#EDEDED",
    "textColor2": "#A8A8A8",
    "textColor3": "#8F8F8F",
    "textColorDisabled": "#5C5C5C",
    "placeholderColor": "#8F8F8F",
    "dividerColor": "rgba(255, 255, 255, 0.07)",
    "borderColor": "rgba(255, 255, 255, 0.12)"
  },
  "Button": {
    "textColorPrimary": "#1B0A05",
    "textColorHoverPrimary": "#1B0A05",
    "textColorPressedPrimary": "#1B0A05",
    "textColorFocusPrimary": "#1B0A05",
    "textColorInfo": "#141414",
    "textColorHoverInfo": "#141414",
    "textColorPressedInfo": "#141414",
    "textColorFocusInfo": "#141414",
    "textColorSuccess": "#141414",
    "textColorHoverSuccess": "#141414",
    "textColorPressedSuccess": "#141414",
    "textColorFocusSuccess": "#141414",
    "textColorWarning": "#141414",
    "textColorHoverWarning": "#141414",
    "textColorPressedWarning": "#141414",
    "textColorFocusWarning": "#141414",
    "textColorError": "#141414",
    "textColorHoverError": "#141414",
    "textColorPressedError": "#141414",
    "textColorFocusError": "#141414"
  },
  "Checkbox": {
    "checkMarkColor": "#1B0A05"
  },
  "Radio": {
    "buttonTextColorActive": "#1B0A05"
  },
  "DatePicker": {
    "itemTextColorActive": "#1B0A05"
  }
};

/** Light NaiveUI overrides: standardize fonts, use dark text on status buttons. */
export const naiveLightOverrides: GlobalThemeOverrides = {
  "common": {
    "fontFamily": "var(--on-font-family-sans)",
    "fontFamilyMono": "\"SF Mono\", \"JetBrains Mono\", ui-monospace, Menlo, Consolas, \"Liberation Mono\", monospace"
  },
  "Button": {
    "textColorInfo": "#141414",
    "textColorHoverInfo": "#141414",
    "textColorPressedInfo": "#141414",
    "textColorFocusInfo": "#141414",
    "textColorSuccess": "#141414",
    "textColorHoverSuccess": "#141414",
    "textColorPressedSuccess": "#141414",
    "textColorFocusSuccess": "#141414",
    "textColorWarning": "#141414",
    "textColorHoverWarning": "#141414",
    "textColorPressedWarning": "#141414",
    "textColorFocusWarning": "#141414",
    "textColorError": "#141414",
    "textColorHoverError": "#141414",
    "textColorPressedError": "#141414",
    "textColorFocusError": "#141414"
  }
};
