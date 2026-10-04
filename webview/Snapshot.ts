/**
 * Snapshot rasterisation (spec §10): igv's toSVG() output is drawn to a
 * canvas at the requested scale and exported as PNG bytes.
 */

export interface PngSnapshot {
  png: Uint8Array;
  width: number;
  height: number;
}

export function svgDimensions(svg: string): { width: number; height: number } {
  const w = /<svg[^>]*\swidth="([\d.]+)/.exec(svg);
  const h = /<svg[^>]*\sheight="([\d.]+)/.exec(svg);
  return { width: w ? Math.ceil(Number(w[1])) : 0, height: h ? Math.ceil(Number(h[1])) : 0 };
}

export async function svgToPng(svg: string, scale = 2): Promise<PngSnapshot> {
  const dims = svgDimensions(svg);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const width = dims.width || img.naturalWidth;
    const height = dims.height || img.naturalHeight;
    if (!width || !height) throw new Error('snapshot SVG has no size');
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!pngBlob) throw new Error('canvas.toBlob returned null');
    const png = new Uint8Array(await pngBlob.arrayBuffer());
    return { png, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to decode snapshot SVG as an image'));
    img.src = src;
  });
}
