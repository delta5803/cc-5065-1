// Display helpers: HDR linear -> sRGB for the canvas. Noise metric computed on
// linear values (not on the tonemapped image) so it measures estimator noise.
//
// Exposure for display is a fixed scene exposure; the tonemap is Reinhard-like
// with a shoulder, so bright emitters do not clip to flat white.
export function tonemap(rgb, exposure = 1.0, gamma = 2.2) {
  // rgb is a length-3 array in linear HDR.
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let v = Math.max(0, rgb[i]) * exposure;
    // ACES-ish filmic shoulder (approximately monotone, no hard clip).
    v = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
    out[i] = Math.pow(Math.max(0, Math.min(1, v)), 1 / gamma);
  }
  return out;
}

export function rgbToCss([r, g, b]) {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

// Render a linear Float64Array image into an ImageData-like RGBA buffer.
export function imageToRGBA(rgb, width, height, exposure = 1.0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const t = tonemap([rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]], exposure);
    data[i * 4] = t[0] * 255;
    data[i * 4 + 1] = t[1] * 255;
    data[i * 4 + 2] = t[2] * 255;
    data[i * 4 + 3] = 255;
  }
  return data;
}

// Per-pixel luminance used for the noise heatmap.
export function luminanceImage(rgb, width, height) {
  const out = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    out[i] = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
  }
  return out;
}

// Relative error image between a sample image and a reference image.
export function relErrorImage(rgb, ref, width, height) {
  const out = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    let a = 0;
    let b = 0;
    for (let c = 0; c < 3; c++) {
      a += rgb[i * 3 + c];
      b += ref[i * 3 + c];
    }
    a /= 3;
    b /= 3;
    out[i] = Math.abs(a - b) / Math.max(1e-6, Math.abs(b) + 1e-3);
  }
  return out;
}
