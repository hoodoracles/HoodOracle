// Build src/app/favicon.ico.
//
// /favicon.ico is still fetched directly by crawlers, link unfurlers and
// older browsers whatever <link rel="icon"> says, and a 404 there is a
// missing icon in a lot of places nobody tests.
//
// Two formats have to be produced by hand here, and both are simpler than
// they sound:
//
//   PNG  Chromium will not give us one. Its encoder drops the alpha channel
//        whenever an image is fully opaque, and Next's .ico decoder rejects
//        any member that is not RGBA -- it fails the whole build, not just
//        the icon. So the browser is used only to rasterise, raw RGBA pixels
//        come back through getImageData, and the PNG is written here with
//        colour type 6 guaranteed.
//
//   ICO  An ICONDIR header, one 16-byte ICONDIRENTRY per image, then the
//        payloads. Since Vista an entry may hold a whole PNG rather than a
//        BMP, so the encoded images go in untouched.

import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const SIZES = [16, 32, 48];
const OUT = "src/app/favicon.ico";
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type 6 = truecolour with alpha
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // adaptive filtering
  ihdr.writeUInt8(0, 12); // no interlace

  // One filter byte per scanline; "none" keeps this honest and the images
  // are tiny, so there is nothing to gain from a smarter filter.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Inlined as a data URI rather than loaded from disk. An image fetched over
// file:// counts as cross-origin and taints the canvas, which makes
// getImageData throw a SecurityError; a data URI is same-origin.
const svgSource = readFileSync("brand/mark-simple-ink.svg", "utf8");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("about:blank");

const images: { size: number; data: Buffer }[] = [];

for (const size of SIZES) {
  const pixels = await page.evaluate(
    async ({ n, svg }: { n: number; svg: string }) => {
      const canvas = document.createElement("canvas");
      canvas.width = n;
      canvas.height = n;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");

      // The ink ground, so the mark is legible on light and dark browser
      // chrome alike. Ink strokes on transparent vanish on a dark tab.
      ctx.fillStyle = "#16161a";
      ctx.fillRect(0, 0, n, n);

      const img = new Image();
      img.src =
        "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await img.decode();

      const inset = Math.round(n * 0.1);
      ctx.drawImage(img, inset, inset, n - inset * 2, n - inset * 2);

      return Array.from(ctx.getImageData(0, 0, n, n).data);
    },
    { n: size, svg: svgSource },
  );

  const data = encodePng(size, size, Buffer.from(pixels));
  if (data.readUInt8(25) !== 6) throw new Error("encoder did not write RGBA");
  images.push({ size, data });
}

await browser.close();

const HEADER = 6;
const ENTRY = 16;
const dir = Buffer.alloc(HEADER + ENTRY * images.length);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // 1 = icon
dir.writeUInt16LE(images.length, 4);

let offset = dir.length;
images.forEach((img, i) => {
  const at = HEADER + i * ENTRY;
  // 256 is encoded as 0 in this field. Nothing here is that large, but the
  // rule is worth honouring rather than writing a silent overflow.
  dir.writeUInt8(img.size >= 256 ? 0 : img.size, at);
  dir.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1);
  dir.writeUInt8(0, at + 2); // palette entries, 0 for truecolour
  dir.writeUInt8(0, at + 3); // reserved
  dir.writeUInt16LE(1, at + 4); // colour planes
  dir.writeUInt16LE(32, at + 6); // bits per pixel
  dir.writeUInt32LE(img.data.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += img.data.length;
});

writeFileSync(OUT, Buffer.concat([dir, ...images.map((i) => i.data)]));
console.log(
  `${OUT}  ${images.map((i) => `${i.size}x${i.size}`).join(" ")}  RGBA  ${offset}B`,
);
