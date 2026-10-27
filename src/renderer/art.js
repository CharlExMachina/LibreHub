// Product images. assets/headset.png, assets/mouse.webp and assets/camera.webp are the full-size sources; the app loads
// the 640 px and 160 px WebP sizes. `lit: false` shows the device desaturated for offline states;
// `glow` adds the soft accent backlight.
function productArt(kind, id, { glow = true, lit = true, small = false } = {}) {
  const src = `assets/${kind}-${small ? 160 : 640}.webp`;
  return `<div class="product-art ${kind}-art${glow ? ' glow' : ''}${lit ? '' : ' offline'}" data-art="${id}">
    <img src="${src}" alt="" draggable="false" decoding="async" />
  </div>`;
}

/** The A50 X. */
export const headsetArt = (id, opts) => productArt('headset', id, opts);
/** The G502 X PLUS. */
export const mouseArt = (id, opts) => productArt('mouse', id, opts);
/** The MX Brio (G Hub's own picture of it, from its depot). */
export const cameraArt = (id, opts) => productArt('camera', id, opts);
