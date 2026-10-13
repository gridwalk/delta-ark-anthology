// Numbered holds, layered on top of the homepage. Each entry gets a number.
// While an entry is lit, the ship picks one of its apartments and reports
// where it is on screen (ship:anchor). The number sits on it on a white tag,
// and a line runs to the tag from the end of the entry: down the gap between
// columns, along under the listing, then down onto a rooftop, or down beside
// the tower and in at the apartment's floor. A click flies the view up to the
// apartment, then cuts to black and opens the artist page.
//
// ship-highlight.js still does the lighting. This only adds to it.
(function () {
  var frame = document.querySelector('.ship-backdrop');
  var list = document.querySelector('.toc-list');
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc-link[data-index]'));
  if (!frame || !list || !links.length) return;

  var origin = window.location.origin;
  var still = window.matchMedia('(prefers-reduced-motion: reduce)');

  // The ship's camera move takes 1.2s; the cut comes a beat after it lands.
  var FLY_MS = 1300;
  // How long the line takes to draw out to the tag.
  var DRAW_MS = 220;

  var hot = null;
  var anchor = null;
  var drawnAt = 0;
  var leaving = false;

  function num(i) {
    return (i < 9 ? '0' : '') + (i + 1);
  }

  function post(message) {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage(message, origin);
  }

  links.forEach(function (link, i) {
    var n = document.createElement('span');
    n.className = 'toc-num';
    n.textContent = num(i);
    link.insertBefore(n, link.firstChild);
  });

  var svgNS = 'http://www.w3.org/2000/svg';
  var layer = document.createElement('div');
  layer.className = 'hold-layer';
  layer.setAttribute('aria-hidden', 'true');
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'hold-line');
  var line = document.createElementNS(svgNS, 'polyline');
  var dot = document.createElementNS(svgNS, 'rect');
  dot.setAttribute('width', '5');
  dot.setAttribute('height', '5');
  svg.appendChild(line);
  svg.appendChild(dot);
  var tag = document.createElement('span');
  tag.className = 'hold-tag';
  tag.style.visibility = 'hidden';
  layer.appendChild(svg);
  layer.appendChild(tag);
  var veil = document.createElement('div');
  veil.className = 'hold-veil';
  document.body.appendChild(layer);
  document.body.appendChild(veil);

  function gap() {
    return parseFloat(getComputedStyle(list).columnGap) || 0;
  }

  // The line's run under the listing, half a column gap below it.
  function lane() {
    return list.getBoundingClientRect().bottom + gap() / 2;
  }

  function tagHeight() {
    return parseFloat(getComputedStyle(tag).lineHeight) || 0;
  }

  // Tells the ship which entry is lit, where it sits across the page, where
  // the line runs under the listing, and how high a tag can sit before it
  // would cover the listing. A click focuses the entry it lands on, which is
  // already lit, so that changes nothing.
  function hold(i) {
    if (i === hot) return;
    hot = i;
    anchor = null;
    if (i === null) {
      post({ type: 'ship:hold', group: null });
    } else {
      var r = links[i].getBoundingClientRect();
      var y1 = lane();
      post({ type: 'ship:hold', group: i, x: r.left + r.width / 2, lane: y1, ceiling: y1 + tagHeight() / 2 + 3, tag: tagHeight() });
    }
    draw();
  }

  function draw() {
    if (hot === null || !anchor) {
      tag.style.visibility = 'hidden';
      svg.style.visibility = 'hidden';
      return;
    }

    tag.textContent = num(hot);
    var row = links[hot].getBoundingClientRect();
    var x = Math.round(anchor.x);
    var y = Math.round(anchor.y);
    var top = Math.round(y - tagHeight() / 2);
    var x0 = Math.round(row.right) + 1;
    var y0 = Math.round(row.top + row.height / 2);
    var gx = Math.round(row.right + gap() / 2);
    var y1 = Math.round(lane());
    var points;
    if (anchor.drop == null) {
      points = top > y1
        ? [[x0, y0], [gx, y0], [gx, y1], [x, y1], [x, top]]
        : [[x0, y0], [gx, y0], [gx, y1], [x, y1]];
    } else {
      var dx = Math.round(anchor.drop);
      var edge = Math.round(dx < x ? x - tag.offsetWidth / 2 : x + tag.offsetWidth / 2);
      points = [[x0, y0], [gx, y0], [gx, y1], [dx, y1], [dx, y], [edge, y]];
    }
    var length = 0;
    for (var k = 1; k < points.length; k++) {
      length += Math.abs(points[k][0] - points[k - 1][0]) + Math.abs(points[k][1] - points[k - 1][1]);
    }
    var t = Math.min(1, (performance.now() - drawnAt) / DRAW_MS);

    line.setAttribute('points', points.map(function (p) { return p.join(','); }).join(' '));
    line.style.strokeDasharray = length;
    line.style.strokeDashoffset = length * Math.pow(1 - t, 3);
    dot.setAttribute('x', x0 - 2);
    dot.setAttribute('y', y0 - 2);
    svg.style.visibility = 'visible';

    tag.style.transform = 'translate(' + x + 'px, ' + top + 'px) translateX(-50%)';
    tag.style.visibility = t < 0.8 ? 'hidden' : 'visible';
  }

  // The ship sends the tag's position every frame while an entry is lit.
  window.addEventListener('message', function (event) {
    if (event.origin !== origin || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.type !== 'ship:anchor') return;
    if (data.group === null || data.group !== hot) {
      anchor = null;
    } else {
      if (!anchor) drawnAt = performance.now();
      anchor = data;
    }
    draw();
  });

  function open(event, i) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (leaving) {
      event.preventDefault();
      return;
    }
    if (still.matches || !anchor || hot !== i) return;
    event.preventDefault();
    leaving = true;
    links[i].classList.add('is-hot');
    links[i].parentNode.classList.add('is-picked');
    document.body.classList.add('holds-leaving');
    post({ type: 'ship:focus', group: i });
    var href = links[i].href;
    setTimeout(function () {
      veil.classList.add('is-on');
      window.location.href = href;
    }, FLY_MS);
  }

  // Once a click has started the flight, the entry stays lit even if the
  // pointer drifts off it. Capturing listeners on the link itself run before
  // ship-highlight.js's handlers, so they can stop it unlighting the ship.
  links.forEach(function (link) {
    ['mouseleave', 'blur'].forEach(function (type) {
      link.addEventListener(type, function (event) {
        if (leaving) event.stopImmediatePropagation();
      }, true);
    });
  });

  links.forEach(function (link, i) {
    link.addEventListener('mouseenter', function () { if (!leaving) hold(i); });
    link.addEventListener('focus', function () { if (!leaving) hold(i); });
    link.addEventListener('mouseleave', function () { if (!leaving) hold(null); });
    link.addEventListener('blur', function () { if (!leaving) hold(null); });
    link.addEventListener('click', function (event) { open(event, i); });
  });

  // Coming back from an artist page with the back button: undo the flight.
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    leaving = false;
    veil.classList.remove('is-on');
    document.body.classList.remove('holds-leaving');
    links.forEach(function (link) {
      link.classList.remove('is-hot');
      link.parentNode.classList.remove('is-picked');
    });
    hold(null);
    post({ type: 'ship:highlight', group: null });
    post({ type: 'ship:focus', group: null });
  });
})();
