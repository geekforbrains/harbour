import sharp from "sharp";
import { writeFileSync } from "fs";
import { join } from "path";

const PRIMARY = "#5043a3";
const WHITE = "#ffffff";
const OUT = join(import.meta.dirname, "..", "public");

// Lucide anchor icon as clean SVG (viewBox 0 0 24 24)
const anchorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 6v16"/>
  <path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/>
  <path d="M9 11h6"/>
  <circle cx="12" cy="4" r="2"/>
</svg>`;

// App icon: rounded square with anchor
function makeAppIcon(size, iconPad, cornerRadius) {
  const iconSize = size - iconPad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="${PRIMARY}"/>
  <svg x="${iconPad}" y="${iconPad}" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 6v16"/>
    <path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/>
    <path d="M9 11h6"/>
    <circle cx="12" cy="4" r="2"/>
  </svg>
</svg>`;
}

// Favicon: simple circle bg (works better at tiny sizes)
function makeFaviconSvg(size) {
  const r = size / 2;
  const iconPad = Math.round(size * 0.18);
  const iconSize = size - iconPad * 2;
  // Thicker stroke for small sizes
  const strokeW = size <= 32 ? 2.8 : 2.2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${r}" cy="${r}" r="${r}" fill="${PRIMARY}"/>
  <svg x="${iconPad}" y="${iconPad}" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="${WHITE}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 6v16"/>
    <path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/>
    <path d="M9 11h6"/>
    <circle cx="12" cy="4" r="2"/>
  </svg>
</svg>`;
}

// Social share image (OG image): 1200x630 with centered icon
function makeOgImage() {
  const w = 1200, h = 630;
  const iconSize = 280;
  const iconX = (w - iconSize) / 2;
  const iconY = (h - iconSize) / 2 - 40;
  const textY = iconY + iconSize + 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${PRIMARY}"/>
  <svg x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 6v16"/>
    <path d="m19 13 2-1a9 9 0 0 1-18 0l2 1"/>
    <path d="M9 11h6"/>
    <circle cx="12" cy="4" r="2"/>
  </svg>
  <text x="${w / 2}" y="${textY}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="52" font-weight="600" fill="${WHITE}">Harbour</text>
</svg>`;
}

async function generate() {
  // PWA / app icons (rounded square)
  const appSizes = [192, 512];
  for (const size of appSizes) {
    const pad = Math.round(size * 0.15);
    const radius = Math.round(size * 0.19);
    const svg = makeAppIcon(size, pad, radius);
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    const name = `icon-${size}.png`;
    writeFileSync(join(OUT, name), buf);
    console.log(`✓ ${name}`);
  }

  // Apple touch icon (180x180) — Apple adds its own rounding, so use square with slight radius
  {
    const size = 180;
    const pad = Math.round(size * 0.15);
    const svg = makeAppIcon(size, pad, 0);
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    writeFileSync(join(OUT, "apple-touch-icon.png"), buf);
    console.log("✓ apple-touch-icon.png");
  }

  // Favicon PNGs
  for (const size of [16, 32, 48]) {
    const svg = makeFaviconSvg(size);
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    writeFileSync(join(OUT, `favicon-${size}.png`), buf);
    console.log(`✓ favicon-${size}.png`);
  }

  // favicon.ico (multi-size)
  // ICO = concatenated BMPs or PNGs, but simplest is just a 32x32 PNG renamed
  // We'll use ImageMagick to combine into proper .ico
  {
    const png16 = await sharp(Buffer.from(makeFaviconSvg(16))).png().toBuffer();
    const png32 = await sharp(Buffer.from(makeFaviconSvg(32))).png().toBuffer();
    const png48 = await sharp(Buffer.from(makeFaviconSvg(48))).png().toBuffer();
    writeFileSync("/tmp/fav16.png", png16);
    writeFileSync("/tmp/fav32.png", png32);
    writeFileSync("/tmp/fav48.png", png48);
    console.log("✓ favicon PNGs staged for .ico conversion");
  }

  // SVG favicon (for modern browsers) — circle style
  writeFileSync(join(OUT, "icon.svg"), makeFaviconSvg(32));
  console.log("✓ icon.svg (favicon)");

  // OG / social share image
  {
    const svg = makeOgImage();
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    writeFileSync(join(OUT, "og-image.png"), buf);
    console.log("✓ og-image.png (1200x630)");
  }

  // Clean standalone SVG for general use (square, no background)
  writeFileSync(join(OUT, "anchor-icon.svg"), anchorSvg);
  console.log("✓ anchor-icon.svg (standalone)");

  // High-res square icon for social profiles etc (1024x1024)
  {
    const size = 1024;
    const pad = Math.round(size * 0.15);
    const radius = Math.round(size * 0.19);
    const svg = makeAppIcon(size, pad, radius);
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    writeFileSync(join(OUT, "icon-1024.png"), buf);
    console.log("✓ icon-1024.png (social profile)");
  }

  console.log("\nDone! Now run: magick /tmp/fav16.png /tmp/fav32.png /tmp/fav48.png public/favicon.ico");
}

generate().catch(console.error);
