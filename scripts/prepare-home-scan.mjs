import { readFile, writeFile } from 'node:fs/promises';

const sourceScan = new URL('../public/assets/3dImage-clean.lssnap', import.meta.url);
const sourceAxes = new URL('../public/assets/3dImage-surfels.bin', import.meta.url);
const homeScan = new URL('../public/assets/3dImage-home.lssnap', import.meta.url);
const homeAxes = new URL('../public/assets/3dImage-home-surfels.bin', import.meta.url);

const scan = await readFile(sourceScan);
const axes = await readFile(sourceAxes);
const count = scan.readInt32LE(4);
if (scan.toString('ascii', 0, 3) !== 'LSS' || scan[3] !== 1 || axes.readUInt32LE(0) !== count) {
  throw new Error('Source scan and surfel axes do not match');
}

let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
for (let i = 0; i < count; i++) {
  const offset = 16 + i * 9;
  const x = scan.readInt16LE(offset);
  const y = scan.readInt16LE(offset + 2);
  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
}

// Matches the homepage viewer's existing quadrant selection exactly.
const xCut = (minX + maxX) / 2;
const yCut = (minY + maxY) / 2;
const selected = [];
for (let i = 0; i < count; i++) {
  const offset = 16 + i * 9;
  if (scan.readInt16LE(offset) >= xCut && scan.readInt16LE(offset + 2) >= yCut) selected.push(i);
}

const annotationLength = scan.readInt32LE(8);
const annotationStart = 16 + count * 9;
const outputScan = Buffer.alloc(16 + selected.length * 9 + annotationLength);
scan.copy(outputScan, 0, 0, 16);
outputScan.writeInt32LE(selected.length, 4);
selected.forEach((source, target) => scan.copy(outputScan, 16 + target * 9, 16 + source * 9, 16 + source * 9 + 9));
scan.copy(outputScan, 16 + selected.length * 9, annotationStart, annotationStart + annotationLength);

const outputAxes = Buffer.alloc(4 + selected.length * 12);
outputAxes.writeUInt32LE(selected.length, 0);
selected.forEach((source, target) => axes.copy(outputAxes, 4 + target * 12, 4 + source * 12, 4 + source * 12 + 12));

async function writeIfChanged(url, contents) {
  const existing = await readFile(url).catch(() => null);
  if (!existing?.equals(contents)) await writeFile(url, contents);
}

await Promise.all([writeIfChanged(homeScan, outputScan), writeIfChanged(homeAxes, outputAxes)]);
console.log(`Prepared homepage scan: ${selected.length} of ${count} surfels`);
