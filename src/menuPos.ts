// Where a fixed-position menu goes for a click at (x, y).
//
// The app zooms by setting `zoom` on <html>, which scales a fixed element's
// left/top but not clientX/clientY or innerWidth. Measured with the cursor at
// x=200 and style left 200px, the element renders at 200px on zoom 1, 250px on
// 1.25, 300px on 1.5, 400px on 2, and 100px on 0.5. So the click has to be
// converted into the zoomed space, and the clamp applied there too: a menu at
// `left` occupies `left * zoom` through `(left + w) * zoom`, and that must fit
// inside the unzoomed viewport.
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
