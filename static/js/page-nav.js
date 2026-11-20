// In-page navigation on the homepage.
//
// A click on an artist does not load a new page. The listing collapses: the
// rows go away one at a time, from the bottom row up, and only the title box
// stays. The address changes to the artist's URL with history.pushState, so
// the ship iframe keeps running and does not reload. The artist's chunk on
// the ship stays lit.
//
// The browser's back button, or a click on the site name, brings the rows
// back one at a time from the top down.
//
// This step shows no artist content yet. A reload at an artist URL still
// loads the separate artist page.
(function () {
  var list = document.querySelector('.toc-list');
  var frame = document.querySelector('.ship-backdrop');
  if (!list || !window.history.pushState) return;

  // Milliseconds between two rows. Slow enough that each line of text reads
  // as its own step, so the listing closes like a drawer, line by line.
  //
  // The steps run also with the system's reduce-motion setting. Nothing
  // slides or zooms: whole lines go away in place.
  var ROW_DELAY = 70;
  var HOME_TITLE = list.dataset.homeTitle || document.title;

  var entries = Array.prototype.slice.call(list.querySelectorAll('.toc-entry'));
  var title = list.querySelector('.title-box-home');
  var stack = document.querySelector('.ship-panel-stack');
  // The tiles hide in TILE_STEPS chunks from left to right, at the same pace
  // as the rows. They have no rows of their own, so the steps are equal
  // slices of the column's width.
  var TILE_STEPS = 8;
  var tileTimers = [];
  var timers = [];
  // An artist URL starts collapsed, with data-selected set by the template.
  // 'list', 'artist', or 'about'. An artist URL and the about URL start
  // collapsed (see the templates).
  var state =
    list.dataset.view === 'about' ? 'about'
    : list.dataset.selected !== undefined ? 'artist'
    : 'list';

  function lightGroup(group) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'ship:highlight', group: group }, window.location.origin);
  }

  // The space right of the first column, in viewport pixels across: { left,
  // width, centre }. On the artwork view, the laser's end goes to its centre
  // (see focusCenterX in ship/src/main.js), and so does the media. The tiles
  // are hidden then, so the space runs to the window's right edge. When the
  // column takes almost the whole width, as on a phone, the space is the
  // whole window.
  function freeSpace() {
    var column = list.querySelector('.toc-title');
    var left = column ? column.getBoundingClientRect().right : 0;
    if (window.innerWidth - left < 240) left = 0;
    var width = window.innerWidth - left;
    return { left: left, width: width, centre: left + width / 2 };
  }

  // The shade behind the text column ends just past this edge (see
  // .artwork-shade in main.css).
  function setColumnEdge() {
    var column = list.querySelector('.toc-title');
    if (column) {
      document.documentElement.style.setProperty('--column-right', column.getBoundingClientRect().right + 'px');
    }
  }
  setColumnEdge();
  window.addEventListener('resize', setColumnEdge);

  // The laser's end goes to the centre of the media box (see mediaBox), so
  // the media sits on it. The box is the same for every artist, with or
  // without media.
  // On the about view, the ship centres itself in the free space right of the
  // text column (see viewCenterX in ship/src/main.js). Elsewhere, null gives
  // back the listing's centre.
  // The about view also opens the exploded view of the cargo (see
  // explode.js in the ship).
  function sendViewCenter() {
    if (!frame || !frame.contentWindow) return;
    var x = state === 'about' ? freeSpace().centre : null;
    frame.contentWindow.postMessage({ type: 'ship:viewCenter', x: x }, window.location.origin);
    frame.contentWindow.postMessage({ type: 'ship:explode', on: state === 'about' }, window.location.origin);
  }

  function sendFocusCenter() {
    if (!frame || !frame.contentWindow) return;
    var box = mediaBox();
    frame.contentWindow.postMessage(
      { type: 'ship:focusCenter', x: box.left + box.width / 2, y: box.top + box.height / 2 },
      window.location.origin
    );
  }
  window.addEventListener('resize', function () {
    sendFocusCenter();
    sendViewCenter();
    placeMedia();
    placePager();
  });

  // ── Artwork media ────────────────────────────────────────────────────────
  //
  // The video embed, or else the poster, centred on the laser's end: the
  // centre of the free space across, and the middle of the window down. The
  // embed is made when the media shows and removed when it goes, so a video
  // stops. It comes in after the camera's flight, in MEDIA_STEPS chunks from
  // the top, and goes in the same chunks from the bottom.
  var media = document.querySelector('.artwork-media');
  var MEDIA_SHARE = 0.75; // of the free width
  var MEDIA_MAX = 1200; // pixels wide at most
  var MEDIA_HEIGHT = 0.75; // of the window height, at most
  var MEDIA_DELAY = 1200; // milliseconds, about one camera flight
  var MEDIA_STEPS = 8;
  var MEDIA_STEP = 30; // milliseconds per chunk
  var mediaTimers = [];

  // Where the media goes, in viewport pixels at the top of the page: centred
  // across in the free space, with its top level with the work title in the
  // text column. The title is two blank lines under the panel's top, and the
  // panel starts under the title box's rows (see .artwork-panel and
  // .artwork-info in main.css), so its place is known before the panel shows.
  function mediaBox() {
    var space = freeSpace();
    var width = Math.min(space.width * MEDIA_SHARE, MEDIA_MAX, (window.innerHeight * MEDIA_HEIGHT * 16) / 9);
    var height = (width * 9) / 16;
    var line = parseFloat(getComputedStyle(list).lineHeight) || 16.5;
    var section = list.closest('.toc') || list;
    var titleRows = parseFloat(getComputedStyle(section).getPropertyValue('--toc-title-rows')) || 3;
    var top = list.getBoundingClientRect().top + window.scrollY + line * (titleRows + 2);
    return { left: space.centre - width / 2, top: top, width: width, height: height };
  }

  // ── Previous and next ─────────────────────────────────────────────────
  //
  // Links to the neighbours of the chosen artist in the listing's order,
  // wrapping at both ends. They sit in the space under the media box (see
  // placePager). They come in with the media, stay while the view moves from
  // artist to artist, and go when the listing opens.
  var pager = document.querySelector('.artwork-pager');
  var allLinks = Array.prototype.slice.call(list.querySelectorAll('.toc-link[data-index]'));

  function setPager(link) {
    if (!pager || !link) return;
    var n = allLinks.indexOf(link);
    var prev = allLinks[(n - 1 + allLinks.length) % allLinks.length];
    var next = allLinks[(n + 1) % allLinks.length];
    pager.querySelector('.pager-prev').setAttribute('href', prev.getAttribute('href'));
    pager.querySelector('.pager-next').setAttribute('href', next.getAttribute('href'));
  }

  function placePager() {
    if (!pager || pager.hidden) return;
    var box = mediaBox();
    // The same frame as the media: placed for the top of the page.
    var top = box.top + box.height;
    pager.style.left = box.left + 'px';
    pager.style.width = box.width + 'px';
    pager.style.top = top + 'px';
    pager.style.height = Math.max(window.innerHeight - top, 0) + 'px';
  }

  var pagerTimers = [];
  function showPager(delay) {
    if (!pager) return;
    pagerTimers.forEach(clearTimeout);
    pagerTimers = [];
    if (!pager.hidden) return;
    pagerTimers.push(setTimeout(function () {
      pager.hidden = false;
      placePager();
      steps(pager, true);
    }, delay));
  }

  function hidePager() {
    if (!pager) return;
    pagerTimers.forEach(clearTimeout);
    pagerTimers = [];
    if (pager.hidden) return;
    steps(pager, false, function () { pager.hidden = true; });
  }

  // Shows (in = true) or hides an element in MEDIA_STEPS chunks of its
  // height, from the top in, and from the bottom out.
  function steps(element, show, done) {
    for (var n = 1; n <= MEDIA_STEPS; n++) {
      (function (n) {
        pagerTimers.push(setTimeout(function () {
          var share = show ? 100 - (100 * n) / MEDIA_STEPS : (100 * n) / MEDIA_STEPS;
          element.style.clipPath = show && n === MEDIA_STEPS ? '' : 'inset(0 0 ' + share + '% 0)';
        }, n * MEDIA_STEP));
      })(n);
    }
    if (show) element.style.clipPath = 'inset(0 0 100% 0)';
    pagerTimers.push(setTimeout(function () {
      if (!show) element.style.clipPath = '';
      if (done) done();
    }, (MEDIA_STEPS + 1) * MEDIA_STEP));
  }

  if (pager) {
    pager.addEventListener('click', function (event) {
      var target = event.target.closest('a');
      if (!target || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var link = list.querySelector('.toc-link[href="' + target.getAttribute('href') + '"]');
      if (!link) return;
      event.preventDefault();
      openArtist(link, true);
    });
  }

  function placeMedia() {
    if (!media || media.hidden) return;
    var box = mediaBox();
    media.style.width = box.width + 'px';
    media.style.height = box.height + 'px';
    media.style.left = box.left + 'px';
    media.style.top = box.top + 'px';
  }

  function clearMedia() {
    mediaTimers.forEach(clearTimeout);
    mediaTimers = [];
  }

  function showMedia(article, delay) {
    if (!media) return;
    clearMedia();
    media.innerHTML = '';
    media.hidden = true;
    if (!article) return;
    var video = article.dataset.video;
    var poster = article.dataset.poster;
    if (!video && !poster) return;

    mediaTimers.push(setTimeout(function () {
      var element;
      if (video) {
        element = document.createElement('iframe');
        element.src = video;
        element.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
        element.allowFullscreen = true;
        // YouTube refuses to play an embed that sends no referrer.
        element.referrerPolicy = 'strict-origin-when-cross-origin';
        element.title = 'Artwork video';
      } else {
        element = document.createElement('img');
        element.src = poster;
        element.alt = '';
      }
      media.appendChild(element);
      media.style.clipPath = 'inset(0 0 100% 0)';
      media.hidden = false;
      placeMedia();
      for (var n = 1; n <= MEDIA_STEPS; n++) {
        (function (n) {
          mediaTimers.push(setTimeout(function () {
            media.style.clipPath = n === MEDIA_STEPS ? '' : 'inset(0 0 ' + (100 - (100 * n) / MEDIA_STEPS) + '% 0)';
          }, n * MEDIA_STEP));
        })(n);
      }
    }, delay));
  }

  function hideMedia() {
    if (!media) return;
    clearMedia();
    if (media.hidden) return;
    for (var n = 1; n <= MEDIA_STEPS; n++) {
      (function (n) {
        mediaTimers.push(setTimeout(function () {
          media.style.clipPath = 'inset(0 0 ' + (100 * n) / MEDIA_STEPS + '% 0)';
        }, n * MEDIA_STEP));
      })(n);
    }
    mediaTimers.push(setTimeout(function () {
      media.hidden = true;
      media.innerHTML = '';
      media.style.clipPath = '';
    }, (MEDIA_STEPS + 1) * MEDIA_STEP));
  }

  // Fires the laser from the artist's chunk and flies the camera out along
  // it, or with null, flies back (see focusGroup in ship/src/main.js). The
  // flight takes the whole transition time, so the camera ends last.
  function focusGroup(group) {
    if (!frame || !frame.contentWindow) return;
    // The centre goes first, so the ship has it when it plans the view.
    if (group !== null) sendFocusCenter();
    frame.contentWindow.postMessage(
      { type: 'ship:focus', group: group, duration: transitionTime() / 1000 },
      window.location.origin
    );
  }

  // One time for the transitions to and from an artist, in milliseconds: the
  // longer of the two, plus CAMERA_LAST, times CAMERA_SLOW. Each direction's steps are timed
  // from the layout, so the camera, which takes the whole time, always ends
  // last, and both directions take the same time.
  // - To an artist: the rows close, then the text's lines in the window come
  //   in; the media comes in after MEDIA_DELAY.
  // - Back: the text's lines in the window go, then the rows open.
  var CAMERA_LAST = 300;
  // Stretches the whole time, so the camera moves more slowly still. The
  // page's own steps keep their pace, so they end well before the camera.
  var CAMERA_SLOW = 1.4;
  function transitionTime() {
    var rows = screenRows().length * ROW_DELAY;
    var line = parseFloat(getComputedStyle(list).lineHeight) || 16.5;
    var top = list.getBoundingClientRect().top;
    var lines = Math.max(0, Math.ceil((window.innerHeight - top) / line));
    var to = Math.max(rows + lines * INFO_IN, MEDIA_DELAY + (MEDIA_STEPS + 1) * MEDIA_STEP);
    var back = lines * INFO_OUT + rows;
    return (Math.max(to, back) + CAMERA_LAST) * CAMERA_SLOW;
  }

  // The entries, grouped by their row on the screen. The listing fills its
  // columns from top to bottom, so one screen row holds one entry of each
  // column. Rows are sorted from the top.
  function screenRows() {
    var rows = {};
    entries.forEach(function (entry) {
      var top = Math.round(entry.getBoundingClientRect().top);
      (rows[top] = rows[top] || []).push(entry);
    });
    return Object.keys(rows)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (top) { return rows[top]; });
  }

  function stop() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  // Hides (gone = true) or shows the rows one at a time, in `order`.
  function step(rows, gone) {
    stop();
    rows.forEach(function (row, n) {
      timers.push(setTimeout(function () { setGone(row, gone); }, n * ROW_DELAY));
    });
  }

  function setGone(row, gone) {
    row.forEach(function (entry) { entry.classList.toggle('is-gone', gone); });
  }

  // Hides the tiles left of `share` of their column's width (0 shows them
  // whole, 1 hides them). The frames are clipped here. The ship clips its
  // tile pictures at the same edge, in viewport pixels.
  function clipTiles(share) {
    if (!stack) return;
    var rect = stack.getBoundingClientRect();
    var inset = share * rect.width;
    stack.style.clipPath = share > 0 ? 'inset(0 0 0 ' + inset + 'px)' : '';
    // A clipped tile must not take clicks or hovers.
    stack.style.pointerEvents = share > 0 ? 'none' : '';
    stack.classList.remove('is-hidden');
    if (frame && frame.contentWindow) {
      frame.contentWindow.postMessage(
        { type: 'ship:panelClip', x: share > 0 ? rect.left + inset : null },
        window.location.origin
      );
    }
  }

  // Hides the tiles from left to right, or shows them again in the reverse
  // order, one chunk at a time.
  function stepTiles(hide) {
    tileTimers.forEach(clearTimeout);
    tileTimers = [];
    for (var n = 1; n <= TILE_STEPS; n++) {
      (function (n) {
        var share = hide ? n / TILE_STEPS : 1 - n / TILE_STEPS;
        tileTimers.push(setTimeout(function () { clipTiles(share); }, n * ROW_DELAY));
      })(n);
    }
  }

  // Returns the milliseconds until the last row is gone.
  // The shade behind the text column comes in from left to right in
  // SHADE_STEPS vertical strips, and goes from right to left, at the rows'
  // pace. Its strips span from the window's left edge to where its gradient
  // ends (see .artwork-shade in main.css).
  var shade = document.querySelector('.artwork-shade');
  var SHADE_STEPS = 8;
  var shadeTimers = [];
  var shadeShown = 0; // strips in view

  function shadeWidth() {
    var column = list.querySelector('.toc-title');
    var right = column ? column.getBoundingClientRect().right : window.innerWidth / 3;
    // The gradient ends 8rem past the column's edge.
    return right + 8 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  }

  function setShade(strips) {
    shadeShown = strips;
    if (!shade) return;
    var shown = (shadeWidth() * strips) / SHADE_STEPS;
    shade.style.clipPath = strips >= SHADE_STEPS ? 'none' : 'inset(0 calc(100% - ' + shown + 'px) 0 0)';
  }

  function stepShade(show) {
    shadeTimers.forEach(clearTimeout);
    shadeTimers = [];
    var from = shadeShown;
    var to = show ? SHADE_STEPS : 0;
    var count = Math.abs(to - from);
    for (var n = 1; n <= count; n++) {
      (function (n) {
        shadeTimers.push(setTimeout(function () {
          setShade(from + (show ? n : -n));
        }, n * ROW_DELAY));
      })(n);
    }
  }

  function collapse(next) {
    state = next || 'artist';
    list.classList.add('is-collapsed');
    var rows = screenRows().reverse();
    step(rows, true);
    stepTiles(true);
    stepShade(true);
    return rows.length * ROW_DELAY;
  }

  // ── Artwork information ────────────────────────────────────────────────
  //
  // Each artist has a hidden block in the artwork panel, under the title box.
  // A block appears line by line from the top, and goes line by line from
  // the bottom of what is in view. Every line in the panel is one --line
  // high, so a clip that grows or shrinks by one line height per step shows
  // or hides exactly one line of text. These steps are much faster than the
  // listing's rows, because there is much more text.
  var panel = document.querySelector('.artwork-panel');
  var articles = panel ? Array.prototype.slice.call(panel.querySelectorAll('.artwork-info')) : [];
  var INFO_IN = 15; // milliseconds per line to appear
  var INFO_OUT = 10; // milliseconds per line to go
  var infoTimers = [];
  var shownInfo = articles.filter(function (a) { return !a.hidden; })[0] || null;

  function lineHeight() {
    return parseFloat(getComputedStyle(panel).lineHeight) || 16.5;
  }


  function clearInfo() {
    infoTimers.forEach(clearTimeout);
    infoTimers = [];
  }

  function articleFor(link) {
    var slug = link.getAttribute('href').split('/').filter(Boolean).pop();
    return articles.filter(function (a) { return a.dataset.slug === slug; })[0] || null;
  }

  // Shows `article` line by line, after `delay` milliseconds. Only the lines
  // in view step in. The rest is there when the steps end.
  function revealInfo(article, delay) {
    if (!panel || !article) return;
    clearInfo();
    articles.forEach(function (a) {
      a.hidden = a !== article;
      a.style.clipPath = '';
    });
    shownInfo = article;
    article.style.clipPath = 'inset(0 0 100% 0)';
    panel.hidden = false;
    // Only the lines in the window step in.
    var line = lineHeight();
    var inView = window.innerHeight - article.getBoundingClientRect().top;
    var steps = Math.ceil(Math.max(0, Math.min(article.offsetHeight, inView)) / line);
    for (var n = 1; n <= steps; n++) {
      (function (n) {
        infoTimers.push(setTimeout(function () {
          article.style.clipPath = 'inset(0 0 calc(100% - ' + n * line + 'px) 0)';
        }, delay + n * INFO_IN));
      })(n);
    }
    infoTimers.push(setTimeout(function () { article.style.clipPath = ''; }, delay + (steps + 1) * INFO_IN));
  }

  // Hides the shown block line by line, from the bottom of what is in the
  // window, then scrolls the page back to the top and calls `done`.
  function concealInfo(done) {
    clearInfo();
    var article = shownInfo;
    if (!panel || panel.hidden || !article) {
      if (done) done();
      return;
    }
    var line = lineHeight();
    var rect = article.getBoundingClientRect();
    var top = Math.max(0, -rect.top);
    var bottom = Math.min(article.offsetHeight, window.innerHeight - rect.top);
    var steps = Math.ceil((bottom - top) / line);
    for (var n = 1; n <= steps; n++) {
      (function (n) {
        infoTimers.push(setTimeout(function () {
          var cut = Math.max(bottom - n * line, 0);
          article.style.clipPath = 'inset(0 0 ' + (article.offsetHeight - cut) + 'px 0)';
        }, n * INFO_OUT));
      })(n);
    }
    infoTimers.push(setTimeout(function () {
      article.hidden = true;
      article.style.clipPath = '';
      panel.hidden = true;
      shownInfo = null;
      window.scrollTo(0, 0);
      if (done) done();
    }, (steps + 1) * INFO_OUT));
  }

  function expand() {
    state = 'list';
    list.classList.remove('is-collapsed');
    step(screenRows(), false);
    stepTiles(false);
  }

  function openArtist(link, push) {
    var name = link.querySelector('.toc-name');
    document.title = (name ? name.textContent + ' — ' : '') + HOME_TITLE.replace(/^.*—\s*/, '');
    if (push) history.pushState({ artist: link.getAttribute('href') }, '', link.getAttribute('href'));
    var article = articleFor(link);
    setPager(link);
    showPager(MEDIA_DELAY);
    hideMedia();
    // The media waits for the camera to reach the new view.
    mediaTimers.push(setTimeout(function () { showMedia(article, 0); }, MEDIA_DELAY));
    list.classList.remove('is-about');
    if (state === 'about') {
      state = 'artist';
      sendViewCenter();
    }
    if (state !== 'list') {
      // From one artist, or the about text, to another artist: the old text
      // goes, then the new comes.
      state = 'artist';
      concealInfo(function () { revealInfo(article, 0); });
    } else {
      // The text comes in once the listing has closed.
      revealInfo(article, collapse());
    }
    // ship-highlight.js reads this to go back to this artist's light.
    list.dataset.selected = link.dataset.index;
    lightGroup(Number(link.dataset.index));
    focusGroup(Number(link.dataset.index));
  }

  // The about text in the text panel, in the same frame as an artwork, but
  // with no media, no pager, and no laser: the camera goes back to the
  // listing's view.
  var aboutArticle = articles.filter(function (a) { return a.dataset.slug === 'about'; })[0] || null;
  function openAbout(push) {
    if (state === 'about' || !aboutArticle) return;
    document.title = 'About — ' + HOME_TITLE.replace(/^.*—\s*/, '');
    if (push) history.pushState({ about: true }, '', '/about/');
    hideMedia();
    hidePager();
    delete list.dataset.selected;
    list.classList.add('is-about');
    lightGroup(null);
    focusGroup(null);
    if (state === 'artist') {
      state = 'about';
      concealInfo(function () { revealInfo(aboutArticle, 0); });
    } else {
      revealInfo(aboutArticle, collapse('about'));
    }
    sendViewCenter();
  }

  // The "?" box opens the about text, and closes it again.
  var aboutLink = list.querySelector('.title-box-about');
  if (aboutLink) {
    aboutLink.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (state === 'about') openHome(true);
      else openAbout(true);
    });
  }

  function openHome(push) {
    document.title = HOME_TITLE;
    list.classList.remove('is-about');
    state = 'list';
    sendViewCenter();
    if (push) history.pushState({}, '', '/');
    // The text goes first, then the listing opens in its place.
    state = 'list';
    hideMedia();
    hidePager();
    stepShade(false);
    concealInfo(expand);
    delete list.dataset.selected;
    lightGroup(null);
    focusGroup(null);
  }

  list.addEventListener('click', function (event) {
    var link = event.target.closest('.toc-link');
    // A modified click keeps its normal job, such as a new tab.
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openArtist(link, true);
  });

  // The site name is a link to "/". In the artist view, it goes back to the
  // listing without a reload. In the listing, it does nothing.
  if (title) {
    title.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (state !== 'list') openHome(true);
    });
  }

  // On the listing URL, the listing opens the same way as on the way back
  // from an artist: the rows start hidden and come in one at a time from the
  // top down, after a short pause that shows the title box alone first.
  // This script runs at the end of the body, before the first paint, so the
  // full listing does not flash first. Without JavaScript, the listing shows
  // at once.
  var INTRO_PAUSE = 250; // milliseconds

  // ── First load ───────────────────────────────────────────────────────────
  //
  // Nothing moves until the fonts are in and the ship has warmed up and sent
  // 'ship:shown' (see warmUp in ship/src/main.js). The ship shares this
  // page's main thread, so the rows would step unevenly while it builds and
  // compiles. Until then, the title box shows alone, with a small stepped
  // LOADING under it. After READY_LIMIT, the page starts anyway.
  var READY_LIMIT = 8000; // milliseconds
  var shipShown = new Promise(function (resolve) {
    if (!frame) return resolve();
    window.addEventListener('message', function onShown(event) {
      if (event.origin !== window.location.origin || event.source !== frame.contentWindow) return;
      if (!event.data || event.data.type !== 'ship:shown') return;
      window.removeEventListener('message', onShown);
      resolve();
    });
  });
  var fontsIn = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  var ready = Promise.race([
    Promise.all([fontsIn, shipShown]),
    new Promise(function (resolve) { setTimeout(resolve, READY_LIMIT); }),
  ]);

  // The loader: LOADING and one to three dots, one step at a time.
  var loader = document.createElement('p');
  loader.className = 'toc-loading';
  loader.setAttribute('role', 'status');
  loader.textContent = 'Loading';
  (list.closest('.toc') || list.parentNode).appendChild(loader);
  var dots = 0;
  var loaderTimer = setInterval(function () {
    dots = (dots + 1) % 4;
    loader.textContent = 'Loading' + '...'.slice(0, dots);
  }, 250);

  // On an artist URL, the text starts hidden too, so it does not flash before
  // its line-by-line entry.
  if (state !== 'list' && shownInfo) shownInfo.style.clipPath = 'inset(0 0 100% 0)';
  if (state === 'list') {
    entries.forEach(function (entry) { entry.classList.add('is-gone'); });
  }

  ready.then(function () {
    clearInterval(loaderTimer);
    loader.remove();
    // On an artist URL, the text comes in line by line after a short pause.
    if (state === 'artist' && shownInfo) {
      stepShade(true);
      revealInfo(shownInfo, INTRO_PAUSE);
      showMedia(shownInfo, INTRO_PAUSE + MEDIA_DELAY);
      var current = list.querySelector('.toc-link[data-index="' + list.dataset.selected + '"]');
      setPager(current);
      showPager(INTRO_PAUSE + MEDIA_DELAY);
    }
    // On the about URL, only the text comes in.
    if (state === 'about' && shownInfo) {
      stepShade(true);
      revealInfo(shownInfo, INTRO_PAUSE);
    }
    if (state === 'list') {
      timers.push(setTimeout(function () { step(screenRows(), false); }, INTRO_PAUSE));
    }
  });

  // On an artist URL, light that artist's chunk as soon as the ship is up.
  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) return;
    if (!frame || event.source !== frame.contentWindow) return;
    if (!event.data) return;
    if (event.data.type === 'ship:ready' && list.dataset.selected !== undefined) {
      lightGroup(Number(list.dataset.selected));
      focusGroup(Number(list.dataset.selected));
    }
    // An artist URL and the about URL start with the tiles hidden. The about
    // URL also starts with the ship in the space right of the text.
    if (event.data.type === 'ship:ready' && state !== 'list') clipTiles(1);
    if (event.data.type === 'ship:ready' && state === 'about') sendViewCenter();
    // On the artwork view, the ship passes the wheel to the page, so the
    // page scrolls with the text also when the pointer is over the ship.
    if (event.data.type === 'ship:wheel') {
      window.scrollBy(0, event.data.dy);
      return;
    }
    // On the artwork view, a click on the ship goes back to the listing, the
    // same as a click on the site name.
    if (event.data.type === 'ship:home') {
      if (state !== 'list') openHome(true);
      return;
    }
    // A click on a chunk of the ship chooses that artist, the same as a click
    // on the name. A click on the chosen artist's chunk does nothing.
    if (event.data.type === 'ship:select') {
      var link = list.querySelector('.toc-link[data-index="' + event.data.group + '"]');
      if (link && list.dataset.selected !== link.dataset.index) openArtist(link, true);
    }
  });

  window.addEventListener('popstate', function () {
    var path = window.location.pathname;
    var link = list.querySelector('.toc-link[href="' + path + '"]');
    if (link) openArtist(link, false);
    else if (path === '/about/') openAbout(false);
    else openHome(false);
  });
})();
