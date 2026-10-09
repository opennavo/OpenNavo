<script setup lang="ts">
// Browser mode (dev:web) lacks native traffic lights; draw them at the same position for consistent screenshots (08 §9.1: left 18, top 22).
</script>

<template>
  <div class="pointer-events-none absolute left-20px top-16px flex gap-8px" aria-hidden="true">
    <span class="h-12px w-12px rounded-full bg-macos-close"></span>
    <span class="h-12px w-12px rounded-full bg-macos-minimize"></span>
    <span class="h-12px w-12px rounded-full bg-macos-zoom"></span>
  </div>
</template>
