const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');
const nunjucks = require('nunjucks');

const ARTISTS_DIR = path.join(__dirname, 'artists');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const STATIC_DIR = path.join(__dirname, 'static');
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

    artists.push({
      ...frontmatter,
      body,
      slug: folder.name,
      folder: path.join(ARTISTS_DIR, folder.name),
    });
  }

  // Sort: by explicit `order` field first, then alphabetically by name
  artists.sort((a, b) => {
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return artists;
}

// ── Build steps ──────────────────────────────────────────────────────────────

function buildArtistPages(artists) {
  for (const artist of artists) {
    const outDir = path.join(DIST_DIR, 'artists', artist.slug);
    ensureDir(outDir);

    // Copy artist images if they exist
    const imagesDir = path.join(artist.folder, 'images');
    if (fs.existsSync(imagesDir)) {
      copyDir(imagesDir, path.join(outDir, 'images'));
    }

    const html = env.render('artist.njk', { artist });
    fs.writeFileSync(path.join(outDir, 'index.html'), html);
    console.log(`  Built: artists/${artist.slug}/index.html`);
  }
}

function buildTOC(artists) {
  const outDir = path.join(DIST_DIR, 'toc');
  ensureDir(outDir);

  const html = env.render('toc.njk', { artists });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  console.log('  Built: toc/index.html');
}

function buildHomepage() {
  const homeSrc = path.join(TEMPLATES_DIR, 'home.html');
  if (!fs.existsSync(homeSrc)) {
    console.warn('  Warning: templates/home.html not found, skipping homepage');
    return;
  }
  fs.copyFileSync(homeSrc, path.join(DIST_DIR, 'index.html'));
  console.log('  Built: index.html');
}

function copyStatic() {
  if (!fs.existsSync(STATIC_DIR)) return;
  copyDir(STATIC_DIR, path.join(DIST_DIR, 'static'));
  console.log('  Copied: static assets');
}

// ── Main ─────────────────────────────────────────────────────────────────────

function build() {
  console.log('\nBuilding Delta Ark Anthology...');
  ensureDir(DIST_DIR);

  const artists = loadArtists();
  console.log(`  Found ${artists.length} artist(s)`);

  buildArtistPages(artists);
  buildTOC(artists);
  buildHomepage();
  copyStatic();

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
