import { ApiError } from '@opennavo/api';
import { computed, onScopeDispose, shallowReactive, watch } from 'vue';
import type { Ref } from 'vue';

interface RefreshEntry {
  reload: () => Promise<unknown>;
  loading: Ref<boolean>;
  error: Ref<unknown>;
  updatedAt: Ref<number>;
  generation: Ref<number>;
}

// Register only mounted pages and rails; stop background reads after leaving a page.
const entries = shallowReactive(new Set<RefreshEntry>());
const invalidators = new Set<() => void>();
const pending = shallowReactive(new Map<RefreshEntry, Promise<unknown>>());
const refreshing = computed(() => pending.size > 0);
let batch: { requests: Promise<unknown>[]; promise: Promise<void> } | undefined;
export const CONTENT_TTL = 5 * 60_000;

export function registerInvalidator(invalidate: () => void) {
  invalidators.add(invalidate);
}

export function registerRefresh(entry: RefreshEntry) {
  entries.add(entry);
  const reset = () => {
    pending.delete(entry);
    batch = undefined;
  };
  onScopeDispose(() => {
    entries.delete(entry);
    reset();
  });
  return reset;
}

function needsRecovery(entry: RefreshEntry): boolean {
  const error = entry.error.value;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status))
    return false;
  return Boolean(error) || Date.now() - entry.updatedAt.value >= CONTENT_TTL;
}

export function refreshPage(force = true): Promise<void> {
  const selected = [...entries].filter(entry => force || needsRecovery(entry));
  if (!selected.length) return Promise.resolve();
  // Newly mounted resources refresh independently; shared rails still mounted keep coalescing their own in-flight requests.
  if (force && selected.some(entry => !pending.has(entry))) {
    for (const invalidate of invalidators) invalidate();
  }
  const requests = selected.map(entry => {
    const existing = pending.get(entry);
    if (existing) return existing;
    let request: Promise<unknown>;
    try {
      request = entry.reload();
    } catch (cause) {
      request = Promise.reject(cause);
    }
    const tracked = request.finally(() => {
      if (pending.get(entry) === tracked) pending.delete(entry);
    });
    pending.set(entry, tracked);
    return tracked;
  });
  if (
    batch &&
    requests.length === batch.requests.length &&
    requests.every((request, index) => request === batch?.requests[index])
  )
    return batch.promise;
  const current = { requests, promise: Promise.allSettled(requests).then(() => undefined) };
  batch = current;
  void current.promise.then(() => {
    if (batch === current) batch = undefined;
  });
  return current.promise;
}

export function usePageRefresh() {
  return {
    refresh: refreshPage,
    refreshing,
    loading: computed(() => refreshing.value || [...entries].some(entry => entry.loading.value)),
    errors: computed(() => [...entries].flatMap(entry => (entry.error.value ? [entry.error.value] : [])))
  };
}

interface RecoveryState {
  requested: boolean;
  recovering: boolean;
  generation: number;
  lastAttempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Recovery signals belong to resources, not shell routes or global Promises. After a pre-signal request completes, check whether a retry is still needed. */
export function usePageRecovery() {
  const states = new Map<RefreshEntry, RecoveryState>();
  let disposed = false;

  function cancelTimer(state: RecoveryState) {
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
  }

  function reconcile() {
    // Transfer unconsumed signals to replacement resources in the same mount cycle so route changes preserve recovery intent.
    const inherit = [...states.values()].some(state => state.requested || state.recovering);
    for (const [entry, state] of states) {
      if (!entries.has(entry)) {
        cancelTimer(state);
        states.delete(entry);
      }
    }
    for (const entry of entries) {
      let state = states.get(entry);
      if (!state) {
        state = {
          requested: inherit,
          recovering: false,
          generation: entry.generation.value,
          lastAttempt: Number.NEGATIVE_INFINITY
        };
        states.set(entry, state);
      } else if (state.generation !== entry.generation.value) {
        // Language, filters, or external reads replaced the old request; it must not consume the new generation's recovery opportunity.
        state.requested ||= state.recovering;
        state.recovering = false;
        state.generation = entry.generation.value;
        state.lastAttempt = Number.NEGATIVE_INFINITY;
        cancelTimer(state);
      }
    }
  }

  function drain() {
    if (disposed) return;
    reconcile();
    for (const [entry, state] of states) {
      if (!entry.loading.value) state.recovering = false;
      if (!state.requested || document.visibilityState === 'hidden') continue;
      // Includes initial loads, manual refreshes, and recovery requests; waiting neither consumes signals nor blocks other resources.
      if (entry.loading.value) continue;
      if (!needsRecovery(entry)) {
        state.requested = false;
        cancelTimer(state);
        continue;
      }
      if (state.timer !== undefined) continue;
      const remaining = 5_000 - (Date.now() - state.lastAttempt);
      if (remaining > 0) {
        state.timer = setTimeout(() => {
          state.timer = undefined;
          drain();
        }, remaining);
        continue;
      }
      state.requested = false;
      state.recovering = true;
      state.lastAttempt = Date.now();
      // useLoader receives and presents errors; reactive state reports completion. Do not await a stale generation's Promise.
      void entry.reload().catch(() => undefined);
      state.generation = entry.generation.value;
    }
  }

  function recover() {
    if (disposed) return;
    reconcile();
    for (const state of states.values()) state.requested = true;
    drain();
  }

  watch(
    () =>
      [...entries].map(entry => [
        entry,
        entry.generation.value,
        entry.loading.value,
        entry.error.value,
        entry.updatedAt.value
      ]),
    drain,
    { flush: 'post' }
  );
  onScopeDispose(() => {
    disposed = true;
    for (const state of states.values()) cancelTimer(state);
    states.clear();
  });
  return recover;
}
