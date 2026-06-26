export const runtime = "nodejs";
export const dynamic = "force-static";

/**
 * Serves the first-party tracking snippet for arbor-mgmt.com. Install once:
 *   <script async src="https://app.arbor-mgmt.com/track.js"></script>
 *
 * The snippet manages `arbor_vid`/`arbor_sid` as first-party cookies on the site,
 * captures attribution (UTM / click IDs / referrer / landing page / GA client id),
 * sends a pageview, and captures form submissions — all without blocking the page.
 * DNI number-swap is added in Phase 4; the structure leaves room for it.
 */
const SNIPPET = String.raw`(function () {
  try {
    var script = document.currentScript;
    var ENDPOINT = new URL('/api/track', script ? script.src : location.origin).toString();
    var VID_DAYS = 730, SID_MIN = 30;

    function getCookie(n) {
      var m = document.cookie.match('(?:^|; )' + n + '=([^;]*)');
      return m ? decodeURIComponent(m[1]) : null;
    }
    function rootDomain() {
      var h = location.hostname;
      if (h === 'localhost' || /^[0-9.]+$/.test(h)) return null;
      var p = h.split('.');
      return p.length > 2 ? '.' + p.slice(-2).join('.') : h;
    }
    function setCookie(n, v, maxAgeSec) {
      var d = rootDomain();
      document.cookie =
        n + '=' + encodeURIComponent(v) + ';path=/;max-age=' + maxAgeSec +
        ';SameSite=Lax' + (location.protocol === 'https:' ? ';Secure' : '') +
        (d ? ';domain=' + d : '');
    }
    function uuid() {
      if (crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    }

    // Visitor (2yr) + session (30-min sliding) identity.
    var vid = getCookie('arbor_vid');
    if (!vid) { vid = uuid(); }
    setCookie('arbor_vid', vid, VID_DAYS * 86400);

    var sid = getCookie('arbor_sid');
    var sidTs = parseInt(getCookie('arbor_sid_ts') || '0', 10);
    var now = Date.now();
    if (!sid || !sidTs || now - sidTs > SID_MIN * 60000) { sid = uuid(); }
    setCookie('arbor_sid', sid, SID_MIN * 60);
    setCookie('arbor_sid_ts', String(now), SID_MIN * 60);

    function qp() {
      var p = new URLSearchParams(location.search);
      return function (k) { return p.get(k) || undefined; };
    }
    var g = qp();
    function gaClientId() {
      var ga = getCookie('_ga');
      if (!ga) return undefined;
      var parts = ga.split('.');
      return parts.length >= 4 ? parts.slice(-2).join('.') : undefined;
    }

    var base = {
      vid: vid,
      sid: sid,
      url: location.href,
      referrer: document.referrer || undefined,
      ga: gaClientId(),
      utm: {
        source: g('utm_source'), medium: g('utm_medium'), campaign: g('utm_campaign'),
        term: g('utm_term'), content: g('utm_content')
      },
      click: {
        gclid: g('gclid'), gbraid: g('gbraid'), wbraid: g('wbraid'),
        fbclid: g('fbclid'), msclkid: g('msclkid')
      }
    };

    function send(payload) {
      var body = JSON.stringify(payload);
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }));
          return;
        }
      } catch (e) {}
      // text/plain avoids a CORS preflight; keepalive lets it finish on unload.
      fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true,
        headers: { 'Content-Type': 'text/plain' } }).catch(function () {});
    }

    function merge(extra) {
      var o = {}; for (var k in base) o[k] = base[k]; for (var j in extra) o[j] = extra[j]; return o;
    }

    send(merge({ event: 'pageview' }));

    // Form capture — never block the site's own submit (capture phase, no preventDefault).
    document.addEventListener('submit', function (ev) {
      var form = ev.target;
      if (!form || form.tagName !== 'FORM') return;
      if (form.hasAttribute('data-arbor-ignore')) return;
      var fields = {};
      try {
        new FormData(form).forEach(function (v, k) {
          if (typeof v === 'string') fields[k] = v;
        });
      } catch (e) {}
      send(merge({
        event: 'form_submit',
        form: {
          formId: form.getAttribute('id') || form.getAttribute('name') || undefined,
          pageUrl: location.href,
          fields: fields
        }
      }));
    }, true);
  } catch (e) { /* never break the host page */ }
})();`;

export function GET() {
  return new Response(SNIPPET, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
