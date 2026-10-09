<script lang="ts">
  import { FALLOFF_ORDER, FALLOFFS, type FalloffKind } from '../core/falloff';

  let { value, onchange }: { value: FalloffKind; onchange: (f: FalloffKind) => void } = $props();

  const W = 36,
    H = 18;

  /** Brush cross-section: the curve mirrored about the center, sampled from the preset itself. */
  function profile(kind: FalloffKind): string {
    const fn = FALLOFFS[kind].fn;
    const steps = 48;
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * W;
      const t = Math.abs((2 * i) / steps - 1);
      const y = H - 1 - fn(t) * (H - 3);
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d;
  }

  const paths = Object.fromEntries(FALLOFF_ORDER.map((k) => [k, profile(k)])) as Record<
    FalloffKind,
    string
  >;
</script>

<div class="falloffs" role="radiogroup" aria-label="Falloff">
  {#each FALLOFF_ORDER as f (f)}
    <button
      role="radio"
      aria-checked={value === f}
      class:active={value === f}
      title={FALLOFFS[f].label}
      onclick={() => onchange(f)}
    >
      <svg viewBox="0 0 {W} {H}" width={W} height={H} aria-hidden="true">
        <path d={paths[f]} fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </button>
  {/each}
</div>

<style>
  .falloffs {
    display: flex;
    gap: 4px;
  }
  button {
    flex: 1;
    display: flex;
    justify-content: center;
    padding: 4px 0;
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
</style>
