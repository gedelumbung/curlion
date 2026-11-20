// v-top-layer: show an element in the browser's top layer (Popover API) so it paints
// above everything else on the page, regardless of z-index or compositing layers.
// The element needs the `top-layer` class (see style.css), which also gives a
// z-index fallback for browsers without popover support.
export const vTopLayer = {
  mounted(el) {
    el.setAttribute('popover', 'manual')
    try {
      el.showPopover?.()
    } catch {
      // unsupported or already open: the CSS fallback still applies
    }
  },
}
