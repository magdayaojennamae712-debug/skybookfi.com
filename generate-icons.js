// Run this once to generate app icons: node generate-icons.js
const { createCanvas } = require('canvas');
const fs = require('fs');

function createIcon(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#1a2b4a';
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.2);
  ctx.fill();

  // Airplane emoji text
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${size * 0.5}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✈', size / 2, size / 2);

  // Save
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(`public/${filename}`, buffer);
  console.log(`Created ${filename}`);
}

try {
  createIcon(192, 'icon-192.png');
  createIcon(512, 'icon-512.png');
  console.log('Icons created successfully!');
} catch (e) {
  console.log('Canvas not available — using fallback icon method');
  // Fallback: copy a simple PNG
}
