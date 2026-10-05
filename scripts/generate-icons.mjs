// Render PWA icons from the SVG logo using sharp (run once; output is committed).
import sharp from 'sharp';
const logo = (bg, pad) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${bg}"/><g transform="translate(${pad} ${pad}) scale(${(512 - 2 * pad) / 32})"><path d="M16 3l11 4v8c0 7-5 12-11 14C10 27 5 22 5 15V7z" fill="#546a80"/><path d="M11 12h10M11 16h10M11 20h6" stroke="#f7fbfe" stroke-width="2" stroke-linecap="round"/></g></svg>`,
  );
await sharp(logo('#edf5fd', 40)).resize(192).png().toFile('public/icons/icon-192.png');
await sharp(logo('#edf5fd', 40)).resize(512).png().toFile('public/icons/icon-512.png');
await sharp(logo('#edf5fd', 96)).resize(512).png().toFile('public/icons/maskable-512.png');
await sharp(logo('#edf5fd', 30)).resize(180).png().toFile('public/icons/apple-touch-icon.png');
console.log('icons written');
