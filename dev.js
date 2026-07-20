/* Dev server with live reload.
 *
 * Serves dist/, watches the sources, rebuilds on change, and pushes a reload
 * over SSE. HTML responses get a small client script injected before </body>,
 * so no markup or template changes are needed. Uses only chokidar, which is
 * already a dependency — no new packages.
 *
 *   npm run dev
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const chokidar = require('chokidar');

const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT) || 8080;
const WATCH = ['artists', 'templates', 'static', 'build.js'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

// ── Live-reload clients ──────────────────────────────────────────────────────

const clients = new Set();

function broadcast(event) {
  for (const res of clients) res.write(`data: ${event}\n\n`);
}

const CLIENT_SCRIPT = `
<script>
(function () {
  var es = new EventSource('/__livereload');
  es.onmessage = function (e) { if (e.data === 'reload') location.reload(); };
  es.onerror = function () {
    // Server restarting or gone — poll until it answers, then reload.
    es.close();
    var retry = setInterval(function () {
      fetch('/__livereload/ping', { cache: 'no-store' })
        .then(function () { clearInterval(retry); location.reload(); })
        .catch(function () {});
    }, 500);
  };
})();
</script>`;

// ── Build ────────────────────────────────────────────────────────────────────

let building = false;
let queued = false;

function rebuild() {
  if (building) { queued = true; return; }
  building = true;
  execFile('node', [path.join(__dirname, 'build.js')], (err, stdout, stderr) => {
    building = false;
    if (err) {
      console.error('\n  Build failed:\n' + (stderr || stdout));
    } else {
      const built = (stdout.match(/Built:/g) || []).length;
      console.log(`  Rebuilt (${built} pages) — reloading`);
      broadcast('reload');
    }
    if (queued) { queued = false; rebuild(); }
  });
}

// ── Static file server ───────────────────────────────────────────────────────

function serve(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath === '/__livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 500\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (urlPath === '/__livereload/ping') {
    res.writeHead(200, { 'Cache-Control': 'no-store' });
    return res.end('ok');
  }

  let filePath = path.join(DIST, urlPath);

  // Keep the resolved path inside dist/.
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8">404 — ${urlPath}${CLIENT_SCRIPT}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  // no-store so an edited stylesheet is never served from cache after a reload.
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };

  if (ext === '.html') {
    let html = fs.readFileSync(filePath, 'utf8');
    html = html.includes('</body>')
      ? html.replace('</body>', `${CLIENT_SCRIPT}\n</body>`)
      : html + CLIENT_SCRIPT;
    res.writeHead(200, headers);
    return res.end(html);
  }

  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

// ── Start ────────────────────────────────────────────────────────────────────

rebuild();

http.createServer(serve).listen(PORT, () => {
  console.log(`\n  Dev server:  http://localhost:${PORT}`);
  console.log(`  Watching:    ${WATCH.join(', ')}\n`);
});

chokidar
  .watch(WATCH, { ignoreInitial: true, cwd: __dirname })
  .on('all', (event, file) => {
    console.log(`  ${event}: ${file}`);
    rebuild();
  });
