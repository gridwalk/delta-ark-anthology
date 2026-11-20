// Lights an entry's buildings on the ship backdrop while its link is hovered
// or focused, and tells the ship where to draw its fixed panel views.
//
// The ship is framed, so it is driven by postMessage. Each link's data-index
// is its group on the ship, which the iframe allocates from ?groups= at load.
(function () {
  var frame = document.querySelector('.ship-backdrop');
  if (!frame) return;

  function post(message) {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage(message, window.location.origin);
  }

  function send(group) {
    post({ type: 'ship:highlight', group: group });
  }

  // The ship draws its fixed views inside the panel frames. It needs their
  // inner rectangles, in viewport pixels, which match its own because the
  // iframe fills the viewport.
  var panels = document.querySelectorAll('.ship-panel');
  var links = document.querySelectorAll('.toc-link[data-index]');
  var shipReady = false;

  function sendPanels() {
    if (!shipReady || !panels.length) return;
    var rects = Array.prototype.map.call(panels, function (panel) {
      var r = panel.getBoundingClientRect();
      return {
        x: r.left + panel.clientLeft,
        y: r.top + panel.clientTop,
        width: panel.clientWidth,
        height: panel.clientHeight,
      };
    });
    post({ type: 'ship:panels', rects: rects });
  }

  // EXPERIMENT: two-way navigation. A container under the pointer on the
  // ship lights its group there, and the ship sends { type: 'ship:hover',
  // group }. The matching name gets the hover look, from the class below.
  function markShipHover(group) {
    links.forEach(function (link) {
      link.classList.toggle('is-ship-hover', Number(link.dataset.index) === group);
    });
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) return;
    if (event.source !== frame.contentWindow) return;
    if (event.data && event.data.type === 'ship:hover') {
      var group = event.data.group;
      markShipHover(Number.isInteger(group) ? group : null);
      // The pointer left the ship. Clear the light unless the pointer is now
      // on a name, which has lit its own group.
      // In the artist view (see page-nav.js), go back to the chosen artist.
      if (event.data.left && !document.querySelector('.toc-link:hover')) {
        var list = document.querySelector('.toc-list');
        var selected = list && list.dataset.selected;
        send(selected !== undefined ? Number(selected) : null);
      }
      return;
    }
    if (event.data && event.data.type === 'ship:ready') {
      shipReady = true;
      sendPanels();
    }
  });

  // A click on a panel flies the main view to that panel's view. While the
  // pointer is over a panel, the rectangle inside it follows the pointer;
  // the position goes as shares of the panel's inner box from its top left.
  panels.forEach(function (panel, index) {
    panel.addEventListener('click', function () {
      post({ type: 'ship:view', index: index });
    });
    panel.addEventListener('mousemove', function (event) {
      var r = panel.getBoundingClientRect();
      post({
        type: 'ship:cursor',
        index: index,
        x: (event.clientX - r.left - panel.clientLeft) / panel.clientWidth,
        y: (event.clientY - r.top - panel.clientTop) / panel.clientHeight,
      });
    });
    panel.addEventListener('mouseleave', function () {
      post({ type: 'ship:cursor', index: index, x: null });
    });
  });

  if (panels.length) {
    window.addEventListener('resize', sendPanels);
    window.addEventListener('scroll', sendPanels, { passive: true });
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(sendPanels);
      panels.forEach(function (panel) { observer.observe(panel); });
    }
  }

  links.forEach(function (link) {
    var group = Number(link.dataset.index);
    link.addEventListener('mouseenter', function () { send(group); });
    link.addEventListener('focus', function () { send(group); });
    // While the listing is collapsed (see page-nav.js), the chosen artist
    // stays lit. A row that hides under the pointer fires mouseleave, which
    // must not clear that light.
    function leave() {
      if (link.closest('.toc-list.is-collapsed')) return;
      send(null);
    }
    link.addEventListener('mouseleave', leave);
    link.addEventListener('blur', leave);
  });
})();
