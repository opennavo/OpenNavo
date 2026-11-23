import { computed, reactive, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { PackageSummary } from '@opennavo/api';
import type { HermesEffort, HermesProvider } from '@/hermes/providers';
import {
  HERMES_AUX_TASKS,
  HERMES_EFFORTS,
  HERMES_PROVIDER_MAP,
  defaultProviderEndpoint,
  modelId,
  pickOfficialProvider,
  providerCardForSlug,
  providerModels,
  shortModel,
  type HermesAuxTask,
  type HermesProviderInfo
} from '@/hermes/providers';
import { en, zhCN } from '@/hermes/content';
import { i18n } from '@/i18n';
import { commands, unwrap, IpcError } from '@/ipc/client';
import { isMessagingSource } from '@/hermes/platforms';
import { notifyHermesReply } from '@/hermes/notifications';
import type { HermesLoginStatus, HermesModelOptions, HermesRuntimeStatus, HermesSteerResult } from '@/ipc/bindings';
import { useToasts } from '@/composables/useToasts';
import { useHermesNotificationsStore } from '@/stores/hermesNotifications';
import rectangleIcon from '@/assets/hermes/rectangle.png';

/**
 * Text for a failed model-catalog read.
 *
 * A gateway restart used to arrive as the WebSocket detail `code 1012:`, and the profile rail
 * printed that raw close code. The status number stays in the error code; the rail gets a sentence.
 */
export function catalogFailureText(error: unknown, locale = String(i18n.global.locale.value)): string {
  if (error instanceof IpcError && error.code === 'E_HERMES_GATEWAY_RESTART') {
    return locale === 'zh-CN' ? zhCN.settings.model.catalogRestart : en.settings.model.catalogRestart;
  }
  if (error instanceof IpcError) return error.detail ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

export type HermesControlLevel = 'open' | 'guarded' | 'full';

export interface HermesMacSettings {
  enabled: boolean;
  level: HermesControlLevel;
  terminal: boolean;
  screen: boolean;
  files: boolean;
  install: boolean;
  cron: boolean;
  confirmWrites: boolean;
}

export interface HermesProfile {
  id: string;
  name: string;
  kind: 'local' | 'remote' | 'ssh' | 'cloud' | 'panel';
  endpoint: string;
  status: 'connected' | 'connecting' | 'error' | 'offline';
  version: string;
  latency: number | null;
  models: number;
  error?: string;
}

function modelCatalogCount(options: HermesModelOptions | null): number {
  return (options?.providers ?? []).reduce(
    (total, provider) => total + (provider.total_models ?? provider.models?.length ?? 0),
    0
  );
}

/** Opaque fingerprint used to scope catalog caches by endpoint; never sent to the runtime. */
function credentialFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

interface HermesProfileState {
  model: HermesModelSettings;
  conversations: HermesConversation[];
  activeId: string | null;
  workingDir: string;
  auxiliary: HermesAuxSettings;
  forceAuxVision: boolean;
  mac?: HermesMacSettings;
}

interface PersistedProfiles {
  version: number;
  activeProfileId: string;
  profiles: HermesProfile[];
  states: Record<string, HermesProfileState>;
  activeAgentProfiles?: Record<string, string>;
  profileColors?: Record<string, string>;
  profileOrder?: Record<string, string[]>;
  defaultAgentProfiles?: Record<string, string>;
  removedConnections?: number;
}

export interface HermesAgentProfile {
  name: string;
  displayName: string | null;
  path: string;
  isDefault: boolean;
  model: string | null;
  provider: string | null;
  skillCount: number;
  hasEnv: boolean;
}

export interface HermesModelSettings {
  provider: HermesProvider;
  model: string;
  effort: HermesEffort;
  /** Provider priority/fast service tier, when the model supports it. */
  fast: boolean;
  endpoint: string;
  /** The key itself is owned by the runtime; the UI only remembers whether one was supplied. */
  keySet: boolean;
}

export interface HermesToolEvent {
  requestId: string;
  phase: 'start' | 'complete';
  toolId?: string;
  name: string;
  label?: string;
  duration?: number;
}

export interface HermesToolCall {
  name: string;
  label: string;
  time: string;
  toolId?: string;
  /** Arguments the model sent, as the panel stored them (usually JSON). */
  args?: string;
  /** Result body, once the panel has one for this call. */
  result?: string;
  /** The tool reported a failure. */
  error?: boolean;
  /** The call has no result row in the loaded page. */
  pending?: boolean;
}

export type HermesCard = 'cleanup' | 'updates' | 'explain';

export interface HermesMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Raw user text, or an i18n key into the local Hermes content. */
  text?: string;
  textKey?: string;
  tools?: readonly HermesToolCall[];
  package?: PackageSummary;
  card?: HermesCard;
  footKey?: string;
  /** Rows showing what the user allowed, denied or answered during this turn. */
  decisions?: HermesDecision[];
  /** Files attached to this user turn. */
  attachments?: string[];
  /** This user message was injected into the running turn. */
  steering?: boolean;
  /**
   * Visible in the transcript but waiting for the shared turn slot to free up. The row is the
   * queue entry: it keeps the conversation in history and is reused when the turn starts.
   */
  queued?: boolean;
  /** True while Hermes is still streaming this message. */
  streaming?: boolean;
  /** The turn was stopped. Streamed text stays; this is not a finished answer. */
  interrupted?: boolean;
  reasoning?: string;
  at: number;
}

export type HermesAuxSettings = Record<HermesAuxTask, { provider: string; model: string }>;

export function defaultAuxSettings(): HermesAuxSettings {
  return Object.fromEntries(HERMES_AUX_TASKS.map(task => [task, { provider: 'auto', model: '' }])) as HermesAuxSettings;
}

/** The scopes the runtime's `approval` request can offer (`contracts/server_requests.py`). */
export type HermesApprovalChoice = 'once' | 'session' | 'always' | 'deny';

export interface HermesApprovalRequest {
  /** `srq-…` id of the request this card answers. */
  requestId: string;
  /** Epoch ms after which the runtime stops waiting (`approvals.timeout`). */
  deadline?: number | null;
  request_id?: string;
  command?: string;
  description?: string;
  /** The tool that raised the gate (`tool_name` on the request). */
  tool_name?: string | null;
  /** Exactly what the runtime allows: `session`/`always` disappear when nothing may be persisted, and a
   *  smart-approval denial reduces the set to `once`/`deny`. */
  choices?: string[];
  smart_denied?: boolean | null;
  allow_session?: boolean | null;
  allow_permanent?: boolean | null;
}

export type HermesAskKind = 'approval' | 'clarify' | 'secret';

export interface HermesClarifyQuestion {
  qid: string;
  question: string;
  choices?: string[] | null;
  multi_select?: boolean | null;
}

export interface HermesClarifyRequest {
  requestId: string;
  deadline?: number | null;
  questions: HermesClarifyQuestion[];
}

/** One masked string the agent needs: a sudo password, an env secret, a vault unlock. */
export interface HermesSecretRequest {
  requestId: string;
  deadline?: number | null;
  /** What the runtime calls the value; also what the transcript note names (never the value). */
  label: string;
  /** The runtime's own sentence, when it sent one. */
  prompt?: string;
}

export interface HermesAsk {
  requestId: string;
  /** The chat turn that opened this card; other windows ignore its broadcast events. */
  turnRequestId?: string;
  /** Conversation showing the card. A background turn keeps its card until the user returns. */
  conversationId?: string;
  kind: HermesAskKind;
  deadline: number | null;
  params: Record<string, unknown>;
}

/**
 * One in-flight chat turn, owned by its conversation rather than by the view.
 *
 * Switching a profile or opening another conversation only changes what is on screen; the turn
 * keeps its own request id, owning `connection::agentProfile`, gateway coordinates and live
 * session, so stream events and a later Stop still reach the right backend. This mirrors the
 * official desktop, where background profiles keep their sockets and events are applied to the
 * session's own state (`store/session-states.ts`), not to whichever chat is active.
 */
interface LiveHermesTurn {
  turn: number;
  requestId: string;
  conversationId: string;
  /** `connection::agentProfile` that owns the conversation. */
  ownerKey: string;
  /** Gateway coordinates captured at send time; a profile switch must not retarget Stop. */
  gatewayUrl: string | null;
  gatewayProfileId: string | null;
  /** Provider chosen when the turn was composed, for error classification after a switch. */
  provider: HermesProvider;
  liveSessionId?: string;
  stopping: boolean;
  stopRequested: boolean;
}

export interface HermesClarifyAnswer {
  qid: string;
  answer: string | null;
}

export type HermesAskOutcome = 'allowed' | 'denied' | 'submitted' | 'skipped' | 'cancelled' | 'timeout';

/** What the runtime reported after a card was answered; recorded in the transcript. */
export interface HermesDecision {
  requestId: string;
  /** The chat turn that opened the card, used to keep the note in its own transcript. */
  turnRequestId?: string;
  kind: HermesAskKind;
  outcome: HermesAskOutcome;
  scope?: HermesApprovalChoice | null;
  /** The command, env var or first question — never a secret value. */
  summary?: string;
  count?: number | null;
  at?: number;
}

/**
 * What a send does while a turn is running. The official desktop reads this from the runtime's
 * `display.busy_input_mode`: `interrupt` is the default stop-and-correct redirect, `steer`
 * injects at the next tool boundary, and `queue` admits the text as the next turn.
 */
export type HermesBusyMode = 'interrupt' | 'steer' | 'queue';

export interface HermesSessionEvent {
  requestId: string;
  liveSessionId: string;
  sessionId: string;
  /** False when the stored session could not be resumed and `session.create` made a new one. */
  resumed?: boolean;
  /** Running turn's fence for `session.steer`; absent until the runtime claims the turn. */
  executionGeneration?: number | null;
  /** Runtime busy-input policy, read once when the turn opens. */
  busyInputMode?: HermesBusyMode | null;
}

export interface HermesContextUsage {
  used: number;
  max: number;
  percent: number;
}

/**
 * The four views of the panel's session store. They mirror the panel's own desktop: local
 * chats, gateway threads, scheduled jobs and the archive are separate lists, because one
 * busy platform would otherwise bury everything else on a single page.
 */
export type PanelHistorySlice = 'recents' | 'messaging' | 'cron' | 'archived';

export const PANEL_HISTORY_SLICES: readonly PanelHistorySlice[] = ['recents', 'messaging', 'cron', 'archived'];

/** Paging state for one slice of one (connection, agent profile). */
export interface PanelSliceState {
  /** Rows already read from the host, counted from the newest one. */
  offset: number;
  total: number;
  hasMore: boolean;
  /** Set only after a successful page: a failed read must be retried, not cached as empty. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The host has no aggregated endpoint, so this is the current profile only. */
  degraded: boolean;
}

export interface HermesChunk {
  requestId: string;
  delta: string;
}

export interface HermesInstallProgress {
  phase: string;
  downloaded: number;
  total: number | null;
  percent: number;
}

export interface HermesConversation {
  id: string;
  title?: string;
  messages: HermesMessage[];
  updatedAt: number;
  titleKey?: string;
  previewKey?: string;
  /** Hermes CLI session id; later turns resume the same agent context. */
  sessionId?: string;
  /** Live gateway session id for the in-flight turn (steer/interrupt). */
  liveSessionId?: string;
  /** Runtime `execution_generation` for the in-flight turn; `session.steer` rejects a stale value. */
  executionGeneration?: number;
  /** Runtime `display.busy_input_mode`; absent until the first session event, then `interrupt`. */
  busyMode?: HermesBusyMode;
  /** Hermes Panel row: the list carries host metadata until the transcript is opened. */
  panel?: boolean;
  /** Panel-provided preview line, so the list renders without reading a transcript. */
  panelPreview?: string;
  /** Panel row's own message count, shown while the transcript is still on the host. */
  panelMessages?: number;
  /** Panel row's `runtime_revision`: the fence every panel write has to echo back. */
  panelRevision?: number;
  /** Panel row's `runtime_generation`: the panel requires it for a delete. */
  panelGeneration?: number;
  /** Gateway platform that produced the row (`telegram`, `discord`, `desktop`, …). */
  panelSource?: string;
  /**
   * The host's own `last_activity_at` in ms, without the local `updatedAt` fallback: only a
   * value the host actually reported can prove a row moved on since its transcript was read.
   */
  panelActivity?: number;
  /** Profile that owns the row, stamped by the host's aggregated list. */
  panelProfile?: string;
  /** The host archived the row: it only appears in the archive view. */
  panelArchived?: boolean;
  /** The host pinned the row. */
  panelPinned?: boolean;
  /** History slice this row was read through, so a slice refresh only drops its own rows. */
  panelSlice?: PanelHistorySlice;
  /** Rows already read from the host, counted back from the newest one. */
  panelOffset?: number;
  /** A full page came back, so older rows probably exist on the host. */
  panelHasOlder?: boolean;
  /** Transcript already fetched for a panel row (local conversations are always loaded). */
  messagesLoaded?: boolean;
  /** Latest official context-window occupancy for this conversation. */
  context?: HermesContextUsage;
}

interface PersistedHermes {
  version?: number;
  model: HermesModelSettings;
  mac: HermesMacSettings;
  conversations: HermesConversation[];
  activeId: string | null;
  workingDir?: string;
  auxiliary?: HermesAuxSettings;
  forceAuxVision?: boolean;
}

const STORAGE_KEY = 'ONV_HERMES_STATE_V2';
const STORAGE_VERSION = 3;
/** Panel transcript page size: the same tail window the Hermes desktop hydrates. */
const PANEL_TRANSCRIPT_PAGE = 120;
/** History page size per slice. The host caps a page at 200 (500 through the aggregated route). */
const PANEL_HISTORY_PAGE = 40;
const PANEL_HISTORY_MAX = 200;
const LEGACY_MODEL_OPTIONS_CACHE_KEY = 'ONV_HERMES_MODEL_OPTIONS_V2';
const MODEL_OPTIONS_CACHE_PREFIX = 'ONV_HERMES_MODEL_OPTIONS_V3';
const MODEL_OPTIONS_CACHE_SCHEMA = 3;
const MODEL_OPTIONS_CACHE_TTL = 15 * 60_000;
/**
 * Delay before resuming a panel session whose first turn a provider rejected. The failure comes
 * from the host resolving a freshly-created session's model override before its profile
 * credential is available; the resume path reads the profile's own route, so one retry inside
 * the same turn is enough. The short delay lets the failed attempt settle on the host first.
 */
const PROVIDER_AUTH_RETRY_DELAY_MS = 250;
const PROFILES_KEY = 'ONV_HERMES_PROFILES_V1';

const RECTANGLE: PackageSummary = {
  kind: 'cask',
  token: 'rectangle',
  name: 'Rectangle',
  displayName: 'Rectangle',
  summary:
    'Free, open-source Mac window manager for moving, resizing and tiling windows with shortcuts and snap areas.',
  iconUrl: rectangleIcon,
  accentColor: '#1179BB',
  version: '2.0.4',
  primaryCategory: { slug: 'utilities', name: 'System Tools', icon: 'lucide:wrench' },
  installs30d: 9024,
  rank30d: 39,
  autoUpdates: true,
  deprecated: false,
  disabled: false,
  isFont: false,
  isLibrary: false,
  editorChoice: false,
  versionChangedAt: '2026-10-20T20:15:10.40794Z',
  sourceLocale: 'en-US',
  machineTranslated: false,
  recommendationPaused: false
};

const DEFAULT_MODEL: HermesModelSettings = {
  provider: 'nous',
  model: 'Hermes 4 · 405B',
  effort: 'medium',
  fast: false,
  endpoint: '',
  // Not a fact: `refreshCredentialState()` fills this in from the runtime's store.
  keySet: false
};

const DEFAULT_MAC: HermesMacSettings = {
  enabled: false,
  level: 'open',
  terminal: false,
  screen: false,
  files: false,
  install: false,
  cron: false,
  confirmWrites: true
};

const LOCAL_PROFILE: HermesProfile = {
  id: 'local',
  name: 'Local Mac',
  kind: 'local',
  endpoint: '',
  status: 'connected',
  version: '',
  latency: null,
  models: 0
};

function profileDefaults(): PersistedProfiles {
  return {
    version: 1,
    activeProfileId: 'local',
    profiles: [{ ...LOCAL_PROFILE }],
    states: {},
    activeAgentProfiles: {},
    removedConnections: 0
  };
}

function readProfiles(): PersistedProfiles {
  if (typeof localStorage === 'undefined') return profileDefaults();
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '') as Partial<PersistedProfiles>;
    const rawProfiles =
      Array.isArray(parsed.profiles) && parsed.profiles.some(profile => profile.id === 'local')
        ? parsed.profiles
        : [{ ...LOCAL_PROFILE }, ...(parsed.profiles ?? [])];
    const profiles = rawProfiles.filter(profile => profile.kind === 'local' || profile.kind === 'panel');
    const requestedActive = typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : 'local';
    return {
      version: 1,
      activeProfileId: profiles.some(profile => profile.id === requestedActive) ? requestedActive : 'local',
      removedConnections: rawProfiles.length - profiles.length,
      profiles,
      states: parsed.states && typeof parsed.states === 'object' ? parsed.states : {},
      profileColors: parsed.profileColors && typeof parsed.profileColors === 'object' ? parsed.profileColors : {},
      profileOrder: parsed.profileOrder && typeof parsed.profileOrder === 'object' ? parsed.profileOrder : {},
      defaultAgentProfiles:
        parsed.defaultAgentProfiles && typeof parsed.defaultAgentProfiles === 'object'
          ? parsed.defaultAgentProfiles
          : {},
      activeAgentProfiles:
        parsed.activeAgentProfiles && typeof parsed.activeAgentProfiles === 'object' ? parsed.activeAgentProfiles : {}
    };
  } catch {
    return profileDefaults();
  }
}

let sequence = 0;
function id(prefix: string) {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}

function message(entry: Omit<HermesMessage, 'id' | 'at'> & { at?: number }): HermesMessage {
  return { ...entry, id: id('m'), at: entry.at ?? Date.now() };
}

/** A panel row's string field, trimmed; the host sends nulls for unset fields. */
function panelText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Drop the machine preamble the host prepends when a skill, cron job or handoff drives a turn.
 * Without this the sidebar title becomes `[IMPORTANT: The user has invoked the "…" skill…]`,
 * which is what every scheduled row used to look like.
 */
function stripInjectedPreamble(text: string): string {
  const value = text.trim();
  if (!value.startsWith('[')) return value;
  const end = value.indexOf(']');
  if (end < 0) return value;
  // Only a bracketed directive like `[IMPORTANT: …]`, never a user's own "[note] …".
  if (!/^[A-Z][A-Z0-9 _-]{2,}:\s/.test(value.slice(1, end))) return value;
  return value.slice(end + 1).trim();
}

/**
 * One `GET /api/sessions` row as a conversation. The host already ships a title and a preview,
 * so the list never needs a per-session transcript read (that used to cost 21 requests a page).
 */
function panelConversationFromRow(
  row: Record<string, unknown>,
  slice: PanelHistorySlice = 'recents'
): HermesConversation | null {
  const sessionId = panelText(row.id);
  if (!sessionId) return null;
  const preview = stripInjectedPreamble(panelText(row.preview));
  const title = panelText(row.display_name) || panelText(row.title) || preview.slice(0, 48) || sessionId;
  // The host reports epoch seconds; `last_activity_at` is what `order=recent` sorts by.
  const seconds = [row.last_activity_at, row.last_active, row.started_at].find(
    value => typeof value === 'number' && Number.isFinite(value) && value > 0
  ) as number | undefined;
  const source = panelText(row.source) || panelText(row.created_source);
  const profile = panelText(row.profile);
  return {
    id: sessionId,
    title,
    messages: [],
    messagesLoaded: false,
    panel: true,
    panelSlice: slice,
    panelSource: source || undefined,
    panelProfile: profile || undefined,
    panelArchived: row.archived === true,
    panelPinned: row.pinned === true,
    panelActivity: seconds ? seconds * 1000 : undefined,
    panelPreview: preview.slice(0, 120),
    panelMessages: typeof row.message_count === 'number' ? row.message_count : undefined,
    panelRevision: typeof row.runtime_revision === 'number' ? row.runtime_revision : 0,
    panelGeneration: typeof row.runtime_generation === 'number' ? row.runtime_generation : 0,
    updatedAt: seconds ? seconds * 1000 : Date.now(),
    sessionId
  };
}

/** Hermes blanks this on the live `message.complete`, but the stored row still carries it. */
const INTERRUPT_WAITING_PREFIX = 'Operation interrupted: waiting for model response (';

function isInterruptSentinel(text: string): boolean {
  return text.trimStart().startsWith(INTERRUPT_WAITING_PREFIX);
}

/**
 * A provider rejected the model request's credential. The desktop distinguishes this from a
 * panel-session failure by the gateway code and the runtime's own copy; only this class is
 * retried by resuming the session a first turn just created.
 */
function isProviderAuthFailure(error: unknown): boolean {
  if (!(error instanceof IpcError) || error.code !== 'E_HERMES_GATEWAY_STREAM') return false;
  return /rejected your api key|invalid token|http 401/i.test(`${error.message}\n${error.detail ?? ''}`);
}

function panelRowInterrupted(row: Record<string, unknown>): boolean {
  const meta = row.display_metadata;
  if (!meta) return false;
  if (typeof meta === 'object') return (meta as { interrupted?: unknown }).interrupted === true;
  if (typeof meta !== 'string') return false;
  try {
    return (JSON.parse(meta) as { interrupted?: unknown }).interrupted === true;
  } catch {
    return false;
  }
}

/** Panel transcripts interleave user/assistant turns with tool payloads; tool rows fold into
 * the assistant turn that called them, the way the panel's own transcript does. */
function panelMessagesFrom(entries: unknown[], sessionId: string): HermesMessage[] {
  const messages: HermesMessage[] = [];
  const calls = new Map<string, HermesToolCall>();
  /** Seconds when each call started, so its result row can report a duration. */
  const startedAt = new Map<string, number>();
  let lastAssistant: HermesMessage | null = null;

  const timeOf = (value: unknown) => (typeof value === 'number' ? value * 1000 : Date.now());
  const secondsOf = (value: unknown) => (typeof value === 'number' ? value : undefined);
  const duration = (start: number | undefined, end: number | undefined) => {
    if (start === undefined || end === undefined || end < start) return '';
    const delta = end - start;
    return delta >= 10 ? `${Math.round(delta)}s` : `${delta.toFixed(1)}s`;
  };

  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    // Model scaffolding the panel's own sidebar hides (compaction notes, synthetic rows).
    if (row.display_kind === 'hidden') continue;

    if (row.role === 'tool') {
      const result = typeof row.content === 'string' ? row.content : '';
      const toolId = panelText(row.tool_call_id);
      const target = toolId ? calls.get(toolId) : undefined;
      if (target) {
        target.result = result;
        target.pending = false;
        target.error = row.effect_disposition === 'error';
        target.time = duration(startedAt.get(toolId), secondsOf(row.timestamp));
        continue;
      }
      // A result whose call is not in this page still has to be readable: hang it on the
      // nearest assistant turn, or on a synthetic one when the page opens with results.
      const orphan: HermesToolCall = {
        name: panelText(row.tool_name) || 'tool',
        label: '',
        time: '',
        toolId,
        result
      };
      if (!lastAssistant) {
        lastAssistant = {
          ...message({ role: 'assistant', text: '', at: timeOf(row.timestamp) }),
          id: `panel-${sessionId}-tools-${index}`
        };
        messages.push(lastAssistant);
      }
      lastAssistant.tools = [...(lastAssistant.tools ?? []), orphan];
      continue;
    }

    if (row.role !== 'user' && row.role !== 'assistant') continue;
    const rawText = typeof row.content === 'string' ? row.content : '';
    const interrupted = row.role === 'assistant' && (panelRowInterrupted(row) || isInterruptSentinel(rawText));
    const text = isInterruptSentinel(rawText) ? '' : rawText;
    const stored = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    // A stop after tools is stored as its own assistant row whose only text is the
    // interrupt sentinel. Fold that onto the bubble that already has the preamble,
    // matching the official transcript (the row says the reply was stopped).
    if (!text.trim() && !stored.length) {
      if (interrupted && lastAssistant) lastAssistant.interrupted = true;
      if (!interrupted || lastAssistant) continue;
    }

    const at = timeOf(row.timestamp);
    const tools: HermesToolCall[] = stored.flatMap(call => {
      if (!call || typeof call !== 'object') return [];
      const record = call as Record<string, unknown>;
      const fn = (record.function && typeof record.function === 'object' ? record.function : {}) as Record<
        string,
        unknown
      >;
      const name = panelText(fn.name) || panelText(record.name) || 'tool';
      const args = typeof fn.arguments === 'string' ? fn.arguments : '';
      const toolId = panelText(record.call_id) || panelText(record.id);
      return [
        {
          name,
          label: '',
          time: '',
          toolId,
          args: args || undefined,
          pending: true
        }
      ];
    });

    const built: HermesMessage = {
      ...message({
        role: row.role,
        text,
        at,
        reasoning: typeof row.reasoning === 'string' ? row.reasoning : undefined
      }),
      id: `panel-${sessionId}-${String(row.id ?? index)}`
    };
    if (tools.length) built.tools = tools;
    if (interrupted) built.interrupted = true;
    messages.push(built);
    if (row.role === 'assistant') lastAssistant = built;
    for (const call of tools) {
      if (!call.toolId) continue;
      calls.set(call.toolId, call);
      const start = secondsOf(row.timestamp);
      if (start !== undefined) startedAt.set(call.toolId, start);
    }
  }

  return messages;
}

function defaults(): PersistedHermes {
  return {
    version: STORAGE_VERSION,
    model: { ...DEFAULT_MODEL },
    mac: { ...DEFAULT_MAC },
    conversations: [],
    activeId: null,
    workingDir: '',
    auxiliary: defaultAuxSettings(),
    forceAuxVision: false
  };
}

function read(): PersistedHermes {
  if (typeof localStorage === 'undefined') return defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<PersistedHermes>;
    const restoredModel = { ...DEFAULT_MODEL, ...parsed.model };
    if (!HERMES_EFFORTS.includes(restoredModel.effort)) restoredModel.effort = 'medium';
    restoredModel.fast = Boolean(restoredModel.fast);
    const auxiliary = defaultAuxSettings();
    for (const task of HERMES_AUX_TASKS) {
      const entry = parsed.auxiliary?.[task];
      if (entry && typeof entry.provider === 'string' && typeof entry.model === 'string') {
        auxiliary[task] = { provider: entry.provider, model: entry.model };
      }
    }
    return {
      model: restoredModel,
      workingDir: typeof parsed.workingDir === 'string' ? parsed.workingDir : '',
      auxiliary,
      mac: parsed.version === STORAGE_VERSION ? { ...DEFAULT_MAC, ...parsed.mac } : { ...DEFAULT_MAC },
      conversations: Array.isArray(parsed.conversations)
        ? parsed.conversations
            .map(conversation => ({
              ...conversation,
              messages: conversation.messages.map(entry => ({ ...entry, streaming: false })),
              liveSessionId: undefined,
              executionGeneration: undefined,
              busyMode: undefined
            }))
            .filter(
              conversation => !(conversation.messages.length > 0 && conversation.messages.every(entry => entry.textKey))
            )
        : [],
      activeId: parsed.activeId ?? null
    };
  } catch {
    return defaults();
  }
}

interface HermesModelOptionsCache {
  schema: number;
  options: HermesModelOptions;
  at: number;
}

function modelOptionsCachePrefix(connectionId?: string, agentProfile?: string): string {
  if (!connectionId) return `${MODEL_OPTIONS_CACHE_PREFIX}::`;
  const connection = `${MODEL_OPTIONS_CACHE_PREFIX}::${encodeURIComponent(connectionId)}::`;
  return agentProfile ? `${connection}${encodeURIComponent(agentProfile)}::` : connection;
}

function modelOptionsCacheKey(connectionId: string, agentProfile: string, endpoint: string): string {
  const endpointKey = endpoint.trim() ? credentialFingerprint(endpoint.trim()) : 'none';
  return `${modelOptionsCachePrefix(connectionId, agentProfile)}${endpointKey}`;
}

function modelOptionsCacheKeys(connectionId?: string, agentProfile?: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  const prefix = modelOptionsCachePrefix(connectionId, agentProfile);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function clearModelOptionsCache(connectionId?: string, agentProfile?: string) {
  for (const key of modelOptionsCacheKeys(connectionId, agentProfile)) localStorage.removeItem(key);
}

function removeLegacyModelOptionsCache() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_MODEL_OPTIONS_CACHE_KEY);
}

function readModelOptionsCache(key: string): HermesModelOptionsCache | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HermesModelOptionsCache>;
    if (
      parsed.schema !== MODEL_OPTIONS_CACHE_SCHEMA ||
      !parsed.options ||
      !Array.isArray(parsed.options.providers) ||
      typeof parsed.at !== 'number'
    )
      return null;
    return { schema: MODEL_OPTIONS_CACHE_SCHEMA, options: parsed.options, at: parsed.at };
  } catch {
    return null;
  }
}

function writeModelOptionsCache(key: string, options: HermesModelOptions, at: number) {
  if (typeof localStorage === 'undefined') return;
  const payload = JSON.stringify({ schema: MODEL_OPTIONS_CACHE_SCHEMA, options, at } satisfies HermesModelOptionsCache);
  try {
    localStorage.setItem(key, payload);
    return;
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      console.warn('Hermes model catalog cache could not be persisted:', error);
      return;
    }
  }
  // Quota is shared by every catalog entry. Free the oldest catalogs one at a time and stop as
  // soon as this payload fits, instead of discarding every other connection wholesale.
  const stale = modelOptionsCacheKeys()
    .filter(candidate => candidate !== key)
    .map(candidate => ({ key: candidate, at: readModelOptionsCache(candidate)?.at ?? 0 }))
    .sort((left, right) => left.at - right.at);
  for (const entry of stale) {
    localStorage.removeItem(entry.key);
    try {
      localStorage.setItem(key, payload);
      return;
    } catch (error) {
      if (!isQuotaExceededError(error)) {
        console.warn('Hermes model catalog cache could not be persisted:', error);
        return;
      }
    }
  }
  console.warn('Hermes model catalog cache could not be persisted: storage quota is full.');
}

function isQuotaExceededError(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? String((error as { name?: unknown }).name) : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  return (
    typeof DOMException !== 'undefined' && error instanceof DOMException && (error.code === 22 || error.code === 1014)
  );
}

function modelOptionsEndpoint(connection: HermesProfile | undefined, localEndpoint: string): string {
  return connection && connection.kind !== 'local' ? connection.endpoint.trim() : localEndpoint.trim();
}

/** Local Hermes session store. The assistant runtime is intentionally replaceable; today the demo replies locally. */
export const useHermesStore = defineStore('hermes', () => {
  const initial = read();
  const notificationPrefs = useHermesNotificationsStore();
  const model = ref<HermesModelSettings>(initial.model);
  const mac = ref<HermesMacSettings>(initial.mac);
  const conversations = ref<HermesConversation[]>(initial.conversations);
  const activeId = ref<string | null>(initial.activeId);
  const thinking = ref(false);
  /**
   * The stored session id a running turn is using. Media cards need it as soon as the gateway
   * opens the session, but it must not become the conversation's resumable id until the turn
   * succeeds (or the old session is known to be gone).
   */
  const turnSessionIds = ref<Record<string, string>>({});
  /** Server→client requests the running turn is parked on: approval, clarify, masked prompts. */
  const asks = ref<HermesAsk[]>([]);
  /** Only the cards belonging to the conversation on screen; a background turn keeps its own. */
  const activeAsks = computed(() =>
    asks.value.filter(ask => !ask.conversationId || ask.conversationId === activeId.value)
  );
  /** The runtime coalesces its own approval queue, so the cards are answered one at a time. */
  const headAsk = computed(() => activeAsks.value[0] ?? null);
  const approvalRequest = computed<HermesApprovalRequest | null>(() => {
    const ask = headAsk.value;
    if (!ask || ask.kind !== 'approval') return null;
    return {
      ...(ask.params as Omit<HermesApprovalRequest, 'requestId'>),
      requestId: ask.requestId,
      deadline: ask.deadline
    };
  });
  const clarifyRequest = computed<HermesClarifyRequest | null>(() => {
    const ask = headAsk.value;
    if (!ask || ask.kind !== 'clarify') return null;
    const questions = Array.isArray(ask.params.questions) ? (ask.params.questions as HermesClarifyQuestion[]) : [];
    return { requestId: ask.requestId, deadline: ask.deadline, questions };
  });
  const secretRequest = computed<HermesSecretRequest | null>(() => {
    const ask = headAsk.value;
    if (!ask || ask.kind !== 'secret') return null;
    const text = (name: string) => {
      const value = ask.params[name];
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    return {
      requestId: ask.requestId,
      deadline: ask.deadline,
      // The runtime names the value differently per gate: an env var, a vault, a site, a sudo command.
      label: text('env_var') ?? text('display_name') ?? text('site') ?? text('backend') ?? text('command') ?? '',
      prompt: text('prompt') ?? text('hint')
    };
  });
  const historyReady = ref(false);
  const stopping = ref(false);
  const stopRequested = ref(false);
  const runtime = ref<HermesRuntimeStatus | null>(null);
  const installing = ref(false);
  const installProgress = ref<HermesInstallProgress | null>(null);
  const workingDir = ref(initial.workingDir ?? '');
  const auxiliary = ref<HermesAuxSettings>(initial.auxiliary ?? defaultAuxSettings());
  const forceAuxVision = ref(Boolean(initial.forceAuxVision));
  const storedProfiles = readProfiles();
  const profiles = ref<HermesProfile[]>(storedProfiles.profiles);
  const activeProfileId = ref(storedProfiles.activeProfileId);
  const profileStates = ref<Record<string, HermesProfileState>>(migrateProfileStates(storedProfiles.states));
  const agentProfilesByConnection = ref<Record<string, HermesAgentProfile[]>>({});
  const activeAgentProfiles = ref<Record<string, string>>({ ...storedProfiles.activeAgentProfiles });
  const profileColors = ref<Record<string, string>>({ ...storedProfiles.profileColors });
  const profileOrder = ref<Record<string, string[]>>({ ...storedProfiles.profileOrder });
  const defaultAgentProfiles = ref<Record<string, string>>({ ...storedProfiles.defaultAgentProfiles });
  const windowScopedRoute = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('profile');
  for (const [connectionId, profile] of Object.entries(defaultAgentProfiles.value)) {
    activeAgentProfiles.value = { ...activeAgentProfiles.value, [connectionId]: profile };
  }
  removeLegacyModelOptionsCache();
  const initialAgentProfile = preferredAgentProfile(storedProfiles.activeProfileId);
  const initialProfileState = profileStates.value[`${storedProfiles.activeProfileId}::${initialAgentProfile}`];
  const initialModelSettings = initialProfileState?.model ?? initial.model;
  const initialModelOptionsKey = modelOptionsCacheKey(
    storedProfiles.activeProfileId,
    initialAgentProfile,
    modelOptionsEndpoint(
      profiles.value.find(profile => profile.id === storedProfiles.activeProfileId),
      initialModelSettings.endpoint
    )
  );
  const cachedOptions = readModelOptionsCache(initialModelOptionsKey);
  const loginStatus = ref<HermesLoginStatus | null>(null);
  const modelOptions = ref<HermesModelOptions | null>(cachedOptions?.options ?? null);
  const modelOptionsUpdatedAt = ref<number | null>(cachedOptions?.at ?? null);
  const modelOptionsOwner = ref<string | null>(cachedOptions ? initialModelOptionsKey : null);
  if (cachedOptions) {
    const cachedConnection = profiles.value.find(profile => profile.id === storedProfiles.activeProfileId);
    if (cachedConnection) cachedConnection.models = modelCatalogCount(cachedOptions.options);
  }
  const modelOptionsLoading = ref(false);
  let modelOptionsSeq = 0;
  let modelOptionsEpoch = 0;
  let modelOptionsRequestKey: string | null = null;
  const profileSwitching = ref(false);
  const profileSwitchError = ref<string | null>(null);
  /** Profile name being activated, so the chat area can say what it is waiting for. */
  const profileSwitchingTo = ref<string | null>(null);
  let profileActivationSeq = 0;
  let profileSwitchSeq = 0;
  const panelAuthExpired = ref<string | null>(null);
  let panelAuthGeneration = 0;

  function notePanelAuthError(error: unknown) {
    if (!panelActive.value) return;
    // A provider 401 ("custom rejected your API key") is a model failure reported inside
    // the turn, not proof that the panel session expired. Only the panel's own auth error
    // may open the sign-in sheet.
    if (!(error instanceof IpcError) || error.code !== 'E_HERMES_PANEL_AUTH') return;
    if (panelAuthExpired.value === activeProfile.value.id) return;
    panelAuthExpired.value = activeProfile.value.id;
    toasts.push({
      tone: 'warning',
      title: 'Hermes Panel',
      description: 'The Hermes Panel session expired. Sign in again.'
    });
  }
  const modelOptionsError = ref<string | null>(null);
  const apiKey = ref('');
  const toasts = useToasts();
  if (storedProfiles.removedConnections) {
    toasts.push({
      tone: 'info',
      title: 'Hermes Panel',
      description: `${storedProfiles.removedConnections} unsupported connection(s) were removed. Hermes Panel is now the only remote mode.`
    });
  }
  let replyTimer: ReturnType<typeof setTimeout> | undefined;
  let turnSeq = 0;
  let stopKillTimer: number | undefined;
  let stopFinalizeTimer: number | undefined;
  let historySaveTimer: number | undefined;
  let historyLoaded = false;
  let historyLoadStarted = false;
  let historyProfile: string | null = null;
  /** Bumped for every history read so a slow request can never write the next profile's state. */
  let historySeq = 0;
  /** Serializes history writes; a read waits for this before trusting the file on disk. */
  let pendingHistorySave: Promise<void> = Promise.resolve();
  /**
   * Paging state per `connection::agentProfile`, one record per history slice.
   *
   * A `reactive` map, not a `ref` holding plain objects: the loader mutates `state.loading`
   * and `state.error` in place, and mutating a raw object behind a ref notifies nothing — the
   * popover then keeps rendering its first render (a silent empty list) even after a failure.
   */
  const panelSlices = reactive<Record<string, Record<PanelHistorySlice, PanelSliceState>>>({});
  /** Bumped whenever a panel read can no longer be folded into the current list. */
  let panelHistoryGeneration = 0;
  /** Latest request per `connection::profile::slice`; an older response must not publish over it. */
  const panelHistoryRequests = new Map<string, number>();
  /** Callers waiting on a slice read that is already in flight. */
  const panelHistoryWaiters = new Map<string, Array<() => void>>();
  /** Read every profile on the host through `/api/profiles/sessions`. */
  const panelAllProfiles = ref(false);
  /** Connection ids whose profile list is in flight (the rail shows a spinner meanwhile). */
  const agentProfilesLoadingIds = ref<Set<string>>(new Set());
  /** Panel session id whose transcript is being read, so the chat area can say it is loading. */
  const panelConversationLoading = ref<string | null>(null);
  let historySaveEnabled = true;
  let historySaveErrorShown = false;
  let resolveHistoryReady: () => void = () => {};
  let historyReadyPromise = new Promise<void>(resolve => {
    resolveHistoryReady = resolve;
  });
  /**
   * A correction waiting for the turn to claim a live session and generation. `mode` is the policy
   * known when it was typed; `null` means the session event had not arrived yet, so the flush must
   * re-read `conversation.busyMode` instead of pinning the default.
   */
  interface PendingSteer {
    text: string;
    messageId: string;
    mode: 'interrupt' | 'steer' | null;
  }
  const pendingSteers = new Map<string, PendingSteer[]>();
  /**
   * Text waiting for the next turn in its conversation. `messageId` points at the visible user
   * row shown for a queued send, so the drain can reuse that row instead of duplicating it.
   */
  interface QueuedSend {
    text: string;
    messageId?: string;
    /** Files composed with the message; a pre-flight requeue has to take them along. */
    attachments?: string[];
  }
  const queuedAfterTurn = new Map<string, QueuedSend[]>();
  /**
   * The assistant bubble currently receiving this conversation's stream events. A correction
   * seals it, so the next delta opens a fresh bubble below the correction — the official
   * desktop's `pre-steer output → correction → post-steer output` order.
   */
  const streamingAssistantIds = new Map<string, string>();
  /**
   * Turns that are still running, keyed by turn id and by conversation. They survive profile and
   * conversation switches; only Stop (or deleting the conversation) retires them.
   */
  const liveTurns = new Map<number, LiveHermesTurn>();
  const liveTurnByConversation = new Map<string, number>();
  /** The turn the shared stop timers belong to, so another turn's completion cannot clear them. */
  let stopTimerTurn: number | null = null;
  /**
   * The conversation whose queued text is already inside `send`. One drain at a time.
   * `stopThinking` clears it: that bump retires the in-flight turn, and a hung chat would
   * otherwise leave `select` unable to start the rows still queued.
   */
  let queuedDrain: { id: string; epoch: number } | null = null;
  let queuedDrainEpoch = 0;
  /**
   * Turns force-retired before the gateway announced their session. The `hermes-session`
   * listener stays registered until `hermesChat` settles, so when the id finally arrives it can
   * send the interrupt that retirement could not. A local turn is hard-stopped instead; a
   * remote/panel turn has no such handle until this event.
   */
  const pendingTurnInterrupts = new Map<string, { gatewayUrl: string | null; profileId: string | null }>();

  function preferredAgentProfile(connectionId: string) {
    return activeAgentProfiles.value[connectionId] ?? defaultAgentProfiles.value[connectionId] ?? 'default';
  }

  function stateKey(connectionId = activeProfileId.value, agentProfile = preferredAgentProfile(connectionId)) {
    return `${connectionId}::${agentProfile}`;
  }

  function migrateProfileStates(states: Record<string, HermesProfileState>): Record<string, HermesProfileState> {
    const next: Record<string, HermesProfileState> = {};
    for (const [key, value] of Object.entries(states)) {
      next[key.includes('::') ? key : `${key}::default`] = value;
    }
    return next;
  }

  // ── Background turns ──────────────────────────────────────────────────────
  // A turn belongs to its conversation, not to the visible chat. These lookups route a stream
  // event or a completion to the owning profile state even after the user switched away.

  function conversationForOwner(conversationId: string, ownerKey: string): HermesConversation | undefined {
    if (ownerKey === stateKey()) {
      return conversations.value.find(item => item.id === conversationId);
    }
    return profileStates.value[ownerKey]?.conversations.find(item => item.id === conversationId);
  }

  function findConversationById(conversationId: string): HermesConversation | undefined {
    const active = conversations.value.find(item => item.id === conversationId);
    if (active) return active;
    for (const state of Object.values(profileStates.value)) {
      const found = state.conversations.find(item => item.id === conversationId);
      if (found) return found;
    }
    return undefined;
  }

  function liveTurnForConversation(conversationId: string | null | undefined): LiveHermesTurn | undefined {
    if (!conversationId) return undefined;
    const turn = liveTurnByConversation.get(conversationId);
    return turn === undefined ? undefined : liveTurns.get(turn);
  }

  function activeLiveTurn(): LiveHermesTurn | undefined {
    return liveTurnForConversation(activeId.value);
  }

  function turnConversation(turnId: number): HermesConversation | undefined {
    const turn = liveTurns.get(turnId);
    return turn ? conversationForOwner(turn.conversationId, turn.ownerKey) : undefined;
  }

  /** `liveTurns` is a plain Map; this ref lets the UI react to a turn starting or ending. */
  const liveTurnRevision = ref(0);

  /** What a history row should say about its conversation's live turn. */
  function conversationActivity(conversationId: string): 'replying' | 'waiting' | null {
    void liveTurnRevision.value;
    const turn = liveTurnForConversation(conversationId);
    if (!turn) return null;
    return asks.value.some(ask => ask.turnRequestId === turn.requestId) ? 'waiting' : 'replying';
  }

  /** Turns running somewhere other than the conversation on screen, for the status banner. */
  const backgroundTurns = computed(() => {
    void liveTurnRevision.value;
    return [...liveTurns.values()]
      .filter(turn => turn.conversationId !== activeId.value)
      .map(turn => {
        const conversation = conversationForOwner(turn.conversationId, turn.ownerKey);
        const firstUser = conversation?.messages.find(entry => entry.role === 'user');
        return {
          conversationId: turn.conversationId,
          title: conversation?.title?.trim() || (firstUser?.text ?? '').slice(0, 48),
          waiting: asks.value.some(ask => ask.turnRequestId === turn.requestId),
          stopping: turn.stopping,
          // A turn from another profile is reachable too: `openBackgroundTurn` switches first.
          // Only a deleted row or an owner whose profile is gone has nowhere to open.
          openable:
            Boolean(conversation) &&
            (turn.ownerKey === stateKey() ||
              profiles.value.some(profile => turn.ownerKey.startsWith(`${profile.id}::`)))
        };
      });
  });

  /** Show a background conversation without disturbing its turn, switching profile if needed. */
  async function openBackgroundTurn(conversationId: string): Promise<boolean> {
    const turn = liveTurnForConversation(conversationId);
    if (!turn) return false;
    if (turn.ownerKey !== stateKey()) {
      const [connectionId, agentProfile] = turn.ownerKey.split('::');
      if (!connectionId || !profiles.value.some(profile => profile.id === connectionId)) return false;
      switchProfile(connectionId, agentProfile || undefined);
    }
    // `applyProfileState` fills the list synchronously; select now so the user sees the row.
    if (!conversations.value.some(item => item.id === conversationId)) return false;
    select(conversationId);
    // The switch kicked off `loadHistory`; its restored `activeId` must not replace the row the
    // user just asked for. Re-select once that read has settled.
    if (!historyLoaded) {
      await historyReadyPromise;
      if (conversations.value.some(item => item.id === conversationId) && activeId.value !== conversationId) {
        select(conversationId);
      }
    }
    return true;
  }

  /** `thinking`/`stopping` describe the conversation on screen, never a background one. */
  function syncTurnUi() {
    const turn = activeLiveTurn();
    thinking.value = Boolean(turn);
    stopping.value = Boolean(turn?.stopping);
    stopRequested.value = Boolean(turn?.stopRequested);
  }

  function registerLiveTurn(turn: LiveHermesTurn) {
    liveTurns.set(turn.turn, turn);
    liveTurnByConversation.set(turn.conversationId, turn.turn);
    liveTurnRevision.value += 1;
    syncTurnUi();
  }

  function clearAsksForTurn(requestId: string) {
    if (!requestId) return;
    asks.value = asks.value.filter(ask => ask.turnRequestId !== requestId);
  }

  /** Forget a turn. Returns its context so callers can still interrupt or finalize it. */
  function retireLiveTurn(turnId: number): LiveHermesTurn | undefined {
    const turn = liveTurns.get(turnId);
    if (!turn) return undefined;
    liveTurns.delete(turnId);
    if (liveTurnByConversation.get(turn.conversationId) === turnId) {
      liveTurnByConversation.delete(turn.conversationId);
    }
    clearAsksForTurn(turn.requestId);
    if (turnSessionIds.value[turn.conversationId]) {
      const remainingTurnSessions = { ...turnSessionIds.value };
      delete remainingTurnSessions[turn.conversationId];
      turnSessionIds.value = remainingTurnSessions;
    }
    liveTurnRevision.value += 1;
    syncTurnUi();
    // A background profile is not covered by the `conversations` watcher that persists the
    // active one. Flush its finished state so a restart does not resurrect the partial turn.
    if (turn.ownerKey !== stateKey()) persist();
    return turn;
  }

  /**
   * Interrupt this turn's own session. The conversation's `liveSessionId` still names the
   * previous turn until this turn's `hermes-session` event arrives, so it is never a fallback
   * here: an early Stop would interrupt the turn before this one and let this one keep running.
   * Returns false when this turn has not claimed a session yet.
   */
  async function interruptTurn(turn: LiveHermesTurn): Promise<boolean> {
    const live = turn.liveSessionId;
    if (!live) return false;
    if (!turn.gatewayUrl) await unwrap(commands.hermesInterrupt(live, null, null));
    else await unwrap(commands.hermesInterrupt(live, turn.gatewayUrl, turn.gatewayProfileId));
    return true;
  }

  /**
   * Ask a turn's backend to stop. An early Stop has no session id to target yet, so it sends
   * nothing: the 1.2 s retry and the `hermes-session` handler take over as soon as the id is
   * known. Only a caller that is already retiring the turn (`force`) may hard-stop the local
   * gateway as a last resort, never the first button press.
   */
  async function requestTurnStop(turn: LiveHermesTurn, force: boolean) {
    if (turn.liveSessionId) {
      try {
        await interruptTurn(turn);
        return;
      } catch (error) {
        if (!force) throw error;
      }
    }
    if (!force) return;
    // Register before yielding: a `hermes-session` can arrive while `hermesStop` is in flight,
    // and that event is the only one this request id may ever get. Dropping it here left the
    // prompt running on a gateway that then refused to stop. A successful hard stop makes the
    // registration moot and is removed; a failed one keeps it for the late session.
    pendingTurnInterrupts.set(turn.requestId, {
      gatewayUrl: turn.gatewayUrl,
      profileId: turn.gatewayProfileId
    });
    if (!turn.gatewayUrl && runtime.value?.ready) {
      try {
        await commands.hermesStop();
        pendingTurnInterrupts.delete(turn.requestId);
        return;
      } catch {
        // Best effort: the turn is already retired locally; the registration above still
        // covers a session the surviving gateway announces afterwards.
      }
    }
  }

  /** Stamp every open assistant bubble in the conversation as stopped. */
  function markConversationStopped(conversation: HermesConversation) {
    const current = streamingAssistant(conversation);
    if (current) {
      current.streaming = false;
      current.interrupted = true;
      if (!current.text) current.text = '已停止。';
    }
    for (const entry of conversation.messages) {
      if (entry.role === 'assistant' && entry.streaming) {
        entry.streaming = false;
        entry.interrupted = true;
        if (!entry.text) entry.text = '已停止。';
      }
    }
    streamingAssistantIds.delete(conversation.id);
    const last = [...conversation.messages].reverse().find(entry => entry.role === 'assistant');
    if (last && !last.text) last.text = '已停止。';
    conversation.liveSessionId = undefined;
    conversation.executionGeneration = undefined;
    conversation.updatedAt = Date.now();
  }

  /** Retire one turn immediately and ask its backend to stop. Used by Stop's hung fallback. */
  function forceStopTurn(turnId: number) {
    const turn = liveTurns.get(turnId);
    if (!turn) return;
    const conversation = turnConversation(turnId);
    if (conversation) markConversationStopped(conversation);
    // The turn's own session id is the only safe target; the conversation may still hold the
    // previous turn's id, and interrupting that would leave this turn running.
    void requestTurnStop(turn, true).catch(() => undefined);
    retireLiveTurn(turnId);
    if (stopTimerTurn === turnId) clearStopTimers();
    // Start whatever was queued behind this turn, in its own conversation.
    drainQueuedTurns();
  }

  /** Delete/clear/Stop paths that remove a conversation also end the turn running in it. */
  function stopTurnForConversation(conversationId: string) {
    const turn = liveTurnForConversation(conversationId);
    if (!turn) return;
    forceStopTurn(turn.turn);
  }

  const activeProfile = computed(
    () =>
      profiles.value.find(profile => profile.id === activeProfileId.value) ?? profiles.value[0] ?? { ...LOCAL_PROFILE }
  );
  const remoteActive = computed(() => activeProfile.value.kind !== 'local');
  const panelActive = computed(() => activeProfile.value.kind === 'panel');
  const activeAgentProfileName = computed(() => preferredAgentProfile(activeProfileId.value));
  const fleetProfiles = computed(() =>
    profiles.value.map(connection => ({
      connection,
      profiles: agentProfilesByConnection.value[connection.id] ?? []
    }))
  );
  const agentProfilesLoading = computed(() => agentProfilesLoadingIds.value.has(activeProfileId.value));
  const agentProfiles = computed(() => {
    const list = agentProfilesByConnection.value[activeProfileId.value] ?? [];
    const order = profileOrder.value[activeProfileId.value] ?? [];
    if (!order.length) return list;
    return [...list].sort((left, right) => {
      const leftIndex = order.indexOf(left.name);
      const rightIndex = order.indexOf(right.name);
      if (leftIndex === -1 && rightIndex === -1) return left.name.localeCompare(right.name);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
  });
  const gatewayUrl = computed(() => (remoteActive.value ? activeProfile.value.endpoint : null));
  const gatewayProfileId = computed(() => (remoteActive.value ? activeProfile.value.id : null));

  function currentProfileState(owner = activeAgentProfileName.value): HermesProfileState {
    const owned = conversations.value.filter(item => ownsPanelRow(item, owner));
    return {
      model: { ...model.value },
      conversations: owned,
      activeId: owned.some(item => item.id === activeId.value) ? activeId.value : null,
      workingDir: workingDir.value,
      auxiliary: { ...auxiliary.value },
      forceAuxVision: forceAuxVision.value,
      mac: { ...mac.value }
    };
  }

  /**
   * Which list a panel row belongs to, inferring it for rows persisted by an older build (or by
   * a run before slices existed). Without this, an unowned row is never dropped by any slice
   * refresh and leaks into every view as a phantom conversation.
   */
  function sliceOf(conversation: HermesConversation): PanelHistorySlice {
    if (conversation.panelSlice) return conversation.panelSlice;
    if (conversation.panelArchived) return 'archived';
    const source = conversation.panelSource ?? '';
    if (source === 'cron') return 'cron';
    if (isMessagingSource(source)) return 'messaging';
    return 'recents';
  }

  /**
   * Whether a panel row belongs to `owner`'s session store.
   *
   * Only the aggregated read stamps an owner onto a row, so an unstamped row belongs to whichever
   * profile listed it. Without this the rows another profile contributed to the aggregated list
   * stayed in the active profile's state and came back on the next profile switch or restart.
   */
  function ownsPanelRow(conversation: HermesConversation, owner: string): boolean {
    return !conversation.panel || !conversation.panelProfile || conversation.panelProfile === owner;
  }

  function applyProfileState(state: HermesProfileState, owner = activeAgentProfileName.value) {
    model.value = { ...state.model };
    conversations.value = state.conversations
      .filter(conversation => ownsPanelRow(conversation, owner))
      .map(conversation =>
        conversation.panel ? { ...conversation, panelSlice: sliceOf(conversation) } : conversation
      );
    activeId.value = state.activeId;
    workingDir.value = state.workingDir;
    auxiliary.value = { ...state.auxiliary };
    forceAuxVision.value = state.forceAuxVision;
    mac.value = { ...(state.mac ?? DEFAULT_MAC) };
    // The conversation that just became visible may own a background turn (or none at all).
    syncTurnUi();
  }

  function saveActiveProfileState() {
    const key = stateKey();
    const [, owner = 'default'] = key.split('::');
    profileStates.value = { ...profileStates.value, [key]: currentProfileState(owner) };
  }

  function blankProfileState(): HermesProfileState {
    return {
      model: { ...DEFAULT_MODEL, keySet: false },
      conversations: [],
      activeId: null,
      workingDir: '',
      auxiliary: defaultAuxSettings(),
      forceAuxVision: false,
      mac: { ...DEFAULT_MAC }
    };
  }

  if (activeProfile.value.kind !== 'local') {
    if (!profileStates.value[stateKey('local', 'default')]) {
      profileStates.value = { ...profileStates.value, [stateKey('local', 'default')]: blankProfileState() };
    }
    applyProfileState(profileStates.value[stateKey()] ?? blankProfileState());
    mac.value = { ...DEFAULT_MAC };
  }

  const active = computed(() => conversations.value.find(item => item.id === activeId.value) ?? null);
  const messages = computed(() => active.value?.messages ?? []);
  const mediaSessionId = computed(() => {
    const conversation = active.value;
    if (!conversation) return null;
    return turnSessionIds.value[conversation.id] ?? conversation.sessionId ?? null;
  });
  // A panel row is a real conversation even while its transcript is still only on the host.
  const history = computed(() =>
    [...conversations.value]
      .filter(item => item.panel || item.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  );
  const modelShort = computed(() => shortModel(model.value.model));
  const macActive = computed(() => mac.value.enabled && mac.value.level !== 'open');
  const macStatus = computed(() => (mac.value.enabled ? mac.value.level : 'paused'));
  const runtimeReady = computed(() => Boolean(runtime.value?.ready));
  const contextUsage = computed(() => active.value?.context ?? null);
  const auxiliaryCustomCount = computed(
    () =>
      HERMES_AUX_TASKS.filter(task => auxiliary.value[task].provider !== 'auto' && Boolean(auxiliary.value[task].model))
        .length
  );

  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    historyLoaded = true;
    resolveHistoryReady();
  }

  /**
   * Write the current conversations to `profileName`'s history file immediately.
   *
   * The payload and profile are captured synchronously, so calling this just before a
   * profile switch saves the *outgoing* profile even though the active name changes next.
   */
  function flushHistorySave(profileName = activeAgentProfileName.value): Promise<void> {
    if (historySaveTimer) {
      window.clearTimeout(historySaveTimer);
      historySaveTimer = undefined;
    }
    if (
      remoteActive.value ||
      !historyLoaded ||
      !historySaveEnabled ||
      typeof window === 'undefined' ||
      !('__TAURI_INTERNALS__' in window)
    )
      return pendingHistorySave;
    const json = JSON.stringify({
      version: STORAGE_VERSION,
      conversations: conversations.value.filter(item => ownsPanelRow(item, profileName)),
      activeId: activeId.value
    });
    const profileArg = profileName === 'default' ? null : profileName;
    pendingHistorySave = pendingHistorySave
      .catch(() => undefined)
      .then(async () => {
        try {
          const result = await commands.hermesHistorySave(json, profileArg);
          if (result.status === 'error' && !historySaveErrorShown) {
            historySaveErrorShown = true;
            toasts.push({
              tone: 'warning',
              title: 'Hermes history',
              description: 'Could not write history.json; keeping the local copy.'
            });
          }
          if (result.status === 'ok') historySaveErrorShown = false;
        } catch {
          if (!historySaveErrorShown) {
            historySaveErrorShown = true;
            toasts.push({
              tone: 'warning',
              title: 'Hermes history',
              description: 'Could not write history.json; keeping the local copy.'
            });
          }
        }
      });
    return pendingHistorySave;
  }

  function scheduleHistorySave() {
    if (
      remoteActive.value ||
      !historyLoaded ||
      !historySaveEnabled ||
      typeof window === 'undefined' ||
      !('__TAURI_INTERNALS__' in window)
    )
      return;
    if (historySaveTimer) window.clearTimeout(historySaveTimer);
    historySaveTimer = window.setTimeout(() => {
      historySaveTimer = undefined;
      void flushHistorySave();
    }, 300);
  }

  function persist() {
    if (typeof localStorage === 'undefined') return;
    saveActiveProfileState();
    const owner = activeAgentProfileName.value;
    const owned = conversations.value.filter(item => ownsPanelRow(item, owner));
    try {
      if (!windowScopedRoute) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            version: STORAGE_VERSION,
            model: model.value,
            mac: mac.value,
            conversations: owned,
            activeId: owned.some(item => item.id === activeId.value) ? activeId.value : null,
            workingDir: workingDir.value,
            auxiliary: auxiliary.value,
            forceAuxVision: forceAuxVision.value
          } satisfies PersistedHermes)
        );
      }
      let activeRoute = activeProfileId.value;
      let activeAgents = activeAgentProfiles.value;
      if (windowScopedRoute) {
        try {
          const stored = JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') as Partial<PersistedProfiles>;
          if (typeof stored.activeProfileId === 'string') activeRoute = stored.activeProfileId;
          if (stored.activeAgentProfiles) activeAgents = stored.activeAgentProfiles;
        } catch {
          // Keep the in-memory route if the shared record is unreadable.
        }
      }
      localStorage.setItem(
        PROFILES_KEY,
        JSON.stringify({
          version: 1,
          activeProfileId: activeRoute,
          profiles: profiles.value,
          states: profileStates.value,
          activeAgentProfiles: activeAgents,
          profileColors: profileColors.value,
          profileOrder: profileOrder.value,
          defaultAgentProfiles: defaultAgentProfiles.value
        } satisfies PersistedProfiles)
      );
      scheduleHistorySave();
    } catch {
      // A full or unavailable localStorage must not break the assistant.
    }
  }

  watch([model, mac, conversations, activeId, workingDir, auxiliary, forceAuxVision], persist, { deep: true });

  async function loadRuntime() {
    try {
      runtime.value = await unwrap(commands.hermesRuntimeStatus());
      const local = profiles.value.find(profile => profile.id === 'local');
      if (local) {
        local.status = runtime.value.ready ? 'connected' : 'offline';
        local.version = /(\d+\.\d+\.\d+)/.exec(runtime.value.version ?? '')?.[1] ?? local.version;
      }
    } catch (error) {
      runtime.value = {
        ready: false,
        installed: false,
        version: null,
        expectedVersion: '',
        path: null,
        dataPath: null,
        computerUse: false,
        outdated: false,
        message: error instanceof IpcError ? error.message : String(error)
      };
    }
    if (runtime.value?.installed && !runtime.value.ready && runtime.value.message) {
      console.warn('Local Hermes:', runtime.value.message);
      toasts.push({ tone: 'warning', title: 'Local Hermes', description: runtime.value.message });
    }
  }

  async function installRuntime(): Promise<boolean> {
    if (installing.value) return false;
    installing.value = true;
    installProgress.value = { phase: 'preparing', downloaded: 0, total: null, percent: 0 };
    let unlisten: (() => void) | undefined;
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<HermesInstallProgress>('hermes-install-progress', event => {
          installProgress.value = event.payload;
        });
      } catch {
        // Progress is an enhancement; the install command still completes.
      }
    }
    try {
      runtime.value = await unwrap(commands.hermesRuntimeInstall());
      toasts.push({ tone: 'success', title: 'Hermes', description: 'Local Hermes installed.' });
      return runtime.value.ready;
    } catch (error) {
      const detail = error instanceof IpcError ? (error.detail ?? error.message) : String(error);
      const cancelled = /cancel/i.test(detail);
      toasts.push({ tone: cancelled ? 'info' : 'danger', title: 'Hermes install', description: detail });
      return false;
    } finally {
      unlisten?.();
      installing.value = false;
    }
  }

  async function cancelInstall() {
    try {
      await unwrap(commands.hermesRuntimeInstallCancel());
    } catch {
      // The install may already have finished.
    }
  }

  async function loadHistory(profileName = activeAgentProfileName.value) {
    if (typeof window !== 'undefined' && historySaveTimer) {
      window.clearTimeout(historySaveTimer);
      historySaveTimer = undefined;
    }
    if (historyLoadStarted && historyProfile === profileName) {
      if (!historyLoaded) await historyReadyPromise;
      return;
    }
    // Release waiters of the superseded read; each load resolves only its own promise.
    const previousResolve = resolveHistoryReady;
    const seq = ++historySeq;
    historyLoadStarted = true;
    historyProfile = profileName;
    historyLoaded = false;
    historyReady.value = false;
    historyReadyPromise = new Promise<void>(resolve => {
      resolveHistoryReady = resolve;
    });
    const done = resolveHistoryReady;
    previousResolve();
    if (remoteActive.value) {
      historyLoaded = true;
      historyReady.value = true;
      done();
      return;
    }
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      historyLoaded = true;
      historyReady.value = true;
      done();
      return;
    }
    // Do not read a file a pending write is about to replace.
    await pendingHistorySave.catch(() => undefined);
    if (seq !== historySeq) {
      done();
      return;
    }
    let hasBackend = false;
    try {
      const raw = await unwrap(commands.hermesHistoryLoad(profileName === 'default' ? null : profileName));
      // A newer read (usually another profile) owns the store now; discard this result
      // instead of overwriting its conversations with the previous profile's file.
      if (seq !== historySeq) {
        done();
        return;
      }
      if (raw) {
        hasBackend = true;
        const parsed = JSON.parse(raw) as { conversations?: unknown; activeId?: unknown };
        if (!Array.isArray(parsed.conversations)) throw new Error('history conversations missing');
        const restored = parsed.conversations.map(conversation => {
          if (!conversation || typeof conversation !== 'object') throw new Error('invalid conversation');
          const entry = conversation as HermesConversation;
          if (typeof entry.id !== 'string' || !Array.isArray(entry.messages))
            throw new Error('invalid conversation shape');
          return {
            ...entry,
            messages: entry.messages.map(entryMessage => {
              if (
                !entryMessage ||
                typeof entryMessage !== 'object' ||
                typeof entryMessage.id !== 'string' ||
                (entryMessage.role !== 'user' && entryMessage.role !== 'assistant')
              ) {
                throw new Error('invalid message');
              }
              return { ...entryMessage, streaming: false };
            }),
            liveSessionId: undefined,
            executionGeneration: undefined,
            busyMode: undefined
          };
        });
        const localLatest = conversations.value.reduce((latest, item) => Math.max(latest, item.updatedAt || 0), 0);
        const backendLatest = restored.reduce((latest, item) => Math.max(latest, item.updatedAt || 0), 0);
        // Prefer local on a tie: deleting a conversation does not bump the remaining rows'
        // timestamps, so a same-timestamp file would otherwise resurrect it.
        if (conversations.value.length && localLatest >= backendLatest) {
          // Keep local unsaved work and write it back after load instead of
          // letting an older file erase the current conversation.
          hasBackend = false;
        } else {
          conversations.value = restored;
          activeId.value = typeof parsed.activeId === 'string' ? parsed.activeId : null;
          // The restored conversation may be the one still streaming in this profile.
          syncTurnUi();
        }
      }
    } catch {
      if (seq === historySeq) {
        historySaveEnabled = false;
        toasts.push({
          tone: 'warning',
          title: 'Hermes history',
          description: 'history.json is unreadable; keeping the local copy and leaving the file untouched.'
        });
      }
    } finally {
      if (seq === historySeq) {
        historyLoaded = true;
        historyReady.value = true;
        if (!hasBackend && historySaveEnabled) scheduleHistorySave();
        // The runtime queue is not persisted, but a queued row is. Rebuild it and resume when
        // the conversation it belongs to is in this profile and the slot is free.
        drainQueuedTurns();
      }
      done();
    }
  }

  async function uninstallRuntime(): Promise<boolean> {
    try {
      runtime.value = await unwrap(commands.hermesRuntimeUninstall());
      localStorage.removeItem(STORAGE_KEY);
      invalidateModelOptionsCacheFor();
      removeLegacyModelOptionsCache();
      modelOptions.value = null;
      modelOptionsUpdatedAt.value = null;
      modelOptionsOwner.value = null;
      conversations.value = [];
      activeId.value = null;
      model.value = { ...DEFAULT_MODEL };
      mac.value = { ...DEFAULT_MAC };
      toasts.push({ tone: 'success', title: 'Hermes', description: 'Local Hermes and its data were removed.' });
      return true;
    } catch (error) {
      const detail = error instanceof IpcError ? (error.detail ?? error.message) : String(error);
      toasts.push({ tone: 'danger', title: 'Hermes uninstall', description: detail });
      return false;
    }
  }

  function modelOptionsCacheEndpoint(connectionId: string, localEndpoint: string): string {
    return modelOptionsEndpoint(
      profiles.value.find(profile => profile.id === connectionId),
      localEndpoint
    );
  }

  /** The in-memory catalog, but only when it belongs to this connection, profile and endpoint. */
  function modelOptionsForScope(
    profileName = activeAgentProfileName.value,
    source: HermesModelSettings = model.value
  ): HermesModelOptions | null {
    const cacheKey = modelOptionsCacheKey(
      activeProfileId.value,
      profileName,
      modelOptionsCacheEndpoint(activeProfileId.value, source.endpoint)
    );
    return modelOptionsOwner.value === cacheKey ? modelOptions.value : null;
  }

  function alignRemoteModelToCatalog(options: HermesModelOptions) {
    if (!remoteActive.value) return;
    const remoteProviders = options.providers ?? [];
    // A host can list a stale `custom` row next to the scoped `custom:newapi` row that
    // actually answers. The stale row is often `is_current` and carries one old model, so
    // "first current provider" selects exactly the broken one. Prefer an authenticated row.
    const forCard = pickOfficialProvider(remoteProviders, model.value.provider);
    const remoteProvider =
      (forCard?.authenticated && (forCard.models?.length ?? 0) > 0 ? forCard : undefined) ??
      remoteProviders.find(
        provider => provider.is_current && provider.authenticated && (provider.models?.length ?? 0) > 0
      ) ??
      remoteProviders.find(provider => provider.authenticated && (provider.models?.length ?? 0) > 0) ??
      ((forCard?.models?.length ?? 0) > 0 ? forCard : undefined) ??
      remoteProviders.find(provider => provider.is_current && (provider.models?.length ?? 0) > 0) ??
      remoteProviders.find(provider => (provider.models?.length ?? 0) > 0);
    if (!remoteProvider) return;
    const remoteModels = remoteProvider.models ?? [];
    if (!remoteModels.includes(model.value.model)) {
      model.value.model = remoteModels[0]!;
    }
    const mappedProvider = providerCardForSlug(remoteProvider.slug);
    if (mappedProvider) model.value.provider = mappedProvider;
  }

  /**
   * The concrete provider slug the panel host must receive.
   *
   * `model.provider` is an OpenNavo card id (`custom`), while a panel may register the
   * working endpoint under a scoped runtime slug (`custom:newapi`). Sending the card id
   * resolves to the host's stale canonical provider instead.
   */
  function remoteChatTarget(): { provider: string; model: string } {
    const options = modelOptionsForScope();
    const row = options ? pickOfficialProvider(options.providers ?? [], model.value.provider) : undefined;
    if (!row) return { provider: model.value.provider, model: modelId(model.value.model) };
    const models = row.models ?? [];
    if (models.length && !models.includes(model.value.model)) {
      // Repair state saved by an older build that aligned to the stale row. Keeping the
      // visible selection and the outgoing turn in sync avoids sending a model the
      // authenticated endpoint does not serve.
      model.value.model = models[0]!;
    }
    return { provider: row.slug?.trim() || model.value.provider, model: modelId(model.value.model) };
  }

  function applyModelOptionsCatalog(options: HermesModelOptions, at: number, ownerKey: string, alignModel = false) {
    modelOptions.value = options;
    modelOptionsUpdatedAt.value = at;
    modelOptionsOwner.value = ownerKey;
    const catalogProfile = profiles.value.find(profile => profile.id === activeProfileId.value);
    if (catalogProfile) catalogProfile.models = modelCatalogCount(options);
    if (alignModel) alignRemoteModelToCatalog(options);
  }

  async function loadModelOptions(
    refresh = false,
    source: HermesModelSettings = model.value,
    keyOverride?: string,
    profileName = activeAgentProfileName.value
  ) {
    if (!runtime.value?.ready && !remoteActive.value) return;
    const owner = stateKey(activeProfileId.value, profileName);
    const requestApiKey = (keyOverride ?? apiKey.value).trim();
    const requestKey = [
      owner,
      source.provider,
      modelId(source.model),
      source.effort,
      String(source.fast),
      source.endpoint.trim(),
      String(refresh),
      gatewayUrl.value ?? '',
      gatewayProfileId.value ?? '',
      credentialFingerprint(requestApiKey),
      String(panelActive.value),
      String(panelAuthGeneration),
      panelAuthExpired.value ?? ''
    ].join('::');
    if (modelOptionsLoading.value && modelOptionsRequestKey === requestKey) return;
    const cacheKey = modelOptionsCacheKey(
      activeProfileId.value,
      profileName,
      modelOptionsCacheEndpoint(activeProfileId.value, source.endpoint)
    );
    const cached = readModelOptionsCache(cacheKey);
    const seq = ++modelOptionsSeq;
    const epoch = modelOptionsEpoch;
    if (cached) {
      if (modelOptionsOwner.value !== cacheKey || (modelOptionsUpdatedAt.value ?? 0) < cached.at) {
        // A cached catalog may be stale relative to the model the user just saved, so it only
        // fills the picker and never rewrites the active model. Only a fresh response aligns.
        applyModelOptionsCatalog(cached.options, cached.at, cacheKey);
      }
      if (!refresh && Date.now() - cached.at < MODEL_OPTIONS_CACHE_TTL) {
        modelOptionsError.value = null;
        // This call supersedes any catalog still in flight for another scope. Its `seq` is now
        // stale, so its `finally` will not clear the loading state this call owns.
        modelOptionsLoading.value = false;
        modelOptionsRequestKey = null;
        return;
      }
    }
    modelOptionsRequestKey = requestKey;
    modelOptionsLoading.value = true;
    modelOptionsError.value = null;
    try {
      const request = unwrap(
        commands.hermesModelOptions({
          provider: source.provider,
          model: modelId(source.model),
          effort: source.effort,
          fast: source.fast,
          apiKey: requestApiKey || null,
          endpoint: source.endpoint.trim() || null,
          refresh,
          includeUnconfigured: true,
          gatewayUrl: gatewayUrl.value,
          profileId: gatewayProfileId.value,
          profile: profileName,
          panelAuth: panelActive.value
        })
      );
      const options = await Promise.race([
        request,
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('加载官方模型目录超时，请稍后重试。')), 55_000)
        )
      ]);
      // A newer profile, provider or refresh owns the visible catalog. The old response must not
      // overwrite it, and it must not persist a model choice for the newly selected profile.
      if (
        seq !== modelOptionsSeq ||
        epoch !== modelOptionsEpoch ||
        stateKey(activeProfileId.value, profileName) !== owner
      )
        return;
      const at = Date.now();
      applyModelOptionsCatalog(options, at, cacheKey, profileName === activeAgentProfileName.value);
      writeModelOptionsCache(cacheKey, options, at);
    } catch (error) {
      if (seq !== modelOptionsSeq || epoch !== modelOptionsEpoch) return;
      modelOptionsError.value = catalogFailureText(error);
      notePanelAuthError(error);
    } finally {
      if (seq === modelOptionsSeq) {
        modelOptionsLoading.value = false;
        modelOptionsRequestKey = null;
      }
    }
  }

  function cancelModelOptionsRequest() {
    // A request started before this point carries a catalog for the invalidated scope. Advance
    // the epoch so it cannot apply or write itself back over the cleared cache.
    modelOptionsEpoch += 1;
    modelOptionsLoading.value = false;
    modelOptionsRequestKey = null;
  }

  /**
   * Drop cached catalogs for one connection (or every connection when omitted), optionally
   * scoped to one or more agent profiles. A request already in flight for the active connection
   * is invalidated with the cache it would otherwise repopulate.
   */
  function invalidateModelOptionsCacheFor(connectionId?: string, ...profileNames: (string | undefined)[]) {
    if (profileNames.length === 0) {
      clearModelOptionsCache(connectionId);
    } else {
      for (const profileName of profileNames) clearModelOptionsCache(connectionId, profileName);
    }
    if (!connectionId || connectionId === activeProfileId.value) cancelModelOptionsRequest();
  }

  function invalidateModelOptionsCache(profileName?: string) {
    invalidateModelOptionsCacheFor(activeProfileId.value, profileName);
  }

  function agentProfileModel(name: string): HermesModelSettings {
    return {
      ...(profileStates.value[stateKey(activeProfileId.value, name)]?.model ?? { ...DEFAULT_MODEL, keySet: false })
    };
  }

  function agentProfileMac(name: string): HermesMacSettings {
    return { ...(profileStates.value[stateKey(activeProfileId.value, name)]?.mac ?? DEFAULT_MAC) };
  }

  function setAgentProfileModel(name: string, next: HermesModelSettings) {
    const key = stateKey(activeProfileId.value, name);
    const state = profileStates.value[key] ?? blankProfileState();
    profileStates.value = { ...profileStates.value, [key]: { ...state, model: { ...next } } };
    persist();
  }

  function setAgentProfileMac(name: string, next: HermesMacSettings) {
    const key = stateKey(activeProfileId.value, name);
    const state = profileStates.value[key] ?? blankProfileState();
    profileStates.value = { ...profileStates.value, [key]: { ...state, mac: { ...next } } };
    persist();
  }

  function setAgentProfileDefault(name: string) {
    defaultAgentProfiles.value = { ...defaultAgentProfiles.value, [activeProfileId.value]: name };
    persist();
    toasts.push({ tone: 'success', title: 'Hermes', description: 'Default profile updated.' });
  }

  function setAgentProfileColor(name: string, color: string | null) {
    const next = { ...profileColors.value };
    if (color) next[name] = color;
    else delete next[name];
    profileColors.value = next;
    persist();
  }

  function moveAgentProfile(name: string, direction: -1 | 1) {
    const current = agentProfiles.value.map(profile => profile.name);
    const index = current.indexOf(name);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= current.length) return;
    const next = [...current];
    [next[index], next[target]] = [next[target]!, next[index]!];
    profileOrder.value = { ...profileOrder.value, [activeProfileId.value]: next };
    persist();
  }

  async function addPanelProfile(name: string, baseUrl: string, username: string, password: string) {
    const profileId = `panel-${Date.now().toString(36)}`;
    const login = await unwrap(commands.hermesPanelLogin(profileId, baseUrl.trim(), username.trim(), password));
    panelAuthGeneration += 1;
    panelAuthExpired.value = null;
    try {
      const list = await unwrap(commands.hermesAgentProfiles(profileId, login.baseUrl));
      if (!list.length) throw new Error('The panel returned no profiles.');
    } catch (error) {
      await commands.hermesPanelLogout(profileId).catch(() => undefined);
      throw error;
    }
    const probe = await unwrap(commands.hermesConnectionProbe(profileId, login.baseUrl)).catch(() => null);
    const profile: HermesProfile = {
      id: profileId,
      name: name.trim() || 'Hermes Panel',
      kind: 'panel',
      endpoint: login.baseUrl,
      status: 'connected',
      version: /(\d+\.\d+\.\d+)/.exec(probe?.version ?? '')?.[1] ?? '',
      latency: probe?.latencyMs ?? null,
      models: 0
    };
    profiles.value = [...profiles.value, profile];
    switchProfile(profileId);
    await loadAgentProfiles();
    return profile;
  }

  async function reloginPanel(profileId: string, baseUrl: string, username: string, password: string) {
    const profile = profiles.value.find(item => item.id === profileId && item.kind === 'panel');
    if (!profile) throw new Error('Panel connection not found.');
    await commands.hermesPanelLogout(profileId).catch(() => undefined);
    invalidateModelOptionsCacheFor(profileId);
    await unwrap(commands.hermesPanelLogin(profileId, baseUrl.trim(), username.trim(), password));
    panelAuthGeneration += 1;
    panelAuthExpired.value = null;
    await unwrap(commands.hermesAgentProfiles(profileId, baseUrl.trim()));
    const probe = await unwrap(commands.hermesConnectionProbe(profileId, baseUrl.trim())).catch(() => null);
    profile.endpoint = baseUrl.trim();
    profile.status = 'connected';
    profile.version = /(\d+\.\d+\.\d+)/.exec(probe?.version ?? '')?.[1] ?? profile.version;
    profile.latency = probe?.latencyMs ?? profile.latency;
    profile.models = 0;
    profile.error = undefined;
    await loadAgentProfiles();
    await loadModelOptions(true);
    panelAuthExpired.value = null;
  }

  async function probeConnections() {
    const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!tauri) return;
    await Promise.all(
      profiles.value
        .filter(profile => profile.kind !== 'local')
        .map(async profile => {
          try {
            const result = await unwrap(commands.hermesConnectionProbe(profile.id, profile.endpoint));
            profile.status = result.ok ? 'connected' : 'error';
            profile.latency = result.latencyMs;
            profile.version = /(\d+\.\d+\.\d+)/.exec(result.version ?? '')?.[1] ?? profile.version;
            profile.error = undefined;
          } catch (error) {
            profile.status = 'offline';
            profile.error = 'Connection probe failed';
            if (profile.id === activeProfile.value.id) notePanelAuthError(error);
          }
        })
    );
    persist();
  }

  async function removeProfile(profileId: string) {
    if (profileId === 'local') return;
    const profile = profiles.value.find(item => item.id === profileId);
    if (!profile) return;
    if (profile.kind === 'panel') {
      await commands.hermesPanelLogout(profileId).catch(() => undefined);
      panelAuthGeneration += 1;
    }
    invalidateModelOptionsCacheFor(profileId);
    // Removing a connection removes its conversations; their turns must not keep writing into
    // deleted state or leave the backend running unattended.
    for (const turn of liveTurns.values()) {
      if (!turn.ownerKey.startsWith(`${profileId}::`)) continue;
      const conversation = conversationForOwner(turn.conversationId, turn.ownerKey);
      if (conversation) markConversationStopped(conversation);
      void requestTurnStop(turn, true).catch(() => undefined);
      retireLiveTurn(turn.turn);
    }
    // Queues are keyed by conversation, not by profile: drop every one that belonged to the
    // state being removed, or an orphan key would keep waiting forever. The active profile's
    // conversations live in `conversations`, not in its saved state, so include both.
    if (activeProfileId.value === profileId) forgetQueuesFor(conversations.value);
    for (const [key, state] of Object.entries(profileStates.value)) {
      if (key.startsWith(`${profileId}::`)) forgetQueuesFor(state.conversations);
    }
    const wasActive = activeProfileId.value === profileId;
    profiles.value = profiles.value.filter(item => item.id !== profileId);
    const nextStates = { ...profileStates.value };
    for (const key of Object.keys(nextStates)) {
      if (key.startsWith(`${profileId}::`)) delete nextStates[key];
    }
    profileStates.value = nextStates;
    const nextAgents = { ...activeAgentProfiles.value };
    delete nextAgents[profileId];
    activeAgentProfiles.value = nextAgents;
    const nextDefaults = { ...defaultAgentProfiles.value };
    delete nextDefaults[profileId];
    defaultAgentProfiles.value = nextDefaults;
    if (wasActive) {
      activeProfileId.value = 'local';
      panelHistoryGeneration += 1;
      applyProfileState(profileStates.value[stateKey('local', 'default')] ?? blankProfileState());
      modelOptions.value = null;
      modelOptionsUpdatedAt.value = null;
      modelOptionsOwner.value = null;
      drainActiveQueue();
    }
    persist();
  }

  function switchProfile(profileId: string, agentName?: string) {
    const profile = profiles.value.find(item => item.id === profileId);
    if (!profile || (profileId === activeProfileId.value && !agentName)) return;
    // A turn keeps running in the profile being left behind: switching only moves the view.
    // `applyProfileState` below re-derives the stop button for the new profile's conversation.
    // Persist the outgoing profile's conversations before the active route changes, so a
    // delayed debounce cannot write them into the next profile's file.
    flushHistorySave();
    saveActiveProfileState();
    // The typed key belongs to the profile that was just saved into; carrying it over made
    // the next `write_config` copy it into the newly selected profile's `.env`.
    apiKey.value = '';
    activeProfileId.value = profileId;
    panelHistoryGeneration += 1;
    if (agentName) {
      activeAgentProfiles.value = { ...activeAgentProfiles.value, [profileId]: agentName };
    } else if (!activeAgentProfiles.value[profileId]) {
      activeAgentProfiles.value = {
        ...activeAgentProfiles.value,
        [profileId]: defaultAgentProfiles.value[profileId] ?? 'default'
      };
    }
    modelOptions.value = null;
    modelOptionsUpdatedAt.value = null;
    modelOptionsOwner.value = null;
    if (profile.kind !== 'local') {
      mac.value = { ...DEFAULT_MAC };
    }
    applyProfileState(profileStates.value[stateKey()] ?? blankProfileState());
    persist();
    void loadAgentProfiles();
    void loadHistory();
    void loadPanelHistory();
    drainActiveQueue();
    void activateCurrentProfile();
  }

  /** Panel requests carry the agent profile so the host scopes its own session store. */
  function agentProfileArg(): string | null {
    const name = activeAgentProfileName.value;
    return name && name !== 'default' ? name : null;
  }

  /**
   * The profile argument for a specific panel row.
   *
   * The aggregated list mixes several stores, so a write has to name the row's own profile; the
   * active one would address the wrong store (404 on read, wrong row on a fenced delete).
   */
  function panelProfileArg(conversation: HermesConversation): string | null {
    const name = conversation.panelProfile?.trim();
    if (!name) return agentProfileArg();
    return name === 'default' ? null : name;
  }

  function connectionArgs() {
    return {
      connectionId: remoteActive.value ? activeProfile.value.id : null,
      gatewayUrl: remoteActive.value ? activeProfile.value.endpoint : null
    };
  }

  async function loadAgentProfilesFor(connection: HermesProfile) {
    agentProfilesLoadingIds.value = new Set(agentProfilesLoadingIds.value).add(connection.id);
    try {
      return await loadAgentProfilesInner(connection);
    } finally {
      const next = new Set(agentProfilesLoadingIds.value);
      next.delete(connection.id);
      agentProfilesLoadingIds.value = next;
    }
  }

  async function loadAgentProfilesInner(connection: HermesProfile) {
    const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    const fallback: HermesAgentProfile[] = [
      {
        name: activeAgentProfiles.value[connection.id] ?? 'default',
        displayName: null,
        path: connection.endpoint || 'local',
        isDefault: true,
        model: null,
        provider: null,
        skillCount: 0,
        hasEnv: false
      }
    ];
    if (!tauri) {
      agentProfilesByConnection.value = { ...agentProfilesByConnection.value, [connection.id]: fallback };
      return fallback;
    }
    try {
      const list = await unwrap(
        commands.hermesAgentProfiles(
          connection.kind !== 'local' ? connection.id : null,
          connection.kind !== 'local' ? connection.endpoint : null
        )
      );
      agentProfilesByConnection.value = { ...agentProfilesByConnection.value, [connection.id]: list };
      connection.status = 'connected';
      connection.models = list.length;
      connection.error = undefined;
      const current = activeAgentProfiles.value[connection.id];
      if (!current || !list.some(profile => profile.name === current)) {
        activeAgentProfiles.value = {
          ...activeAgentProfiles.value,
          [connection.id]: list.find(profile => profile.isDefault)?.name ?? list[0]?.name ?? 'default'
        };
      }
      return list;
    } catch (error) {
      const code = error instanceof IpcError ? error.code : '';
      const detail = error instanceof IpcError ? (error.detail ?? error.message) : String(error);
      connection.status = 'error';
      connection.error = detail;
      if (connection.kind === 'panel' && code === 'E_HERMES_PANEL_AUTH') {
        panelAuthExpired.value = connection.id;
        toasts.push({
          tone: 'warning',
          title: 'Hermes Panel',
          description: 'The Hermes Panel session expired. Sign in again.'
        });
      }
      agentProfilesByConnection.value = { ...agentProfilesByConnection.value, [connection.id]: fallback };
      return fallback;
    }
  }

  async function loadAgentProfiles() {
    return loadAgentProfilesFor(activeProfile.value);
  }

  async function loadAllAgentProfiles() {
    await Promise.all(profiles.value.map(connection => loadAgentProfilesFor(connection)));
  }

  /** Paging state for one slice of the active profile, created on first use. */
  function sliceState(slice: PanelHistorySlice, key = stateKey()): PanelSliceState {
    if (!panelSlices[key]) panelSlices[key] = emptySlices();
    const record = panelSlices[key];
    return record[slice];
  }

  /**
   * Forget every cached slice of every connection+profile.
   *
   * A host write can change more than the active profile's list (the aggregated read spans all of
   * them), and the cursor counted rows against the list that just changed: keeping it would make
   * the next append skip a row.
   */
  function invalidatePanelSlices() {
    panelHistoryGeneration += 1;
    for (const record of Object.values(panelSlices)) {
      for (const slice of PANEL_HISTORY_SLICES) {
        const state = record[slice];
        state.loaded = false;
        state.offset = 0;
      }
    }
  }

  /** Read-only view for the UI: rendering must never create store state. */
  const IDLE_SLICE: PanelSliceState = Object.freeze({
    offset: 0,
    total: 0,
    hasMore: false,
    loaded: false,
    loading: false,
    error: null,
    degraded: false
  });

  function panelSliceState(slice: PanelHistorySlice): PanelSliceState {
    const record = panelSlices[stateKey()];
    return record ? record[slice] : IDLE_SLICE;
  }

  function emptySlices(): Record<PanelHistorySlice, PanelSliceState> {
    const fresh = (): PanelSliceState => ({
      offset: 0,
      total: 0,
      hasMore: false,
      loaded: false,
      loading: false,
      error: null,
      degraded: false
    });
    return { recents: fresh(), messaging: fresh(), cron: fresh(), archived: fresh() };
  }

  /** Rows of one slice, newest first. Local conversations only belong to the recents view. */
  function panelRowsFor(slice: PanelHistorySlice): HermesConversation[] {
    // Outside the aggregated read the list only owns the active profile's rows: anything another
    // profile contributed is hidden instead of shown as a row that cannot be opened.
    const owner = activeAgentProfileName.value;
    const scoped = panelAllProfiles.value ? history.value : history.value.filter(item => ownsPanelRow(item, owner));
    if (slice === 'recents') return scoped.filter(item => !item.panel || sliceOf(item) === 'recents');
    return scoped.filter(item => item.panel && sliceOf(item) === slice);
  }

  /**
   * Whether the host reports that a row changed since its transcript was read. A turn from this
   * window only appends locally, so the host's own signals are the ones that matter.
   */
  function hostMovedOn(before: HermesConversation, after: HermesConversation): boolean {
    if (before.panelMessages !== after.panelMessages) return true;
    // Both sides have to carry a host timestamp: `updatedAt` falls back to the local clock, so a
    // missing one would look newer on every read.
    return (
      before.panelActivity !== undefined &&
      after.panelActivity !== undefined &&
      after.panelActivity > before.panelActivity
    );
  }

  /**
   * Fold one page into the conversation store without losing what another slice owns.
   *
   * A transcript already read for a row is kept, and a replace only drops rows *this* slice
   * listed before: a row that moved to another view (archived, another platform) is re-tagged
   * by its own read, never silently discarded.
   */
  function mergePanelPage(
    slice: PanelHistorySlice,
    loaded: HermesConversation[],
    append: boolean,
    owner: string,
    allProfiles: boolean
  ) {
    const byId = new Map(loaded.map(item => [item.id, item] as const));
    const next: HermesConversation[] = [];
    let activeInvalidated = false;
    for (const conversation of conversations.value) {
      if (!conversation.panel) {
        next.push(conversation);
        continue;
      }
      const fresh = byId.get(conversation.id);
      if (fresh) {
        byId.delete(conversation.id);
        // The row moved on the host since its transcript was read (a new turn, a rename from
        // another client). Keeping the cached transcript then sticks forever, because
        // `messagesLoaded` says it is already read; local-only turns are still kept.
        const moved = hostMovedOn(conversation, fresh);
        if (moved) {
          fresh.messages = conversation.messages.filter(entry => !entry.id.startsWith('panel-'));
          fresh.messagesLoaded = false;
          fresh.panelOffset = 0;
          fresh.panelHasOlder = false;
          if (conversation.id === activeId.value) activeInvalidated = true;
        } else {
          fresh.messages = conversation.messages;
          fresh.messagesLoaded = conversation.messagesLoaded;
          fresh.panelOffset = conversation.panelOffset;
          fresh.panelHasOlder = conversation.panelHasOlder;
        }
        fresh.context = conversation.context;
        next.push(fresh);
        continue;
      }
      // Keep rows from other slices, and (on an append) the pages already loaded here.
      const owned = allProfiles || ownsPanelRow(conversation, owner);
      if ((sliceOf(conversation) !== slice || append) && owned) next.push(conversation);
    }
    next.push(...byId.values());
    // Conversations this window owns locally (an in-flight turn, or a chat started here that
    // the host has not listed yet) are never dropped by a panel page.
    conversations.value = next.sort((left, right) => right.updatedAt - left.updatedAt);
    // The open conversation just lost its transcript: read it again instead of showing an empty
    // chat area until the user selects the row a second time.
    if (activeInvalidated && activeId.value) void loadPanelConversation(activeId.value);
  }

  /**
   * Read one history slice. Slices are separate requests because one busy gateway would
   * otherwise fill the first page on its own; each slice also has its own paging cursor.
   */
  async function loadPanelHistory(slice: PanelHistorySlice = 'recents', append = false) {
    if (!panelActive.value) return;
    const key = stateKey();
    const owner = activeAgentProfileName.value;
    const connectionId = activeProfile.value.id;
    const profileArg = agentProfileArg();
    const allProfiles = panelAllProfiles.value;
    const generation = panelHistoryGeneration;
    const requestId = `${key}::${slice}`;
    const state = sliceState(slice, key);
    if (state.loading) {
      return new Promise<void>(resolve => {
        const waiters = panelHistoryWaiters.get(requestId) ?? [];
        waiters.push(resolve);
        panelHistoryWaiters.set(requestId, waiters);
      });
    }
    if (!append && state.loaded) return;
    const seq = (panelHistoryRequests.get(requestId) ?? 0) + 1;
    panelHistoryRequests.set(requestId, seq);
    // A replace re-reads everything already on screen, so the page it drops and the page it
    // draws are the same window; an append asks for the next one.
    const loadedRows = conversations.value.filter(item => item.panel && sliceOf(item) === slice).length;
    const limit = append ? PANEL_HISTORY_PAGE : Math.min(PANEL_HISTORY_MAX, Math.max(PANEL_HISTORY_PAGE, loadedRows));
    const offset = append ? state.offset : 0;
    state.loading = true;
    state.error = null;
    try {
      const raw = await unwrap(
        commands.hermesPanelHistory(connectionId, profileArg, allProfiles, slice, limit, offset)
      );
      // The user moved to another profile or changed the aggregate scope while this page was in
      // flight. Folding it into the new list would tag rows with the wrong owner and persist them.
      if (
        seq !== panelHistoryRequests.get(requestId) ||
        generation !== panelHistoryGeneration ||
        key !== stateKey() ||
        connectionId !== activeProfile.value.id ||
        allProfiles !== panelAllProfiles.value
      ) {
        return;
      }
      const parsed = JSON.parse(raw) as {
        sessions?: unknown[];
        total?: unknown;
        hasMore?: unknown;
        degraded?: unknown;
      };
      const rows = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      const loaded = rows
        .map(row =>
          row && typeof row === 'object' ? panelConversationFromRow(row as Record<string, unknown>, slice) : null
        )
        .filter(Boolean) as HermesConversation[];
      mergePanelPage(slice, loaded, append, owner, allProfiles);
      const total = typeof parsed.total === 'number' ? parsed.total : rows.length;
      state.offset = append ? state.offset + rows.length : rows.length;
      state.total = total;
      state.hasMore = parsed.hasMore === true;
      state.degraded = parsed.degraded === true;
      // An empty first page is a real answer (this profile has no rows), so it is cached too.
      state.loaded = true;
      // Keep the conversation the user is reading; only fall back when it is gone from the list.
      if (!append && !conversations.value.some(item => item.id === activeId.value)) {
        activeId.value = conversations.value[0]?.id ?? null;
      }
      persist();
    } catch (error) {
      if (seq === panelHistoryRequests.get(requestId) && generation === panelHistoryGeneration && key === stateKey()) {
        notePanelAuthError(error);
        // Not cached as empty: the next open retries instead of showing "no history".
        state.error = error instanceof IpcError ? (error.detail ?? error.message) : String(error);
      }
    } finally {
      if (seq === panelHistoryRequests.get(requestId)) state.loading = false;
      const waiters = panelHistoryWaiters.get(requestId);
      if (waiters) {
        panelHistoryWaiters.delete(requestId);
        for (const resolve of waiters) resolve();
      }
    }
  }

  function loadMorePanelHistory(slice: PanelHistorySlice = 'recents') {
    return loadPanelHistory(slice, true);
  }

  /** Re-read a slice after the host refused a fenced write or a row changed. */
  async function refreshPanelHistory(slice: PanelHistorySlice = 'recents') {
    if (!panelActive.value) return;
    const state = sliceState(slice);
    state.loaded = false;
    state.offset = 0;
    await loadPanelHistory(slice);
  }

  /**
   * Aggregate every profile on the host. The panel's aggregated endpoint tags rows with their
   * owner; an older host degrades to the current profile and the UI says so.
   */
  async function setPanelAllProfiles(all: boolean) {
    if (panelAllProfiles.value === all) return;
    panelAllProfiles.value = all;
    // Rows were read under the previous scope: every cached profile has to be read again, and the
    // caller (the open history view) decides which slice to fetch now.
    invalidatePanelSlices();
    for (const record of Object.values(panelSlices)) {
      for (const slice of PANEL_HISTORY_SLICES) record[slice].error = null;
    }
    // Turning the aggregate off drops the rows other profiles contributed, so they cannot linger in
    // this profile's list (and in its persisted state) after the scope changed.
    if (all) return;
    const owner = activeAgentProfileName.value;
    const kept: HermesConversation[] = [];
    let rehomed = false;
    for (const conversation of conversations.value) {
      if (ownsPanelRow(conversation, owner)) {
        kept.push(conversation);
        continue;
      }
      // This row belongs to another agent profile. A turn started on it from this window still
      // carries this profile as its owner; hand the conversation and the turn to the row's own
      // state, or chunks and the completion would look for it here and lose it (and
      // `syncConversation` would re-insert it on completion). Rows with a queued send move too.
      const turn = liveTurnForConversation(conversation.id);
      // A turn from another profile already writes into that profile's own copy; replacing it
      // with this list row would drop the live transcript.
      if (turn && turn.ownerKey !== stateKey()) continue;
      const homeOwner = conversation.panelProfile?.trim();
      const hasLocalWork =
        Boolean(turn) ||
        Boolean(queuedAfterTurn.get(conversation.id)?.length) ||
        Boolean(pendingSteers.get(conversation.id)?.length) ||
        conversation.messages.some(entry => !entry.id.startsWith('panel-'));
      if (!homeOwner || !hasLocalWork) continue;
      const homeKey = stateKey(activeProfileId.value, homeOwner);
      if (turn) turn.ownerKey = homeKey;
      const home = profileStates.value[homeKey] ?? blankProfileState();
      const existing = home.conversations.find(item => item.id === conversation.id);
      // Keep a transcript the home profile already loaded; append this row's own messages. A
      // live turn's user row and bubble are among them by reference, so chunks keep landing on
      // the bubble even though the stored conversation object is new.
      const messageIds = new Set((existing?.messages ?? []).map(entry => entry.id));
      const moved = existing
        ? {
            ...existing,
            ...conversation,
            messages: [...existing.messages, ...conversation.messages.filter(entry => !messageIds.has(entry.id))],
            messagesLoaded: existing.messagesLoaded,
            panelOffset: existing.panelOffset,
            panelHasOlder: existing.panelHasOlder
          }
        : conversation;
      profileStates.value = {
        ...profileStates.value,
        [homeKey]: {
          ...home,
          conversations: [moved, ...home.conversations.filter(item => item.id !== conversation.id)]
        }
      };
      rehomed = true;
    }
    conversations.value = kept;
    if (activeId.value && !kept.some(item => item.id === activeId.value)) {
      activeId.value = kept[0]?.id ?? null;
    }
    syncTurnUi();
    if (rehomed) {
      // The banner derives the row's owner; it must re-read the moved turn.
      liveTurnRevision.value += 1;
      persist();
    }
  }

  /** Archive or restore a panel row; the archive is its own slice on the host. */
  async function setConversationArchived(idValue: string, archived: boolean) {
    const target = conversations.value.find(item => item.id === idValue);
    if (!target?.panel) return;
    try {
      await unwrap(
        commands.hermesPanelSessionArchive(
          activeProfile.value.id,
          idValue,
          archived,
          target.panelRevision ?? 0,
          target.panelGeneration ?? 0,
          panelProfileArg(target)
        )
      );
    } catch (error) {
      notePanelAuthError(error);
      toasts.push({
        tone: 'warning',
        title: 'Hermes history',
        description: archived
          ? 'Could not archive this panel conversation.'
          : 'Could not restore this panel conversation.'
      });
      void refreshPanelHistory(target.panelSlice ?? 'recents');
      return;
    }
    target.panelArchived = archived;
    target.panelRevision = (target.panelRevision ?? 0) + 1;
    // The row belongs to another list now: drop it from the one on screen and reload that list
    // once the user comes back to it. A live turn would re-insert it locally on completion, so
    // end that turn first — archiving a conversation is a lifecycle action, unlike navigation.
    // Its queue must go before the stop (the stop may start the next queued send), and a
    // restored row must not replay text that was waiting when it was archived.
    forgetQueuesFor([target]);
    for (const entry of target.messages) {
      if (entry.role === 'user' && entry.queued) entry.queued = false;
    }
    stopTurnForConversation(idValue);
    conversations.value = conversations.value.filter(item => item.id !== idValue);
    if (activeId.value === idValue) {
      activeId.value = conversations.value[0]?.id ?? null;
      // The new row on screen may own the (only) live turn.
      syncTurnUi();
    }
    invalidatePanelSlices();
    persist();
  }

  /**
   * Read one panel transcript on demand. The list deliberately carries no messages, so opening a
   * conversation is the only request that reads a transcript.
   */
  async function loadPanelConversation(idValue: string) {
    const target = conversations.value.find(item => item.id === idValue);
    if (!target?.panel || target.messagesLoaded) return;
    if (panelConversationLoading.value === idValue) return;
    panelConversationLoading.value = idValue;
    try {
      const raw = await unwrap(
        commands.hermesPanelSessionMessages(
          activeProfile.value.id,
          idValue,
          panelProfileArg(target),
          PANEL_TRANSCRIPT_PAGE,
          0
        )
      );
      const parsed = JSON.parse(raw) as { messages?: unknown[] };
      const rows = Array.isArray(parsed.messages) ? parsed.messages : [];
      const transcript = panelMessagesFrom(rows, idValue);
      // A turn sent while this read was in flight is newer than the transcript: keep it.
      const localOnly = target.messages.filter(entry => !entry.id.startsWith('panel-'));
      target.messages = [...transcript, ...localOnly];
      target.messagesLoaded = true;
      target.panelOffset = rows.length;
      // This route does not report `has_older`; a full page is the same signal the panel's own
      // desktop uses to offer the rows before it.
      target.panelHasOlder = rows.length >= PANEL_TRANSCRIPT_PAGE;
      // A row with no title fell back to its preview; the transcript gives a better one.
      const firstUser = transcript.find(entry => entry.role === 'user');
      if (!target.title || target.title === idValue) target.title = firstUser?.text?.slice(0, 48) || target.title;
      persist();
    } catch (error) {
      notePanelAuthError(error);
      toasts.push({
        tone: 'warning',
        title: 'Hermes history',
        description: 'Could not read this panel conversation.'
      });
    } finally {
      if (panelConversationLoading.value === idValue) panelConversationLoading.value = null;
    }
  }

  /**
   * Prepend the next older page. Offsets count back from the newest row, so the loaded row count
   * is the next offset; rows persisted between two reads are de-duplicated by message id.
   */
  async function loadOlderPanelMessages(idValue?: string) {
    const target = conversations.value.find(item => item.id === (idValue ?? activeId.value));
    if (!target?.panel || !target.panelHasOlder) return;
    if (panelConversationLoading.value === target.id) return;
    panelConversationLoading.value = target.id;
    try {
      const raw = await unwrap(
        commands.hermesPanelSessionMessages(
          activeProfile.value.id,
          target.id,
          panelProfileArg(target),
          PANEL_TRANSCRIPT_PAGE,
          target.panelOffset ?? 0
        )
      );
      const parsed = JSON.parse(raw) as { messages?: unknown[] };
      const rows = Array.isArray(parsed.messages) ? parsed.messages : [];
      const older = panelMessagesFrom(rows, target.id);
      const seen = new Set(target.messages.map(entry => entry.id));
      target.messages = [...older.filter(entry => !seen.has(entry.id)), ...target.messages];
      target.panelOffset = (target.panelOffset ?? 0) + rows.length;
      target.panelHasOlder = rows.length >= PANEL_TRANSCRIPT_PAGE;
      persist();
    } catch (error) {
      notePanelAuthError(error);
      toasts.push({
        tone: 'warning',
        title: 'Hermes history',
        description: 'Could not read older panel messages.'
      });
    } finally {
      if (panelConversationLoading.value === target.id) panelConversationLoading.value = null;
    }
  }

  async function activateCurrentProfile() {
    if (!runtimeReady.value && !remoteActive.value) return;
    const activation = ++profileActivationSeq;
    profileSwitching.value = true;
    profileSwitchError.value = null;
    try {
      await loadModelOptions(false);
      if (activation !== profileActivationSeq) return;
      if (modelOptionsError.value) profileSwitchError.value = modelOptionsError.value;
    } finally {
      if (activation === profileActivationSeq) profileSwitching.value = false;
    }
  }

  async function switchAgentProfile(name: string) {
    if (!name || name === activeAgentProfileName.value) return;
    const switchSeq = ++profileSwitchSeq;
    // Like a connection switch, this is navigation: the outgoing profile's running turn stays
    // alive and keeps writing into its own conversations (official desktop behavior).
    flushHistorySave();
    profileSwitchingTo.value = name;
    saveActiveProfileState();
    // Same reason as `switchProfile`: a key entered for the previous profile must not follow
    // the switch into this one's `.env`.
    apiKey.value = '';
    activeAgentProfiles.value = { ...activeAgentProfiles.value, [activeProfileId.value]: name };
    modelOptions.value = null;
    modelOptionsUpdatedAt.value = null;
    modelOptionsOwner.value = null;
    applyProfileState(profileStates.value[stateKey(activeProfileId.value, name)] ?? blankProfileState());
    if (remoteActive.value) mac.value = { ...DEFAULT_MAC };
    panelHistoryGeneration += 1;
    persist();
    void loadHistory();
    void loadPanelHistory();
    drainActiveQueue();
    try {
      await activateCurrentProfile();
    } finally {
      if (switchSeq === profileSwitchSeq) profileSwitchingTo.value = null;
    }
  }

  function switchToAgentProfile(connectionId: string, name: string) {
    if (connectionId !== activeProfileId.value) {
      switchProfile(connectionId, name);
    } else {
      switchAgentProfile(name);
    }
  }

  async function createAgentProfile(name: string, cloneFrom: string | null, soul: string | null) {
    const args = connectionArgs();
    await unwrap(commands.hermesAgentProfileCreate(args.connectionId, args.gatewayUrl, name, cloneFrom, soul));
    if (soul?.trim()) {
      // The create endpoint's `soul` field is not honored by every panel host (older builds
      // ignore an unknown field). Verify what the profile really holds before switching to it:
      // a first session that reads a cloned/default identity is exactly the silent failure this
      // check exists to surface. The profile itself exists, so the form keeps the actionable
      // error instead of closing as a success.
      try {
        await verifyAgentProfileSoul(name, soul);
      } catch (error) {
        await loadAgentProfiles();
        throw new Error(
          `Profile 已创建，但 SOUL.md 未能写入：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    await loadAgentProfiles();
    await switchAgentProfile(name);
  }

  async function renameAgentProfile(name: string, newName: string) {
    const args = connectionArgs();
    await unwrap(commands.hermesAgentProfileRename(args.connectionId, args.gatewayUrl, name, newName));
    invalidateModelOptionsCacheFor(activeProfileId.value, name, newName);
    const oldKey = stateKey(activeProfileId.value, name);
    const newKey = stateKey(activeProfileId.value, newName);
    const nextStates = { ...profileStates.value };
    if (nextStates[oldKey]) {
      nextStates[newKey] = nextStates[oldKey];
      delete nextStates[oldKey];
      profileStates.value = nextStates;
    }
    // A running turn looks its conversation up by owner key; follow the rename so it keeps
    // streaming into the same state instead of losing the conversation mid-answer.
    for (const turn of liveTurns.values()) {
      if (turn.ownerKey === oldKey) turn.ownerKey = newKey;
    }
    if (activeAgentProfileName.value === name) {
      activeAgentProfiles.value = { ...activeAgentProfiles.value, [activeProfileId.value]: newName };
    }
    if (defaultAgentProfiles.value[activeProfileId.value] === name) {
      defaultAgentProfiles.value = { ...defaultAgentProfiles.value, [activeProfileId.value]: newName };
    }
    const order = profileOrder.value[activeProfileId.value];
    if (order?.includes(name)) {
      profileOrder.value = {
        ...profileOrder.value,
        [activeProfileId.value]: order.map(item => (item === name ? newName : item))
      };
    }
    await loadAgentProfiles();
    persist();
  }

  async function deleteAgentProfile(name: string) {
    const args = connectionArgs();
    await unwrap(commands.hermesAgentProfileDelete(args.connectionId, args.gatewayUrl, name));
    invalidateModelOptionsCacheFor(activeProfileId.value, name);
    const removedKey = stateKey(activeProfileId.value, name);
    // The profile's state is about to disappear; stop anything still writing into it.
    for (const turn of liveTurns.values()) {
      if (turn.ownerKey !== removedKey) continue;
      const conversation = conversationForOwner(turn.conversationId, turn.ownerKey);
      if (conversation) markConversationStopped(conversation);
      void requestTurnStop(turn, true).catch(() => undefined);
      retireLiveTurn(turn.turn);
    }
    if (activeAgentProfileName.value === name) {
      await switchAgentProfile('default');
    }
    const removedState = profileStates.value[removedKey];
    if (removedState) forgetQueuesFor(removedState.conversations);
    const nextStates = { ...profileStates.value };
    delete nextStates[stateKey(activeProfileId.value, name)];
    profileStates.value = nextStates;
    await loadAgentProfiles();
    persist();
  }

  async function openAgentProfileWindow(name: string) {
    const args = connectionArgs();
    await unwrap(commands.hermesOpenProfileWindow(args.connectionId ?? 'local', name));
  }

  async function exportAgentProfile(name: string, output: string) {
    const args = connectionArgs();
    return unwrap(commands.hermesAgentProfileExport(args.connectionId, args.gatewayUrl, name, output));
  }

  async function importAgentProfile(archive: string, name: string | null) {
    const args = connectionArgs();
    await unwrap(commands.hermesAgentProfileImport(args.connectionId, args.gatewayUrl, archive, name));
    await loadAgentProfiles();
  }

  async function loadAgentProfileSoul(name: string) {
    const args = connectionArgs();
    return unwrap(commands.hermesAgentProfileSoul(args.connectionId, args.gatewayUrl, name));
  }

  /**
   * Write one profile's SOUL.md and prove the host stored it. A save is a plain file write, but
   * the editor must not report success for a host that answered OK while keeping another file
   * (create-time `soul` handling on older panel builds, or a per-profile resolution failure).
   */
  async function storeAgentProfileSoul(name: string, content: string) {
    const args = connectionArgs();
    await unwrap(commands.hermesAgentProfileSoulSave(args.connectionId, args.gatewayUrl, name, content));
    const expected = content.trim();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stored = await loadAgentProfileSoul(name);
      if (stored.trim() === expected) return;
      if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 80));
    }
    throw new Error('Hermes 未能写入该 Profile 的 SOUL.md。');
  }

  /** Make sure `content` is the profile's stored SOUL.md, writing it only when it is not. */
  async function verifyAgentProfileSoul(name: string, content: string) {
    const expected = content.trim();
    try {
      const stored = await loadAgentProfileSoul(name);
      if (stored.trim() === expected) return;
    } catch {
      // An unreadable file is exactly the case the explicit write below recovers.
    }
    await storeAgentProfileSoul(name, content);
  }

  async function saveAgentProfileSoul(name: string, content: string) {
    await storeAgentProfileSoul(name, content);
  }

  function updateProfile(profileId: string, patch: Partial<HermesProfile>) {
    const profile = profiles.value.find(item => item.id === profileId);
    if (!profile) return;
    const endpointChanged = typeof patch.endpoint === 'string' && patch.endpoint.trim() !== profile.endpoint.trim();
    Object.assign(profile, patch);
    if (endpointChanged) {
      invalidateModelOptionsCacheFor(profileId);
      if (profileId === activeProfileId.value) {
        modelOptions.value = null;
        modelOptionsUpdatedAt.value = null;
        modelOptionsOwner.value = null;
      }
    }
    persist();
  }

  /**
   * Only the newest login-status read may write. Opening settings, changing profile, and
   * switching connections all start a read; a slower reply from the previous host/profile
   * must not overwrite the current `loginStatus`.
   */
  let loginStatusSeq = 0;

  async function loadLoginStatus(profileName = activeAgentProfileName.value) {
    const seq = ++loginStatusSeq;
    try {
      // Official logins live in the agent profile's own `auth.json`, so the status must be
      // read from the profile being inspected, not from the shared root home.
      const profileArg = !profileName || profileName === 'default' ? null : profileName;
      const status = await unwrap(commands.hermesLoginStatus(profileArg));
      if (seq === loginStatusSeq) loginStatus.value = status;
    } catch {
      if (seq === loginStatusSeq) loginStatus.value = null;
    }
  }

  function setAuxiliary(task: HermesAuxTask, nextProvider: string, nextModel: string) {
    auxiliary.value = {
      ...auxiliary.value,
      [task]: { provider: nextProvider, model: nextModel }
    };
  }

  function resetAuxiliary() {
    auxiliary.value = defaultAuxSettings();
    forceAuxVision.value = false;
  }

  function setForceAuxVision(value: boolean) {
    forceAuxVision.value = value;
  }

  function resetSession() {
    if (active.value) {
      const conversationId = active.value.id;
      active.value.sessionId = undefined;
      active.value.liveSessionId = undefined;
      active.value.executionGeneration = undefined;
      active.value.busyMode = undefined;
      streamingAssistantIds.delete(conversationId);
      // A new session can no longer satisfy a steer's generation. Hand the text to the
      // next-turn queue instead of dropping it; rows already queued there stay valid.
      deferPendingSteers(conversationId);
    }
  }

  function setWorkingDir(value: string) {
    const changed = value !== workingDir.value;
    workingDir.value = value;
    if (changed) resetSession();
    persist();
  }

  function setApiKey(value: string) {
    apiKey.value = value;
  }

  function select(idValue: string) {
    if (!conversations.value.some(item => item.id === idValue)) return;
    activeId.value = idValue;
    // The selected conversation may still be streaming in the background.
    syncTurnUi();
    // A panel row is metadata only until it is opened.
    void loadPanelConversation(idValue);
    // A steer that failed while this conversation was in the background waits here.
    drainQueuedAfterTurn(idValue);
  }

  /**
   * Select a conversation opened from a system notification. Unlike a history-row click this
   * must not stop the turn that may be running in another conversation, and it has to cope with
   * a page that mounted before the conversation history had finished loading.
   */
  async function revealConversation(idValue: string): Promise<boolean> {
    const conversationId = idValue.trim();
    if (!conversationId) return false;
    if (!historyLoadStarted) await loadHistory();
    else if (!historyLoaded) await historyReadyPromise;
    if (!conversations.value.some(item => item.id === conversationId) && panelActive.value) {
      for (const slice of PANEL_HISTORY_SLICES) {
        if (conversations.value.some(item => item.id === conversationId)) break;
        const state = sliceState(slice);
        if (state.loading || !state.loaded) await loadPanelHistory(slice);
      }
    }
    if (!conversations.value.some(item => item.id === conversationId)) return false;
    activeId.value = conversationId;
    void loadPanelConversation(conversationId);
    return true;
  }

  function newChat() {
    activeId.value = null;
    // The previous conversation may still be streaming in the background; a fresh draft is idle.
    syncTurnUi();
  }

  async function deleteConversation(idValue: string) {
    if (historyLoadStarted && !historyLoaded) await historyReadyPromise;
    const index = conversations.value.findIndex(item => item.id === idValue);
    if (index < 0) return;
    const target = conversations.value[index];
    if (target?.panel) {
      // The host owns the row: dropping it locally only made it reappear on the next read.
      try {
        await unwrap(
          commands.hermesPanelSessionDelete(
            activeProfile.value.id,
            idValue,
            target.panelRevision ?? 0,
            target.panelGeneration ?? 0,
            panelProfileArg(target)
          )
        );
      } catch (error) {
        notePanelAuthError(error);
        toasts.push({
          tone: 'warning',
          title: 'Hermes history',
          description: 'Could not delete this panel conversation.'
        });
        // The row moved on the host: re-read the list it came from so the retry carries the fresh
        // fence instead of failing against the same stale one.
        void refreshPanelHistory(target.panelSlice ?? 'recents');
        return;
      }
    }
    // Drop this row's queue before stopping its turn: the turn's stop path may start the next
    // queued send, and that must never be a message belonging to the conversation being deleted.
    pendingSteers.delete(idValue);
    queuedAfterTurn.delete(idValue);
    streamingAssistantIds.delete(idValue);
    // A turn keeps writing into its conversation even while the row is off screen. Stop it
    // whether or not it is selected: its completion path would otherwise re-insert the row
    // (`syncConversation`) and persist the conversation the user just deleted.
    stopTurnForConversation(idValue);
    if (activeId.value === idValue) {
      activeId.value = null;
      syncTurnUi();
    }
    conversations.value = conversations.value.filter(item => item.id !== idValue);
    // The host dropped the row: other slices still list it until they are re-read.
    if (target?.panel) invalidatePanelSlices();
    persist();
    flushHistorySave();
  }

  async function renameConversation(idValue: string, title: string) {
    if (historyLoadStarted && !historyLoaded) await historyReadyPromise;
    const target = conversations.value.find(item => item.id === idValue);
    if (!target) return;
    const next = title.trim();
    if (!next) return;
    if (target.panel) {
      // Same reason as delete: the host's title is the one every client reads back.
      try {
        await unwrap(
          commands.hermesPanelSessionRename(
            activeProfile.value.id,
            idValue,
            next,
            target.panelRevision ?? 0,
            target.panelGeneration ?? 0,
            panelProfileArg(target)
          )
        );
      } catch (error) {
        notePanelAuthError(error);
        toasts.push({
          tone: 'warning',
          title: 'Hermes history',
          description: 'Could not rename this panel conversation.'
        });
        // The row moved on the host: re-read the list it came from so the next attempt carries the
        // fresh fence.
        void refreshPanelHistory(target.panelSlice ?? 'recents');
        return;
      }
    }
    target.title = next;
    target.updatedAt = Date.now();
    // The host bumped the row's revision for the write we just made.
    if (target.panel) target.panelRevision = (target.panelRevision ?? 0) + 1;
    persist();
    flushHistorySave();
  }

  async function clearHistory() {
    if (historyLoadStarted && !historyLoaded) await historyReadyPromise;
    // Panel rows live on the host, so only this Mac's own conversations can be cleared here.
    const cleared = conversations.value.filter(item => !item.panel).map(item => item.id);
    // Drop every queue first: stopping a turn can start the next queued send, and no cleared
    // conversation may be started (and then re-inserted) by that drain.
    for (const idValue of cleared) {
      pendingSteers.delete(idValue);
      queuedAfterTurn.delete(idValue);
      streamingAssistantIds.delete(idValue);
    }
    for (const idValue of cleared) stopTurnForConversation(idValue);
    conversations.value = conversations.value.filter(item => item.panel);
    if (activeId.value && !conversations.value.some(item => item.id === activeId.value)) activeId.value = null;
    syncTurnUi();
    persist();
    flushHistorySave();
  }

  function exportHistory() {
    if (typeof document === 'undefined') return;
    const payload = JSON.stringify(
      { version: STORAGE_VERSION, exportedAt: new Date().toISOString(), conversations: conversations.value },
      null,
      2
    );
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `opennavo-hermes-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function ensureConversation(): HermesConversation {
    if (active.value) return active.value;
    const conversation: HermesConversation = { id: id('c'), messages: [], updatedAt: Date.now() };
    conversations.value = [conversation, ...conversations.value];
    activeId.value = conversation.id;
    return conversation;
  }

  function scenarioFor(text: string): 'rectangle' | 'cleanup' | 'updates' | 'explain' | 'fallback' {
    if (/清理|磁盘|空间|缓存|clean|disk|storage|cache/i.test(text)) return 'cleanup';
    if (/更新|升级|update|upgrade/i.test(text)) return 'updates';
    if (/页面|这个|解释|做什么|page|explain|what can/i.test(text)) return 'explain';
    if (/窗口|分屏|管理|window|manager|snap/i.test(text)) return 'rectangle';
    return 'fallback';
  }

  function assistantFor(scenario: ReturnType<typeof scenarioFor>): HermesMessage {
    if (scenario === 'rectangle') {
      return message({
        role: 'assistant',
        textKey: 'messages.rectangle.assistant',
        tools: [
          { name: 'catalog.search', label: 'search', time: '0.8s' },
          { name: 'library.list', label: 'library', time: '0.4s' },
          { name: 'catalog.get', label: 'detail', time: '1.2s' }
        ],
        package: RECTANGLE,
        footKey: 'messages.rectangle.foot'
      });
    }
    if (scenario === 'cleanup') {
      return message({
        role: 'assistant',
        textKey: 'messages.cleanup.assistant',
        tools: [
          { name: 'cleanup.scan', label: 'scan', time: '1.4s' },
          { name: 'cleanup.classify', label: 'classify', time: '0.7s' }
        ],
        card: 'cleanup',
        footKey: 'messages.cleanup.foot'
      });
    }
    if (scenario === 'updates') {
      return message({
        role: 'assistant',
        textKey: 'messages.updates.assistant',
        tools: [
          { name: 'updates.check', label: 'updates', time: '0.9s' },
          { name: 'tasks.preview', label: 'preview', time: '0.5s' }
        ],
        card: 'updates',
        footKey: 'messages.updates.foot'
      });
    }
    if (scenario === 'explain') {
      return message({
        role: 'assistant',
        textKey: 'messages.explain.assistant',
        card: 'explain',
        footKey: 'messages.explain.foot'
      });
    }
    return message({ role: 'assistant', textKey: 'messages.fallback.assistant' });
  }

  function streamingAssistant(conversation: HermesConversation) {
    const assistantId = streamingAssistantIds.get(conversation.id);
    if (!assistantId) return undefined;
    return conversation.messages.find(entry => entry.id === assistantId);
  }

  /** The bubble that should receive this turn's deltas; after a seal, start a new one. */
  function ensureStreamingAssistant(conversation: HermesConversation) {
    const existing = streamingAssistant(conversation);
    if (existing) return existing;
    const assistant = message({ role: 'assistant', text: '', streaming: true });
    conversation.messages = [...conversation.messages, assistant];
    streamingAssistantIds.set(conversation.id, assistant.id);
    conversation.updatedAt = Date.now();
    return assistant;
  }

  /**
   * Freeze the bubble above an accepted correction. The next delta opens a new bubble below it,
   * and an empty placeholder is dropped so no blank assistant row survives the correction.
   */
  function sealStreamingAssistant(conversation: HermesConversation) {
    const assistantId = streamingAssistantIds.get(conversation.id);
    if (!assistantId) return;
    streamingAssistantIds.delete(conversation.id);
    const index = conversation.messages.findIndex(entry => entry.id === assistantId);
    if (index < 0) return;
    const entry = conversation.messages[index]!;
    entry.streaming = false;
    if (!entry.text && !entry.tools?.length && !entry.reasoning && !entry.decisions?.length) {
      conversation.messages.splice(index, 1);
    }
    conversation.updatedAt = Date.now();
  }

  /** A tool completion can land after its starting bubble was sealed; keep it on that bubble. */
  function findToolCall(
    conversation: HermesConversation,
    startIndex: number,
    toolId: string | undefined,
    name: string
  ) {
    for (let index = conversation.messages.length - 1; index >= startIndex; index -= 1) {
      const entry = conversation.messages[index];
      if (entry?.role !== 'assistant' || !entry.tools?.length) continue;
      const call = toolId
        ? entry.tools.find(item => item.toolId === toolId)
        : [...entry.tools].reverse().find(item => item.name === name && item.time === '…');
      if (call) return { entry, call };
    }
    return undefined;
  }

  function lastAssistantFrom(conversation: HermesConversation, startIndex: number) {
    for (let index = conversation.messages.length - 1; index >= startIndex; index -= 1) {
      const entry = conversation.messages[index];
      if (entry?.role === 'assistant') return entry;
    }
    return undefined;
  }

  function dropSteeringMessage(conversationId: string, messageId: string) {
    // A steer can outlive a switch, so the row may live in a background profile's state.
    const target = findConversationById(conversationId);
    const index = target?.messages.findIndex(entry => entry.id === messageId) ?? -1;
    if (!target || index < 0) return;
    target.messages.splice(index, 1);
    target.updatedAt = Date.now();
  }

  /** Runtime queues belong to conversations; drop them when their conversation is removed. */
  function forgetQueuesFor(conversationsToForget: Iterable<HermesConversation>) {
    for (const conversation of conversationsToForget) {
      pendingSteers.delete(conversation.id);
      queuedAfterTurn.delete(conversation.id);
      streamingAssistantIds.delete(conversation.id);
    }
  }

  function queueSteerAfterTurn(
    conversationId: string,
    text: string,
    front = false,
    messageId?: string,
    attachments?: string[]
  ) {
    const queued = queuedAfterTurn.get(conversationId) ?? [];
    const entry: QueuedSend = {
      text,
      messageId,
      attachments: attachments?.length ? [...attachments] : undefined
    };
    queuedAfterTurn.set(conversationId, front ? [entry, ...queued] : [...queued, entry]);
    return entry;
  }

  /**
   * A queued row is persisted with its conversation, but the queue itself is runtime state.
   * Rebuild the queue from the visible rows after a reload or a profile restore so a row saved
   * as `queued` can still be sent instead of sitting in the transcript forever.
   */
  function hydrateQueuedRows(conversationId: string) {
    const conversation = findConversationById(conversationId);
    if (!conversation) return;
    const queued = queuedAfterTurn.get(conversationId) ?? [];
    const attached = new Set(queued.map(entry => entry.messageId).filter((value): value is string => Boolean(value)));
    const missing = conversation.messages.filter(
      entry => entry.role === 'user' && entry.queued && !attached.has(entry.id)
    );
    if (!missing.length) return;
    queuedAfterTurn.set(conversationId, [
      ...queued,
      ...missing.map(entry => ({
        text: entry.text ?? '',
        messageId: entry.id,
        attachments: entry.attachments?.length ? [...entry.attachments] : undefined
      }))
    ]);
  }

  /** A steer accepted before its generation arrived still has to be sent on a later turn. */
  function deferPendingSteers(conversationId: string) {
    const pending = pendingSteers.get(conversationId);
    pendingSteers.delete(conversationId);
    if (!pending?.length) return;
    for (const steer of pending) {
      dropSteeringMessage(conversationId, steer.messageId);
      queueSteerAfterTurn(conversationId, steer.text);
    }
  }

  function drainQueuedAfterTurn(conversationId: string, allowBackground = false, parked?: QueuedSend) {
    // Reloaded/profile-restored conversations keep their queued rows but not the runtime queue.
    hydrateQueuedRows(conversationId);
    if (thinking.value || queuedDrain) return;
    // One runtime turn at a time: a background turn also owns the backend resources.
    if (liveTurns.size > 0) return;
    // A failed steer waits for its own conversation to come back on screen; the turn-end path
    // may start it in the background because the user was promised that send.
    if (!allowBackground && active.value?.id !== conversationId) return;
    // The target must still exist; the text belongs to its own conversation even when that
    // conversation is not the one on screen (the turn then runs in the background).
    if (!conversations.value.some(item => item.id === conversationId)) return;
    const queued = queuedAfterTurn.get(conversationId);
    if (!queued?.length) return;
    // A pre-submit Stop parks its row in the queue. It never owns the drain that follows: the
    // rows behind it do. (Only a parked row at the head changes which entry starts; a row that
    // was queued behind others stays there.)
    const nextIndex = parked !== undefined && queued[0] === parked ? 1 : 0;
    const next = queued[nextIndex];
    if (!next) return;
    const rest = queued.filter((_, index) => index !== nextIndex);
    if (rest.length) queuedAfterTurn.set(conversationId, rest);
    else queuedAfterTurn.delete(conversationId);
    const epoch = ++queuedDrainEpoch;
    queuedDrain = { id: conversationId, epoch };
    void send(next.text, next.attachments ?? [], conversationId, next.messageId).finally(() => {
      if (queuedDrain?.epoch === epoch) queuedDrain = null;
    });
  }

  function releaseQueuedDrain(conversationId: string) {
    if (queuedDrain?.id === conversationId) queuedDrain = null;
  }

  function drainActiveQueue() {
    if (activeId.value) drainQueuedAfterTurn(activeId.value);
  }

  /**
   * Start the next queued send now that no turn owns the shared slot. Prefer the conversation
   * on screen, then any other conversation in this profile: a queued row was promised a send
   * when the blocking turn ended, even if the user has since opened another chat.
   */
  function drainQueuedTurns() {
    if (thinking.value || queuedDrain || liveTurns.size > 0) return;
    const candidates = [
      ...(activeId.value ? [activeId.value] : []),
      ...[...queuedAfterTurn.keys()].filter(queuedId => queuedId !== activeId.value)
    ];
    for (const conversationId of candidates) {
      hydrateQueuedRows(conversationId);
      if (!queuedAfterTurn.get(conversationId)?.length) continue;
      // A queue can outlive its conversation in this list: it belongs to another profile (its
      // visible row is restored with that profile), or the row was deleted/archived. Skipping
      // it must not park every later queue behind an id that is not here. The entry stays in
      // the map so returning to its profile can resume it.
      if (!conversations.value.some(item => item.id === conversationId)) continue;
      drainQueuedAfterTurn(conversationId, true);
      // A started send claims the shared slot; never start a second turn behind it.
      if (queuedDrain || liveTurns.size > 0 || thinking.value) return;
    }
  }

  function steerFailureDetail(error: unknown) {
    return error instanceof IpcError ? (error.detail ?? error.message) : String(error);
  }

  function isStaleGenerationError(error: unknown) {
    return steerFailureDetail(error).includes('stale_generation');
  }

  function isUnsupportedRedirectError(error: unknown) {
    return /does not support active-turn redirect|method not found|unknown method|4010/i.test(
      steerFailureDetail(error)
    );
  }

  /**
   * `stale_generation` is the gateway's fence, not a broken turn. Retry once when a newer
   * stamp has already arrived; a second miss is the caller's signal to queue the text.
   */
  async function dispatchSteer(
    conversation: HermesConversation,
    live: string,
    generation: number,
    text: string
  ): Promise<{ ok: true; result: HermesSteerResult } | { ok: false; error: unknown }> {
    const request = (sessionId: string, stamp: number) =>
      unwrap(commands.hermesSteer(sessionId, stamp, text, gatewayUrl.value, gatewayProfileId.value));
    try {
      return { ok: true, result: await request(live, generation) };
    } catch (error) {
      const latest = conversation.executionGeneration;
      const latestLive = conversation.liveSessionId;
      if (!isStaleGenerationError(error) || latest === undefined || latest === generation || !latestLive) {
        return { ok: false, error };
      }
      try {
        return { ok: true, result: await request(latestLive, latest) };
      } catch (retryError) {
        return { ok: false, error: retryError };
      }
    }
  }

  async function dispatchRedirect(live: string, text: string) {
    try {
      return {
        ok: true as const,
        result: await unwrap(commands.hermesRedirect(live, text, gatewayUrl.value, gatewayProfileId.value))
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  }

  /**
   * Queue a correction until this turn has claimed its live session and generation. `mode` stays
   * `null` when the busy policy was unknown at send time, so the flush can use the policy that
   * arrives with the session instead of pinning the default.
   */
  function parkCorrection(
    conversation: HermesConversation,
    messageId: string,
    mode: 'interrupt' | 'steer' | null,
    text: string
  ) {
    pendingSteers.set(conversation.id, [...(pendingSteers.get(conversation.id) ?? []), { text, messageId, mode }]);
  }

  /**
   * Deliver one mid-turn correction. The official desktop's default is `session.redirect`
   * (stop-and-correct); `session.steer` is the configured alternative. Rejected, unknown,
   * client-invisible or failed corrections are never left in the transcript as if the model had
   * seen them: the bubble is removed and the text either becomes the next turn or is reported.
   */
  async function deliverCorrection(
    conversation: HermesConversation,
    messageId: string,
    requestedMode: 'interrupt' | 'steer' | null,
    text: string
  ) {
    // A correction typed before the session event arrives has no frozen policy. Re-read the
    // conversation now: the event that unblocked the flush also wrote `busyMode`.
    const policy = requestedMode ?? conversation.busyMode;
    // A parked correction can flush after an approval/clarify/secret card opened (session resume
    // replays `open_requests` before `message.start`). The turn is parked on the user, so neither
    // redirect nor steer can reach the model: queue it, exactly like a live `send` does.
    if (policy === 'queue' || asks.value.length > 0) {
      dropSteeringMessage(conversation.id, messageId);
      queueSteerAfterTurn(conversation.id, text);
      toasts.push({
        tone: 'info',
        title: 'Hermes',
        description:
          asks.value.length > 0
            ? '本轮正在等待你的确认，这条修正已排队到本轮结束后发送。'
            : '当前设置为排队发送，这条修正已排队到本轮结束后发送。'
      });
      return;
    }
    let effectiveMode = policy === 'steer' ? 'steer' : 'interrupt';
    if (effectiveMode === 'steer') {
      const correction = conversation.messages.find(entry => entry.id === messageId);
      if (correction) correction.steering = true;
    }
    const live = conversation.liveSessionId;
    const generation = conversation.executionGeneration;
    // `executionGeneration` is cleared when every turn starts and only this turn's session event
    // sets it again. Gate redirect on it too: the previous turn's `liveSessionId` stays on the
    // conversation after the turn succeeds, and must never receive this turn's correction.
    if (!live || generation === undefined) {
      parkCorrection(conversation, messageId, requestedMode, text);
      return;
    }
    let dispatched =
      effectiveMode === 'steer'
        ? await dispatchSteer(conversation, live, generation, text)
        : await dispatchRedirect(live, text);
    // Older runtimes only know steer. Keep the correction usable instead of losing it.
    if (!dispatched.ok && effectiveMode === 'interrupt' && isUnsupportedRedirectError(dispatched.error)) {
      effectiveMode = 'steer';
      const correction = conversation.messages.find(entry => entry.id === messageId);
      if (correction) correction.steering = true;
      dispatched = await dispatchSteer(conversation, live, generation, text);
    }
    if (!dispatched.ok) {
      notePanelAuthError(dispatched.error);
      dropSteeringMessage(conversation.id, messageId);
      queueSteerAfterTurn(conversation.id, text);
      toasts.push({
        tone: 'warning',
        title: effectiveMode === 'steer' ? 'Hermes steer' : 'Hermes redirect',
        description: steerFailureDetail(dispatched.error)
      });
      return;
    }
    if (dispatched.result.status === 'rejected') {
      dropSteeringMessage(conversation.id, messageId);
      queueSteerAfterTurn(conversation.id, text);
      toasts.push({
        tone: 'info',
        title: effectiveMode === 'steer' ? 'Hermes steer' : 'Hermes redirect',
        description: '这条修正未送达，已排队到本轮结束后发送。'
      });
      return;
    }
    if (effectiveMode === 'interrupt' && dispatched.result.status === 'queued') {
      // The gateway accepted the text into its own next-turn queue, but this one-turn IPC stream
      // will not receive that turn (it returns at the first message.complete). Do not leave a
      // bubble that looks delivered, and do not re-send it locally: the gateway already runs it.
      dropSteeringMessage(conversation.id, messageId);
      toasts.push({
        tone: 'info',
        title: 'Hermes redirect',
        description: 'Hermes 已把这条修正排到下一轮；当前窗口收不到那一轮的回答，请不要重复发送。'
      });
      return;
    }
    sealStreamingAssistant(conversation);
  }

  async function flushSteers(conversation: HermesConversation) {
    const queued = pendingSteers.get(conversation.id) ?? [];
    if (!queued.length) return;
    pendingSteers.delete(conversation.id);
    for (const steer of queued) {
      await deliverCorrection(conversation, steer.messageId, steer.mode, steer.text);
    }
    drainQueuedAfterTurn(conversation.id);
  }

  function maybeNotifyHermesReply(
    kind: 'turnDone' | 'turnError',
    conversationId: string,
    text: string | null | undefined
  ) {
    if (!notificationPrefs.isEnabled(kind)) return;
    // Completion kinds follow the official desktop rule: only the conversation on
    // screen may notify, so background sessions cannot produce a toast per reply.
    if (activeId.value !== conversationId) return;
    void notifyHermesReply(kind, conversationId, text);
  }

  /**
   * Attachments never join a queue: `send` rejects the whole message while the conversation on
   * screen is replying, another turn owns the runtime slot, or this conversation still has rows
   * waiting. The composer asks first, so a rejected send keeps the text and the selected files
   * instead of clearing both for a turn that never starts.
   */
  function attachmentsBlocked() {
    if (thinking.value) return true;
    // One runtime turn at a time, even when it belongs to another conversation.
    if (liveTurns.size > 0) return true;
    const conversation = active.value;
    if (!conversation) return false;
    hydrateQueuedRows(conversation.id);
    return (queuedAfterTurn.get(conversation.id)?.length ?? 0) > 0;
  }

  async function send(
    text: string,
    attachments: string[] = [],
    targetConversationId?: string,
    queuedMessageId?: string
  ) {
    const findTarget = () =>
      targetConversationId ? (conversations.value.find(item => item.id === targetConversationId) ?? null) : null;
    // A targeted send comes from the queue drain and may belong to a background conversation;
    // it may still start once the shared turn slot is free, as long as its target exists.
    const targetSendable = () => targetConversationId === undefined || Boolean(findTarget());
    // A correction belongs to the turn on screen: `thinking` describes that conversation only.
    const targetActive = () =>
      targetConversationId === undefined || (active.value?.id === targetConversationId && Boolean(findTarget()));
    let pendingUserId: string | undefined;
    let pendingAssistantId: string | undefined;
    /** The queued row this send is consuming, so an abort can put the text back behind it. */
    let activeQueuedMessageId = queuedMessageId;
    /** The pending user row was already on screen as queued; keep it and re-mark it on abort. */
    let pendingUserQueued = false;
    /** This send handed its row back to the queue before submitting; the finally must not drain it. */
    let returnedToQueue = false;
    /**
     * The panel turn resumed a stored session instead of creating one. A provider rejection on a
     * resume is the profile's real credential, not the first-turn race, so it is never retried.
     */
    let attemptedResume = false;
    const restoreTargetQueue = (front = true) => {
      if (targetConversationId) {
        return queueSteerAfterTurn(targetConversationId, text, front, activeQueuedMessageId, attachments);
      }
      return undefined;
    };
    const restoreUnsentTurn = (conversation: HermesConversation, requeueDirect = false, front = true) => {
      // A direct send that lost its claim was never submitted. Keep its visible row and park it
      // in the conversation's queue, so switching back resumes it instead of deleting the only
      // copy of the message. A stop parks it behind the rows already waiting; a profile switch
      // keeps it in front of them.
      const directRow = requeueDirect && targetConversationId === undefined && Boolean(pendingUserId);
      if (directRow) pendingUserQueued = true;
      // A profile switch can replace the live array with a restored copy; clean both the object
      // this send started with and the one currently in the store, so neither keeps a phantom turn.
      const targets = new Set([
        conversation,
        conversations.value.find(item => item.id === conversation.id),
        // A re-home may already have moved the conversation into its own profile state.
        profileStates.value[turnContext.ownerKey]?.conversations.find(item => item.id === conversation.id)
      ]);
      for (const target of targets) {
        if (!target) continue;
        const queuedRow =
          pendingUserQueued && pendingUserId
            ? target.messages.find(entry => entry.id === pendingUserId && entry.role === 'user')
            : undefined;
        if (queuedRow) queuedRow.queued = true;
        target.messages = target.messages.filter(
          entry => entry.id !== pendingAssistantId && (entry.id !== pendingUserId || Boolean(queuedRow) || directRow)
        );
        target.updatedAt = Date.now();
      }
      streamingAssistantIds.delete(conversation.id);
      if (directRow) {
        const parked = queueSteerAfterTurn(conversation.id, value, front, pendingUserId, attachments);
        persist();
        return parked;
      }
      return restoreTargetQueue(front);
    };
    const value = text.trim();
    if (!value && !attachments.length) return;
    // Decide steer versus a new turn before any await. History and credential checks used to
    // leave `thinking` false, so two drains could both start `hermesChat`.
    if (thinking.value) {
      if (!targetActive()) {
        restoreTargetQueue();
        return;
      }
      if (attachments.length) {
        toasts.push({ tone: 'warning', title: 'Hermes', description: '请等待当前回复结束再发送附件。' });
        return;
      }
      const conversation = findTarget() ?? ensureConversation();
      // Official default: `interrupt` means session.redirect (stop-and-correct). `steer` injects
      // at the next tool boundary, `queue` admits the text as the next turn. A parked card owns
      // the turn, so nothing can reach the model until it is answered. `policy` stays undefined
      // until this turn's session event; the correction keeps it unknown so the flush can use the
      // real policy instead of pinning the default.
      const policy = conversation.busyMode;
      if (policy === 'queue' || asks.value.length > 0) {
        queueSteerAfterTurn(conversation.id, value);
        toasts.push({
          tone: 'info',
          title: 'Hermes',
          description:
            asks.value.length > 0
              ? '本轮正在等待你的确认，这条消息已排队到本轮结束后发送。'
              : '当前设置为排队发送，这条消息已排队到本轮结束后发送。'
        });
        return;
      }
      // Append at the tail, never above the stream that already reached the user: the official
      // transcript order is pre-correction output → correction → post-correction output.
      const correction = message({
        role: 'user',
        text: value,
        steering: policy === 'steer' ? true : undefined
      });
      conversation.messages = [...conversation.messages, correction];
      conversation.updatedAt = Date.now();
      await deliverCorrection(conversation, correction.id, policy ?? null, value);
      drainQueuedAfterTurn(conversation.id);
      return;
    }
    if (!targetSendable()) {
      restoreTargetQueue();
      return;
    }
    const prompt = value || '请查看附件。';
    // A fresh send belongs behind rows already waiting in its conversation. A drain send carries
    // a target conversation and is already the row being started, so it never re-queues here.
    const queuedTarget = targetConversationId === undefined ? active.value : null;
    if (queuedTarget) hydrateQueuedRows(queuedTarget.id);
    const queuedAhead = queuedTarget ? (queuedAfterTurn.get(queuedTarget.id)?.length ?? 0) : 0;
    // The runtime's turn bookkeeping (one local gateway/ask channel, server-side concurrency
    // limits) is not safe for two live turns at once. Keep the background turn alive and queue
    // this row for when it settles instead of silently interrupting either one.
    if (liveTurns.size > 0 || queuedAhead > 0) {
      if (attachments.length) {
        toasts.push({ tone: 'warning', title: 'Hermes', description: '请等待当前回复结束再发送附件。' });
        return;
      }
      const conversation = findTarget() ?? ensureConversation();
      // A drain that raced another turn still has its visible row; queue behind it. A fresh send
      // gets a visible queued row now: an empty placeholder conversation is filtered out of
      // history, and its text would be lost as soon as the user opened another chat.
      const existingRow =
        queuedMessageId !== undefined
          ? conversation.messages.find(entry => entry.id === queuedMessageId && entry.role === 'user')
          : undefined;
      let queueMessageId = queuedMessageId;
      if (!existingRow) {
        const waiting = message({ role: 'user', text: value, queued: true });
        conversation.messages = [...conversation.messages, waiting];
        conversation.updatedAt = Date.now();
        queueMessageId = waiting.id;
      }
      queueSteerAfterTurn(conversation.id, value, false, queueMessageId);
      persist();
      // The slot is free but the conversation already had a queue: its head owns the slot now,
      // in order. (With a live turn, that turn's completion drains the queue instead.)
      const queueOwnsSlot = liveTurns.size === 0;
      if (queueOwnsSlot) drainQueuedAfterTurn(conversation.id);
      const waitingForAnswer = [...liveTurns.values()].some(turn =>
        asks.value.some(ask => ask.turnRequestId === turn.requestId)
      );
      toasts.push({
        tone: 'info',
        title: 'Hermes',
        description: queueOwnsSlot
          ? '前面的消息还在队列中，这条消息已排在它们之后发送。'
          : waitingForAnswer
            ? '另一个会话正在等待你的确认，这条消息已排队，等它结束后发送。'
            : '另一个会话正在回复，这条消息已排队，等它结束后发送。'
      });
      return;
    }
    let conversation = findTarget() ?? ensureConversation();
    // The drain that called us published this epoch synchronously, before the first await.
    const drainEpoch = queuedDrain?.id === conversation.id ? queuedDrain.epoch : undefined;
    // A new turn has not read the runtime's busy policy yet. Leaving the previous turn's value
    // here would let a correction typed before this turn's `hermes-session` pin the old policy
    // (for example, redirect a turn the runtime now says should queue).
    conversation.executionGeneration = undefined;
    conversation.busyMode = undefined;
    // Reuse the row that was shown while waiting instead of appending the same text twice.
    const queuedRow =
      queuedMessageId !== undefined
        ? conversation.messages.find(entry => entry.id === queuedMessageId && entry.role === 'user')
        : undefined;
    let userMessage: HermesMessage;
    if (queuedRow) {
      userMessage = queuedRow;
      pendingUserQueued = true;
    } else {
      // A drain whose visible row was lost (history reload) recreates one and keeps it as the
      // queue handle, so an abort still leaves something to send and something to see.
      const wasQueued = queuedMessageId !== undefined;
      userMessage = message({
        role: 'user',
        text: value,
        queued: wasQueued || undefined,
        attachments: attachments.length ? [...attachments] : undefined
      });
      pendingUserQueued = wasQueued;
      conversation.messages = [...conversation.messages, userMessage];
    }
    pendingUserId = userMessage.id;
    activeQueuedMessageId = queuedMessageId !== undefined ? userMessage.id : activeQueuedMessageId;
    conversation.updatedAt = Date.now();
    const turn = ++turnSeq;
    const requestId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `hermes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Own the turn from the moment the user row exists. Stream events, Stop and the final reply
    // all resolve through this context, so switching profile/conversation only changes the view.
    const turnContext: LiveHermesTurn = {
      turn,
      requestId,
      conversationId: conversation.id,
      ownerKey: stateKey(),
      gatewayUrl: gatewayUrl.value,
      gatewayProfileId: gatewayProfileId.value,
      provider: model.value.provider,
      stopping: false,
      stopRequested: false
    };
    registerLiveTurn(turnContext);
    // The turn owns the shared slot now; the row is no longer waiting. `syncTurnUi` (inside
    // `registerLiveTurn`) only shows Stop for the conversation on screen; a turn that started
    // from a background queue keeps running without claiming the visible composer.
    userMessage.queued = false;
    const abandonClaim = (returnToQueue = false) => {
      pendingTurnInterrupts.delete(requestId);
      if (returnToQueue) returnedToQueue = true;
      // A stop parks the row behind the messages that were already waiting, so they keep their
      // order and the freed slot. A profile switch resumes it in front of them instead.
      const stopped = turnContext.stopping || turnContext.stopRequested;
      const parked = restoreUnsentTurn(conversation, returnToQueue, !(returnToQueue && stopped));
      // Corrections composed while this turn was pre-flight never reached a session; hand them
      // to the queue so a later turn sends them instead of leaving them parked for a stranger.
      deferPendingSteers(conversation.id);
      retireLiveTurn(turn);
      if (returnToQueue && stopped) {
        // This send still holds the drain epoch it took. Release it before asking the queue to
        // run, then start the first row behind the parked prompt. Draining the parked row here
        // would resubmit the prompt the user just cancelled.
        if (queuedDrain?.id === conversation.id && queuedDrain.epoch === drainEpoch) queuedDrain = null;
        drainQueuedAfterTurn(conversation.id, true, parked);
      }
    };
    // A pre-flight send still belongs to the profile that composed it. Once `hermesChat` starts,
    // the turn keeps running; before that, a profile switch restores the row to the queue, and a
    // Stop must never submit the prompt the user already cancelled.
    const claimStillOurs = () => liveTurns.has(turn) && turnContext.ownerKey === stateKey() && !turnContext.stopping;
    // Nothing was submitted. A profile switch leaves the turn alive under its old owner; Stop
    // leaves `stopping` set even after its 10 s fallback retires the turn. Both mean the row
    // belongs back in its conversation's queue. Delete/archive retires the turn with neither
    // signal, and there is no conversation left to queue in.
    const claimLostBeforeSubmit = () =>
      turnContext.stopping || turnContext.stopRequested || (liveTurns.has(turn) && turnContext.ownerKey !== stateKey());
    // `loadHistory` may swap `conversations` for new objects while this await is in flight.
    // The user row was appended to the object captured above; carry it onto the live one
    // or the assistant reply and session metadata land on a conversation the store dropped.
    const syncConversation = () => {
      // `loadHistory` replaces the active list with objects parsed from the file. A turn that
      // kept streaming after a profile switch still holds the previous object, so its final
      // reply would land on a conversation the store no longer shows.
      const ownedHere = turnContext.ownerKey === stateKey();
      const live = ownedHere
        ? conversations.value.find(item => item.id === conversation.id)
        : profileStates.value[turnContext.ownerKey]?.conversations.find(item => item.id === conversation.id);
      if (!live) {
        if (ownedHere) conversations.value = [conversation, ...conversations.value];
        return;
      }
      if (live === conversation) return;
      const carried = conversation.messages.filter(entry => !live.messages.some(item => item.id === entry.id));
      if (carried.length) {
        live.messages = [...live.messages, ...carried];
        live.updatedAt = Date.now();
      }
      if (live.busyMode === undefined) live.busyMode = conversation.busyMode;
      conversation = live;
    };
    if (historyLoadStarted && !historyLoaded) {
      await historyReadyPromise;
      if (!claimStillOurs()) {
        abandonClaim(claimLostBeforeSubmit());
        return;
      }
      syncConversation();
    }
    if (!remoteActive.value) {
      // Verify against the runtime instead of trusting the cached flag: a stale `true`
      // used to let the turn through and fail later with a provider error.
      const info = HERMES_PROVIDER_MAP[model.value.provider];
      if (requiresStoredKey(model.value, info) && !(await refreshCredentialState())) {
        // A switch or Stop during the check means the verdict belongs to the attempt we just
        // left: the row is already back in its queue, so its warning must not pop on the new one.
        const requeue = claimLostBeforeSubmit();
        abandonClaim(requeue);
        if (!requeue) {
          toasts.push({
            tone: 'warning',
            title: 'Hermes profile',
            description: 'Configure this profile’s model and credentials before chatting.'
          });
        }
        return;
      }
    }
    // The profile can change, or Stop can arrive, while an await above is in flight. Before the
    // turn is submitted, that means the row belongs back in the queue; after submission neither
    // check is used.
    if (!claimStillOurs()) {
      abandonClaim(claimLostBeforeSubmit());
      return;
    }

    const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!runtime.value && tauri) await loadRuntime();
    if (!claimStillOurs()) {
      abandonClaim(claimLostBeforeSubmit());
      return;
    }
    if (!runtime.value?.ready && tauri && !remoteActive.value) {
      // The drain already popped this row. Put it back and drop the unsent bubble, or a
      // later select has nothing to send and the transcript keeps a message that never went out.
      abandonClaim();
      toasts.push({
        tone: 'warning',
        title: 'Local Hermes',
        description: 'Install local Hermes before chatting.'
      });
      return;
    }
    if (runtime.value?.ready || remoteActive.value) {
      syncConversation();
      const assistant = message({ role: 'assistant', text: '', streaming: true });
      pendingAssistantId = assistant.id;
      conversation.messages = [...conversation.messages, assistant];
      conversation.updatedAt = Date.now();
      streamingAssistantIds.set(conversation.id, assistant.id);
      // The first assistant bubble of this turn; tools may outlive it after a correction seals it.
      const turnStartIndex = conversation.messages.length - 1;
      const turnAssistant = (target: HermesConversation) =>
        streamingAssistant(target) ?? lastAssistantFrom(target, turnStartIndex) ?? assistant;
      let unlisten: (() => void) | undefined;
      let turnSessionId: string | undefined;
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          const unlistenChunk = await listen<HermesChunk>('hermes-chunk', event => {
            if (event.payload.requestId !== requestId || !liveTurns.has(turn)) return;
            const target = turnConversation(turn);
            if (!target) return;
            // A correction seals the bubble above it; the first delta afterwards opens a fresh
            // bubble below the correction (official arrival order).
            const entry = ensureStreamingAssistant(target);
            entry.text = `${entry.text ?? ''}${event.payload.delta}`;
            target.updatedAt = Date.now();
          });
          const unlistenSession = await listen<HermesSessionEvent>('hermes-session', event => {
            if (event.payload.requestId !== requestId) return;
            // The turn may have been force-retired (Stop's 10 s fallback, delete, archive or a
            // removed profile) before the gateway announced its session. This listener is the
            // only place that still knows the request id, so it sends the interrupt now.
            const parked = pendingTurnInterrupts.get(requestId);
            if (parked) {
              pendingTurnInterrupts.delete(requestId);
              void commands
                .hermesInterrupt(event.payload.liveSessionId, parked.gatewayUrl, parked.profileId)
                .catch(() => undefined);
              return;
            }
            if (!liveTurns.has(turn)) return;
            const target = turnConversation(turn);
            if (!target) return;
            turnContext.liveSessionId = event.payload.liveSessionId;
            target.liveSessionId = event.payload.liveSessionId;
            // Stop was pressed before this turn claimed its session, so the retries had no id
            // to target. Interrupt now instead of waiting out the 10 s fallback.
            if (turnContext.stopping) void requestTurnStop(turnContext, false).catch(() => undefined);
            if (event.payload.busyInputMode) {
              target.busyMode = event.payload.busyInputMode;
            }
            if (event.payload.sessionId) {
              turnSessionId = event.payload.sessionId;
              turnSessionIds.value = {
                ...turnSessionIds.value,
                [conversation.id]: event.payload.sessionId
              };
              // A session that was not resumed is already the only usable id: either there was
              // no stored one, or resume failed and this turn created its replacement.
              if (event.payload.resumed === false) target.sessionId = event.payload.sessionId;
            }
            if (event.payload.executionGeneration != null) {
              target.executionGeneration = event.payload.executionGeneration;
            }
            void flushSteers(target);
          });
          // The turn is parked on a human answer: approval, clarify questions or a masked prompt.
          const unlistenAsk = await listen<HermesAsk>('hermes-ask', event => {
            if (event.payload.turnRequestId !== requestId || !liveTurns.has(turn)) return;
            asks.value = [
              ...asks.value.filter(ask => ask.requestId !== event.payload.requestId),
              { ...event.payload, conversationId: conversation.id }
            ];
          });
          // The runtime settled the request (answered here, withdrawn, or its own deadline passed):
          // drop the card and keep the decision visible in the transcript.
          const unlistenSettled = await listen<HermesDecision>('hermes-ask-settled', event => {
            if (event.payload.turnRequestId !== requestId) return;
            asks.value = asks.value.filter(ask => ask.requestId !== event.payload.requestId);
            const target = turnConversation(turn);
            if (target) recordDecision(event.payload, conversation.id, turnAssistant(target).id);
          });
          const unlistenTool = await listen<HermesToolEvent>('hermes-tool', event => {
            if (event.payload.requestId !== requestId || !liveTurns.has(turn)) return;
            const target = turnConversation(turn);
            if (!target) return;
            // A tool started before a correction may finish after its bubble was sealed; keep
            // the completion on that same bubble instead of duplicating it below the correction.
            const found = findToolCall(target, turnStartIndex, event.payload.toolId, event.payload.name);
            if (event.payload.phase === 'start') {
              if (!found) {
                const entry = ensureStreamingAssistant(target);
                entry.tools = [
                  ...(entry.tools ?? []),
                  {
                    name: event.payload.name,
                    label: event.payload.label || event.payload.name,
                    time: '…',
                    toolId: event.payload.toolId
                  }
                ];
              }
            } else if (found) {
              found.call.label = event.payload.label || found.call.label;
              found.call.time = `${event.payload.duration?.toFixed(1) ?? '0.0'}s`;
            } else {
              const entry = ensureStreamingAssistant(target);
              entry.tools = [
                ...(entry.tools ?? []),
                {
                  name: event.payload.name,
                  label: event.payload.label || event.payload.name,
                  time: `${event.payload.duration?.toFixed(1) ?? '0.0'}s`,
                  toolId: event.payload.toolId
                }
              ];
            }
            target.updatedAt = Date.now();
          });
          const unlistenReasoning = await listen<{ requestId: string; delta: string }>('hermes-reasoning', event => {
            if (event.payload.requestId !== requestId || !liveTurns.has(turn)) return;
            const target = turnConversation(turn);
            if (!target) return;
            const entry = ensureStreamingAssistant(target);
            entry.reasoning = `${entry.reasoning ?? ''}${event.payload.delta}`;
          });
          unlisten = () => {
            unlistenChunk();
            unlistenSession();
            unlistenAsk();
            unlistenSettled();
            unlistenTool();
            unlistenReasoning();
          };
        } catch {
          // Streaming is an enhancement; the final IPC reply still renders.
        }
      }
      try {
        if (!claimStillOurs()) {
          abandonClaim(claimLostBeforeSubmit());
          return;
        }
        syncConversation();
        const chatTarget = remoteActive.value ? remoteChatTarget() : null;
        attemptedResume = Boolean(conversation.sessionId);
        const chatInput = {
          prompt,
          requestId,
          sessionId: conversation.sessionId ?? null,
          provider: chatTarget?.provider ?? model.value.provider,
          model: chatTarget?.model ?? modelId(model.value.model),
          effort: model.value.effort,
          fast: model.value.fast,
          apiKey: apiKey.value.trim() || null,
          endpoint: model.value.endpoint.trim() || null,
          cwd: workingDir.value.trim() || null,
          attachments: [...attachments],
          auxiliary: HERMES_AUX_TASKS.map(task => ({ task, ...auxiliary.value[task] })),
          forceAuxVision: forceAuxVision.value,
          gatewayUrl: gatewayUrl.value,
          profileId: gatewayProfileId.value,
          profile: activeAgentProfileName.value,
          panelAuth: panelActive.value,
          macEnabled: !remoteActive.value && mac.value.enabled,
          controlLevel: remoteActive.value ? 'open' : mac.value.level,
          macTerminal: !remoteActive.value && mac.value.terminal,
          macScreen: !remoteActive.value && mac.value.screen,
          macFiles: !remoteActive.value && mac.value.files,
          macCron: !remoteActive.value && mac.value.cron,
          // A remote host's tools still need a user decision; only this Mac's capability
          // switches are forced off. Without this the backend denied every remote approval.
          confirmWrites: remoteActive.value ? true : mac.value.confirmWrites
        };
        const requestTurn = () => unwrap(commands.hermesChat(chatInput));
        /**
         * A first turn has no visible output to protect: no streamed text, reasoning, tool card
         * or answered decision. Anything else is a real mid-turn failure and must not be replayed.
         */
        const cleanFirstTurn = () => {
          const failed = streamingAssistant(conversation) ?? lastAssistantFrom(conversation, turnStartIndex);
          return (
            !failed?.text?.trim() &&
            !failed?.reasoning?.trim() &&
            !(failed?.tools?.length) &&
            !(failed?.decisions?.length)
          );
        };
        const firstTurnAuthRetryable = (error: unknown) =>
          !attemptedResume &&
          targetConversationId === undefined &&
          !pendingUserQueued &&
          // Attachments were already staged on the first live session; re-sending them on a
          // resume could deliver the same files twice, so only text turns are retried.
          attachments.length === 0 &&
          Boolean(turnContext.gatewayUrl) &&
          Boolean(conversation.sessionId) &&
          Boolean(pendingUserId) &&
          isProviderAuthFailure(error) &&
          cleanFirstTurn();
        let reply: Awaited<ReturnType<typeof requestTurn>>;
        try {
          reply = await requestTurn();
        } catch (error) {
          if (!firstTurnAuthRetryable(error)) throw error;
          // A panel host resolves a freshly-created session's model override before the profile
          // credential is available, so its first prompt can 401 while the session itself now
          // exists. Stay inside this turn (do not let the finally retire it and drain the queue),
          // let the failed attempt settle, then resubmit on the stored session — the same resume a
          // manual retry goes through.
          await new Promise(resolve => window.setTimeout(resolve, PROVIDER_AUTH_RETRY_DELAY_MS));
          if (
            !liveTurns.has(turn) ||
            turnContext.stopping ||
            turnContext.stopRequested ||
            turnContext.ownerKey !== stateKey()
          ) {
            throw error;
          }
          syncConversation();
          chatInput.sessionId = conversation.sessionId ?? null;
          if (!chatInput.sessionId) throw error;
          reply = await requestTurn();
        }
        if (!liveTurns.has(turn)) return;
        // The turn may have finished while its profile is on screen again, after `loadHistory`
        // swapped in a newer object. Reattach before writing the final text, and write that
        // object: `turnConversation` can still see the detached copy in a background snapshot.
        syncConversation();
        const target = conversation;
        const entry = target
          ? (streamingAssistant(target) ??
            lastAssistantFrom(target, turnStartIndex) ??
            ensureStreamingAssistant(target))
          : undefined;
        // A completion that races the Stop button must still read as stopped: the user asked
        // for the turn to end, even if the model happened to finish before the interrupt landed.
        const stoppedByUser = turnContext.stopping || turnContext.stopRequested;
        const interrupted = reply.interrupted === true || isInterruptSentinel(reply.text) || stoppedByUser;
        if (target && entry) {
          const visible = (isInterruptSentinel(reply.text) ? '' : reply.text).trim();
          if (interrupted) {
            // Official desktop: a stopped complete may only extend what is
            // already on screen. A shorter or different text, including the
            // blanked "waiting for model response" sentinel, never replaces it.
            entry.interrupted = true;
            const shown = (entry.text ?? '').trim();
            // A stopped completion may only extend text that already reached the screen. With
            // nothing streamed there is nothing to extend, so keep the stop marker instead of
            // pasting the full answer the user cancelled.
            entry.text =
              shown && visible.startsWith(shown) && visible.length > shown.length ? visible : shown || '已停止。';
          } else {
            entry.text = visible || entry.text || 'Hermes returned an empty response.';
          }
          entry.streaming = false;
          streamingAssistantIds.delete(conversation.id);
          if (reply.sessionId) target.sessionId = reply.sessionId;
          if (reply.liveSessionId) target.liveSessionId = reply.liveSessionId;
          if (reply.usage?.context_used && reply.usage.context_max) {
            const used = reply.usage.context_used;
            const max = reply.usage.context_max;
            target.context = {
              used,
              max,
              percent: reply.usage.context_percent ?? Math.round((used / max) * 100)
            };
          }
          target.updatedAt = Date.now();
        }
        if (!interrupted) {
          maybeNotifyHermesReply('turnDone', conversation.id, reply.text);
        }
      } catch (error) {
        if (!liveTurns.has(turn)) return;
        syncConversation();
        if (turnContext.stopping || turnContext.stopRequested) {
          const target = conversation;
          const entry = streamingAssistant(target) ?? lastAssistantFrom(target, turnStartIndex);
          if (entry) {
            entry.interrupted = true;
            entry.text = entry.text || '已停止。';
            entry.streaming = false;
            streamingAssistantIds.delete(conversation.id);
            target.updatedAt = Date.now();
          }
          return;
        }
        notePanelAuthError(error);
        const detail = error instanceof IpcError ? (error.detail ?? error.message) : String(error);
        const expiredOpenCode =
          (turnContext.provider === 'opencode-go' || turnContext.provider === 'opencode') &&
          /api key has expired|401/i.test(detail);
        const messageText = expiredOpenCode
          ? `${detail}

OpenCode Go 的 API Key 已过期。请在 [OpenCode Console](https://opencode.ai/console) 创建新的 API Key，然后在 Hermes 设置 → OpenCode Go 中填写。`
          : detail;
        syncConversation();
        const target = conversation;
        const entry =
          streamingAssistant(target) ?? lastAssistantFrom(target, turnStartIndex) ?? ensureStreamingAssistant(target);
        if (entry) {
          entry.text = entry.text || messageText;
          entry.streaming = false;
          streamingAssistantIds.delete(conversation.id);
          target.updatedAt = Date.now();
        }
        toasts.push({
          tone: 'danger',
          title: expiredOpenCode ? 'OpenCode API Key' : turnContext.gatewayUrl ? 'Hermes Panel' : 'Local Hermes',
          description: expiredOpenCode ? 'OpenCode Go Key 已过期，请创建新的 API Key。' : detail
        });
        maybeNotifyHermesReply('turnError', conversation.id, detail);
      } finally {
        // The session listener is about to unregister; no late id can be interrupted after this.
        pendingTurnInterrupts.delete(requestId);
        unlisten?.();
        if (turnSessionId && turnSessionIds.value[conversation.id] === turnSessionId) {
          const remainingTurnSessions = { ...turnSessionIds.value };
          delete remainingTurnSessions[conversation.id];
          turnSessionIds.value = remainingTurnSessions;
        }
        const ctx = liveTurns.get(turn);
        if (ctx) {
          // Another turn's Stop must not be finalized by this turn's completion.
          if (stopTimerTurn === turn) clearStopTimers();
          syncConversation();
          sealStreamingAssistant(conversation);
          conversation.executionGeneration = undefined;
          // Steering state is keyed by conversation and may now live in a background profile.
          deferPendingSteers(ctx.conversationId);
          retireLiveTurn(turn);
          // Let the next queued row start. This send's own finally still holds the previous epoch.
          releaseQueuedDrain(ctx.conversationId);
          // Prefer the conversation on screen, then any other queue this turn was blocking.
          drainQueuedTurns();
        } else if (active.value?.id === conversation.id && !thinking.value) {
          // `stopThinking` retired this turn, so the branch above did not run. Continue the
          // queue once this chat settles, and only clear the guard epoch this send took.
          if (queuedDrain?.id === conversation.id && queuedDrain.epoch === drainEpoch) queuedDrain = null;
          // A pre-submit Stop parked this row in its queue; `abandonClaim` already resumed the
          // rows behind it. Draining again here would resubmit the prompt just cancelled.
          if (!returnedToQueue && !queuedDrain) drainQueuedAfterTurn(conversation.id);
        }
      }
      return;
    }

    const reply = assistantFor(scenarioFor(value));
    replyTimer = setTimeout(() => {
      const target = conversationForOwner(turnContext.conversationId, turnContext.ownerKey);
      if (target) {
        target.messages = [...target.messages, reply];
        target.updatedAt = Date.now();
      }
      if (stopTimerTurn === turn) clearStopTimers();
      retireLiveTurn(turn);
      replyTimer = undefined;
    }, 520);
  }

  function clearStopTimers() {
    if (stopKillTimer) clearTimeout(stopKillTimer);
    if (stopFinalizeTimer) clearTimeout(stopFinalizeTimer);
    stopKillTimer = undefined;
    stopFinalizeTimer = undefined;
    stopTimerTurn = null;
  }

  function stopThinking() {
    if (replyTimer) clearTimeout(replyTimer);
    replyTimer = undefined;
    const turn = activeLiveTurn();
    if (turn) {
      const conversationId = turn.conversationId;
      // Marks the bubbles, interrupts the turn's own backend and retires it.
      forceStopTurn(turn.turn);
      // Same handoff as a finished turn. Deleting the wait list left the steering bubble
      // on screen and gave select nothing to send.
      deferPendingSteers(conversationId);
    } else if (active.value) {
      // No tracked turn, but a superseded request may have left an open bubble and a live
      // session id behind. Stop that session on the connection that is visible now.
      const conversation = active.value;
      const live = conversation.liveSessionId;
      // A correction may have left its own user row at the tail; seal every streaming assistant
      // in the conversation, then stamp the last one so the stop is visible.
      markConversationStopped(conversation);
      if (live) {
        if (remoteActive.value) {
          void commands.hermesInterrupt(live, gatewayUrl.value, gatewayProfileId.value).catch(() => undefined);
        } else {
          // Same rule as a tracked turn's Stop: interrupt the session, keep the gateway warm.
          void commands.hermesInterrupt(live, null, null).catch(() => undefined);
        }
      }
    }
    // The superseded send skips its drain, and a hung chat never settles to clear this.
    // Drop it now so a later select can start the rows still queued.
    queuedDrain = null;
    syncTurnUi();
  }

  /**
   * Record what the runtime did with a card at the end of the turn's assistant message, so a granted
   * command is visible after the fact (the runtime redacts what it sends; a secret never travels).
   */
  function recordDecision(decision: HermesDecision, conversationId: string, assistantId: string) {
    const target = findConversationById(conversationId);
    if (!target) return;
    const entry = target.messages.find(item => item.id === assistantId);
    if (!entry) return;
    entry.decisions = [...(entry.decisions ?? []), { ...decision, at: Date.now() }];
    target.updatedAt = Date.now();
  }

  async function answerAsk(
    requestId: string,
    reply:
      | { kind: 'approval'; choice: HermesApprovalChoice }
      | { kind: 'clarify'; answers: HermesClarifyAnswer[]; cancelled: boolean }
      | { kind: 'secret'; value: string }
  ) {
    // Drop the card before the IPC round-trip: the settled event only records the outcome, so a hung
    // send would otherwise leave a card that can be answered twice.
    asks.value = asks.value.filter(ask => ask.requestId !== requestId);
    try {
      await unwrap(commands.hermesAskRespond(requestId, reply));
    } catch (error) {
      toasts.push({
        tone: 'warning',
        title: 'Hermes',
        description: error instanceof IpcError ? (error.detail ?? error.message) : String(error)
      });
    }
  }

  function respondApproval(choice: HermesApprovalChoice) {
    const ask = approvalRequest.value;
    if (!ask) return Promise.resolve();
    return answerAsk(ask.requestId, { kind: 'approval', choice });
  }

  function respondClarify(answers: HermesClarifyAnswer[], cancelled = false) {
    const ask = clarifyRequest.value;
    if (!ask) return Promise.resolve();
    return answerAsk(ask.requestId, { kind: 'clarify', answers, cancelled });
  }

  function respondSecret(value: string) {
    const ask = secretRequest.value;
    if (!ask) return Promise.resolve();
    return answerAsk(ask.requestId, { kind: 'secret', value });
  }

  function armStopFallbacks(turnId: number, conversationId: string | undefined) {
    // Arm the fallbacks before awaiting IPC: a hung interrupt must not disable them.
    clearStopTimers();
    stopTimerTurn = turnId;
    stopKillTimer = window.setTimeout(() => {
      const turn = liveTurns.get(turnId);
      if (!turn || !turn.stopping) return;
      // Retry against the turn's own backend; the visible profile may have changed. If the
      // session is still unknown, the `hermes-session` handler interrupts as soon as it arrives.
      void requestTurnStop(turn, false).catch(() => undefined);
    }, 1200);
    stopFinalizeTimer = window.setTimeout(() => {
      // A turn retired before this fires was retired by a path that already resumed its queue:
      // the pre-flight abort parks its row and drains behind it, delete/archive drops the queue.
      if (!liveTurns.has(turnId)) return;
      forceStopTurn(turnId);
      if (conversationId) deferPendingSteers(conversationId);
    }, 10_000);
  }

  async function stop() {
    // Stop belongs to the conversation on screen; background turns keep running untouched.
    const turn = activeLiveTurn();
    if (!turn) return;
    if (turn.stopping) {
      // A steer failure can mark the turn as stopping before this button is pressed.
      armStopFallbacks(turn.turn, turn.conversationId);
      return;
    }
    turn.stopRequested = true;
    turn.stopping = true;
    clearAsksForTurn(turn.requestId);
    stopRequested.value = true;
    stopping.value = true;
    armStopFallbacks(turn.turn, turn.conversationId);
    // Nothing is sent when this turn has not claimed a session yet: the retry, the session
    // event and the 10 s fallback finish the stop without ever touching the previous turn's id.
    await requestTurnStop(turn, false).catch(() => undefined);
  }

  function credentialsUsable(settings: HermesModelSettings) {
    return !requiresStoredKey(settings, HERMES_PROVIDER_MAP[settings.provider]) || settings.keySet;
  }

  function saveModel(next: HermesModelSettings) {
    const previous = model.value;
    const changed =
      previous.provider !== next.provider ||
      previous.model !== next.model ||
      previous.effort !== next.effort ||
      previous.fast !== next.fast ||
      previous.endpoint !== next.endpoint;
    const becameUsable = !credentialsUsable(previous) && credentialsUsable(next);
    model.value = { ...next };
    if (changed) resetSession();
    // A queued row parked on a missing key stays on this conversation. Saving a usable
    // model is the signal to send it; select and profile switches are not required.
    if (becameUsable) drainActiveQueue();
  }

  function saveMac(next: HermesMacSettings) {
    mac.value = { ...next };
  }

  function useProvider(provider: HermesProvider) {
    const info = HERMES_PROVIDER_MAP[provider];
    resetSession();
    model.value = {
      ...model.value,
      provider,
      model: info.models[0] ?? model.value.model,
      endpoint: defaultProviderEndpoint(provider),
      keySet: false
    };
  }

  /** Providers that authenticate through an account login or a local CLI store. */
  function usesAccountLogin(info: HermesProviderInfo): boolean {
    return info.oauth || Boolean(info.login) || Boolean(info.localAuth);
  }

  /** True when the provider cannot work without a stored API key. */
  function requiresStoredKey(settings: HermesModelSettings, info: HermesProviderInfo): boolean {
    if (usesAccountLogin(info)) return false;
    // Local and custom endpoints may be keyless; the runtime only asks for a key when one exists.
    if (info.id === 'local') return false;
    if (info.id === 'custom') return !settings.endpoint.trim();
    return true;
  }

  /**
   * Re-read whether the runtime holds an API key for `provider`.
   *
   * `keySet` is persisted UI state, but the key lives in the runtime's own `.env` and can
   * disappear outside this app (CLI, uninstall, a failed write), so it is never trusted
   * on its own.
   */
  async function refreshCredentialState(provider: HermesProvider = model.value.provider) {
    const info = HERMES_PROVIDER_MAP[provider];
    if (usesAccountLogin(info)) {
      if (model.value.provider === provider && model.value.keySet) {
        model.value = { ...model.value, keySet: false };
      }
      return false;
    }
    try {
      // A key belongs to the agent profile whose `.env` holds it, not the shared root.
      const owner = stateKey();
      const profileArg = activeAgentProfileName.value === 'default' ? null : activeAgentProfileName.value;
      const keySet = await unwrap(commands.hermesSecretStatus(provider, profileArg));
      // The profile can change while the runtime answers. The result then describes the profile
      // that asked: writing it onto the new profile's model would persist the wrong key state,
      // and a "present" answer would drain that profile's queue by mistake.
      if (stateKey() !== owner) return keySet;
      if (model.value.provider === provider) {
        model.value = { ...model.value, keySet };
      }
      // The send that parked the queue already returned. A key that is present now can
      // continue it while this conversation is still on screen.
      if (keySet && provider === model.value.provider && credentialsUsable(model.value)) drainActiveQueue();
      return keySet;
    } catch {
      return false;
    }
  }

  function setEffort(effort: HermesEffort) {
    model.value = { ...model.value, effort };
    resetSession();
  }

  function stopMac() {
    mac.value = { ...mac.value, enabled: false };
    stopThinking();
  }

  // Persist the v3 migration immediately so an old full-control record cannot
  // come back merely because nothing else changed this launch.
  if (typeof localStorage !== 'undefined') persist();

  return {
    model,
    mac,
    refreshCredentialState,
    requiresStoredKey,
    conversations,
    activeId,
    active,
    messages,
    mediaSessionId,
    history,
    thinking,
    backgroundTurns,
    conversationActivity,
    openBackgroundTurn,
    historyReady,
    approvalRequest,
    respondApproval,
    clarifyRequest,
    respondClarify,
    secretRequest,
    respondSecret,
    stopping,
    stop,
    profiles,
    activeProfile,
    activeProfileId,
    activeAgentProfileName,
    agentProfiles,
    agentProfilesLoading,
    fleetProfiles,
    loadAllAgentProfiles,
    probeConnections,
    switchToAgentProfile,
    profileColors,
    profileOrder,
    defaultAgentProfiles,
    setAgentProfileDefault,
    agentProfileModel,
    agentProfileMac,
    setAgentProfileModel,
    setAgentProfileMac,
    setAgentProfileColor,
    moveAgentProfile,
    remoteActive,
    panelActive,
    panelAuthExpired,
    gatewayUrl,
    gatewayProfileId,
    switchProfile,
    switchAgentProfile,
    loadAgentProfiles,
    createAgentProfile,
    renameAgentProfile,
    deleteAgentProfile,
    loadAgentProfileSoul,
    saveAgentProfileSoul,
    exportAgentProfile,
    importAgentProfile,
    openAgentProfileWindow,
    addPanelProfile,
    reloginPanel,
    removeProfile,
    updateProfile,
    runtime,
    runtimeReady,
    contextUsage,
    auxiliary,
    forceAuxVision,
    auxiliaryCustomCount,
    setAuxiliary,
    setForceAuxVision,
    resetAuxiliary,
    installing,
    installProgress,
    installRuntime,
    cancelInstall,
    uninstallRuntime,
    loginStatus,
    workingDir,
    setWorkingDir,
    loadLoginStatus,
    modelOptions,
    modelOptionsLoading,
    profileSwitching,
    profileSwitchError,
    profileSwitchingTo,
    modelOptionsError,
    modelOptionsUpdatedAt,
    modelOptionsForScope,
    loadModelOptions,
    invalidateModelOptionsCache,
    apiKey,
    loadRuntime,
    loadHistory,
    loadPanelHistory,
    loadMorePanelHistory,
    loadPanelConversation,
    loadOlderPanelMessages,
    refreshPanelHistory,
    panelConversationLoading,
    panelSlices,
    panelAllProfiles,
    panelRowsFor,
    setPanelAllProfiles,
    setConversationArchived,
    panelSliceState,
    setApiKey,
    modelShort,
    macActive,
    macStatus,
    providers: providerModels,
    select,
    revealConversation,
    newChat,
    deleteConversation,
    renameConversation,
    clearHistory,
    exportHistory,
    send,
    attachmentsBlocked,
    stopThinking,
    saveModel,
    saveMac,
    resetSession,
    useProvider,
    setEffort,
    stopMac
  };
});
