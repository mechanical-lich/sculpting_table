<script lang="ts">
  import type { ArmatureStatus } from '../app/controller';
  import { ARMATURE_TOOLS, type ArmatureSettings } from '../tools/armatureTool';

  let {
    settings,
    status,
    symmetryX,
    nodeCount,
    previewKey,
    deleteKey,
    onsymmetry,
    onpreview,
    onblend,
    onresolution,
    onmake,
  }: {
    settings: ArmatureSettings;
    status: ArmatureStatus;
    symmetryX: boolean;
    nodeCount: number;
    previewKey: string;
    deleteKey: string;
    onsymmetry: (on: boolean) => void;
    onpreview: (on: boolean) => void;
    onblend: (v: number) => void;
    onresolution: (v: number) => void;
    onmake: () => void;
  } = $props();
</script>

<h2>{ARMATURE_TOOLS[settings.tool].label}</h2>
<p class="hint">{ARMATURE_TOOLS[settings.tool].hint}</p>

<label class="check">
  <input
    type="checkbox"
    checked={symmetryX}
    onchange={(e) => onsymmetry(e.currentTarget.checked)}
  />
  <span>X symmetry</span>
</label>
<label class="check">
  <input
    type="checkbox"
    checked={settings.preview}
    onchange={(e) => onpreview(e.currentTarget.checked)}
  />
  <span>Preview skin <kbd>{previewKey}</kbd></span>
</label>

<h2>Skin</h2>
<label class="row">
  <span>Joint softness</span>
  <input
    type="range"
    min="0"
    max="100"
    value={Math.round(settings.blend * 100)}
    oninput={(e) => onblend(+e.currentTarget.value / 100)}
  />
  <output>{Math.round(settings.blend * 100)}</output>
</label>
<label class="row">
  <span>Mesh resolution</span>
  <input
    type="range"
    min="48"
    max="256"
    step="8"
    value={settings.resolution}
    oninput={(e) => onresolution(+e.currentTarget.value)}
  />
  <output>{settings.resolution}</output>
</label>

<button class="make" disabled={status.making} onclick={onmake}>
  {status.making ? 'Making mesh…' : 'Make mesh'}
</button>

{#if status.error}
  <p class="error">{status.error}</p>
{:else if status.thinNodes > 0}
  <p class="warn">
    {status.thinNodes}
    {status.thinNodes === 1 ? 'sphere is' : 'spheres are'} thinner than the preview grid; raise Mesh resolution
    if they look broken.
  </p>
{/if}
<p class="muted">
  {nodeCount}
  {nodeCount === 1 ? 'sphere' : 'spheres'}{#if settings.preview && status.previewMs !== null}
    · preview {Math.round(status.previewMs)} ms{/if}
</p>
<p class="hint">
  Hover a sphere and press <kbd>{deleteKey}</kbd> to delete it. Shift with Move or Scale affects the whole
  branch.
</p>

<style>
  h2 {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 4px 0 12px;
  }
  h2:not(:first-child) {
    margin-top: 24px;
  }
  .hint,
  .muted {
    color: var(--muted);
    margin: -6px 0 14px;
  }
  .muted {
    margin: 8px 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    margin-bottom: 14px;
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
  .make {
    width: 100%;
    font: inherit;
    font-weight: 600;
    color: #1e1f22;
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 6px 10px;
    cursor: pointer;
  }
  .make:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .error {
    color: #e88;
  }
  .warn {
    color: #e0b84a;
  }
  kbd {
    font: inherit;
    font-size: 10px;
    padding: 0 4px;
    margin-left: 4px;
    border: 1px solid var(--line);
    border-radius: 3px;
    color: var(--muted);
  }
</style>
