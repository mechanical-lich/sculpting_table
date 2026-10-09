<script lang="ts">
  import type { AppController, Stats, ArmatureStatus } from '../app/controller';
  import type { DocumentMode, LevelInfo } from '../app/document';
  import {
    ARMATURE_TOOL_ORDER,
    ARMATURE_TOOLS,
    type ArmatureSettings,
    type ArmatureToolKind,
  } from '../tools/armatureTool';
  import ArmaturePanel from './ArmaturePanel.svelte';
  import { BRUSH_ORDER, BRUSHES, type BrushKind } from '../core/brush';
  import type { ToolSettings } from '../tools/sculptTool';
  import { RADIUS_MAX_PX, RADIUS_MIN_PX } from '../tools/sculptTool';
  import { FALLOFFS } from '../core/falloff';
  import BrushIcon from './BrushIcon.svelte';
  import FalloffPicker from './FalloffPicker.svelte';
  import StampPicker from './StampPicker.svelte';
  import StencilPanel from './StencilPanel.svelte';
  import type { StampEntry } from '../tools/stamps';
  import { hotkeyLabel, IS_MAC, keyLabel, STENCIL_KEY } from './hotkeys';

  let { controller }: { controller: AppController } = $props();

  // The UI mirrors tool state from events; it never owns it.
  let tool = $derived(controller.tool);
  let settings = $state<ToolSettings | null>(null);
  let history = $state({ canUndo: false, canRedo: false });
  let stats = $state<Stats | null>(null);
  let level = $state<LevelInfo | null>(null);
  let stampEntries = $state<readonly StampEntry[]>([]);
  let activeBrush = $derived<BrushKind>(settings?.brush ?? 'sculpt');
  let mode = $state<DocumentMode>('sculpt');
  let armatureSettings = $state<ArmatureSettings | null>(null);
  let armatureState = $state<ArmatureStatus | null>(null);
  let nodeCount = $state(1);

  $effect(() => {
    settings = {
      ...tool.settings,
      strength: { ...tool.settings.strength },
      falloff: { ...tool.settings.falloff },
      stamp: Object.fromEntries(
        Object.entries(tool.settings.stamp).map(([k, v]) => [k, { ...v }]),
      ) as ToolSettings['stamp'],
      stencil: { ...tool.settings.stencil },
    };
    level = controller.document.levelInfo();
    stampEntries = [...tool.stamps.entries];
    mode = controller.document.mode;
    armatureSettings = { ...controller.armature.settings };
    armatureState = controller.armatureStatus;
    nodeCount = controller.document.tree.count;
    const unsubs = [
      controller.document.events.on('mode', (m) => (mode = m)),
      controller.document.events.on('edited', () => (nodeCount = controller.document.tree.count)),
      controller.armature.events.on('edited', () => (nodeCount = controller.document.tree.count)),
      controller.armature.events.on('settings', (z) => (armatureSettings = z)),
      controller.events.on('armatureState', (z) => (armatureState = z)),
      tool.events.on('stamps', (e) => (stampEntries = [...e])),
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
  const altShift = IS_MAC ? '⌥⇧' : 'Alt+Shift';
  const altCtrl = IS_MAC ? '⌥⌃' : 'Alt+Ctrl';

  // Each icon sketches what the tool does to a sphere.
  const armatureToolIcons: Record<ArmatureToolKind, string> = {
    draw: 'M9 15 a5 5 0 1 0 0.01 0 M13 9 L18 4 M15 4 H18 V7',
    move: 'M12 3 V21 M3 12 H21 M12 3 l-2.5 2.5 M12 3 l2.5 2.5 M21 12 l-2.5 -2.5 M21 12 l-2.5 2.5',
    scale:
      'M12 12 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M4 20 L8.5 15.5 M20 4 L15.5 8.5 M4 20 h4 M4 20 v-4 M20 4 h-4 M20 4 v4',
    rotate: 'M19 12 A7 7 0 1 1 12 5 M12 5 l3 -2 M12 5 l3 2',
    delete: 'M12 12 m-6 0 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0 M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5',
  };

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
  {#if mode === 'armature'}
    <button class="primary" disabled={armatureState?.making} onclick={() => controller.makeMesh()}
      >{armatureState?.making ? 'Making mesh…' : 'Make mesh'}</button
    >
  {:else}
    <button onclick={() => controller.backToArmature()} title="Back to the armature (undoable)"
      >Armature</button
    >
  {/if}
  {#if level && mode === 'sculpt'}
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
    {#if mode === 'armature'}{nodeCount}
      {nodeCount === 1 ? 'sphere' : 'spheres'}{:else if level}{formatCount(level.triangles)} tris{/if}
    {#if stats}· {stats.fps} fps · {stats.frameMs.toFixed(1)} ms{/if}
  </span>
</div>

{#if mode === 'armature' && armatureSettings && armatureState && settings}
  <aside class="panel">
    <ArmaturePanel
      settings={armatureSettings}
      status={armatureState}
      symmetryX={settings.symmetryX}
      {nodeCount}
      previewKey={hotkeyLabel('preview')}
      deleteKey={IS_MAC ? hotkeyLabel('deleteNodeAlt') : hotkeyLabel('deleteNode')}
      onsymmetry={(on) => tool.setSymmetryX(on)}
      onpreview={(on) => controller.armature.setPreview(on)}
      onblend={(v) => controller.armature.setBlend(v)}
      onresolution={(v) => controller.armature.setResolution(v)}
      onmake={() => controller.makeMesh()}
    />
  </aside>
  <nav class="tray" aria-label="Armature tools">
    {#each ARMATURE_TOOL_ORDER as z (z)}
      <button
        class:active={armatureSettings.tool === z}
        onclick={() => controller.armature.setTool(z)}
        title={ARMATURE_TOOLS[z].hint}
        aria-pressed={armatureSettings.tool === z}
      >
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            d={armatureToolIcons[z]}
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {ARMATURE_TOOLS[z].label}
      </button>
    {/each}
  </nav>
{:else if settings}
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

    {#if activeBrush !== 'grab'}
      <div class="field">
        <span>Stamp</span>
        <StampPicker
          entries={stampEntries}
          value={settings.stamp[activeBrush]}
          onselect={(id) => tool.setStamp(activeBrush, id)}
          onrotation={(r) => tool.setStampRotation(activeBrush, r)}
          onspacing={(v) => tool.setStampSpacing(activeBrush, v)}
          onload={(label, stamp) => tool.addStamp(label, stamp)}
        />
      </div>
    {/if}

    <label class="check">
      <input
        type="checkbox"
        checked={settings.symmetryX}
        onchange={(e) => tool.setSymmetryX(e.currentTarget.checked)}
      />
      <span>X symmetry <kbd>{hotkeyLabel('symmetry')}</kbd></span>
    </label>

    <h2>Mask</h2>
    <div class="mask-actions">
      <button
        onclick={() => controller.maskCommand('invert')}
        title="Swap masked and unmasked areas">Invert</button
      >
      <button onclick={() => controller.maskCommand('clear')} title="Unmask everything"
        >Clear</button
      >
      <button onclick={() => controller.maskCommand('all')} title="Mask everything">All</button>
    </div>
    <p class="hint">
      {#if activeBrush === 'mask'}{ctrl} + drag erases the mask, {shift} + drag softens its edges.
      {:else}Paint with the Mask brush to protect areas; Invert to sculpt only inside them.{/if}
    </p>

    <h2>Stencil</h2>
    <StencilPanel
      entries={stampEntries}
      value={settings.stencil}
      keyLabel={keyLabel(STENCIL_KEY)}
      onselect={(id) => tool.setStencil(id)}
      onload={(label, image) => tool.setStencil(tool.addStamp(label, image, false).id)}
      onopacity={(o) => tool.setStencilOpacity(o)}
      ontile={(t) => tool.setStencilTile(t)}
      onreset={() => tool.resetStencilPlacement()}
    />

    <h2>Controls</h2>
    <dl>
      <dt>{alt} + LMB</dt>
      <dd>Orbit</dd>
      <dt>{alt} + MMB, {altShift} + LMB</dt>
      <dd>Pan</dd>
      <dt>{alt} + RMB, {altCtrl} + LMB</dt>
      <dd>Zoom</dd>
      <dt>Wheel / pinch</dt>
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
  .mask-actions {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }
  .mask-actions button {
    flex: 1;
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
  button.primary {
    font-weight: 600;
    color: #1e1f22;
    background: var(--accent);
    border-color: var(--accent);
  }
  button.primary:hover:not(:disabled) {
    background: #ecc865;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
