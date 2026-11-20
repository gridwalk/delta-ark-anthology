const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const nunjucks = require('nunjucks');

const ARTISTS_DIR = path.join(__dirname, 'artists');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const STATIC_DIR = path.join(__dirname, 'static');
const EMBEDS_DIR = path.join(__dirname, 'embeds');
const DIST_DIR = path.join(__dirname, 'dist');

// Configure nunjucks to load from templates directory
const env = nunjucks.configure(TEMPLATES_DIR, { autoescape: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/* Reads the pixel size of a JPEG from its SOF marker. Returns null if the file
   is not a JPEG that it can read. */
function jpegSize(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    // SOF0–SOF15 hold the size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// ── Load all artist data ─────────────────────────────────────────────────────

function loadArtists() {
  if (!fs.existsSync(ARTISTS_DIR)) return [];

  const artists = [];

  for (const folder of fs.readdirSync(ARTISTS_DIR, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;

    const mdPath = path.join(ARTISTS_DIR, folder.name, 'index.md');
    if (!fs.existsSync(mdPath)) {
      console.warn(`  Warning: no index.md in artists/${folder.name}, skipping`);
      continue;
    }

    const raw = fs.readFileSync(mdPath, 'utf8');
    const { data: frontmatter, content } = matter(raw);
    const body = marked(content);

    // The listing icon comes from a fixed file name, so it needs no
    // front-matter field. scripts/make-thumbs.js makes it from poster.jpg.
    // The template needs its size for the width and height attributes.
    const thumbPath = path.join(ARTISTS_DIR, folder.name, 'images', 'poster-thumb.jpg');
    const thumbSize = fs.existsSync(thumbPath) ? jpegSize(thumbPath) : null;

    artists.push({
      ...frontmatter,
      body,
      slug: folder.name,
      folder: path.join(ARTISTS_DIR, folder.name),
      thumb: thumbSize
        ? { src: `/artists/${folder.name}/images/poster-thumb.jpg`, ...thumbSize }
        : null,
      // The full poster, for the artwork view when there is no video.
      poster: fs.existsSync(path.join(ARTISTS_DIR, folder.name, 'images', 'poster.jpg'))
        ? `/artists/${folder.name}/images/poster.jpg`
        : null,
    });
  }

  // Always alphabetical by contributor name. `sensitivity: 'base'` makes the
  // comparison case- and accent-insensitive, so "XTRUX" and "Castañeda" land
  // where a reader expects rather than after every lowercase name.
  artists.sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', 'en', { sensitivity: 'base' })
  );

  return artists;
}

// ── Build steps ──────────────────────────────────────────────────────────────

function buildArtistPages(artists) {
  // Each artist URL is the homepage in its collapsed state (see below).
  for (const artist of artists) {
    const outDir = path.join(DIST_DIR, 'artists', artist.slug);
    ensureDir(outDir);

    // Copy artist images if they exist
    const imagesDir = path.join(artist.folder, 'images');
    if (fs.existsSync(imagesDir)) {
      copyDir(imagesDir, path.join(outDir, 'images'));
    }

    // An artist URL serves the homepage with that artist selected, so a
    // reload shows the same view as the in-page navigation (see page-nav.js).
    // The listing starts collapsed. artist.njk is kept for the artist
    // content, which is the next step.
    const html = env.render('toc.njk', { artists, selected: artist, page: 'toc' });
    fs.writeFileSync(path.join(outDir, 'index.html'), html);
    console.log(`  Built: artists/${artist.slug}/index.html`);
  }
}

/* The listing is the homepage. It renders at the site root with the ship
   backdrop; /toc-lattice/ keeps the three.js placeholder grid and its
   hover-to-frame camera. Both come from one shared include.

   /toc/ was the listing's old home, so it stays as a redirect rather than a
   404 — links and bookmarks to it still land on the homepage. */
function buildTOC(artists) {
  const pages = [
    { file: 'index.html', template: 'toc.njk', page: 'toc' },
    { file: 'toc-lattice/index.html', template: 'toc-lattice.njk', page: 'toc-lattice' },
  ];

  for (const { file, template, page } of pages) {
    const outPath = path.join(DIST_DIR, file);
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, env.render(template, { artists, page }));
    console.log(`  Built: ${file}`);
  }

  // Static-host redirect: no server to send a 301, so refresh + replace.
  const redirect = path.join(DIST_DIR, 'toc', 'index.html');
  ensureDir(path.dirname(redirect));
  fs.writeFileSync(
    redirect,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Runtime Season</title>
  <link rel="canonical" href="/">
  <meta http-equiv="refresh" content="0; url=/">
</head>
<body>
  <p>This page has moved to the <a href="/">Runtime Season</a>.</p>
  <script>location.replace('/');</script>
</body>
</html>
`
  );
  console.log('  Built: toc/index.html (redirect to /)');
}

/* Type specimen: an unlisted page at /type/ that sets the listing in each
   candidate typeface, for choosing a replacement. Nothing links to it. */
function buildTypeSpecimen(artists) {
  const outPath = path.join(DIST_DIR, 'type', 'index.html');
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, env.render('type.njk', { artists, page: 'type' }));
  console.log('  Built: type/index.html');
}

/* Headline pairing specimen: an unlisted page at /type/pairing/ that sets
   candidate headline faces with the Martian Mono body text. The sample artist
   has a name in letters, with an accent to test the glyph cover, and a work
   title with a colon and mixed case. */
const PAIRING_SAMPLE = 'leo-castaneda';
function buildTypePairing(artists) {
  const sample = artists.find((a) => a.slug === PAIRING_SAMPLE) || artists[0];
  // A plain-text excerpt of the body, about two short paragraphs long.
  const text = (sample.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const excerpt = text.length > 420 ? text.slice(0, 420).replace(/\s+\S*$/, '') + '…' : text;
  const outPath = path.join(DIST_DIR, 'type', 'pairing', 'index.html');
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(
    outPath,
    env.render('type-pairing.njk', { artists, sample: { ...sample, excerpt }, page: 'type' })
  );
  console.log('  Built: type/pairing/index.html');
}

/* The about page. A placeholder for now: the sea backdrop and a framed
   block of text. */
function buildAbout(artists) {
  const outPath = path.join(DIST_DIR, 'about', 'index.html');
  ensureDir(path.dirname(outPath));
  // The about URL serves the homepage with the about text open, the same as
  // the artist URLs (see openAbout in page-nav.js). about.njk is no longer
  // used.
  fs.writeFileSync(outPath, env.render('toc.njk', { artists, about: true, page: 'toc' }));
  console.log('  Built: about/index.html');
}

function copyStatic() {
  if (!fs.existsSync(STATIC_DIR)) return;
  copyDir(STATIC_DIR, path.join(DIST_DIR, 'static'));
  console.log('  Copied: static assets');
}

/* Prebuilt standalone pages, copied to the site root verbatim.
 *
 * Each subdirectory of embeds/ becomes a top-level path — embeds/foo/ serves
 * at /foo/. These are built elsewhere and dropped in whole; nothing here
 * templates or rewrites them, so their asset paths must already match the
 * path they are served from.
 *
 * Note these are only unlisted, not private: the repo is public and Pages
 * serves every file to anyone who asks for the URL.
 */
function copyEmbeds() {
  if (!fs.existsSync(EMBEDS_DIR)) return;

  const names = fs
    .readdirSync(EMBEDS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const name of names) {
    copyDir(path.join(EMBEDS_DIR, name), path.join(DIST_DIR, name));
    console.log(`  Copied: /${name}/ (embed)`);
  }
}

// three.js ships from node_modules rather than being committed.
//
// Two things matter about the layout below. The module build imports
// ./three.core.min.js by relative path, so those two sit together. And the
// jsm modules import the bare specifier "three", which the import map in
// base.njk resolves.
function copyVendor() {
  const threeDir = path.join(__dirname, 'node_modules', 'three');
  const outDir = path.join(DIST_DIR, 'static', 'js', 'vendor');

  const core = ['three.module.min.js', 'three.core.min.js'];
  const jsm = [
    'lines/LineSegments2.js',
    'lines/LineSegmentsGeometry.js',
    'lines/LineMaterial.js',
  ];

  const missing = [
    ...core.map((f) => path.join(threeDir, 'build', f)),
    ...jsm.map((f) => path.join(threeDir, 'examples', 'jsm', f)),
  ].filter((p) => !fs.existsSync(p));

  if (missing.length) {
    console.warn(`  Warning: three.js files missing, skipping (${missing.length})`);
    return;
  }

  ensureDir(outDir);
  for (const f of core) {
    fs.copyFileSync(path.join(threeDir, 'build', f), path.join(outDir, f));
  }
  for (const f of jsm) {
    const dest = path.join(outDir, 'jsm', f);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(path.join(threeDir, 'examples', 'jsm', f), dest);
  }
  console.log(`  Copied: three.js (${core.length + jsm.length} files)`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function build() {
  console.log('\nBuilding Delta Ark Anthology...');
  ensureDir(DIST_DIR);

  const artists = loadArtists();
  console.log(`  Found ${artists.length} artist(s)`);

  buildArtistPages(artists);
  buildTOC(artists);
  buildTypeSpecimen(artists);
  buildTypePairing(artists);
  buildAbout(artists);
  copyStatic();
  copyVendor();
  copyEmbeds();

  console.log('\nDone.\n');
}

build();

// ── Watch mode ───────────────────────────────────────────────────────────────

if (process.argv.includes('--watch')) {
  const chokidar = require('chokidar');
  console.log('Watching for changes...\n');

  chokidar
    .watch(['artists', 'templates', 'static'], { ignoreInitial: true })
    .on('all', (event, filePath) => {
      console.log(`  ${event}: ${filePath}`);
      build();
    });
}
