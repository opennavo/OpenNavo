<script lang="ts">
import { computed, defineComponent, h } from 'vue';
import { OnIcon } from '@opennavo/ui';
import { parseRefText, refChipLabel } from '@/hermes/composerRich';

function iconName(kind: string) {
  if (kind === 'url') return 'lucide:globe';
  if (kind === 'folder') return 'lucide:folder';
  return 'lucide:file';
}

/**
 * A sent user message's prose with its stored references painted as chips. A render function,
 * not a template: whitespace between template elements becomes text nodes, and a space added
 * beside a chip would change what the reader sees compared with what the user sent.
 */
export default defineComponent({
  name: 'HermesUserText',
  props: { text: { type: String, required: true } },
  setup(props) {
    const parts = computed(() => parseRefText(props.text));

    return () =>
      h(
        'div',
        { class: 'whitespace-pre-wrap' },
        parts.value.map(part =>
          part.type === 'text'
            ? h('span', part.text)
            : h('span', { class: 'hermes-ref-chip', title: part.value }, [
                h(OnIcon, { name: iconName(part.kind), size: 11, class: 'hermes-ref-chip-icon' }),
                refChipLabel(part.kind, part.value)
              ])
        )
      );
  }
});
</script>
