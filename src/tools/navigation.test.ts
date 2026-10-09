import { describe, expect, it } from 'vitest';
import { MUDBOX_NAV } from './navigation';

const mods = { altKey: true, shiftKey: false, ctrlKey: false, metaKey: false };

describe('Mudbox navigation', () => {
  it('maps Alt + mouse buttons to orbit, pan and dolly', () => {
    expect(MUDBOX_NAV.match({ ...mods, button: 0 })).toBe('orbit');
    expect(MUDBOX_NAV.match({ ...mods, button: 1 })).toBe('pan');
    expect(MUDBOX_NAV.match({ ...mods, button: 2 })).toBe('dolly');
  });

  it('pans and dollies with the left button alone, for mice without MMB/RMB', () => {
    expect(MUDBOX_NAV.match({ ...mods, shiftKey: true, button: 0 })).toBe('pan');
    expect(MUDBOX_NAV.match({ ...mods, ctrlKey: true, button: 0 })).toBe('dolly');
  });

  it('leaves the mouse to the tool without Alt', () => {
    expect(MUDBOX_NAV.match({ ...mods, altKey: false, button: 0 })).toBeNull();
    expect(MUDBOX_NAV.match({ ...mods, altKey: false, shiftKey: true, button: 0 })).toBeNull();
  });
});
