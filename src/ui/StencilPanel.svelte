<script lang="ts">
  import type { Stamp } from '../core/stamp';
  import type { StencilSettings } from '../tools/sculptTool';
  import type { StampEntry } from '../tools/stamps';
  import ImageGrid from './ImageGrid.svelte';

  let {
    entries,
    value,
    keyLabel,
    onselect,
    onload,
    onopacity,
    ontile,
    onreset,
  }: {
    entries: readonly StampEntry[];
    value: StencilSettings;
    keyLabel: string;
    onselect: (id: string | null) => void;
    onload: (label: string, image: Stamp) => void;
    onopacity: (o: number) => void;
    ontile: (t: boolean) => void;
    onreset: () => void;
  } = $props();
</script>

<ImageGrid label="Stencil" {entries} value={value.id} {onselect} {onload} />

{#if value.id !== null}
  <label class="row">
    <span>Opacity</span>
    <input
      type="range"
      min="0"
      max="100"
      value={Math.round(value.opacity * 100)}
      oninput={(e) => onopacity(+e.currentTarget.value / 100)}
    />
    <output>{Math.round(value.opacity * 100)}</output>
  </label>
  <div class="inline">
    <label class="check">
      <input
        type="checkbox"
        checked={value.tile}
        onchange={(e) => ontile(e.currentTarget.checked)}
      />
      <span>Tile</span>
    </label>
    <button onclick={onreset}>Reset</button>
  </div>
  <p class="hint">
    Hold <kbd>{keyLabel}</kbd>: left-drag rotates, middle-drag moves, right-drag scales.
  </p>
{/if}

<style>
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    margin-bottom: 8px;
  }
  .row input {
    grid-column: 1;
    width: 100%;
    accent-color: var(--accent);
  }
  .row output {
    grid-column: 2;
    min-width: 40px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .inline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  button {
    font: inherit;
    color: var(--text);
    background: var(--button);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 3px 10px;
    cursor: pointer;
  }
  button:hover {
    background: var(--button-hover);
  }
  .hint {
    margin: 0;
    color: var(--muted);
  }
  kbd {
    font: inherit;
    font-size: 10px;
    padding: 0 4px;
    border: 1px solid var(--line);
    border-radius: 3px;
  }
</style>
