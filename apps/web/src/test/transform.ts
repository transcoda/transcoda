/**
 * The translate and scale of an inline CSS `transform`, as numbers. jsdom's serialisation changes
 * between versions (31 drops a zero second translate value and adds a space after the comma), so
 * tests compare these numbers instead of the string.
 */
export function transformOf(el: HTMLElement): { x: number; y: number; scale: number } {
  const t = el.style.transform;
  const translate = /translate\(\s*(-?[\d.]+)px\s*(?:,\s*(-?[\d.]+)px\s*)?\)/.exec(t);
  const scale = /scale\(\s*(-?[\d.]+)\s*\)/.exec(t);
  return {
    x: translate ? Number(translate[1]) : 0,
    y: translate?.[2] ? Number(translate[2]) : 0,
    scale: scale ? Number(scale[1]) : 1,
  };
}
