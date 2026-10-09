<script lang="ts">
  import type { StampEntry, StampRotation, StampSettings } from '../tools/stamps';
  import ImageGrid from './ImageGrid.svelte';

  let {
    entries,
    value,
    onselect,
    onrotation,
    onspacing,
    onload,
  }: {
    entries: readonly StampEntry[];
    value: StampSettings;
    onselect: (id: string | null) => void;
    onrotation: (r: StampRotation) => void;
    onspacing: (s: number) => void;
    onload: (label: string, stamp: StampEntry['stamp']) => void;
  } = $props();

  const rotations: { id: StampRotation; label: string; hint: string }[] = [
    { id: 'stroke', label: 'Stroke', hint: 'Turn with the stroke direction' },
    { id: 'random', label: 'Random', hint: 'A random angle per dab' },
    { id: 'fixed', label: 'Fixed', hint: 'Upright on screen' },
  ];
</script>

<ImageGrid label="Stamp" {entries} value={value.id} {onselect} {onload} />

{#if value.id !== null}
  <div class="segmented" role="radiogroup" aria-label="Stamp rotation">
    {#each rotations as r (r.id)}
      <button
        role="radio"
        aria-checked={value.rotation === r.id}
        class:active={value.rotation === r.id}
        title={r.hint}
        onclick={() => onrotation(r.id)}>{r.label}</button
      >
    {/each}
  </div>
  <label class="spacing">
    <span>Spacing</span>
    <input
      type="range"
      min="5"
      max="150"
      value={Math.round(value.spacing * 100)}
      oninput={(e) => onspacing(+e.currentTarget.value / 100)}
    />
    <output>{Math.round(value.spacing * 100)}%</output>
  </label>
{/if}

<style>
  button {
    font: inherit;
    color: var(--muted);
    background: var(--button);
    border: 1px solid var(--line);
    border-radius: 4px;
    cursor: pointer;
  }
  button:hover {
    background: var(--button-hover);
  }
  button.active {
    color: var(--text);
    background: var(--accent-bg);
    border-color: var(--accent);
  }

  .segmented {
    display: flex;
    gap: 4px;
    margin-bottom: 10px;
  }
  .segmented button {
    flex: 1;
    padding: 3px 0;
  }
  .spacing {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
  }
  .spacing input {
    grid-column: 1;
    width: 100%;
    accent-color: var(--accent);
  }
  .spacing output {
    grid-column: 2;
    min-width: 40px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
