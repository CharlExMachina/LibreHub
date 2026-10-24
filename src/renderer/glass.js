// Liquid glass, refracted by Chromium's compositor rather than in JavaScript.
//
// Libraries such as liquidGL and liquidglass rasterise the page into a WebGL texture, because a web page
// can't read the pixels behind an element, and then run a render loop to keep that texture current.
// Electron is Chromium, and Chromium can do the reading itself: `backdrop-filter` accepts an SVG filter,
// and an feDisplacementMap in it bends whatever the compositor has already drawn behind the element,
// on the GPU. Scrolling content, the live meters and CSS animations all refract as they move, and when
// nothing on screen changes, no frame is drawn and the glass costs nothing.
//
// The optics are liquidglass's (github.com/ybouane/liquidglass), so the same settings give the same look:
// a quarter-circle bevel that bends light where it enters and where it leaves, a slight magnification
// toward the middle, colour fringing at the rim, and its Fresnel, specular and edge lighting.
//
// Each glass element gets its own filter. Its displacement map is put together from nine pieces: four
// corners, four edges stretched along their length, and a flat middle. The pieces depend on the corner
// radius and the bevel only, so a resize just moves them (a few attribute writes) and never redraws a map.
// They're kept small on purpose: on every frame that redraws the glass, Chromium copies each feImage's
// pixels again (once for every pass that reads the map), so a full-size map made scrolling several times more
// expensive. The map is smooth, so it's drawn at half the CSS resolution and stretched.
//
// Light doesn't bend, so the lighting isn't in the filter: it's a border-image (the same nine pieces, done
// by CSS) of white light, which the compositor paints once and keeps.
//
// startGlass() takes the selector of the glass elements; the look is set in their CSS, with liquidglass's
// names and defaults:
//   --glass-refraction  how much the bevel bends the backdrop (liquidglass: refraction, 0.69). 0 = no filter at
//                       all, only the lighting, which costs nothing per frame: for things that should look like
//                       glass without bending (cards, dialogs)
//   --glass-bevel       depth of the curved rim, in px (zRadius, 40)
//   --glass-dome        1 = a dome that magnifies the whole element, 0 = a pill with a bevelled rim (bevelMode, 0)
//   --glass-magnify     0 = without the slight magnification toward the middle, which costs a pass (1)
//   --glass-aberration  colour fringing at the rim (chromAberration, 0.05). Three samples instead of one; and
//                       glass inside glass must leave it at 0 (its backdrop has transparency, where they don't add up)
//   --glass-fresnel     light reflected at grazing angles, toward the rim (fresnel, 1)
//   --glass-edge        the bright stroke and glow along the edge (edgeHighlight, 0.05)
//   --glass-specular    highlights from four lights (specular, 0)
//   --glass-smooth      a blur after the bending, in px (0.6): Chromium samples the bent backdrop by the
//                       nearest pixel where WebGL blends four, and this evens out the grain that leaves where the
//                       rim squeezes the backdrop. A pass of its own; 0 leaves it out
//   --glass-press       extra bending while the element (or the button it's in) is held, as a fraction (0)
// The element's own CSS does the rest: blur, saturation and brightness go in its `backdrop-filter`, in front
// of `var(--glass-filter, )` (liquidglass brightens the glass by 6%: `brightness(1.06)`), and tint, shadow and
// border radius are its background, box-shadow and border-radius. It needs a border style (any width, even 0)
// for the lighting to show.
//
// Two rules of CSS to design around: glass inside glass bends only what its glass parent painted before it,
// not what's behind the parent; and an ancestor with opacity below 1 (or a filter or mask) turns the bending
// off for everything inside it, so fade glass with its own opacity, not a wrapper's.

const NS = 'http://www.w3.org/2000/svg';
const IOR = 1.5;
// The lighting image's middle, which border-image stretches: tall enough for the edge stroke to fade
// smoothly from the top of the element to its bottom.
const MID = 32;
// Pixels per CSS px of the displacement map's pieces (see above), and of the magnification ramp's side.
const MAP_SCALE = 0.5;
const RAMP = 16;

let defs;
let nextId = 0;
const lenses = new Map();
const cache = new Map();

/** Turn the elements matching `selector` into glass, now and as pages render. */
export function startGlass(selector, root = document.body) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  defs = document.createElementNS(NS, 'defs');
  svg.append(defs);
  document.body.append(svg);

  const sizes = new ResizeObserver((entries) => {
    for (const e of entries) {
      const box = e.borderBoxSize?.[0];
      lenses.get(e.target)?.resize(box ? box.inlineSize : e.contentRect.width, box ? box.blockSize : e.contentRect.height);
    }
  });
  const add = (node) => {
    if (node.nodeType !== 1) return;
    const found = node.matches(selector) ? [node, ...node.querySelectorAll(selector)] : node.querySelectorAll(selector);
    for (const el of found) {
      if (lenses.has(el)) continue;
      lenses.set(el, createLens(el));
      sizes.observe(el, { box: 'border-box' });
    }
  };
  new MutationObserver((records) => {
    let removed = false;
    for (const r of records) {
      for (const n of r.addedNodes) add(n);
      removed ||= r.removedNodes.length > 0;
    }
    if (!removed) return;
    for (const [el, lens] of lenses) {
      if (el.isConnected) continue;
      sizes.unobserve(el);
      lens.dispose();
      lenses.delete(el);
    }
  }).observe(root, { childList: true, subtree: true });
  add(root);
}

function readOptions(el) {
  const css = getComputedStyle(el);
  const num = (name, fallback) => {
    const v = parseFloat(css.getPropertyValue(name));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    refraction: num('--glass-refraction', 0.69),
    bevel: Math.max(num('--glass-bevel', 40), 1),
    dome: num('--glass-dome', 0) > 0,
    magnify: num('--glass-magnify', 1) > 0,
    aberration: num('--glass-aberration', 0.05),
    fresnel: num('--glass-fresnel', 1),
    edge: num('--glass-edge', 0.05),
    specular: num('--glass-specular', 0),
    smooth: num('--glass-smooth', 0.6),
    press: num('--glass-press', 0),
  };
}

function createLens(el) {
  const id = `glass-${++nextId}`;
  const opts = readOptions(el);
  const bends = opts.refraction > 0;

  // [magnification:] a ramp image stretched over the element shifts every sample toward the middle.
  // Then the bevel: the pieces over a neutral flood make the map, and the backdrop is sampled through it.
  const filter = svgEl('filter', { id, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB', x: 0, y: 0 });
  const pieces = PIECES.map((name) => svgEl('feImage', { preserveAspectRatio: 'none', result: name }));
  const ramp = svgEl('feImage', { preserveAspectRatio: 'none', x: 0, y: 0, result: 'ramp' });
  const zoom = svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'ramp', xChannelSelector: 'R', yChannelSelector: 'G', result: 'zoomed' });
  const source = opts.magnify ? 'zoomed' : 'SourceGraphic';
  if (opts.magnify) filter.append(ramp, zoom);
  // A neutral flood under the pieces keeps the map opaque at their edges: where a piece ends on a fraction
  // of a pixel, a half-transparent map pixel would read as a big shift and draw a seam.
  filter.append(...pieces, svgEl('feFlood', { 'flood-color': 'rgb(128,128,128)', result: 'flat' }),
    svgEl('feMerge', { result: 'map' }, svgEl('feMergeNode', { in: 'flat' }), ...PIECES.map((name) => svgEl('feMergeNode', { in: name }))));
  const shifts = [];
  const shift = (result, spread) => {
    const node = svgEl('feDisplacementMap', { in: source, in2: 'map', xChannelSelector: 'R', yChannelSelector: 'G', result });
    node.spread = spread;
    shifts.push(node);
    return node;
  };
  if (opts.aberration > 0) {
    // Real glass bends blue further than red: each channel is sampled with its own strength, then added up.
    const isolate = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'];
    ['r', 'g', 'b'].forEach((ch, k) => filter.append(shift(`${ch}0`, 1 + (k - 1) * opts.aberration * ABERRATION),
      svgEl('feColorMatrix', { in: `${ch}0`, type: 'matrix', values: isolate[k], result: ch })));
    filter.append(svgEl('feComposite', { in: 'r', in2: 'g', operator: 'arithmetic', k2: 1, k3: 1, result: 'rg' }),
      svgEl('feComposite', { in: 'rg', in2: 'b', operator: 'arithmetic', k2: 1, k3: 1, result: 'bent' }));
  } else {
    filter.append(shift('bent', 1));
  }
  // Inside the filter, so its edge is the element's (duplicated, not blurred into what's around it).
  if (opts.smooth > 0) filter.append(svgEl('feGaussianBlur', { in: 'bent', stdDeviation: opts.smooth, edgeMode: 'duplicate' }));
  if (bends) {
    defs.append(filter);
    el.style.setProperty('--glass-filter', `url(#${id})`);
  }

  // The strengths, in px: the bevel's largest shift and the magnification's at the edge, along x and y.
  let held = 1, rimPx = 0, zoomPx = 0;
  const setStrength = (k) => {
    held = k;
    // feDisplacementMap shifts by scale × (channel − ½), and the maps use the whole channel range.
    for (const s of shifts) s.setAttribute('scale', String(2 * rimPx * s.spread * k));
    zoom.setAttribute('scale', String(2 * zoomPx * k));
  };

  let key = '';
  const lens = {
    resize(w, h) {
      if (!w || !h) return;
      const half = Math.min(w, h) / 2;
      const radius = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, half);
      const bevel = Math.min(opts.bevel, half);
      const c = Math.max(radius, bevel);
      // liquidglass's magnification: by refraction × 4 px at the edge of a pill; a dome's grows with its size.
      const [kx, ky] = !opts.magnify || !bends ? [0, 0]
        : opts.dome ? [(w / 2) * opts.refraction * 0.35, (h / 2) * opts.refraction * 0.35]
          : [opts.refraction * 4, opts.refraction * 4];
      const k = [radius, bevel, kx, ky, half].map((v) => Math.round(v * 4)).join(':');
      if (k !== key) {
        key = k;
        const t = tiles({ radius, bevel, kx, ky, half }, opts);
        if (bends) {
          pieces.forEach((p, i) => p.setAttribute('href', t.pieces[i]));
          ramp.setAttribute('href', t.ramp);
        }
        rimPx = t.rimPx;
        zoomPx = Math.max(kx, ky);
        setStrength(held);
        el.style.borderImage = t.light ? `url(${t.light}) ${t.slice} fill / ${t.lightWidth}px` : '';
      }
      if (!bends) return;
      setAttrs(filter, { width: w, height: h });
      setAttrs(ramp, { width: w, height: h });
      // tl, t, tr, r, br, b, bl, l
      const boxes = [[0, 0, c, c], [c, 0, w - 2 * c, c], [w - c, 0, c, c], [w - c, c, c, h - 2 * c],
        [w - c, h - c, c, c], [c, h - c, w - 2 * c, c], [0, h - c, c, c], [0, c, c, h - 2 * c]];
      pieces.forEach((p, i) => {
        const [x, y, bw, bh] = boxes[i];
        setAttrs(p, { x, y, width: Math.max(bw, 0), height: Math.max(bh, 0) });
      });
    },
    dispose() {
      filter.remove();
      presser.removeEventListener('pointerdown', down);
      el.style.removeProperty('border-image');
      el.style.removeProperty('--glass-filter');
    },
  };

  // Held, the glass bulges: a short tween of its strength, only while it moves.
  let raf = 0;
  const tween = (to) => {
    cancelAnimationFrame(raf);
    const from = held, t0 = performance.now(), ms = 180;
    const step = (now) => {
      const p = Math.min((now - t0) / ms, 1);
      setStrength(from + (to - from) * (1 - (1 - p) ** 3));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  const down = (e) => {
    if (e.button !== 0) return;
    tween(1 + opts.press);
    const up = () => { tween(1); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };
  // A knob or lens doesn't take the pointer itself; the control around it does.
  const presser = el.closest('button, label') ?? el;
  if (opts.press > 0 && bends) presser.addEventListener('pointerdown', down);
  return lens;
}

// ------------------------------------------------------------------ the optics (liquidglass's shader, in px)

const PIECES = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
// liquidglass fringes by chromAberration × 18 × 2 px at the rim, where the bevel shifts by about 43 px
// (at its defaults): as a share of the bevel's shift, that's about 1.7 per unit of aberration.
const ABERRATION = 1.7;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// The height of the bevel at `d` px in from the edge: a quarter circle of radius zR, flat beyond it.
const height = (d, zR) => (d <= 0 ? 0 : d >= zR ? zR : Math.sqrt(d * (2 * zR - d)));
// Its slope, taken over ±2 px as the shader does (which keeps it finite at the edge).
const slope = (d, zR) => (height(d + 2, zR) - height(d - 2, zR)) / 4;
const unit = (x, y, z) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Its four lights, for Blinn-Phong highlights seen from straight above (y points down, as on screen).
const V = [0, 0, 1];
const half = (l) => unit(l[0] + V[0], l[1] + V[1], l[2] + V[2]);
const H1 = half(unit(0.4, 0.7, 1)), H2 = half(unit(-0.3, -0.5, 1)), L3 = unit(0.1, 0.3, 1), H4 = half(unit(0, 0.9, 0.4));

/**
 * For a corner radius, a bevel (both px, clamped to the element), the magnification at the edge along x and y
 * (px) and the element's shorter half (px): the eight pieces of the displacement map as image URLs (PIECES
 * order), the magnification ramp, the light for border-image with its slice (in image pixels), and the
 * bevel's largest shift (px), which the map's full range stands for.
 */
function tiles({ radius, bevel, kx, ky, half: shortHalf }, o) {
  const key = JSON.stringify([radius, bevel, kx, ky, shortHalf, o]);
  const hit = cache.get(key);
  if (hit) return hit;
  const c = Math.max(radius, bevel);
  // The light is painted once and kept, so it's drawn at the screen's resolution.
  const lightScale = Math.min(2, Math.ceil(devicePixelRatio || 1));

  // Where the bevel samples the backdrop from, px inward, `d` px in from the edge. A pill bends light where it
  // enters and where it leaves, and a little more the thicker the glass; a dome only magnifies.
  const bend = (d) => o.dome ? 0 : slope(d, bevel) * (1 - 1 / IOR) * (2 + 0.5 * height(d, bevel) / bevel) * o.refraction * 30;
  // The magnification fades in over the bevel. The ramp applies it in full everywhere, so the pieces take
  // back what the bevel shouldn't have (along the normal; along the edge it's a fraction of a pixel).
  const depth = (d) => smoothstep(0, bevel, d);
  let rimPx = 1e-6;
  for (let d = 0; d <= bevel; d += 0.25) rimPx = Math.max(rimPx, Math.abs(bend(d)) + Math.max(kx, ky) * (1 - depth(d)));

  // A point at (x, y) from the top-left corner of the element, inside the top-left corner piece: its distance
  // from the edge and the outward normal there.
  const corner = (x, y) => {
    const u = radius - x, v = radius - y;
    if (u > 0 && v > 0) {
      const len = Math.hypot(u, v);
      // just outside the arc still counts, for the light's antialiased edge
      return len > radius + 1 ? null : [radius - len, -u / len, -v / len];
    }
    return u > v ? [x, -1, 0] : [y, 0, -1];
  };
  // Mirror the top-left corner into the other three (in a piece of size `n`); flip the normal with it.
  const flip = (fx, fy, n) => (x, y) => {
    const hit = corner(fx ? n - x : x, fy ? n - y : y);
    return hit && [hit[0], fx ? -hit[1] : hit[1], fy ? -hit[2] : hit[2]];
  };
  const NEUTRAL = [128, 128, 128, 255];
  const shift = (d, nx, ny) => {
    if (d >= bevel) return NEUTRAL;
    const b = bend(d), back = 1 - depth(d);
    // inward is −n
    const sx = -nx * (b - kx * back), sy = -ny * (b - ky * back);
    return [128 + 127 * sx / rimPx, 128 + 127 * sy / rimPx, 128, 255];
  };
  // White light, its strength as alpha, at `d` px in, with outward normal n; `top` is 1 at the top of the
  // element and 0 at its bottom. liquidglass adds most of these terms to the colour, and mixes toward white
  // by the Fresnel term; laid over as white, the result is the same to within a few percent.
  const light = (d, nx, ny, top) => {
    const s = d >= bevel ? 0 : slope(d, bevel);
    const N = unit(s * nx, s * ny, 1);
    const fres = (1 - Math.abs(N[2])) ** 4 * o.fresnel;
    const spec = (Math.max(dot(N, H1), 0) ** 90 + Math.max(dot(N, H2), 0) ** 50 * 0.3 + Math.max(dot(N, L3), 0) ** 6 * 0.1
      + Math.max(dot(N, H4), 0) ** 120 * 0.6) * o.specular;
    const stroke = smoothstep(-2.5, -1.5, -d) * (1 - smoothstep(-1, 0, -d)) * (0.4 + 0.6 * top);
    const rim = smoothstep(shortHalf * 0.35, 0, d) * o.edge * 0.22;
    const glow = smoothstep(5, 0, d) * o.edge * 0.15;
    const env = (N[1] * 0.5 + 0.5) * fres * 0.08;
    const added = clamp(spec + rim + glow + stroke * o.edge * 0.55 + env, 0, 1);
    const a = 1 - (1 - added) * (1 - fres * 0.2);
    const cover = clamp(d * lightScale + 0.5, 0, 1);
    return [255, 255, 255, 255 * cover * a];
  };
  const draw = (w, h, at, paint, outside, scale = MAP_SCALE) => {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(h * scale));
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cv.width, cv.height);
    for (let j = 0; j < cv.height; j++) {
      for (let i = 0; i < cv.width; i++) {
        const x = (i + 0.5) / scale, y = (j + 0.5) / scale;
        const hit = at(x, y);
        img.data.set(hit ? paint(...hit, x, y) : outside, (j * cv.width + i) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  };

  const pieces = [
    draw(c, c, flip(false, false, c), shift, NEUTRAL),
    draw(2, c, (x, y) => [y, 0, -1], shift, NEUTRAL),
    draw(c, c, flip(true, false, c), shift, NEUTRAL),
    draw(c, 2, (x) => [c - x, 1, 0], shift, NEUTRAL),
    draw(c, c, flip(true, true, c), shift, NEUTRAL),
    draw(2, c, (x, y) => [c - y, 0, 1], shift, NEUTRAL),
    draw(c, c, flip(false, true, c), shift, NEUTRAL),
    draw(c, 2, (x) => [x, -1, 0], shift, NEUTRAL),
  ];

  // The magnification: every sample moved toward the middle, in proportion to how far it is from it.
  const k = Math.max(kx, ky, 1e-6);
  const ramp = draw(RAMP, RAMP, (x, y) => [(2 * x) / RAMP - 1, (2 * y) / RAMP - 1], (u, v) => [128 - 127 * u * kx / k, 128 - 127 * v * ky / k, 128, 255], NEUTRAL, 1);

  // The light, for a box of 2e + MID: border-image stretches its middle row and column, and fills the middle
  // with its middle pixel, so that has to be the flat top's light. Its edges reach as far in as the glow does.
  const e = Math.ceil(Math.max(c, shortHalf * 0.35));
  const size = 2 * e + MID;
  const lit = o.fresnel > 0 || o.edge > 0 || o.specular > 0;
  const lightImage = lit
    ? draw(size, size, (x, y) => {
      const fx = x > size / 2, fy = y > size / 2;
      const lx = fx ? size - x : x, ly = fy ? size - y : y;
      // as seen from the top-left corner (the middle row and column are straight edges), then mirrored
      const hit = lx >= e && ly >= e ? [Infinity, 0, 0] : lx >= e ? [ly, 0, -1] : ly >= e ? [lx, -1, 0] : corner(lx, ly);
      return hit && [hit[0], fx ? -hit[1] : hit[1], fy ? -hit[2] : hit[2]];
    }, (d, nx, ny, x, y) => light(d, nx, ny, top(y)), [0, 0, 0, 0], lightScale)
    : null;
  // The edge stroke is brightest at the top of the element and fades to its bottom; stretched, the middle
  // rows stand for everything in between.
  function top(y) {
    return y < e ? 1 : y > size - e ? 0 : 1 - (y - e) / MID;
  }

  const out = { pieces, ramp, light: lightImage, slice: Math.round(e * lightScale), lightWidth: e, rimPx };
  cache.set(key, out);
  return out;
}

function svgEl(tag, attrs, ...children) {
  const node = document.createElementNS(NS, tag);
  setAttrs(node, attrs);
  node.append(...children);
  return node;
}

function setAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
}
