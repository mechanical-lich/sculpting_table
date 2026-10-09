<script lang="ts">
  export type StartChoice = 'sphere' | 'armature';

  let { onchoose }: { onchoose: (choice: StartChoice) => void } = $props();

  let first: HTMLButtonElement;
  $effect(() => first.focus());
</script>

<div class="backdrop">
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="start-title">
    <h1 id="start-title">Start sculpting</h1>
    <div class="choices">
      <button bind:this={first} class="choice" onclick={() => onchoose('sphere')}>
        <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
          <circle cx="24" cy="24" r="17" />
          <ellipse cx="24" cy="24" rx="17" ry="6" opacity="0.45" />
        </svg>
        <span class="name">Sphere</span>
        <span class="desc">Start from a ball of clay and sculpt straight away.</span>
      </button>
      <button class="choice" onclick={() => onchoose('armature')}>
        <svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true">
          <circle cx="24" cy="15" r="6" />
          <circle cx="24" cy="31" r="8" />
          <circle cx="11" cy="24" r="3.5" />
          <circle cx="37" cy="24" r="3.5" />
          <path d="M24 21 V23 M14.5 24 H17 M31 24 H33.5" />
        </svg>
        <span class="name">Armature</span>
        <span class="desc">Build a figure from spheres, then turn it into a mesh.</span>
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(10, 11, 13, 0.6);
    z-index: 10;
  }
  .dialog {
    width: min(520px, 100%);
    padding: 24px;
    background: var(--chrome);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  }
  h1 {
    margin: 0 0 16px;
    font-size: 16px;
    font-weight: 600;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .choice {
    display: grid;
    justify-items: center;
    gap: 6px;
    padding: 18px 14px;
    font: inherit;
    color: var(--text);
    text-align: center;
    background: var(--button);
    border: 1px solid var(--line);
    border-radius: 6px;
    cursor: pointer;
  }
  .choice:hover,
  .choice:focus-visible {
    background: var(--button-hover);
    border-color: var(--accent);
    outline: none;
  }
  svg {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.6;
  }
  .name {
    font-size: 14px;
    font-weight: 600;
  }
  .desc {
    color: var(--muted);
  }
</style>
