import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { MirrorChoice, MirrorInput, MirrorProbe } from '@/ipc/bindings';
import { commands, unwrap } from '@/ipc/client';
import { useLoader } from './useLoader';
import { useAppLocale } from './useAppLocale';
import { fetchClientConfig } from './useClientConfig';
import type { ClientConfig } from './useClientConfig';

export type MirrorOption = ClientConfig['mirrors'][number];

/** Suggest a faster available mirror when the official probe exceeds this threshold or fails (06 §11). */
export const SLOW_OFFICIAL_MS = 1500;
/** Probe URL when no official source is configured in the backend (matches seed data, 03 §5.3). */
const OFFICIAL_PROBE_URL = 'https://formulae.brew.sh/api/formula.jws.json';
/** mirror_probe accepts at most 32 sources per call (06 §5.2). */
const PROBE_LIMIT = 32;

/** Suggested replacement for the official source: fastest available mirror, with both latencies (null if the official probe failed). */
export interface MirrorSuggestion {
  option: MirrorOption;
  latencyMs: number;
  officialMs: number | null;
}

export function toMirrorChoice(option: MirrorOption): MirrorChoice {
  const official = option.key === 'official';
  return {
    key: option.key,
    apiDomain: official ? null : (option.apiDomain ?? null),
    bottleDomain: official ? null : (option.bottleDomain ?? null),
    brewGitRemote: official ? null : (option.brewGitRemote ?? null),
    coreGitRemote: official ? null : (option.coreGitRemote ?? null)
  };
}

export function sameMirrorChoice(a: MirrorChoice, b: MirrorChoice): boolean {
  return (
    a.key === b.key &&
    a.apiDomain === b.apiDomain &&
    a.bottleDomain === b.bottleDomain &&
    a.brewGitRemote === b.brewGitRemote &&
    a.coreGitRemote === b.coreGitRemote
  );
}

function toInput(option: MirrorOption): MirrorInput {
  return {
    key: option.key,
    name: option.name,
    probeUrl: option.probeUrl,
    apiDomain: option.apiDomain ?? null,
    bottleDomain: option.bottleDomain ?? null,
    brewGitRemote: option.brewGitRemote ?? null,
    coreGitRemote: option.coreGitRemote ?? null
  };
}

/**
 * Download sources (first-launch-onboarding §3.3): enabled backend mirrors in backend order, always including the official source.
 * Load, probe, find the fastest source, and suggest alternatives when the official source is slow; pages decide when to save (Welcome button or Settings selection).
 */
export function useMirrorOptions(includeMirrors: () => boolean = () => true) {
  const { t } = useI18n();
  const { appLocale } = useAppLocale();
  const { data: config, loading, error, reload: load } = useLoader(fetchClientConfig, [appLocale]);
  const failed = computed(() => Boolean(error.value));
  const probes = ref<Record<string, MirrorProbe>>({});
  const probing = ref(false);

  // Use backend official-source metadata when configured (name, description, probe URL); otherwise prepend a built-in entry.
  const options = computed<MirrorOption[]>(() => {
    const mirrors = (config.value?.mirrors ?? []).filter(mirror => includeMirrors() || mirror.key === 'official');
    if (mirrors.some(mirror => mirror.key === 'official')) return mirrors;
    const official: MirrorOption = {
      key: 'official',
      name: t('mirrors.official'),
      probeUrl: OFFICIAL_PROBE_URL,
      recommended: false,
      apiDomain: null,
      bottleDomain: null,
      brewGitRemote: null,
      coreGitRemote: null
    };
    return [official, ...mirrors];
  });

  const find = (key: string | null | undefined) => options.value.find(option => option.key === key);

  // If another probe is requested during probing (e.g. configuration reloaded), discard these results and probe the latest list again.
  let running: Promise<void> | null = null;
  let again = false;
  function probe(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    probing.value = true;
    running = (async () => {
      do {
        again = false;
        probes.value = {};
        const inputs = options.value.slice(0, PROBE_LIMIT).map(toInput);
        const results = await unwrap(commands.mirrorProbe(inputs)).catch((): MirrorProbe[] => []);
        if (!again) probes.value = Object.fromEntries(results.map(result => [result.key, result]));
      } while (again);
    })().finally(() => {
      probing.value = false;
      running = null;
    });
    return running;
  }

  function latency(key: string): number | undefined {
    const result = probes.value[key];
    return result?.ok && result.latencyMs !== null ? result.latencyMs : undefined;
  }

  function fastestOf(candidates: readonly MirrorOption[]) {
    let best: { option: MirrorOption; latencyMs: number } | undefined;
    for (const option of candidates) {
      const ms = latency(option.key);
      if (ms !== undefined && (!best || ms < best.latencyMs)) best = { option, latencyMs: ms };
    }
    return best;
  }

  /** Fastest available source, including the official source. */
  const fastest = computed(() => fastestOf(options.value)?.option.key);

  /** If the official probe fails or exceeds 1,500 ms and a faster mirror exists, suggest the fastest mirror without switching automatically. */
  const suggestion = computed<MirrorSuggestion | undefined>(() => {
    if (!probes.value.official) return undefined;
    const officialMs = latency('official') ?? null;
    if (officialMs !== null && officialMs <= SLOW_OFFICIAL_MS) return undefined;
    const best = fastestOf(options.value.filter(option => option.key !== 'official'));
    if (!best || (officialMs !== null && best.latencyMs >= officialMs)) return undefined;
    return { ...best, officialMs };
  });

  /** Sources whose probes completed unsuccessfully; exclude pending or untested sources. */
  const unreachable = (key: string) => probes.value[key]?.ok === false;

  return {
    options,
    loading,
    failed,
    probes,
    probing,
    fastest,
    suggestion,
    find,
    load,
    probe,
    unreachable
  };
}
