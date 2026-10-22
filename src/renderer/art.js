// The A50 X product image (assets/headset.png is the full-size source; the app loads the WebP sizes).
// `lit: false` shows it desaturated for offline states; `glow` adds the soft accent backlight.
export function headsetArt(id, { glow = true, lit = true, small = false } = {}) {
  const src = small ? 'assets/headset-160.webp' : 'assets/headset-640.webp';
  return `<div class="headset-art${glow ? ' glow' : ''}${lit ? '' : ' offline'}" data-art="${id}">
    <img src="${src}" alt="" draggable="false" decoding="async" />
  </div>`;
}
