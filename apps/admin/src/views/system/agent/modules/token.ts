import type { BodyOf } from '@/typings/api/opennavo';
import type { AgentPermission } from './permissions';

/** default: server calculates 90 days (creation only); custom: specified time; never: no expiry. */
export type TokenExpiry = 'default' | 'custom' | 'never';

export interface TokenForm {
  name: string;
  permissions: AgentPermission[];
  allowDelete: boolean;
  expiry: TokenExpiry;
  expiresAt: number | null;
  ipAllowlist: string[];
}

/** Form → payload: omit expiresAt for default, null for never; remove empty IPs. */
export function buildTokenBody(form: TokenForm): BodyOf<'createAgentToken'> {
  const body: BodyOf<'createAgentToken'> = {
    name: form.name.trim(),
    permissions: [...form.permissions],
    allowDelete: form.allowDelete,
    ipAllowlist: form.ipAllowlist.map(item => item.trim()).filter(Boolean)
  };
  if (form.expiry === 'never') body.expiresAt = null;
  if (form.expiry === 'custom' && form.expiresAt) body.expiresAt = new Date(form.expiresAt).toISOString();
  return body;
}
