<script lang="ts">
  import type { BrushKind } from '../core/brush';

  let { brush }: { brush: BrushKind } = $props();

  // Each icon sketches the brush's effect on a surface profile.
  const paths: Record<BrushKind, string> = {
    sculpt: 'M3 17 C8 17 8 9 12 9 C16 9 16 17 21 17',
    smooth: 'M3 13 q2 -4 4 0 t4 0 M13 13 H21',
    grab: 'M3 18 C9 18 10 9 16 6 M16 6 h-4.5 M16 6 v4.5',
    pinch: 'M3 12 H9.5 M7 9 L10 12 L7 15 M21 12 H14.5 M17 9 L14 12 L17 15',
    flatten: 'M3 17 C5 17 6 11 8 11 H16 C18 11 19 17 21 17',
    crease: 'M3 9 H8 L12 17 L16 9 H21',
    inflate: 'M12 8 a4 4 0 1 0 0.01 0 M12 5 V2 M12 19 V22 M5 12 H2 M19 12 H22',
    scrape: 'M3 16 H6 L8 11 H13 L15 16 H21 M5 8 H16',
    knife: 'M3 9 H10.5 L12 20 L13.5 9 H21',
    wax: 'M3 18 H21 M5 14.5 H19 M8 11 H16',
  };
</script>

<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
  <path
    d={paths[brush]}
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>
