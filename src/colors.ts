// AutoCAD Color Index (ACI) colours as 24-bit RGB.

const BASIC = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
const GRAYS = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];
const LEVELS = [1, 0.8, 0.6, 0.5, 0.3];

function hsv(h: number, s: number, v: number): number {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const c = (x: number) => Math.floor(x * 255 + 1e-9);
  return (c(f(5)) << 16) | (c(f(3)) << 8) | c(f(1));
}

/** The 256 ACI colours. 1 to 9 are the standard colours; 10 to 249 run through 24 hues, each at
 * five brightness levels, full and half saturated; 250 to 255 are greys. */
export const ACI: readonly number[] = Array.from({ length: 256 }, (_, i) => {
  if (i < 10) return BASIC[i]!;
  if (i >= 250) return GRAYS[i - 250]!;
  const hue = (Math.floor(i / 10) - 1) * 15;
  const j = i % 10;
  return hsv(hue, j % 2 ? 0.5 : 1, LEVELS[Math.floor(j / 2)]!);
});

/** The RGB colour of an ACI index. Colour 7 is black on a light background and white on a dark one. */
export function aciToRgb(index: number, background: 'light' | 'dark' = 'light'): number {
  const i = Math.abs(Math.round(index));
  if (i === 7) return background === 'dark' ? 0xffffff : 0x000000;
  return ACI[i] ?? 0xffffff;
}
