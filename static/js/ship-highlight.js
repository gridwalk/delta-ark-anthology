// Lights an entry's buildings on the ship backdrop while its link is hovered
// or focused.
//
// The ship is framed, so it is driven by postMessage. Each link's data-index
// is its group on the ship, which the iframe allocates from ?groups= at load.
(function () {
  var frame = document.querySelector('.ship-backdrop');
  if (!frame) return;

  function send(group) {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage(
      { type: 'ship:highlight', group: group },
      window.location.origin
    );
  }

  var links = document.querySelectorAll('.toc-link[data-index]');
  links.forEach(function (link) {
    var group = Number(link.dataset.index);
    link.addEventListener('mouseenter', function () { send(group); });
    link.addEventListener('focus', function () { send(group); });
    link.addEventListener('mouseleave', function () { send(null); });
    link.addEventListener('blur', function () { send(null); });
  });
})();
