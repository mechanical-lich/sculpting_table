/**
 * Hotkeys bind on `KeyboardEvent.code` (layout-independent physical keys) and
 * display with the layout's `key` via the Keyboard Map API when available.
 *
 * Never bind Cmd/Ctrl + W, T, N, Q, R, or digits: browsers reserve them.
 */

export interface Hotkey {
  id: string;
  code: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  primary?: boolean;
  shift?: boolean;
  description: string;
}

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const RESERVED_WITH_PRIMARY = new Set(['KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyR']);

export const HOTKEYS = [
  { id: 'undo', code: 'KeyZ', primary: true, description: 'Undo' },
  { id: 'redo', code: 'KeyZ', primary: true, shift: true, description: 'Redo' },
  { id: 'redoAlt', code: 'KeyY', primary: true, description: 'Redo' },
  { id: 'radiusDown', code: 'BracketLeft', description: 'Smaller brush' },
  { id: 'radiusUp', code: 'BracketRight', description: 'Larger brush' },
  { id: 'frame', code: 'KeyF', description: 'Frame model' },
  { id: 'symmetry', code: 'KeyX', description: 'Toggle X symmetry' },
] as const satisfies readonly Hotkey[];

export type HotkeyId = (typeof HOTKEYS)[number]['id'];

for (const h of HOTKEYS as readonly Hotkey[]) {
  if (h.primary && (RESERVED_WITH_PRIMARY.has(h.code) || h.code.startsWith('Digit'))) {
    throw new Error(`Hotkey ${h.id} uses a browser-reserved shortcut`);
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  // Range sliders are fine to bind over; text inputs are not.
  return (
    target instanceof HTMLInputElement && target.type !== 'range' && target.type !== 'checkbox'
  );
}

export function matchHotkey(e: KeyboardEvent): HotkeyId | null {
  if (e.repeat && !e.code.startsWith('Bracket')) return null;
  if (isEditable(e.target)) return null;
  const primary = IS_MAC ? e.metaKey : e.ctrlKey;
  const otherMod = IS_MAC ? e.ctrlKey : e.metaKey;
  if (otherMod || e.altKey) return null;
  for (const h of HOTKEYS as readonly Hotkey[]) {
    if (h.code === e.code && !!h.primary === primary && !!h.shift === e.shiftKey) {
      return h.id as HotkeyId;
    }
  }
  return null;
}

// --- display ----------------------------------------------------------------

let layout: Map<string, string> | null = null;

/** Loads the keyboard layout map so labels follow the user's layout. */
export async function loadKeyboardLayout(): Promise<void> {
  const kb = (
    navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }
  ).keyboard;
  if (!kb?.getLayoutMap) return;
  try {
    layout = await kb.getLayoutMap();
  } catch {
    // Not available in this context (e.g. iframe); fall back to code names.
  }
}

/** Refines the display label from a real keydown, which reports the layout's key. */
export function learnKey(e: KeyboardEvent): void {
  if (e.key.length === 1 && !e.altKey && !e.shiftKey) {
    layout ??= new Map();
    layout.set(e.code, e.key.toLowerCase());
  }
}

function codeLabel(code: string): string {
  const fromLayout = layout?.get(code);
  if (fromLayout) return fromLayout.toUpperCase();
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  return code;
}

export function hotkeyLabel(id: HotkeyId): string {
  const h = (HOTKEYS as readonly Hotkey[]).find((k) => k.id === id);
  if (!h) return '';
  const parts: string[] = [];
  if (h.primary) parts.push(IS_MAC ? '⌘' : 'Ctrl');
  if (h.shift) parts.push(IS_MAC ? '⇧' : 'Shift');
  parts.push(codeLabel(h.code));
  return parts.join(IS_MAC ? '' : '+');
}
