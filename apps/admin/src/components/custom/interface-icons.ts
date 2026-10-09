import type { Component } from 'vue';
import AntDesignCloseOutlined from '~icons/ant-design/close-outlined';
import AntDesignColumnWidthOutlined from '~icons/ant-design/column-width-outlined';
import AntDesignLineOutlined from '~icons/ant-design/line-outlined';
import HeroiconsLanguage from '~icons/heroicons/language';
import LineMdMenuFoldLeft from '~icons/line-md/menu-fold-left';
import LineMdMenuFoldRight from '~icons/line-md/menu-fold-right';
import LucideActivity from '~icons/lucide/activity';
import LucideBoxes from '~icons/lucide/boxes';
import LucideBraces from '~icons/lucide/braces';
import LucideBriefcase from '~icons/lucide/briefcase';
import LucideClapperboard from '~icons/lucide/clapperboard';
import LucideCodeXml from '~icons/lucide/code-xml';
import LucideCpu from '~icons/lucide/cpu';
import LucideDatabase from '~icons/lucide/database';
import LucideGamepad2 from '~icons/lucide/gamepad-2';
import LucideGlobe from '~icons/lucide/globe';
import LucideGraduationCap from '~icons/lucide/graduation-cap';
import LucideLayoutDashboard from '~icons/lucide/layout-dashboard';
import LucideLibrary from '~icons/lucide/library';
import LucideMenu from '~icons/lucide/menu';
import LucideMessageCircle from '~icons/lucide/message-circle';
import LucideNetwork from '~icons/lucide/network';
import LucideNotebookPen from '~icons/lucide/notebook-pen';
import LucidePackage from '~icons/lucide/package';
import LucidePanelTop from '~icons/lucide/panel-top';
import LucidePenTool from '~icons/lucide/pen-tool';
import LucideRocket from '~icons/lucide/rocket';
import LucideRotateCcwClock from '~icons/lucide/rotate-ccw-clock';
import LucideSettings from '~icons/lucide/settings';
import LucideShield from '~icons/lucide/shield';
import LucideSparkles from '~icons/lucide/sparkles';
import LucideSquareTerminal from '~icons/lucide/square-terminal';
import LucideType from '~icons/lucide/type';
import LucideUserRound from '~icons/lucide/user-round';
import LucideWrench from '~icons/lucide/wrench';
import LucideZap from '~icons/lucide/zap';
import MajesticonsColorSwatchLine from '~icons/majesticons/color-swatch-line';
import MaterialSymbolsHdrAuto from '~icons/material-symbols/hdr-auto';
import MaterialSymbolsNightlightRounded from '~icons/material-symbols/nightlight-rounded';
import MaterialSymbolsSunny from '~icons/material-symbols/sunny';
import MdiFormatHorizontalAlignLeft from '~icons/mdi/format-horizontal-align-left';
import MdiFormatHorizontalAlignRight from '~icons/mdi/format-horizontal-align-right';
import MdiHelpCircle from '~icons/mdi/help-circle';
import MdiPin from '~icons/mdi/pin';
import MdiPinOff from '~icons/mdi/pin-off';
import MdiPinOffOutline from '~icons/mdi/pin-off-outline';
import MdiPinOutline from '~icons/mdi/pin-outline';
import PhCaretDoubleLeftBold from '~icons/ph/caret-double-left-bold';
import PhCaretDoubleRightBold from '~icons/ph/caret-double-right-bold';
import PhSignOut from '~icons/ph/sign-out';
import PhUserCircle from '~icons/ph/user-circle';

// Fixed interface and seeded category icons are compiled locally; no Iconify API request is needed.
export const interfaceIcons: Readonly<Record<string, Component>> = {
  'ant-design:close-outlined': AntDesignCloseOutlined,
  'ant-design:column-width-outlined': AntDesignColumnWidthOutlined,
  'ant-design:line-outlined': AntDesignLineOutlined,
  'heroicons:language': HeroiconsLanguage,
  'line-md:menu-fold-left': LineMdMenuFoldLeft,
  'line-md:menu-fold-right': LineMdMenuFoldRight,
  'lucide:activity': LucideActivity,
  'lucide:boxes': LucideBoxes,
  'lucide:braces': LucideBraces,
  'lucide:briefcase': LucideBriefcase,
  'lucide:clapperboard': LucideClapperboard,
  'lucide:code-xml': LucideCodeXml,
  'lucide:cpu': LucideCpu,
  'lucide:database': LucideDatabase,
  'lucide:gamepad-2': LucideGamepad2,
  'lucide:globe': LucideGlobe,
  'lucide:graduation-cap': LucideGraduationCap,
  'lucide:layout-dashboard': LucideLayoutDashboard,
  'lucide:library': LucideLibrary,
  'lucide:menu': LucideMenu,
  'lucide:message-circle': LucideMessageCircle,
  'lucide:network': LucideNetwork,
  'lucide:notebook-pen': LucideNotebookPen,
  'lucide:package': LucidePackage,
  'lucide:panel-top': LucidePanelTop,
  'lucide:pen-tool': LucidePenTool,
  'lucide:rocket': LucideRocket,
  'lucide:rotate-ccw-clock': LucideRotateCcwClock,
  'lucide:settings': LucideSettings,
  'lucide:shield': LucideShield,
  'lucide:sparkles': LucideSparkles,
  'lucide:square-terminal': LucideSquareTerminal,
  'lucide:type': LucideType,
  'lucide:user-round': LucideUserRound,
  'lucide:wrench': LucideWrench,
  'lucide:zap': LucideZap,
  'majesticons:color-swatch-line': MajesticonsColorSwatchLine,
  'material-symbols:hdr-auto': MaterialSymbolsHdrAuto,
  'material-symbols:nightlight-rounded': MaterialSymbolsNightlightRounded,
  'material-symbols:sunny': MaterialSymbolsSunny,
  'mdi:format-horizontal-align-left': MdiFormatHorizontalAlignLeft,
  'mdi:format-horizontal-align-right': MdiFormatHorizontalAlignRight,
  'mdi:help-circle': MdiHelpCircle,
  'mdi:pin': MdiPin,
  'mdi:pin-off': MdiPinOff,
  'mdi:pin-off-outline': MdiPinOffOutline,
  'mdi:pin-outline': MdiPinOutline,
  'ph:caret-double-left-bold': PhCaretDoubleLeftBold,
  'ph:caret-double-right-bold': PhCaretDoubleRightBold,
  'ph:sign-out': PhSignOut,
  'ph:user-circle': PhUserCircle,
  'ph-caret-double-left-bold': PhCaretDoubleLeftBold,
  'ph-caret-double-right-bold': PhCaretDoubleRightBold,
  'mdi-pin': MdiPin,
  'mdi-pin-off': MdiPinOff,
  'mdi-help-circle': MdiHelpCircle
};
