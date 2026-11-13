/**
 * Hermes messaging gateways, as the panel names them in `session.source`.
 *
 * The panel keeps these conversations out of its own recents list and renders one
 * section per platform, so the client has to know which ids are gateways: they drive
 * the request filter (`exclude_sources`), the sidebar grouping and the row badge.
 *
 * Keep in sync with the panel's gateway adapters
 * (`apps/desktop/src/lib/session-source.ts` in the Hermes repo).
 */
export const MESSAGING_SOURCES: readonly string[] = [
  'telegram',
  'discord',
  'slack',
  'mattermost',
  'matrix',
  'signal',
  'whatsapp',
  'bluebubbles',
  'photon',
  'homeassistant',
  'email',
  'sms',
  'webhook',
  'api_server',
  'weixin',
  'wecom',
  'qqbot',
  'yuanbao',
  'dingtalk',
  'feishu'
];

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  mattermost: 'Mattermost',
  matrix: 'Matrix',
  signal: 'Signal',
  whatsapp: 'WhatsApp',
  bluebubbles: 'iMessage',
  photon: 'iMessage',
  homeassistant: 'Home Assistant',
  email: 'Email',
  sms: 'SMS',
  webhook: 'Webhook',
  api_server: 'API',
  weixin: 'WeChat',
  wecom: 'WeCom',
  qqbot: 'QQ',
  yuanbao: 'Yuanbao',
  dingtalk: 'DingTalk',
  feishu: 'Feishu'
};

/** Two-character badge for a platform: the panel's own sidebar uses avatars, which this
 *  client has no artwork for, so it draws initials instead of inventing logos. */
const PLATFORM_BADGES: Record<string, string> = {
  bluebubbles: 'iM',
  photon: 'iM',
  homeassistant: 'HA',
  api_server: 'API'
};

const MESSAGING_IDS = new Set(MESSAGING_SOURCES);

export function normalizeSource(source: string | null | undefined): string {
  return (source ?? '').trim().toLowerCase();
}

export function isMessagingSource(source: string | null | undefined): boolean {
  return MESSAGING_IDS.has(normalizeSource(source));
}

export function platformLabel(source: string | null | undefined): string {
  const id = normalizeSource(source);
  if (!id) return '';
  return PLATFORM_LABELS[id] ?? id.replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

export function platformBadge(source: string | null | undefined): string {
  const id = normalizeSource(source);
  if (!id) return '?';
  return PLATFORM_BADGES[id] ?? platformLabel(id).slice(0, 2).toUpperCase();
}
