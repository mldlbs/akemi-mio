const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sizes = [16, 32, 48, 64, 128, 256];
const svgPath = path.join(__dirname, '..', 'build', 'icon.svg');

async function main() {
  // Generate PNG for each size
  const pngBuffers = {};
  for (const size of sizes) {
    pngBuffers[size] = await sharp(svgPath).resize(size, size).png().toBuffer();
    fs.writeFileSync(path.join(__dirname, '..', `build/icon-${size}.png`), pngBuffers[size]);
    console.log(`Generated ${size}x${size} PNG`);
  }

  // Write 256x256 as the main icon PNG for electron-builder
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), pngBuffers[256]);

  // Generate .ico with multiple sizes
  const ico = encodeIco(pngBuffers);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), ico);
  console.log('Generated icon.ico');
}

function encodeIco(pngBuffers) {
  const entries = Object.entries(pngBuffers).map(([size, buf]) => ({
    size: parseInt(size),
    data: buf,
  }));

  const headerSize = 6;
  const dirEntrySize = 16;
  const header = Buffer.alloc(headerSize + entries.length * dirEntrySize);

  // ICO header
  header.writeUInt16LE(0, 0);    // reserved
  header.writeUInt16LE(1, 2);    // type: 1 = ICO
  header.writeUInt16LE(entries.length, 4); // count

  let offset = header.length;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const dirOffset = headerSize + i * dirEntrySize;
    header.writeUInt8(e.size === 256 ? 0 : e.size, dirOffset);     // width
    header.writeUInt8(e.size === 256 ? 0 : e.size, dirOffset + 1); // height
    header.writeUInt8(0, dirOffset + 2); // color palette
    header.writeUInt8(0, dirOffset + 3); // reserved
    header.writeUInt16LE(1, dirOffset + 4);  // color planes
    header.writeUInt16LE(32, dirOffset + 6); // bits per pixel
    header.writeUInt32LE(e.data.length, dirOffset + 8);  // size
    header.writeUInt32LE(offset, dirOffset + 12); // offset
    offset += e.data.length;
  }

  return Buffer.concat([header, ...entries.map(e => e.data)]);
}

main().catch(console.error);
