// TUNING: a temporary panel to set the dither and the fog on the ship.
// Remove this file, its script tag in toc.njk, and the 'ship:tune' message in
// ship/src/main.js when the values are final.
//
// Open the homepage with ?tune=1 to show the panel. The ship sends its current
// values with 'ship:ready'. Each slider sends all values back with
// 'ship:tune'. The panel keeps your values in this browser, so a reload keeps
// them. "Copy values" copies them as JSON to paste into a chat.
(function () {
  if (new URLSearchParams(window.location.search).get('tune') !== '1') return;
  var frame = document.querySelector('.ship-backdrop');
  if (!frame) return;

  var STORE = 'ship-tune';

  // [group, key, label, min, max, step]
  var CONTROLS = [
    ['dither', 'levels', 'Levels per channel', 2, 16, 1],
    ['dither', 'dot', 'Dot size (CSS px)', 1, 8, 1],
    ['dither', 'strength', 'Dither strength', 0, 1, 0.05],
    ['fog', 'front', 'Fog front (ship lengths)', -1, 3, 0.05],
    ['fog', 'back', 'Fog back (ship lengths)', 0, 6, 0.05],
    ['fog', 'curve', 'Fog curve (1 = linear)', 0.2, 10, 0.05],
    ['cargo', 'keep', 'Kept containers (share)', 0, 1, 0.05],
    ['cargo', 'build', 'Build speed (layers/s)', 5, 200, 5],
    ['cargo', 'overlap', 'Copy overlap (0 wait, 1 at once)', 0, 1, 0.05],
    ['tiles', 'fogPush', 'Tile fog push (ship lengths)', -2, 4, 0.05],
    ['tiles', 'lineWeight', 'Tile line weight (x main)', 1, 6, 0.25],
  ];

  var defaults = null; // from the ship
  var values = null;
  var inputs = {};

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE));
    } catch (e) {
      return null;
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(values));
    } catch (e) {
      // No storage: the values still apply until a reload.
    }
  }

  function send() {
    if (!frame.contentWindow || !values) return;
    var message = Object.assign({ type: 'ship:tune' }, values);
    frame.contentWindow.postMessage(message, window.location.origin);
  }

  function text() {
    return JSON.stringify(values, null, 2);
  }

  // ── Panel ────────────────────────────────────────────────────────────────

  var style = document.createElement('style');
  style.textContent = [
    '.ship-tune { position: fixed; left: 16px; bottom: 16px; z-index: 1000;',
    '  width: 280px; max-width: calc(100vw - 32px); padding: 12px;',
    '  background: rgba(11, 13, 18, 0.92); color: #fff; border: 1px solid #00b49b;',
    '  font: 12px/1.4 "Martian Mono", ui-monospace, monospace; pointer-events: auto; }',
    '.ship-tune h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; }',
    '.ship-tune h3 { margin: 10px 0 4px; font-size: 11px; font-weight: 600; color: #00b49b; text-transform: uppercase; }',
    '.ship-tune label { display: block; margin: 6px 0; }',
    '.ship-tune .row { display: flex; justify-content: space-between; }',
    '.ship-tune .val { color: #f15a30; font-variant-numeric: tabular-nums; }',
    '.ship-tune input[type=range] { width: 100%; margin: 2px 0 0; accent-color: #f15a30; }',
    '.ship-tune pre { margin: 10px 0 8px; padding: 6px; background: #000; white-space: pre; overflow: auto; font: inherit; user-select: all; }',
    '.ship-tune .buttons { display: flex; gap: 8px; }',
    '.ship-tune button { flex: 1; padding: 4px; font: inherit; color: #fff; background: none; border: 1px solid #fff; cursor: pointer; }',
    '.ship-tune button:hover { color: #f15a30; border-color: #f15a30; }',
  ].join('\n');
  document.head.appendChild(style);

  var panel = document.createElement('div');
  panel.className = 'ship-tune';
  panel.innerHTML = '<h2>Ship tuning</h2><p class="wait">Waiting for the ship…</p>';
  document.body.appendChild(panel);

  function format(value, step) {
    return step >= 1 ? String(value) : value.toFixed(2);
  }

  function build() {
    panel.innerHTML = '<h2>Ship tuning</h2>';
    var group = null;
    CONTROLS.forEach(function (c) {
      if (c[0] !== group) {
        group = c[0];
        var h = document.createElement('h3');
        h.textContent = group;
        panel.appendChild(h);
      }
      var label = document.createElement('label');
      label.innerHTML =
        '<span class="row"><span>' + c[2] + '</span><span class="val"></span></span>' +
        '<input type="range" min="' + c[3] + '" max="' + c[4] + '" step="' + c[5] + '">';
      var input = label.querySelector('input');
      var out = label.querySelector('.val');
      input.addEventListener('input', function () {
        values[c[0]][c[1]] = Number(input.value);
        out.textContent = format(values[c[0]][c[1]], c[5]);
        pre.textContent = text();
        save();
        send();
      });
      inputs[c[0] + '.' + c[1]] = { input: input, out: out, step: c[5] };
      panel.appendChild(label);
    });

    var pre = document.createElement('pre');
    panel.appendChild(pre);

    var buttons = document.createElement('div');
    buttons.className = 'buttons';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy values';
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(text()).then(
        function () { copy.textContent = 'Copied'; },
        function () { copy.textContent = 'Select the text above'; }
      );
      setTimeout(function () { copy.textContent = 'Copy values'; }, 1500);
    });
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.addEventListener('click', function () {
      values = JSON.parse(JSON.stringify(defaults));
      sync();
      save();
      send();
    });
    buttons.appendChild(copy);
    buttons.appendChild(reset);
    panel.appendChild(buttons);

    function sync() {
      CONTROLS.forEach(function (c) {
        var entry = inputs[c[0] + '.' + c[1]];
        entry.input.value = values[c[0]][c[1]];
        entry.out.textContent = format(values[c[0]][c[1]], entry.step);
      });
      pre.textContent = text();
    }
    sync();
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) return;
    if (event.source !== frame.contentWindow) return;
    if (!event.data || event.data.type !== 'ship:ready' || !event.data.tune) return;

    defaults = JSON.parse(JSON.stringify(event.data.tune));
    // Start from the saved values where they exist, and the ship's elsewhere.
    var saved = load() || {};
    values = JSON.parse(JSON.stringify(defaults));
    Object.keys(values).forEach(function (group) {
      Object.keys(values[group]).forEach(function (key) {
        var v = saved[group] && Number(saved[group][key]);
        if (Number.isFinite(v)) values[group][key] = v;
      });
    });
    build();
    send();
  });
})();
