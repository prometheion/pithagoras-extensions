/*
 * Loaded first in the stream page (Selkies' web client, in the viewer's frame), which the server half serves with it
 * (src/server/pages.ts), as `__gs_shim.js` beside it:
 *  - The client pauses the display's video when its tab is hidden; this keeps it shown, so a background tab keeps its
 *    stream.
 *  - The viewer page scales the whole stream page to fit the window; the client draws the video with nearest-neighbour
 *    filtering, which drops strokes from text at any scale but 1:1, so it is switched back to smooth scaling.
 *  - When the server ends this client's stream (a "KILL <reason>" message, sent when another tab or device connects),
 *    the client stops for good and leaves its last frame up. This tells the viewer page, which then says so.
 */
(() => {
  const d = Document.prototype;
  Object.defineProperty(d, 'hidden', {configurable: true, get: () => false});
  Object.defineProperty(d, 'visibilityState', {configurable: true, get: () => 'visible'});
  document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
  const style = document.createElement('style');
  style.textContent = '#videoStream{image-rendering:auto!important}';
  (document.head || document.documentElement).appendChild(style);
  // The client publishes its transport (a wrapper around the stream socket) as window.selkiesTransport.
  let transport;
  Object.defineProperty(window, 'selkiesTransport', {configurable: true, get: () => transport, set: t => {
    transport = t;
    if (t && t.addEventListener) t.addEventListener('message', e => {
      if (typeof e.data === 'string' && e.data.startsWith('KILL '))
        parent.postMessage({gsStream: 'ended', reason: e.data.slice(5)}, location.origin);
    });
  }});
})();
