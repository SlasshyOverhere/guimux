// Where a fixed-position menu goes for a click at (x, y).
//
// The app zooms by setting `zoom` on <html>, which scales a fixed element's
// left/top but not clientX/clientY or innerWidth. Measured offsets (click at
// x=200, style left 200px): zoom 1 -> 200px, 1.25 -> 250, 1.5 -> 300, 2 -> 400,
// 0.5 -> 100. So the click has to be converted into the zoomed space, and the
// clamp has to be applied there too: a menu at `left` occupies `left * zoom`
// through `(left + w) * zoom`, which must fit inside the unzoomed viewport.
export function menuPos(
  x: number,
  y: number,
  menu: { w: number; h: number },
  view: { zoom: number; w: number; h: number },
): { left: number; top: number } {
  const zoom = view.zoom > 0 ? view.zoom : 1;
  // Math.max(0, ...) keeps the leading edge usable when the menu is bigger
  // than the viewport.
  const fit = (want: number, span: number, size: number) =>
    Math.max(0, Math.min(want / zoom, span / zoom - size));
  return { left: fit(x, view.w, menu.w), top: fit(y, view.h, menu.h) };
}
