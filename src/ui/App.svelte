<script lang="ts">
  import type { AppController, Stats } from '../app/controller';
  import type { BrushKind } from '../core/brush';
  import type { ToolSettings } from '../tools/sculptTool';
  import { RADIUS_MAX_PX, RADIUS_MIN_PX } from '../tools/sculptTool';
  import { hotkeyLabel, IS_MAC } from './hotkeys';

  let { controller }: { controller: AppController } = $props();

  // The UI mirrors tool state from events; it never owns it.
  let tool = $derived(controller.tool);
  let settings = $state<ToolSettings | null>(null);
  let history = $state({ canUndo: false, canRedo: false });
  let stats = $state<Stats | null>(null);
  let activeBrush = $derived<BrushKind>(settings?.brush ?? 'sculpt');

  $effect(() => {
    settings = { ...tool.settings, strength: { ...tool.settings.strength } };
    const unsubs = [
      tool.events.on('settings', (s) => (settings = s)),
      tool.events.on('history', (h) => (history = h)),
      controller.events.on('stats', (s) => (stats = s)),
    ];
    return () => unsubs.forEach((u) => u());
  });

  const brushes: { id: BrushKind; label: string; hint: string }[] = [
    { id: 'sculpt', label: 'Sculpt', hint: 'Push along the surface normal' },
    { id: 'smooth', label: 'Smooth', hint: 'Average out surface detail' },
  ];

  const ctrl = IS_MAC ? '⌃' : 'Ctrl';
  const alt = IS_MAC ? '⌥' : 'Alt';
  const shift = IS_MAC ? '⇧' : 'Shift';
</script>

<div class="topbar">
  <span class="title">Sculpting Table</span>
  <div class="group">
    <button
      disabled={!history.canUndo}
      onclick={() => controller.run('undo')}
      title="Undo ({hotkeyLabel('undo')})"
    >
      Undo
    </button>
    <button
      disabled={!history.canRedo}
      onclick={() => controller.run('redo')}
      title="Redo ({hotkeyLabel('redo')})"
    >
      Redo
    </button>
    <button onclick={() => controller.run('frame')} title="Frame ({hotkeyLabel('frame')})"
      >Frame</button
    >
  </div>
  <span class="stats">
    {#if stats}
      {(stats.triangles / 1000).toFixed(0)}k tris · {stats.fps} fps · {stats.frameMs.toFixed(1)} ms
    {/if}
  </span>
</div>

{#if settings}
  <aside class="panel">
    <h2>{brushes.find((b) => b.id === activeBrush)?.label} Properties</h2>

    <label>
      <span>Size <kbd>{hotkeyLabel('radiusDown')}</kbd><kbd>{hotkeyLabel('radiusUp')}</kbd></span>
      <input
        type="range"
        min={RADIUS_MIN_PX}
        max={RADIUS_MAX_PX}
        value={settings.radiusPx}
        oninput={(e) => tool.setRadius(+e.currentTarget.value)}
      />
      <output>{settings.radiusPx}px</output>
    </label>

    <label>
      <span>Strength</span>
      <input
        type="range"
        min="0"
        max="100"
        value={Math.round(settings.strength[settings.brush] * 100)}
        oninput={(e) => tool.setStrength(activeBrush, +e.currentTarget.value / 100)}
      />
      <output>{Math.round(settings.strength[settings.brush] * 100)}</output>
    </label>

    <label class="check">
      <input
        type="checkbox"
        checked={settings.symmetryX}
        onchange={(e) => tool.setSymmetryX(e.currentTarget.checked)}
      />
      <span>X symmetry <kbd>{hotkeyLabel('symmetry')}</kbd></span>
    </label>

    <h2>Controls</h2>
    <dl>
      <dt>{alt} + LMB</dt>
      <dd>Orbit</dd>
      <dt>{alt} + MMB</dt>
      <dd>Pan</dd>
      <dt>{alt} + RMB / wheel</dt>
      <dd>Zoom</dd>
      <dt>{shift} + drag</dt>
      <dd>Smooth</dd>
      <dt>{ctrl} + drag</dt>
      <dd>Invert</dd>
      <dt>{hotkeyLabel('frame')}</dt>
      <dd>Frame model</dd>
    </dl>
  </aside>

  <nav class="tray" aria-label="Sculpt tools">
    {#each brushes as b (b.id)}
      <button
        class:active={settings.brush === b.id}
        onclick={() => tool.setBrush(b.id)}
        title={b.hint}
      >
        <span class="icon icon-{b.id}"></span>
        {b.label}
      </button>
    {/each}
  </nav>
{/if}

<style>
  .topbar {
    position: absolute;
    inset: 0 0 auto 0;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 12px;
    background: var(--chrome);
    border-bottom: 1px solid var(--line);
  }
  .title {
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .group {
    display: flex;
    gap: 4px;
  }
  .stats {
    margin-left: auto;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .panel {
    position: absolute;
    top: 36px;
    right: 0;
    bottom: 0;
    width: 240px;
    padding: 12px;
    background: var(--chrome);
    border-left: 1px solid var(--line);
    overflow-y: auto;
  }
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
  label {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 8px;
    margin-bottom: 14px;
  }
  label input[type='range'] {
    grid-column: 1;
    width: 100%;
    accent-color: var(--accent);
  }
  label output {
    grid-column: 2;
    min-width: 40px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 8px;
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
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 12px;
    margin: 0;
    color: var(--muted);
  }
  dt {
    color: var(--text);
  }
  dd {
    margin: 0;
  }

  .tray {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(calc(-50% - 120px));
    display: flex;
    gap: 4px;
    padding: 4px;
    background: var(--chrome);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .tray button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 64px;
    padding: 6px 4px;
  }
  .tray button.active {
    background: var(--accent-bg);
    border-color: var(--accent);
  }
  .icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
  }
  .icon-sculpt {
    background: radial-gradient(circle at 35% 30%, #ddd, #777 60%, #444);
  }
  .icon-smooth {
    background: radial-gradient(circle at 50% 50%, #aaa, #888 70%, #555);
    box-shadow: inset 0 0 0 2px #6a6;
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
  button:hover:not(:disabled) {
    background: var(--button-hover);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
