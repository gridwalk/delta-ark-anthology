#!/usr/bin/env node
/* Makes the listing icon for each artist from that artist's poster.

   Input:  artists/<slug>/images/poster.jpg
   Output: artists/<slug>/images/poster-thumb.jpg

   The icon keeps the aspect ratio of the poster. It is 32px high, and its
   width follows from the aspect ratio. Nothing is cropped. The listing shows
   it at 1em high (11px), so 32px is sharp on a 2x or 3x screen.

   This script also limits each poster to 1600px on its longer side.

   The script uses macOS `sips`, so it needs no npm package. Run it after you
   add or replace a poster:

     node scripts/make-thumbs.js            # only posters without a thumb
     node scripts/make-thumbs.js --force    # remake every thumb */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ARTISTS_DIR = path.join(__dirname, '..', 'artists');
const THUMB_SIZE = 32;
const POSTER_MAX = 1600;
const force = process.argv.includes('--force');

function size(file) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], {
    encoding: 'utf8',
  });
  return {
    width: Number(out.match(/pixelWidth: (\d+)/)[1]),
    height: Number(out.match(/pixelHeight: (\d+)/)[1]),
  };
}

function sips(args) {
  execFileSync('sips', args, { stdio: 'ignore' });
}

let made = 0;
for (const slug of fs.readdirSync(ARTISTS_DIR).sort()) {
  const imagesDir = path.join(ARTISTS_DIR, slug, 'images');
  const poster = path.join(imagesDir, 'poster.jpg');
  const thumb = path.join(imagesDir, 'poster-thumb.jpg');
  if (!fs.existsSync(poster)) continue;

  // Keep the poster at a web size.
  const p = size(poster);
  if (Math.max(p.width, p.height) > POSTER_MAX) {
    sips(['-Z', String(POSTER_MAX), poster]);
  }

  if (fs.existsSync(thumb) && !force) continue;

  // Scale the poster to THUMB_SIZE high. The width keeps the aspect ratio.
  sips(['--resampleHeight', String(THUMB_SIZE), poster, '--out', thumb]);
  sips(['-s', 'formatOptions', '80', thumb]);

  console.log(`  Thumb: artists/${slug}/images/poster-thumb.jpg`);
  made++;
}
console.log(`Made ${made} thumbnail(s).`);
