<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { OnButton, OnChip, OnIcon, OnModal } from '@opennavo/ui';
import HermesMark from '@/components/hermes/HermesMark.vue';
import HermesMessage from '@/components/hermes/HermesMessage.vue';
import AssistantHistory from '@/components/hermes/AssistantHistory.vue';
import HermesSettings from '@/components/hermes/HermesSettings.vue';
import HermesProfiles from '@/components/hermes/HermesProfiles.vue';
import HermesGatewayModal from '@/components/hermes/HermesGatewayModal.vue';
import HermesAgentProfiles from '@/components/hermes/HermesAgentProfiles.vue';
import HermesApprovalDialog from '@/components/hermes/HermesApprovalDialog.vue';
import HermesClarifyDialog from '@/components/hermes/HermesClarifyDialog.vue';
import HermesValuePrompt from '@/components/hermes/HermesValuePrompt.vue';
import HermesVaultSaveLoginPrompt from '@/components/hermes/HermesVaultSaveLoginPrompt.vue';
import { useHermesStore } from '@/stores/hermes';
import { commands, unwrap } from '@/ipc/client';
import { useHermesUiStore } from '@/stores/hermesUi';
import { useHermesContent } from '@/composables/useHermesContent';
import { useToasts } from '@/composables/useToasts';
import { useHermesComposerEditor } from '@/composables/useHermesComposerEditor';
import type { PastedTextOutcome } from '@/composables/useHermesComposerEditor';
import { mediaKind } from '@/hermes/media';
import { deriveComposerSubmitState } from '@/hermes/composer';
import { blobToDataUrl, pasteSizeLabel, pastedTextBytes } from '@/hermes/composerClipboard';
import {
  queueHermesNotificationOpen,
  takeHermesNotificationOpen,
  watchHermesNotificationOpen,
  type HermesNotificationOpen
} from '@/hermes/notificationOpen';

const store = useHermesStore();
const ui = useHermesUiStore();
const content = useHermesContent();
const toasts = useToasts();

/** Card titles keep the runtime's own names (env var, vault, site) where it sent one. */
const vaultName = computed(
  () => store.vaultUnlockRequest?.displayName || store.vaultUnlockRequest?.backend || content.value.ask.vaultUnlockName
);
const vaultUnlockTitle = computed(() => content.value.ask.vaultUnlockTitle.replace('{name}', vaultName.value));
const vaultUnlockBody = computed(() => content.value.ask.vaultUnlockBody.replace('{name}', vaultName.value));
const vaultSaveTitle = computed(() =>
  content.value.ask.vaultSaveTitle.replace(
    '{site}',
    store.vaultSaveLoginRequest?.site || content.value.ask.vaultSaveSite
  )
);
const vaultSaveBody = computed(() =>
  content.value.ask.vaultSaveBody.replace(
    '{origin}',
    store.vaultSaveLoginRequest?.origin || content.value.ask.vaultSaveOrigin
  )
);
const vaultCodeTitle = computed(() =>
  content.value.ask.vaultCodeTitle.replace('{site}', store.vaultCodeRequest?.site || content.value.ask.vaultCodeSite)
);

const input = ref('');
const historyOpen = ref(false);
const installOpen = ref(false);
const gatewayOpen = ref(false);
const reloginProfile = ref<import('@/stores/hermes').HermesProfile | null>(null);
let connectionProbeTimer: number | undefined;
const headerRef = ref<HTMLElement | null>(null);
const compactHeader = ref(false);
let headerObserver: ResizeObserver | undefined;
const contextOpen = ref(false);
const attachments = ref<{ path: string; name: string; isImage: boolean; size?: number; label?: string }[]>([]);
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const REMOTE_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const attachmentPreviews = ref<Record<string, string>>({});
const fileInput = ref<HTMLInputElement>();
const scroll = ref<HTMLElement>();
const composer = ref<HTMLElement | null>(null);
const IME_ENTER_GRACE_MS = 50;
const compositionActive = ref(false);
let compositionEndedAt = 0;
/** One send at a time: a second Enter while a paste save is awaited must not send twice. */
let sendInFlight = false;
const composerEditor = useHermesComposerEditor({
  editor: composer,
  value: input,
  attachImages: attachPastedImages,
  attachPastedText,
  attachClipboardImage,
  isComposing: () => compositionActive.value
});
let composerObserver: ResizeObserver | undefined;
let composerWidth = 0;
const dragging = ref(false);
let unlistenDrop: (() => void) | undefined;
let stopNotificationWatch: (() => void) | undefined;
const SUGGESTIONS = ['rectangle', 'cleanup', 'updates', 'explain'] as const;

const modelLabel = computed(
  () => `${content.value.header.model} · ${store.modelShort} · ${content.value.effort[store.model.effort]}`
);

const macLabel = computed(() => {
  if (store.remoteActive) return content.value.profiles.macUnavailable;
  if (!store.mac.enabled) return content.value.header.macPaused;
  if (store.mac.level === 'open') return content.value.header.openOnly;
  return content.value.header.mac;
});

const macTone = computed<'success' | 'neutral'>(() =>
  !store.remoteActive && store.mac.enabled && store.mac.level !== 'open' ? 'success' : 'neutral'
);
const connectionReady = computed(() =>
  store.remoteActive ? store.activeProfile.status === 'connected' : store.runtimeReady
);
/**
 * A rejected panel session needs the sign-in gate. A panel that is merely unreachable does not:
 * the cached transcript stays usable and the probe keeps retrying behind it.
 */
const panelSignedOut = computed(() => store.remoteActive && store.activeProfile.status === 'error');

function retryPanelConnection() {
  void store.retryConnections();
}

/** Waking the Mac or returning to the app is the moment a probe is most likely to matter. */
function probeWhenVisible() {
  if (document.visibilityState === 'visible') void store.probeConnections();
}
/** A panel's own state, not the local runtime's: "Not installed" is meaningless for one. */
const connectionLabel = computed(() => {
  if (!store.remoteActive) {
    return connectionReady.value ? content.value.header.local : content.value.header.demo;
  }
  if (connectionReady.value) return content.value.profiles.remoteOnly;
  if (store.activeProfile.status === 'error') return content.value.profiles.error;
  if (store.activeProfile.status === 'offline') return content.value.profiles.offline;
  return content.value.profiles.connecting;
});

/** Older panel rows are only offered once this conversation's transcript is on screen. */
const showEarlier = computed(() => {
  const active = store.conversations.find(item => item.id === store.activeId);
  return Boolean(active?.panel && active.messagesLoaded && active.panelHasOlder);
});

function enableMac() {
  // Enabling is an explicit grant: default to full control with every capability.
  const next = {
    ...store.mac,
    enabled: true,
    level: 'full' as const,
    terminal: true,
    screen: true,
    files: true,
    cron: true,
    confirmWrites: false
  };
  store.saveMac(next);
  toasts.push({
    tone: 'success',
    title: content.value.common.settingsSaved,
    description: content.value.settings.mac.masterHint
  });
}

/** A streaming turn may keep the transcript in view only while the reader is already at the end. */
const followTail = ref(true);
const TAIL_SLACK_PX = 24;
/** Set while we move the transcript ourselves: its scroll event is not reader intent. */
let programmaticScroll = false;

function atTail(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= TAIL_SLACK_PX;
}

/** Scrolling away from the end stops the chase; scrolling back resumes it. */
function onScroll() {
  const element = scroll.value;
  if (!element) return;
  const tail = atTail(element);
  // Our own move always lands on the tail; never let its scroll event re-open following. A
  // position off the tail is the reader, even while that event is still in flight.
  if (programmaticScroll && tail) return;
  followTail.value = tail;
}

function scrollToBottom() {
  followTail.value = true;
  void nextTick(() => {
    window.requestAnimationFrame(() => {
      const element = scroll.value;
      // A token may queue this frame and the reader may scroll up before it runs.
      if (!element || !followTail.value) return;
      programmaticScroll = true;
      element.scrollTop = element.scrollHeight;
      // Scroll events for this move are dispatched no later than the next frame.
      window.requestAnimationFrame(() => {
        programmaticScroll = false;
      });
    });
  });
}

/** Streaming rewrites the last message on every token; never yank a reader who scrolled up. */
function followStreaming() {
  if (followTail.value) scrollToBottom();
}

// A transcript remounted after the connection gate reopens starts pinned again, at its newest row.
watch(scroll, element => {
  if (element) scrollToBottom();
});

/** Mirrors the composer's `max-h-110px`: past that the draft scrolls instead of growing. */
const COMPOSER_MAX_HEIGHT_PX = 110;

/**
 * Fit the composer to its draft, the way chat composers do it: reset the height so `scrollHeight`
 * reports the content rather than the previous frame, then write that height back and only let the
 * field scroll once the cap is reached.
 */
function onComposerInput() {
  composerEditor.onInput();
  resizeComposer();
}

function resizeComposer() {
  const element = composer.value;
  if (!element) return;
  const previousHeight = element.style.height;
  element.style.height = 'auto';
  const contentHeight = element.scrollHeight;
  element.style.height = `${Math.min(contentHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  element.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  // The transcript is a flex sibling, so a taller composer takes height from it; keep a reader
  // who was following the tail at the tail.
  if (followTail.value && element.style.height !== previousHeight) scrollToBottom();
}

// The input handler measures during typing and IME. This watcher covers Send and New Chat, which
// change the draft without an input event.
watch(input, resizeComposer, { flush: 'post' });

// Re-wrapping changes the line count without an input event (window resizes, layout changes).
watch(composer, element => {
  composerObserver?.disconnect();
  composerObserver = undefined;
  composerWidth = 0;
  if (!element) return;
  resizeComposer();
  composerObserver = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0;
    // Height is ours to set, so only a width change can need another measurement.
    if (width === composerWidth) return;
    composerWidth = width;
    resizeComposer();
  });
  composerObserver.observe(element);
});

const directoryLabel = computed(() => {
  if (store.remoteActive) return content.value.profiles.remoteWorkspace;
  const dir = store.workingDir.trim();
  if (!dir) return content.value.composer.chooseDirectory;
  return dir.split('/').filter(Boolean).at(-1) ?? dir;
});

function attachmentLimitBytes() {
  return store.remoteActive ? REMOTE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
}

/** The one oversize toast shared by the picker, pasted text and pasted images. */
function rejectOversizedAttachment(name: string) {
  toasts.push({
    tone: 'warning',
    title: content.value.composer.attach,
    description: `${name} > ${store.remoteActive ? '16' : '50'} MB`
  });
}

function addAttachment(path: string, name?: string, size?: number, image?: boolean, label?: string): boolean {
  const displayName = name || path.split('/').filter(Boolean).at(-1) || path;
  if (attachments.value.some(item => item.path === path)) return true;
  if (size && size > attachmentLimitBytes()) {
    rejectOversizedAttachment(displayName);
    return false;
  }
  const isImage = image ?? mediaKind(displayName) === 'image';
  attachments.value.push({ path, name: displayName, isImage, size, label });
  if (isImage) void loadAttachmentPreview(path);
  return true;
}

function attachmentIcon(path: string): string {
  const kind = mediaKind(path);
  if (kind === 'image') return 'lucide:image';
  if (kind === 'video') return 'lucide:film';
  if (kind === 'audio') return 'lucide:music';
  return 'lucide:paperclip';
}

async function addAttachmentPaths(paths: string[]) {
  if (!paths.length) return;
  try {
    const info = await commands.hermesAttachmentInfo(paths);
    info.forEach(item => addAttachment(item.path, item.name, item.size, item.isImage));
  } catch {
    paths.forEach(path => addAttachment(path));
  }
}

function desktopAvailable() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Only files this feature wrote may be deleted: never a picker/drag attachment. */
function isManagedComposerPath(path: string) {
  return /(^|[\\/])(composer-pastes|composer-images)[\\/]/.test(path);
}

/** Best effort: a leftover temp file must never keep a removed chip on screen. */
async function discardManagedAttachment(path: string) {
  if (!desktopAvailable() || !isManagedComposerPath(path)) return;
  try {
    await unwrap(commands.hermesDiscardAttachment(path));
  } catch {
    // The file is already gone, or the host refused it; the chip still goes away either way.
  }
}

/** Images from a paste hit the same attachment path as the picker, after a data-URL round trip. */
async function attachPastedImages(blobs: Blob[]) {
  if (!desktopAvailable()) return;
  const limit = attachmentLimitBytes();
  for (const blob of blobs) {
    const displayName = blob instanceof File && blob.name ? blob.name : content.value.composer.pastedContent;
    // Refuse before the IPC round trip; a remote attachment would be rejected host-side anyway.
    if (blob.size > limit) {
      rejectOversizedAttachment(displayName);
      continue;
    }
    try {
      const dataUrl = await blobToDataUrl(blob);
      const info = await unwrap(commands.hermesSaveAttachmentImage(dataUrl, blob instanceof File ? blob.name : null));
      if (!addAttachment(info.path, info.name, info.size, info.isImage)) {
        await discardManagedAttachment(info.path);
      }
    } catch {
      toasts.push({
        tone: 'warning',
        title: content.value.composer.attach,
        description: content.value.composer.imageAttachFailed
      });
    }
  }
}

/**
 * A long paste becomes a `.txt` attachment. `rejected` (too large for either form) is not a
 * write failure and must never fall back to inline text.
 */
async function attachPastedText(text: string): Promise<PastedTextOutcome> {
  // The size gate comes before the IPC availability check: the inline fallback has the same
  // limit, so an oversized paste must be refused even when there is no host to save it.
  if (pastedTextBytes(text) > attachmentLimitBytes()) {
    rejectOversizedAttachment(content.value.composer.pastedContent);
    return 'rejected';
  }
  if (!desktopAvailable()) return 'failed';
  try {
    const info = await unwrap(commands.hermesSavePastedText(text));
    const attached = addAttachment(
      info.path,
      info.name,
      info.size,
      false,
      `${content.value.composer.pastedContent} (${pasteSizeLabel(text)})`
    );
    if (!attached) {
      await discardManagedAttachment(info.path);
      return 'rejected';
    }
    return 'attached';
  } catch {
    toasts.push({
      tone: 'warning',
      title: content.value.composer.attach,
      description: content.value.composer.pasteFailed
    });
    return 'failed';
  }
}

/** WKWebView can deliver a screenshot as an empty paste; the native reader is the fallback. */
async function attachClipboardImage() {
  if (!desktopAvailable()) return false;
  try {
    const path = await unwrap(commands.hermesClipboardImage());
    if (!path) return false;
    await addAttachmentPaths([path]);
    return true;
  } catch {
    return false;
  }
}

async function loadAttachmentPreview(path: string) {
  if (!(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)) return;
  try {
    const preview = await unwrap(commands.hermesAttachmentPreview(path));
    if (preview) attachmentPreviews.value = { ...attachmentPreviews.value, [path]: preview };
  } catch {
    // Preview is optional; the attachment still sends.
  }
}

function attachmentSrc(path: string) {
  return attachmentPreviews.value[path] ?? '';
}

async function openAttachment(path: string) {
  if (!(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)) return;
  try {
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(path);
  } catch (error) {
    toasts.push({ tone: 'warning', title: content.value.composer.attach, description: String(error) });
  }
}

async function pickFiles() {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      await addAttachmentPaths(paths);
    } catch (error) {
      toasts.push({ tone: 'warning', title: content.value.composer.attach, description: String(error) });
    }
    return;
  }
  fileInput.value?.click();
}

function isEditablePasteTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  return Boolean(element?.closest('input, textarea, [contenteditable="true"]'));
}

/**
 * Paste-to-focus: a ⌘V on non-editable chrome routes the clipboard into the composer instead of
 * dying on the window body. The editor's own paste handler runs first and marks the event handled.
 */
function onPaste(event: ClipboardEvent) {
  if (!event.clipboardData || event.defaultPrevented) return;
  const target = event.target instanceof Node ? event.target : null;
  const editor = composer.value;
  if (editor && target && (target === editor || editor.contains(target))) return;
  if (isEditablePasteTarget(event.target) || ui.settingsOpen) return;
  if (target instanceof HTMLElement && target.closest('[role="dialog"]')) return;
  if (!composerEditor.handleClipboard(event.clipboardData)) return;
  event.preventDefault();
  composer.value?.focus();
}

function onFileInput(event: Event) {
  const target = event.target as HTMLInputElement;
  // The browser input has no native path. Tauri uses the dialog path instead.
  toasts.push({
    tone: 'warning',
    title: content.value.composer.attach,
    description: 'Use the desktop app file picker to attach local files.'
  });
  target.value = '';
}

function removeAttachment(index: number) {
  const [removed] = attachments.value.splice(index, 1);
  if (removed) void discardManagedAttachment(removed.path);
}

/** Leaving this draft drops its chips; managed paste files go with them, sent files stay. */
function clearAttachments() {
  const dropped = attachments.value;
  attachments.value = [];
  for (const item of dropped) void discardManagedAttachment(item.path);
}

async function pickDirectory() {
  if (store.remoteActive) return;
  if (!(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)) return;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === 'string') {
      const previous = store.workingDir;
      store.setWorkingDir(selected);
      if (previous !== selected && store.activeId) {
        toasts.push({
          tone: 'info',
          title: content.value.composer.chooseDirectory,
          description: content.value.composer.directoryChanged
        });
      }
    }
  } catch (error) {
    toasts.push({ tone: 'warning', title: content.value.composer.chooseDirectory, description: String(error) });
  }
}

/** A card parked the turn; text can only queue behind it until the user answers. */
const hasBlockingPrompt = computed(() =>
  Boolean(
    store.approvalRequest ||
    store.clarifyRequest ||
    store.secretRequest ||
    store.sudoRequest ||
    store.vaultUnlockRequest ||
    store.vaultSaveLoginRequest ||
    store.vaultCodeRequest
  )
);
/**
 * The composer's primary action mirrors the official desktop: busy input follows the runtime's
 * busy policy instead of starting a second turn, and an empty composer turns the button into Stop.
 */
const composerSubmit = computed(() =>
  deriveComposerSubmitState({
    attachmentCount: attachments.value.length,
    blockingPrompt: hasBlockingPrompt.value,
    busy: store.thinking,
    busyInputMode: store.active?.busyMode ?? null,
    hasPayload: Boolean(input.value.trim()) || attachments.value.length > 0
  })
);
const composerActionLabel = computed(() => {
  switch (composerSubmit.value.action) {
    case 'interrupt':
      return content.value.composer.redirect;
    case 'steer':
      return content.value.composer.steer;
    case 'queue':
      return content.value.composer.queueMessage;
    case 'stop':
      return store.stopping ? content.value.composer.stopping : content.value.composer.stop;
    default:
      return content.value.composer.send;
  }
});
/** Attachments cannot join a correction, so the disabled primary must not claim it will queue. */
const composerPrimaryLabel = computed(() =>
  store.thinking && attachments.value.length ? content.value.composer.attachmentsBusy : composerActionLabel.value
);
/**
 * A busy turn the primary cannot submit (policy still unknown, or files held for the next turn)
 * still has to be stoppable without throwing away the draft.
 */
const showSecondaryStop = computed(
  () => store.thinking && composerSubmit.value.action !== 'stop' && !composerSubmit.value.canSubmit
);
const composerHint = computed(() => {
  if (store.thinking && attachments.value.length) return content.value.composer.attachmentsBusy;
  if (composerSubmit.value.action === 'stop') return composerActionLabel.value;
  // Enter does nothing while the primary is disabled, so the hint must not promise a submit.
  if (!composerSubmit.value.canSubmit || !connectionReady.value) return composerActionLabel.value;
  return `↵ ${composerActionLabel.value}`;
});

async function send() {
  if (sendInFlight) return;
  sendInFlight = true;
  try {
    // A paste may still be saving its attachment. Wait for it so the message carries everything
    // the paste produced instead of clearing the composer under a late save (and the next draft
    // inheriting it).
    await composerEditor.whenPasteSettled();
    // Trim decides whether there is a message; it must not rewrite the prompt (a pasted block
    // keeps its leading indentation and an explicit trailing newline).
    const raw = composerEditor.getPlainText();
    const value = raw.trim();
    const files = attachments.value.map(item => item.path);
    if (!value && !files.length) return;
    if (store.stopping) return;
    if (files.length && store.attachmentsBlocked()) {
      toasts.push({
        tone: 'warning',
        title: content.value.composer.attach,
        description: content.value.composer.attachmentsBusy
      });
      return;
    }
    // The turn's busy policy has not arrived yet (or the payload cannot ride a correction); the
    // button is disabled for the same window, so Enter must not pin a guess either.
    if (!composerSubmit.value.canSubmit) return;
    // A panel that is unreachable shows the reconnect banner; a send would only fail opaquely.
    if (!connectionReady.value) return;
    store.send(raw, files);
    composerEditor.clear();
    // Sent files are the gateway's to read; only the chips go.
    attachments.value = [];
    scrollToBottom();
  } finally {
    sendInFlight = false;
  }
}

/** The primary button submits the form, except with an empty composer, where it stops the turn. */
function onComposerPrimary() {
  if (composerSubmit.value.action === 'stop') store.stop();
}

function onEnter(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  // A composing Enter belongs to the IME, not the composer: let it commit the candidate.
  if (event.isComposing || event.keyCode === 229 || compositionActive.value) return;
  // The confirming Enter after compositionend must not insert a newline while the grace window
  // is open; outside it, this same preventDefault keeps the contenteditable from adding one too.
  event.preventDefault();
  if (Date.now() - compositionEndedAt < IME_ENTER_GRACE_MS) return;
  void send();
}

function onCompositionStart() {
  compositionActive.value = true;
  // Preedit text is not committed content: keep the placeholder from painting behind it.
  composer.value?.removeAttribute('data-empty');
}

function onCompositionEnd() {
  compositionActive.value = false;
  // Safari/WKWebView can dispatch the confirming Enter after compositionend, sometimes with keyCode 13.
  compositionEndedAt = Date.now();
  // The placeholder was held back while composing; now sync it with the committed text.
  composerEditor.syncFromDom();
}

function suggestion(prompt: string) {
  // The offline banner already explains the panel cannot take a message; a suggestion must not
  // bypass the composer's own guard and fail opaquely.
  if (!connectionReady.value) return;
  store.send(prompt);
  scrollToBottom();
}

function newChat() {
  // Switching views never stops a running turn; it keeps streaming into its own conversation.
  store.newChat();
  historyOpen.value = false;
  composerEditor.clear();
  clearAttachments();
  scrollToBottom();
  void nextTick(() => composer.value?.focus());
}

function selectConversation(id: string) {
  // A background turn in another conversation is not interrupted by opening this one.
  store.select(id);
  clearAttachments();
  historyOpen.value = false;
  // Opening a conversation is navigation, not reading: start at its newest row and follow it.
  scrollToBottom();
}

async function openBackgroundTurn(conversationId: string) {
  if (!(await store.openBackgroundTurn(conversationId))) return;
  historyOpen.value = false;
  void nextTick(() => scrollToBottom());
}

async function openNotificationConversation(open: HermesNotificationOpen) {
  if (!(await store.revealConversation(open.conversationId))) return;
  clearAttachments();
  historyOpen.value = false;
  scrollToBottom();
}

const contextPercent = computed(() => {
  const context = store.contextUsage;
  return context ? Math.min(100, Math.max(0, Math.round(context.percent))) : 0;
});
const contextColor = computed(() => {
  if (!store.contextUsage) return 'var(--on-text-tertiary)';
  if (contextPercent.value >= 85) return 'var(--on-status-danger)';
  if (contextPercent.value >= 60) return 'var(--on-status-warning)';
  return 'var(--on-status-success)';
});
const contextKnown = computed(() => Boolean(store.contextUsage));
const contextRadius = 7;
const contextCircumference = 2 * Math.PI * contextRadius;
const contextDashoffset = computed(
  () => contextCircumference * (1 - Math.min(100, Math.max(0, contextPercent.value)) / 100)
);
function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
const contextUsedText = computed(() => formatTokens(store.contextUsage?.used ?? 0));
const contextMaxText = computed(() => formatTokens(store.contextUsage?.max ?? 0));
const contextUsedLabel = computed(() => content.value.context.used.replace('{percent}', String(contextPercent.value)));
const contextTokensLabel = computed(() =>
  content.value.context.tokens.replace('{used}', contextUsedText.value).replace('{total}', contextMaxText.value)
);
const lastMessage = computed(() => store.messages.at(-1));
const streamingAssistant = computed(() =>
  store.messages.some(message => message.role === 'assistant' && message.streaming === true)
);
watch(() => store.thinking, followStreaming, { flush: 'post' });
watch(lastMessage, followStreaming, { deep: true, flush: 'post' });
function openRelogin(profile: import('@/stores/hermes').HermesProfile) {
  reloginProfile.value = profile;
  gatewayOpen.value = true;
  ui.closeProfiles();
}

watch(
  () => store.panelAuthExpired,
  profileId => {
    if (!profileId) return;
    const profile = store.profiles.find(item => item.id === profileId);
    if (!profile) return;
    openRelogin(profile);
  }
);
// Selecting a conversation, opening a notification or starting a draft all land on the newest
// row: an explicit navigation resets following instead of inheriting the previous scroll state.
watch(
  () => store.activeId,
  () => scrollToBottom()
);

async function installRuntime() {
  const ok = await store.installRuntime();
  if (!ok) return;
  installOpen.value = false;
  await nextTick();
  scrollToBottom();
  composer.value?.focus();
}

function closeInstall() {
  if (store.installing) return;
  installOpen.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    if (ui.settingsOpen) return;
    historyOpen.value = !historyOpen.value;
  }
}

onMounted(async () => {
  if (headerRef.value) {
    headerObserver = new ResizeObserver(entries => {
      compactHeader.value = (entries[0]?.contentRect.width ?? 0) < 1240;
    });
    headerObserver.observe(headerRef.value);
  }
  const params = new URLSearchParams(window.location.search);
  const requestedConnection = params.get('connection');
  const requestedProfile = params.get('profile');
  const requestedConversation = params.get('conversation');
  if (requestedConversation) queueHermesNotificationOpen({ conversationId: requestedConversation });
  if (requestedConnection && requestedConnection !== store.activeProfileId) {
    store.switchProfile(requestedConnection);
  }
  await store.loadAllAgentProfiles();
  void store.probeConnections();
  // Panel history lives on the host, so it is read once here instead of only after a switch.
  void store.loadPanelHistory();
  connectionProbeTimer = window.setInterval(() => void store.probeConnections(), 60_000);
  window.addEventListener('focus', probeWhenVisible);
  document.addEventListener('visibilitychange', probeWhenVisible);
  if (requestedProfile) store.switchAgentProfile(requestedProfile);
  const history = store.loadHistory();
  await store.loadRuntime();
  await history;
  if (!store.runtimeReady && !store.remoteActive) installOpen.value = true;
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('paste', onPaste);
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      unlistenDrop = await getCurrentWebview().onDragDropEvent(event => {
        if (event.payload.type === 'over') dragging.value = true;
        if (event.payload.type === 'leave') dragging.value = false;
        if (event.payload.type === 'drop') {
          dragging.value = false;
          void addAttachmentPaths(event.payload.paths);
        }
      });
    } catch {
      // Native drag/drop is an enhancement; the file picker still works.
    }
  }
  stopNotificationWatch = watchHermesNotificationOpen(open => {
    void openNotificationConversation(open);
  });
  const pendingNotificationOpen = takeHermesNotificationOpen();
  if (pendingNotificationOpen) void openNotificationConversation(pendingNotificationOpen);
  scrollToBottom();
  void nextTick(() => composer.value?.focus());
});
onBeforeUnmount(() => {
  if (connectionProbeTimer) window.clearInterval(connectionProbeTimer);
  window.removeEventListener('focus', probeWhenVisible);
  document.removeEventListener('visibilitychange', probeWhenVisible);
  headerObserver?.disconnect();
  composerObserver?.disconnect();
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('paste', onPaste);
  unlistenDrop?.();
  stopNotificationWatch?.();
});
</script>

<template>
  <div class="relative flex h-[calc(100vh-86px)] min-h-0 flex-col">
    <header
      ref="headerRef"
      class="flex h-64px shrink-0 items-center gap-10px border-b border-b-solid border-line-subtle"
    >
      <div class="flex min-w-0 items-center gap-10px">
        <HermesMark :size="30" />
        <span class="text-17px font-600 tracking-[-0.015em] text-ink-primary">Hermes</span>
        <OnChip tone="neutral">{{ content.header.builtin }}</OnChip>
        <span class="inline-flex shrink-0 items-center gap-5px whitespace-nowrap text-11px text-ink-tertiary"
          ><i
            class="h-6px w-6px rounded-full"
            :class="
              store.activeProfile.status === 'error'
                ? 'bg-status-danger'
                : connectionReady
                  ? 'bg-status-success'
                  : 'bg-status-warning'
            "
          ></i
          >{{ connectionLabel }}</span
        >
        <div v-if="!compactHeader" class="flex shrink-0 items-center gap-10px">
          <OnChip :tone="macTone" dot class="shrink-0 whitespace-nowrap">{{ macLabel }}</OnChip>
          <OnButton
            v-if="!store.remoteActive && !store.mac.enabled"
            variant="ghost"
            size="xs"
            icon="lucide:power"
            @click="enableMac"
            >{{ content.header.enableMac }}</OnButton
          >
        </div>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-8px">
        <OnButton
          variant="ghost"
          size="sm"
          icon="lucide:clock"
          icon-only
          :aria-label="content.header.history"
          :aria-expanded="historyOpen"
          data-hermes-history-toggle
          :class="{ 'bg-surface-raised text-ink-primary': historyOpen }"
          @click="historyOpen = !historyOpen"
        />
        <OnButton variant="ghost" size="sm" icon="lucide:plus" @click="newChat">{{ content.header.newChat }}</OnButton>
      </div>
    </header>

    <div
      v-if="!store.remoteActive && !store.runtimeReady"
      class="flex min-h-0 flex-1 flex-col items-center justify-center px-24px pb-40px text-center"
    >
      <HermesMark :size="54" />
      <h2 class="m-0 mt-16px text-21px font-600 tracking-[-0.02em] text-ink-primary">
        {{ content.install.gateTitle }}
      </h2>
      <p class="m-0 mt-7px max-w-430px text-13px leading-[1.7] text-ink-secondary">{{ content.install.gateBody }}</p>
      <p class="m-0 mt-12px text-11px text-ink-tertiary">{{ content.install.size }}</p>
      <OnButton class="mt-20px" variant="accent" size="md" icon="lucide:download" @click="installOpen = true">{{
        content.install.gateButton
      }}</OnButton>
      <p
        v-if="store.runtime?.message"
        class="m-0 mt-12px max-w-480px break-words text-11px leading-[1.5] text-ink-tertiary"
      >
        {{ store.runtime.message }}
      </p>
    </div>

    <!--
      A panel that is signed out is not a Mac missing its local runtime: say so and offer the
      panel sign-in instead of the local install gate. A panel that is merely unreachable keeps
      the conversation below; only a rejected session takes the whole page.
    -->
    <div
      v-else-if="panelSignedOut"
      class="flex min-h-0 flex-1 flex-col items-center justify-center px-24px pb-40px text-center"
    >
      <HermesMark :size="54" />
      <h2 class="m-0 mt-16px text-21px font-600 tracking-[-0.02em] text-ink-primary">
        {{ content.profiles.panelUnavailableTitle }}
      </h2>
      <p class="m-0 mt-7px max-w-430px text-13px leading-[1.7] text-ink-secondary">
        {{ store.activeProfile.error || content.profiles.panelUnavailableBody }}
      </p>
      <OnButton
        v-if="store.activeProfile.kind === 'panel'"
        class="mt-20px"
        variant="accent"
        size="md"
        icon="lucide:key-round"
        @click="openRelogin(store.activeProfile)"
        >{{ content.profiles.relogin }}</OnButton
      >
    </div>

    <template v-else>
      <!--
        A panel that cannot be reached right now is usually a tailnet hiccup or a waking Mac: keep
        the cached conversation on screen and retry instead of replacing it with a full gate.
      -->
      <div
        v-if="store.remoteActive && !connectionReady"
        class="flex shrink-0 items-center gap-8px border-b border-b-solid border-line-subtle bg-surface-raised px-18px py-8px text-11px text-ink-secondary"
        role="status"
        data-hermes-panel-offline
      >
        <OnIcon name="lucide:wifi-off" :size="13" class="shrink-0 text-status-warning" />
        <span class="min-w-0 flex-1">
          {{ content.profiles.offlineNotice }}
          <span v-if="store.activeProfile.error" class="text-ink-tertiary">· {{ store.activeProfile.error }}</span>
        </span>
        <OnButton
          variant="ghost"
          size="xs"
          icon="lucide:refresh-cw"
          data-hermes-panel-retry
          @click="retryPanelConnection"
        >
          {{ content.profiles.retryConnection }}
        </OnButton>
      </div>
      <div
        ref="scroll"
        data-hermes-transcript
        class="min-h-0 flex-1 overflow-y-auto py-18px"
        @scroll.passive="onScroll"
      >
        <div class="mx-auto flex w-full max-w-720px flex-col gap-22px">
          <div v-if="showEarlier" class="flex items-center justify-center">
            <button
              type="button"
              class="inline-flex h-28px items-center gap-6px rounded-full border border-solid border-line-default px-12px font-sans text-11px text-ink-tertiary outline-none hover:border-line-strong hover:text-ink-secondary focus-visible:shadow-focus-ring"
              @click="store.loadOlderPanelMessages()"
            >
              <OnIcon
                :name="store.panelConversationLoading ? 'lucide:loader-circle' : 'lucide:chevron-up'"
                :size="12"
                :class="store.panelConversationLoading ? 'animate-spin' : ''"
              />
              {{ store.panelConversationLoading ? content.history.loadingEarlier : content.history.showEarlier }}
            </button>
          </div>
          <div
            v-if="store.profileSwitching"
            class="flex items-center justify-center gap-6px text-11px text-ink-tertiary"
          >
            <OnIcon name="lucide:loader-circle" :size="12" class="animate-spin" />
            <span>{{
              content.agentProfiles.switchingTo.replace(
                '{name}',
                store.profileSwitchingTo ?? store.activeAgentProfileName
              )
            }}</span>
          </div>
          <div
            v-if="store.panelConversationLoading"
            class="flex items-center justify-center gap-6px text-11px text-ink-tertiary"
          >
            <OnIcon name="lucide:loader-circle" :size="12" class="animate-spin" />
            <span>{{ content.history.loading }}</span>
          </div>
          <div
            v-if="!store.messages.length && !store.thinking && !store.panelConversationLoading"
            class="flex flex-col items-center px-0 pb-18px pt-38px text-center"
          >
            <HermesMark :size="54" />
            <h2 class="m-0 mt-14px text-23px font-600 tracking-[-0.025em] text-ink-primary">
              {{ content.welcome.title }}
            </h2>
            <p class="m-0 mt-5px max-w-430px text-13px leading-[1.7] text-ink-secondary">{{ content.welcome.body }}</p>
            <div class="mt-24px grid w-full max-w-560px grid-cols-2 gap-8px">
              <button
                v-for="item in SUGGESTIONS"
                :key="item"
                type="button"
                :data-hermes-suggestion="item"
                :disabled="!connectionReady"
                class="flex min-w-0 items-start gap-10px rounded-default border border-solid border-line-subtle bg-surface-card p-12px text-left outline-none transition-colors enabled:hover:border-line-strong enabled:hover:bg-surface-raised focus-visible:shadow-focus-ring disabled:cursor-default disabled:opacity-60"
                @click="suggestion(content.welcome.suggestions[item].prompt)"
              >
                <span
                  class="flex h-24px w-24px shrink-0 items-center justify-center rounded-small bg-accent-coral-subtle text-ink-accent"
                >
                  <OnIcon
                    :name="
                      item === 'rectangle'
                        ? 'lucide:mouse-pointer-click'
                        : item === 'cleanup'
                          ? 'lucide:hard-drive'
                          : item === 'updates'
                            ? 'lucide:circle-arrow-down'
                            : 'lucide:app-window'
                    "
                    :size="14"
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <b class="block text-12px font-600 leading-[1.4] text-ink-primary">{{
                    content.welcome.suggestions[item].title
                  }}</b>
                  <span class="mt-2px block text-11px leading-[1.45] text-ink-tertiary">{{
                    content.welcome.suggestions[item].sub
                  }}</span>
                </span>
                <OnIcon name="lucide:arrow-up-right" :size="13" class="mt-3px text-ink-tertiary" />
              </button>
            </div>
          </div>

          <HermesMessage v-for="message in store.messages" :key="message.id" :message="message" />

          <div v-if="store.thinking && !streamingAssistant" class="flex items-start gap-12px">
            <HermesMark :size="26" class="mt-1px" />
            <div class="flex items-center gap-8px pt-4px text-11px text-ink-tertiary">
              <span class="h-5px w-5px animate-pulse rounded-full bg-brand-coral"></span>
              {{ content.composer.thinking }}
            </div>
          </div>
        </div>
      </div>

      <!-- Background turns keep running; say so without hiding a card or the way back to it. -->
      <div v-if="store.backgroundTurns.length" class="mx-auto w-full max-w-720px shrink-0 pb-2px">
        <div
          v-for="turn in store.backgroundTurns"
          :key="turn.conversationId"
          class="flex items-center gap-7px rounded-default border border-solid border-line-subtle bg-surface-card px-10px py-8px text-11px text-ink-secondary"
          data-hermes-background-turn
        >
          <OnIcon
            :name="turn.waiting ? 'lucide:hand' : 'lucide:loader-circle'"
            :size="12"
            :class="turn.waiting ? 'shrink-0 text-status-warning' : 'shrink-0 animate-spin text-ink-tertiary'"
          />
          <span class="shrink-0 font-500">{{
            turn.waiting ? content.composer.backgroundWaiting : content.composer.backgroundReplying
          }}</span>
          <span v-if="turn.title" class="min-w-0 truncate text-ink-tertiary">· {{ turn.title }}</span>
          <button
            v-if="turn.openable"
            type="button"
            class="ml-auto shrink-0 rounded-tiny px-6px py-2px text-10.5px font-600 text-ink-secondary outline-none hover:bg-surface-control hover:text-ink-primary focus-visible:shadow-focus-ring"
            @click="openBackgroundTurn(turn.conversationId)"
          >
            {{ content.composer.backgroundOpen }}
          </button>
        </div>
      </div>

      <div class="shrink-0 pb-16px pt-10px">
        <div class="mx-auto w-full max-w-720px">
          <form
            class="rounded-big border border-solid bg-surface-control px-10px pb-8px pt-9px transition-colors focus-within:border-line-strong"
            :class="dragging ? 'border-accent-coral bg-accent-coral-subtle' : 'border-line-default'"
            @submit.prevent="send"
          >
            <div v-if="attachments.length" class="flex flex-wrap gap-5px px-4px pb-7px">
              <span
                v-for="(file, index) in attachments"
                :key="file.path"
                class="inline-flex max-w-full cursor-pointer items-center gap-5px rounded-tiny border border-solid border-line-subtle bg-surface-raised px-7px py-4px text-11px text-ink-secondary hover:border-line-strong"
                @click="openAttachment(file.path)"
              >
                <img
                  v-if="file.isImage && attachmentSrc(file.path)"
                  :src="attachmentSrc(file.path)"
                  :alt="file.name"
                  class="h-22px w-22px shrink-0 rounded-3px object-cover"
                />
                <OnIcon v-else :name="attachmentIcon(file.path)" :size="12" class="shrink-0 text-ink-tertiary" />
                <span class="min-w-0 truncate">{{ file.label || file.name }}</span>
                <span v-if="file.size && !file.label" class="shrink-0 text-10px text-ink-tertiary"
                  >{{ Math.ceil(file.size / 1024) }} KB</span
                >
                <button
                  type="button"
                  class="flex shrink-0 items-center justify-center text-ink-tertiary outline-none hover:text-ink-primary focus-visible:shadow-focus-ring"
                  :aria-label="`Remove ${file.name}`"
                  @click.stop="removeAttachment(index)"
                >
                  <OnIcon name="lucide:x" :size="11" />
                </button>
              </span>
            </div>
            <div
              id="hermes-composer"
              ref="composer"
              role="textbox"
              aria-multiline="true"
              contenteditable="true"
              data-empty
              class="hermes-composer block max-h-110px min-h-42px w-full resize-none overflow-y-hidden whitespace-pre-wrap break-words border-none bg-transparent px-4px pb-8px pt-4px font-sans text-13.5px leading-[1.55] text-ink-primary outline-none"
              :data-placeholder="content.composer.placeholder"
              :aria-label="content.composer.placeholder"
              @input="onComposerInput"
              @paste="composerEditor.onPaste"
              @keydown="composerEditor.onKeydown"
              @compositionstart="onCompositionStart"
              @compositionend="onCompositionEnd"
              @keydown.enter="onEnter"
            ></div>
            <div class="flex items-center gap-8px">
              <button
                type="button"
                class="flex h-26px w-26px items-center justify-center rounded-small text-ink-tertiary outline-none hover:bg-surface-raised hover:text-ink-primary focus-visible:shadow-focus-ring"
                :aria-label="content.composer.attach"
                @click="pickFiles"
              >
                <OnIcon name="lucide:paperclip" :size="15" />
              </button>
              <input ref="fileInput" type="file" multiple class="hidden" @change="onFileInput" />
              <button
                type="button"
                class="inline-flex h-24px max-w-220px items-center gap-5px rounded-tiny bg-surface-raised px-8px text-11px text-ink-secondary outline-none hover:bg-surface-control focus-visible:shadow-focus-ring"
                :title="store.workingDir || content.composer.directoryHint"
                @click="pickDirectory"
              >
                <OnIcon name="lucide:folder" :size="12" />
                <span class="min-w-0 truncate">{{ directoryLabel }}</span>
                <OnIcon name="lucide:chevron-down" :size="11" class="shrink-0 text-ink-tertiary" />
              </button>
              <div class="ml-auto flex items-center gap-8px">
                <div
                  class="relative flex items-center"
                  @mouseenter="contextOpen = true"
                  @mouseleave="contextOpen = false"
                >
                  <button
                    type="button"
                    class="relative flex h-28px w-28px items-center justify-center rounded-full text-ink-secondary outline-none transition-colors hover:bg-surface-raised hover:text-ink-primary focus-visible:shadow-focus-ring"
                    :aria-label="contextKnown ? `${content.context.title} ${contextPercent}%` : content.context.title"
                    :aria-expanded="contextOpen"
                  >
                    <svg viewBox="0 0 20 20" class="h-18px w-18px -rotate-90 overflow-visible" aria-hidden="true">
                      <circle
                        cx="10"
                        cy="10"
                        :r="contextRadius"
                        fill="none"
                        stroke="currentColor"
                        :stroke-width="1.8"
                        :stroke-dasharray="contextKnown ? undefined : '2.4 2.8'"
                        stroke-linecap="round"
                        :opacity="contextKnown ? 0.5 : 0.9"
                      />
                      <circle
                        v-if="contextKnown"
                        cx="10"
                        cy="10"
                        :r="contextRadius"
                        fill="none"
                        :stroke="contextColor"
                        stroke-width="2"
                        :stroke-dasharray="contextCircumference"
                        :stroke-dashoffset="contextDashoffset"
                        stroke-linecap="round"
                        class="transition-[stroke-dashoffset] duration-300 ease-out"
                      />
                    </svg>
                  </button>
                  <div
                    v-if="contextOpen"
                    class="absolute bottom-30px right-0 z-30 w-220px rounded-big border border-solid border-line-default bg-component-modal-bg p-13px shadow-modal"
                  >
                    <b class="block text-12px font-600 text-ink-primary">{{ content.context.title }}</b>
                    <p class="m-0 mt-5px text-12px text-ink-secondary">
                      {{ store.contextUsage ? contextUsedLabel : content.context.unknown }}
                    </p>
                    <p v-if="store.contextUsage" class="m-0 mt-2px font-mono text-11px text-ink-tertiary">
                      {{ contextTokensLabel }}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  class="font-sans text-11px text-ink-tertiary outline-none hover:text-ink-secondary focus-visible:shadow-focus-ring"
                  @click="ui.openSettings('model')"
                >
                  {{ modelLabel }}
                </button>
                <OnButton
                  v-if="showSecondaryStop"
                  variant="ghost"
                  size="sm"
                  icon="lucide:square"
                  icon-only
                  :aria-label="store.stopping ? content.composer.stopping : content.composer.stop"
                  :disabled="store.stopping"
                  @click="store.stop"
                />
                <span data-hermes-composer-primary class="flex">
                  <OnButton
                    :type="composerSubmit.action === 'stop' ? 'button' : 'submit'"
                    variant="accent"
                    size="sm"
                    :icon="composerSubmit.action === 'stop' ? 'lucide:square' : 'lucide:arrow-up'"
                    icon-only
                    :aria-label="composerPrimaryLabel"
                    :disabled="
                      store.stopping ||
                      (composerSubmit.action !== 'stop' && (!composerSubmit.canSubmit || !connectionReady))
                    "
                    @click="onComposerPrimary"
                  />
                </span>
              </div>
            </div>
          </form>
          <div class="mt-7px flex items-center justify-between gap-12px text-11px text-ink-tertiary">
            <span>{{ content.composer.hint }}</span>
            <span>{{ composerHint }}</span>
          </div>
        </div>
      </div>
    </template>

    <AssistantHistory :open="historyOpen" @close="historyOpen = false" @select="selectConversation" />
    <HermesSettings :open="ui.settingsOpen" :tab="ui.settingsTab" @close="ui.closeSettings()" />
    <HermesProfiles
      :open="ui.profilesOpen"
      @close="ui.closeProfiles()"
      @relogin="openRelogin"
      @add="
        gatewayOpen = true;
        ui.closeProfiles();
      "
    />
    <HermesGatewayModal
      :open="gatewayOpen"
      :relogin-id="reloginProfile?.id ?? null"
      :initial-name="reloginProfile?.name"
      :initial-url="reloginProfile?.endpoint"
      @close="
        gatewayOpen = false;
        reloginProfile = null;
      "
      @saved="
        gatewayOpen = false;
        reloginProfile = null;
      "
    />
    <HermesAgentProfiles :open="ui.agentProfilesOpen" @close="ui.closeAgentProfiles()" />

    <HermesApprovalDialog
      :open="Boolean(store.approvalRequest)"
      :request="store.approvalRequest"
      :total="store.approvalQueueSize"
      @decide="store.respondApproval"
      @close="store.respondApproval('deny')"
    />
    <HermesClarifyDialog
      :open="Boolean(store.clarifyRequest)"
      :request="store.clarifyRequest"
      @submit="store.respondClarify"
      @cancel="store.respondClarify([], true)"
    />
    <HermesValuePrompt
      :open="Boolean(store.sudoRequest)"
      :request-key="store.sudoRequest?.requestId ?? ''"
      :deadline="store.sudoRequest?.deadline ?? null"
      :title="content.ask.sudoTitle"
      :description="content.ask.sudoBody"
      :context="store.sudoRequest?.command"
      :context-label="content.ask.sudoCommandLabel"
      :placeholder="content.ask.sudoPlaceholder"
      :submit-label="content.ask.sudoSubmit"
      :skip-label="content.ask.cancel"
      @submit="store.respondSudo"
      @skip="store.respondSudo('')"
    />
    <HermesValuePrompt
      :open="Boolean(store.secretRequest)"
      :request-key="store.secretRequest?.requestId ?? ''"
      :deadline="store.secretRequest?.deadline ?? null"
      :title="store.secretRequest?.envVar || content.ask.secretTitle"
      :description="store.secretRequest?.prompt || content.ask.secretBody"
      :placeholder="content.ask.secretPlaceholder"
      :submit-label="content.ask.secretSubmit"
      :skip-label="content.ask.skip"
      @submit="store.respondSecret"
      @skip="store.respondSecret('')"
    />
    <HermesValuePrompt
      :open="Boolean(store.vaultUnlockRequest)"
      :request-key="store.vaultUnlockRequest?.requestId ?? ''"
      :deadline="store.vaultUnlockRequest?.deadline ?? null"
      :title="vaultUnlockTitle"
      :description="vaultUnlockBody"
      :placeholder="content.ask.vaultUnlockPlaceholder"
      :submit-label="content.ask.vaultUnlockSubmit"
      :skip-label="content.ask.keepLocked"
      @submit="store.respondVaultUnlock"
      @skip="store.respondVaultUnlock('')"
    />
    <HermesVaultSaveLoginPrompt
      :open="Boolean(store.vaultSaveLoginRequest)"
      :request-key="store.vaultSaveLoginRequest?.requestId ?? ''"
      :deadline="store.vaultSaveLoginRequest?.deadline ?? null"
      :title="vaultSaveTitle"
      :description="vaultSaveBody"
      :identifier-label="content.ask.identifierLabel"
      :identifier-placeholder="content.ask.identifierPlaceholder"
      :password-label="content.ask.passwordLabel"
      :submit-label="content.ask.vaultSaveSubmit"
      :decline-label="content.ask.declineSave"
      @save="store.respondVaultSaveLogin"
      @decline="store.respondVaultSaveLogin('', '')"
    />
    <HermesValuePrompt
      :open="Boolean(store.vaultCodeRequest)"
      :request-key="store.vaultCodeRequest?.requestId ?? ''"
      :deadline="store.vaultCodeRequest?.deadline ?? null"
      :title="vaultCodeTitle"
      :description="store.vaultCodeRequest?.hint || content.ask.vaultCodeBody"
      :masked="false"
      input-mode="numeric"
      autocomplete="one-time-code"
      :placeholder="content.ask.vaultCodePlaceholder"
      :submit-label="content.ask.vaultCodeSubmit"
      :skip-label="content.ask.skip"
      sanitize="code"
      @submit="store.respondVaultCode"
      @skip="store.respondVaultCode('')"
    />

    <OnModal
      :open="installOpen"
      :title="content.install.title"
      :description="content.install.body"
      size="md"
      role="dialog"
      @close="closeInstall"
    >
      <div class="flex flex-col gap-12px">
        <div
          class="flex items-center gap-8px rounded-small border border-solid border-line-subtle bg-surface-inset px-12px py-10px text-11.5px text-ink-secondary"
        >
          <OnIcon name="lucide:hard-drive" :size="14" />
          {{ content.install.size }}
        </div>
        <div v-if="store.installing" class="flex flex-col gap-7px">
          <div class="h-6px overflow-hidden rounded-full bg-surface-inset">
            <div
              class="h-full rounded-full bg-brand-coral transition-[width] duration-300"
              :style="{ width: (store.installProgress?.percent ?? 0) + '%' }"
            ></div>
          </div>
          <span class="text-11px text-ink-tertiary"
            >{{ content.install.installing }} · {{ store.installProgress?.percent ?? 0 }}%</span
          >
        </div>
        <p v-else-if="store.runtime?.message" class="m-0 break-words text-11px leading-[1.5] text-ink-tertiary">
          {{ store.runtime.message }}
        </p>
      </div>
      <template #footer>
        <OnButton variant="ghost" :disabled="store.installing" @click="closeInstall">{{
          content.install.later
        }}</OnButton>
        <OnButton v-if="store.installing" variant="ghost" @click="store.cancelInstall">{{
          content.install.cancelInstall
        }}</OnButton>
        <OnButton v-else variant="accent" icon="lucide:download" @click="installRuntime">
          {{ content.install.install }}
        </OnButton>
      </template>
    </OnModal>
  </div>
</template>

<style>
#hermes-composer[data-empty]::before {
  content: attr(data-placeholder);
  color: inherit;
  opacity: 0.45;
  pointer-events: none;
}

.hermes-ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 0 5px;
  border-radius: 5px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  font-size: 0.92em;
  line-height: 1.45;
  vertical-align: baseline;
  white-space: nowrap;
  user-select: none;
}

.hermes-ref-chip-icon {
  width: 12px;
  height: 12px;
  flex: none;
}
</style>
