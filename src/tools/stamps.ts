import { BUILTIN_STAMPS, type BuiltinStampId, type Stamp } from '../core/stamp';

export interface StampEntry {
  id: string;
  label: string;
  stamp: Stamp;
  builtin: boolean;
}

/** How a stamp is oriented on each dab. */
export type StampRotation = 'stroke' | 'random' | 'fixed';

export interface StampSettings {
  /** Stamp id from the library, or null for no stamp. */
  id: string | null;
  rotation: StampRotation;
  /** Dab spacing as a fraction of the radius while this stamp is in use. */
  spacing: number;
}

/** The stamps available to brushes: built-ins plus images the user loaded. */
export class StampLibrary {
  private readonly items: StampEntry[] = [];
  private nextId = 1;

  constructor() {
    for (const id of Object.keys(BUILTIN_STAMPS) as BuiltinStampId[]) {
      this.items.push({
        id,
        label: BUILTIN_STAMPS[id].label,
        stamp: BUILTIN_STAMPS[id].make(),
        builtin: true,
      });
    }
  }

  get entries(): readonly StampEntry[] {
    return this.items;
  }

  get(id: string | null): StampEntry | null {
    if (id === null) return null;
    return this.items.find((e) => e.id === id) ?? null;
  }

  add(label: string, stamp: Stamp): StampEntry {
    const entry = { id: `user-${this.nextId++}`, label, stamp, builtin: false };
    this.items.push(entry);
    return entry;
  }
}
