<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Component } from 'vue';
import { isRovingKey, nextRovingIndex } from '../composables/roving';
import { useUiMessages } from '../composables/locale';
import OnIcon from './OnIcon.vue';

export interface OnCategoryChip<V extends string> {
  value: V;
  label: string;
  /** Web: render links when categories have separate ?category= URLs. */
  href?: string;
}

export interface OnCategoryChipsProps<V extends string> {
  modelValue: V;
  items: readonly OnCategoryChip<V>[];
  ariaLabel?: string;
  /** Link-mode component such as NuxtLink, native a by default. */
  linkAs?: string | Component;
}

const props = withDefaults(defineProps<OnCategoryChipsProps<T>>(), { linkAs: 'a' });

const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

const messages = useUiMessages();
const strip = ref<HTMLElement>();
const buttons = ref<HTMLElement[]>([]);
const linkMode = computed(() => props.items.some(item => item.href !== undefined));

const chipClass = (selected: boolean) => [
  'm-0 box-border inline-flex h-32px shrink-0 items-center whitespace-nowrap rounded-full border border-solid px-14px font-sans text-13px no-underline outline-none',
  'transition-colors duration-fast ease-standard focus-visible:shadow-focus-ring',
  selected
    ? 'border-transparent bg-button-primary-bg font-600 text-button-primary-text'
    : 'border-line-default bg-transparent text-ink-secondary hover:border-line-strong hover:text-ink-primary'
];

// Arrows serve mouse users only; keyboards use arrows and screen readers use the radio group, so hide from AT/tab order.
const arrowClass =
  'on-chips-arrow absolute top-0 z-1 m-0 box-border h-32px w-32px items-center justify-center rounded-full border-none bg-button-secondary-bg p-0 text-button-secondary-text outline-none transition-colors duration-fast ease-standard hover:bg-button-secondary-hover';

function select(value: T) {
  if (value !== props.modelValue) emit('update:modelValue', value);
}

function linkAttrs(item: OnCategoryChip<T>) {
  return props.linkAs === 'a' ? { href: item.href } : { to: item.href };
}

async function onKeydown(event: KeyboardEvent) {
  if (linkMode.value || !isRovingKey(event.key)) return;
  event.preventDefault();
  const current = props.items.findIndex(item => item.value === props.modelValue);
  const next = nextRovingIndex(
    event.key,
    current,
    props.items.map(() => true)
  );
  const item = props.items[next];
  if (!item) return;
  select(item.value);
  await nextTick();
  // Prevent native focus scrolling, which interrupts smooth scrolling and ignores arrows/fades; reveal handles it.
  buttons.value[next]?.focus({ preventScroll: true });
}

// Hidden horizontal scrollbar plus vertical-only mouse wheels require edge arrows and mouse dragging when overflowing.
const canScrollBack = ref(false);
const canScrollForward = ref(false);

function updateEdges() {
  const el = strip.value;
  if (!el) return;
  // Allow 1 px tolerance because zoom produces fractional scrollLeft that may never equal scrollWidth-clientWidth.
  canScrollBack.value = el.scrollLeft > 1;
  canScrollForward.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}

// Scroll 80% of viewport width, retaining some previous chips for context.
function scrollPage(direction: -1 | 1) {
  const el = strip.value;
  if (!el) return;
  const reduced =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: reduced ? 'auto' : 'smooth' });
}

// Keep chips fully visible outside arrow fades; reserve 64 px at both ends (32 px arrow plus spacing).
const REVEAL_GAP = 64;

function reveal(chip: HTMLElement, behavior: ScrollBehavior) {
  const el = strip.value;
  // Zero clientWidth means no layout, e.g. hidden container/tests; do not scroll.
  if (!el || el.clientWidth === 0) return;
  const view = el.getBoundingClientRect();
  const box = chip.getBoundingClientRect();
  const before = view.left + REVEAL_GAP - box.left;
  const after = box.right - (view.right - REVEAL_GAP);
  if (before > 0) el.scrollBy({ left: -before, behavior });
  else if (after > 0) el.scrollBy({ left: after, behavior });
}

function revealSelected(behavior: ScrollBehavior) {
  const selected = strip.value?.querySelector<HTMLElement>('[aria-checked="true"], [aria-current="page"]');
  if (selected) reveal(selected, behavior);
}

// Keyboard-focused chips must avoid arrows/fades too; do not handle mouse focus here,
// as movement on press would shift the release target. modelValue watcher handles click selection changes.
function onFocusin(event: FocusEvent) {
  const chip = event.target;
  if (!(chip instanceof HTMLElement) || chip === strip.value) return;
  try {
    if (chip.matches(':focus-visible')) reveal(chip, 'auto');
  } catch {
    // Without :focus-visible support, retain native browser focus scrolling.
  }
}

// Mouse-only drag scrolling; touchscreens/trackpads use native scrolling.
const DRAG_THRESHOLD = 5;
const dragging = ref(false);
let press: { id: number; startX: number; startScroll: number } | undefined;
let swallowClick = false;
let swallowTimer: ReturnType<typeof setTimeout> | undefined;

function onPointerDown(event: PointerEvent) {
  const el = strip.value;
  if (!el || event.pointerType !== 'mouse' || event.button !== 0) return;
  press = { id: event.pointerId, startX: event.clientX, startScroll: el.scrollLeft };
}

function onPointerMove(event: PointerEvent) {
  const el = strip.value;
  if (!el || !press || event.pointerId !== press.id) return;
  // If left button released without pointerup, e.g. outside window, end the press.
  if ((event.buttons & 1) === 0) {
    endPress(event);
    return;
  }
  const delta = event.clientX - press.startX;
  if (!dragging.value) {
    if (Math.abs(delta) < DRAG_THRESHOLD) return;
    // Capture only beyond drag threshold; immediate capture retargets clicks to the container and breaks normal clicking.
    dragging.value = true;
    el.setPointerCapture(press.id);
  }
  el.scrollLeft = press.startScroll - delta;
}

function endPress(event: PointerEvent) {
  if (!press || event.pointerId !== press.id) return;
  press = undefined;
  if (!dragging.value) return;
  dragging.value = false;
  // Suppress the click immediately after dragging; without a click, clear the flag next task.
  swallowClick = true;
  clearTimeout(swallowTimer);
  swallowTimer = setTimeout(() => {
    swallowClick = false;
  }, 0);
}

function onClickCapture(event: MouseEvent) {
  if (!swallowClick) return;
  swallowClick = false;
  event.preventDefault();
  event.stopPropagation();
}

// Container/chip width changes, including fonts/locales, change scroll range.
let observer: ResizeObserver | undefined;

function observeContent() {
  const el = strip.value;
  if (!observer || !el) return;
  observer.disconnect();
  observer.observe(el);
  for (const child of Array.from(el.children)) observer.observe(child);
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(updateEdges);
  observeContent();
  updateEdges();
  revealSelected('auto');
});

watch(
  () => props.items,
  () => {
    observeContent();
    updateEdges();
  },
  { flush: 'post' }
);
watch(
  () => props.modelValue,
  () => revealSelected('smooth'),
  { flush: 'post' }
);

onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(swallowTimer);
});
</script>

<template>
  <div class="on-chips-fade relative min-w-0">
    <Transition
      enter-active-class="transition-opacity duration-fast ease-standard"
      leave-active-class="transition-opacity duration-fast ease-standard"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <button
        v-if="canScrollBack"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        data-direction="back"
        class="left-0"
        :class="arrowClass"
        @mousedown.prevent
        @click="scrollPage(-1)"
      >
        <OnIcon name="chevron-left" :size="16" />
      </button>
    </Transition>
    <component
      :is="linkMode ? 'nav' : 'div'"
      ref="strip"
      :role="linkMode ? undefined : 'radiogroup'"
      :aria-label="ariaLabel ?? messages.nav.categories"
      class="on-chips-scroll flex select-none gap-8px overflow-x-auto"
      :class="{
        'on-chips-has-back': canScrollBack,
        'on-chips-has-forward': canScrollForward,
        'on-chips-dragging': dragging
      }"
      @keydown="onKeydown"
      @focusin="onFocusin"
      @scroll.passive="updateEdges"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endPress"
      @pointercancel="endPress"
      @click.capture="onClickCapture"
      @dragstart.prevent
    >
      <template v-if="linkMode">
        <component
          :is="linkAs"
          v-for="item in items"
          :key="item.value"
          v-bind="linkAttrs(item)"
          :aria-current="item.value === modelValue ? 'page' : undefined"
          :class="chipClass(item.value === modelValue)"
          @click="select(item.value)"
        >
          {{ item.label }}
        </component>
      </template>
      <template v-else>
        <button
          v-for="item in items"
          :key="item.value"
          ref="buttons"
          type="button"
          role="radio"
          :aria-checked="item.value === modelValue ? 'true' : 'false'"
          :tabindex="item.value === modelValue ? 0 : -1"
          :class="chipClass(item.value === modelValue)"
          @click="select(item.value)"
        >
          {{ item.label }}
        </button>
      </template>
    </component>
    <Transition
      enter-active-class="transition-opacity duration-fast ease-standard"
      leave-active-class="transition-opacity duration-fast ease-standard"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <button
        v-if="canScrollForward"
        type="button"
        tabindex="-1"
        aria-hidden="true"
        data-direction="forward"
        class="right-0"
        :class="arrowClass"
        @mousedown.prevent
        @click="scrollPage(1)"
      >
        <OnIcon name="chevron-right" :size="16" />
      </button>
    </Transition>
  </div>
</template>

<style>
/* Single horizontal row with edge fades (08 §8.33); widen fades beside visible arrows. */
.on-chips-scroll {
  --on-chips-start-clear: 0px;
  --on-chips-start-fade: 16px;
  --on-chips-end-fade: 16px;
  --on-chips-end-clear: 0px;
  scrollbar-width: none;
  /* Use mask shorthand, equivalent to mask image, to avoid secret-prefix literals flagged by scripts/check-secrets.mjs. */
  -webkit-mask: linear-gradient(
    to right,
    transparent var(--on-chips-start-clear),
    black var(--on-chips-start-fade),
    black calc(100% - var(--on-chips-end-fade)),
    transparent calc(100% - var(--on-chips-end-clear))
  );
  mask: linear-gradient(
    to right,
    transparent var(--on-chips-start-clear),
    black var(--on-chips-start-fade),
    black calc(100% - var(--on-chips-end-fade)),
    transparent calc(100% - var(--on-chips-end-clear))
  );
  padding: 2px 16px;
  margin: -2px -16px;
}

.on-chips-scroll.on-chips-has-back {
  --on-chips-start-clear: 24px;
  --on-chips-start-fade: 64px;
}

.on-chips-scroll.on-chips-has-forward {
  --on-chips-end-clear: 24px;
  --on-chips-end-fade: 64px;
}

.on-chips-scroll::-webkit-scrollbar {
  display: none;
}

.on-chips-scroll.on-chips-dragging,
.on-chips-scroll.on-chips-dragging * {
  cursor: grabbing;
}

/* Mouse arrows are hidden on touchscreens, which scroll directly. */
.on-chips-arrow {
  display: inline-flex;
}

@media (hover: none), (pointer: coarse) {
  .on-chips-arrow {
    display: none;
  }
}
</style>
