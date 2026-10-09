<script lang="ts">
  import type { AppController, Stats } from '../app/controller';
  import type { LevelInfo } from '../app/document';
  import { BRUSH_ORDER, BRUSHES, type BrushKind } from '../core/brush';
  import type { ToolSettings } from '../tools/sculptTool';
  import { RADIUS_MAX_PX, RADIUS_MIN_PX } from '../tools/sculptTool';
  import { FALLOFFS } from '../core/falloff';
  import BrushIcon from './BrushIcon.svelte';
  import FalloffPicker from './FalloffPicker.svelte';
  import { hotkeyLabel, IS_MAC } from './hotkeys';

  let { controller }: { controller: AppController } = $props();

  // The UI mirrors tool state from events; it never owns it.
  let tool = $derived(controller.tool);
  let settings = $state<ToolSettings | null>(null);
  let history = $state({ canUndo: false, canRedo: false });
  let stats = $state<Stats | null>(null);
  let level = $state<LevelInfo | null>(null);
  let activeBrush = $derived<BrushKind>(settings?.brush ?? 'sculpt');

  $effect(() => {
    settings = {
      ...tool.settings,
      strength: { ...tool.settings.strength },
      falloff: { ...tool.settings.falloff },
    };
    level = controller.document.levelInfo();
    const unsubs = [
      tool.events.on('settings', (s) => (settings = s)),
      controller.document.events.on('history', (h) => (history = h)),
      controller.document.events.on('level', (l) => (level = l)),
      controller.events.on('stats', (s) => (stats = s)),
    ];
    return () => unsubs.forEach((u) => u());
  });

  const ctrl = IS_MAC ? '⌃' : 'Ctrl';
  const alt = IS_MAC ? '⌥' : 'Alt';
  const shift = IS_MAC ? '⇧' : 'Shift';

  function formatCount(n: number): string {
    return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`;
  }
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
  {#if level}
    <div class="group level" aria-label="Subdivision level">
      <button
        disabled={level.level === 0}
        onclick={() => controller.run('levelDown')}
        title="Lower level ({hotkeyLabel('levelDown')})">−</button
      >
      <span class="level-label">Level {level.level} / {level.top}</span>
      <button
        disabled={level.level === level.top}
        onclick={() => controller.run('levelUp')}
        title="Higher level ({hotkeyLabel('levelUp')})">+</button
      >
      <button
        disabled={level.nextTriangles === null}
        onclick={() => controller.run('addLevel')}
        title={level.nextTriangles === null
          ? 'Another level would exceed the 5M triangle budget'
          : `Add a level: ${(level.nextTriangles / 1e6).toFixed(1)}M triangles (${hotkeyLabel('addLevel')})`}
        >Subdivide</button
      >
    </div>
  {/if}
  <span class="stats">
    {#if level}{formatCount(level.triangles)} tris{/if}
    {#if stats}· {stats.fps} fps · {stats.frameMs.toFixed(1)} ms{/if}
  </span>
</div>

{#if settings}
  <aside class="panel">
    <h2>{BRUSHES[activeBrush].label} Properties</h2>
    <p class="hint">{BRUSHES[activeBrush].hint}</p>

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

    {#if activeBrush !== 'grab'}
      <label>
        <span>Strength</span>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.round(settings.strength[activeBrush] * 100)}
          oninput={(e) => tool.setStrength(activeBrush, +e.currentTarget.value / 100)}
        />
        <output>{Math.round(settings.strength[activeBrush] * 100)}</output>
      </label>
    {/if}

    <div class="field">
      <span>Falloff <span class="muted">{FALLOFFS[settings.falloff[activeBrush]].label}</span></span
      >
      <FalloffPicker
        value={settings.falloff[activeBrush]}
        onchange={(f) => tool.setFalloff(activeBrush, f)}
      />
    </div>

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
      <dt>{hotkeyLabel('levelUp')} / {hotkeyLabel('levelDown')}</dt>
      <dd>Change level</dd>
      <dt>{hotkeyLabel('addLevel')}</dt>
      <dd>Subdivide</dd>
    </dl>
  </aside>

  <nav class="tray" aria-label="Sculpt tools">
    {#each BRUSH_ORDER as b (b)}
      <button
        class:active={settings.brush === b}
        onclick={() => tool.setBrush(b)}
        title={BRUSHES[b].hint}
        aria-pressed={settings.brush === b}
      >
        <BrushIcon brush={b} />
        {BRUSHES[b].label}
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
    white-space: nowrap;
  }
  .group {
    display: flex;
    gap: 4px;
  }
  .level {
    align-items: center;
  }
  .level-label {
    min-width: 76px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .stats {
    margin-left: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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

  .field {
    display: grid;
    gap: 6px;
    margin-bottom: 14px;
  }
  .muted {
    color: var(--muted);
    margin-left: 4px;
  }
  .hint {
    margin: -6px 0 14px;
    color: var(--muted);
  }

  /* Centered in the viewport (the area left of the 240px panel). */
  .tray {
    position: absolute;
    left: calc((100% - 240px) / 2);
    bottom: 12px;
    transform: translateX(-50%);
    width: max-content;
    max-width: calc(100% - 240px - 24px);
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px;
    padding: 4px;
    background: var(--chrome);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .tray button {
    flex: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    width: 56px;
    padding: 5px 2px;
    font-size: 11px;
    color: var(--muted);
  }
  .tray button.active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--text);
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
