<script setup lang="ts">
import { OnCard, OnHighlightText, OnInstallCommand, OnKeyValueList } from '../../../src';
import StoryRow from '../StoryRow.vue';
import StorySection from '../StorySection.vue';

const details = [
  { key: 'token', label: 'Token', value: 'visual-studio-code', mono: true },
  { key: 'homepage', label: 'Homepage', value: 'code.visualstudio.com', href: 'https://code.visualstudio.com/' },
  { key: 'binary', label: 'Included command', value: 'code', mono: true },
  { key: 'auto', label: 'Automatic updates', value: 'Built in (auto_updates)' },
  { key: 'zap', label: 'On uninstall', value: 'Quit the app and remove the ShipIt background task' }
];
</script>

<template>
  <StorySection
    title="OnInstallCommand / OnKeyValueList / OnHighlightText"
    spec="08 §8.18、§8.19、§8.34"
    description="Detail-page sidebar information; long commands wrap and indent after --cask."
  >
    <StoryRow label="Detail sidebar">
      <div class="flex w-340px flex-col gap-12px">
        <OnCard>
          <OnInstallCommand
            command="brew install --cask visual-studio-code"
            title="Installation command · the command OpenNavo executes"
          />
        </OnCard>
        <OnCard padding="md">
          <OnKeyValueList :items="details" />
        </OnCard>
      </div>
      <div class="w-340px">
        <OnCard><OnInstallCommand command="brew install --formula uv" /></OnCard>
      </div>
    </StoryRow>
    <StoryRow label="Highlighted text">
      <OnHighlightText
        as="p"
        class="m-0 max-w-640px text-15px leading-[1.65] text-ink-secondary"
        text="A **free, open-source code editor** from Microsoft with Git, a debugger, a terminal, and a rich extension ecosystem. Installation **links the code command to /opt/homebrew/bin** so projects can be opened from the terminal."
      />
    </StoryRow>
  </StorySection>
</template>
