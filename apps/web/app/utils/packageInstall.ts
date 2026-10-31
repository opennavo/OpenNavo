import { packageInstallState } from '@opennavo/shared';
import type { PackageInstallState } from '@opennavo/shared';
import type { PackagePage } from './packageFacts';
import type { Translate } from './seoTitles';

export interface InstallLifecycle {
  state: PackageInstallState;
  /** Why Homebrew disabled/deprecated the package or OpenNavo paused it; absent while active. */
  notice?: string;
}

/**
 * One lifecycle guard for the install command (T2): Homebrew's disabled state hides the command;
 * deprecation and OpenNavo's recommendation pause keep it with a warning. The overview's install
 * block and the install details body both read this, so the command never appears in one and
 * disappears in the other.
 */
export function installLifecycle(pkg: PackagePage, t: Translate): InstallLifecycle {
  const state = packageInstallState(pkg);
  if (state === 'active') return { state };
  const key =
    state === 'disabled'
      ? 'package.disabledNotice'
      : state === 'deprecated'
        ? 'package.deprecatedNotice'
        : 'package.staleNotice';
  const reason =
    (state === 'deprecated' ? pkg.deprecation?.reason : pkg.disable?.reason) ??
    pkg.homebrewStatus?.reason ??
    t('package.noReason');
  return { state, notice: t(key, { reason }) };
}
