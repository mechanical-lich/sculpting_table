<script lang="ts">
  import type { Stamp } from '../core/stamp';
  import type { StampEntry } from '../tools/stamps';
  import { loadStampImage, stampThumbnail } from './stampImages';

  /** Picks one image from the library (or none), and loads new ones. */
  let {
    label,
    entries,
    value,
    onselect,
    onload,
  }: {
    label: string;
    entries: readonly StampEntry[];
    value: string | null;
    onselect: (id: string | null) => void;
    onload: (label: string, image: Stamp) => void;
  } = $props();

  let fileInput: HTMLInputElement;
  let error = $state('');

  async function load(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    error = '';
    try {
      onload(file.name.replace(/\.[^.]+$/, ''), await loadStampImage(file));
    } catch {
      error = `Couldn't read ${file.name} as an image.`;
    }
  }
</script>

<div class="grid" role="radiogroup" aria-label={label}>
  <button
    role="radio"
    aria-checked={value === null}
    class:active={value === null}
    title="None"
    onclick={() => onselect(null)}
  >
    <span class="none">None</span>
  </button>
  {#each entries as entry (entry.id)}
    <button
      role="radio"
      aria-checked={value === entry.id}
      class:active={value === entry.id}
      title={entry.label}
      onclick={() => onselect(entry.id)}
    >
      <img src={stampThumbnail(entry.stamp)} alt="" />
    </button>
  {/each}
  <button class="add" title="Load an image (PNG, JPG)" onclick={() => fileInput.click()}>+</button>
  <input bind:this={fileInput} type="file" accept="image/*" hidden onchange={load} />
</div>
{#if error}<p class="error">{error}</p>{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
    margin-bottom: 8px;
  }
  button {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    padding: 2px;
    color: var(--muted);
    background: var(--button);
    border: 1px solid var(--line);
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
  }
  button:hover {
    background: var(--button-hover);
  }
  button.active {
    color: var(--text);
    background: var(--accent-bg);
    border-color: var(--accent);
  }
  img {
    width: 100%;
    height: 100%;
    border-radius: 2px;
  }
  .none {
    font-size: 10px;
  }
  .add {
    font-size: 16px;
  }
  .error {
    color: #e88;
    margin: 0 0 8px;
  }
</style>
