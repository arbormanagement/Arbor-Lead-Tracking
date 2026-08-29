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
 *
 * SHADOW MODE — for running alongside CallRail during the migration:
 *   <script async src="https://app.arbor-mgmt.com/track.js" data-shadow></script>
 *
 * Shadow mode skips the DNI assign call entirely, so the snippet observes only and
 * never touches a phone number on the page. This has to be explicit: without it the
 * assign endpoint falls back to the oldest active *static* number when the pool is
 * empty (`getFallbackNumber`), so a "harmless" install would in fact rewrite every
 * `tel:` link on the site and race CallRail's swap.js for the displayed number.
 * Drop the attribute at cutover, once CallRail's swap.js is gone.
 */
const SNIPPET = String.raw`(function () {
  try {
    var script = document.currentScript;
    var ENDPOINT = new URL('/api/track', script ? script.src : location.origin).toString();
    var VID_DAYS = 730, SID_MIN = 30;
    // Observe-only: track everything, never touch a number on the page.
    var SHADOW = !!(script && script.hasAttribute('data-shadow'));

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

    // A new campaign touch STARTS A NEW SESSION, even mid-visit. Attribution here
    // is last-touch, and the session row freezes its attribution on insert — so a
    // visitor who arrives direct, browses, then clicks a Google ad back to the
    // site inside the 30-minute window would otherwise keep the frozen "direct"
    // source and never record the gclid, handing the converting click zero credit.
    // Fingerprint only the campaign-identifying params, so ordinary navigation
    // (which carries none) never breaks the session.
    var campNow = (function () {
      var p = new URLSearchParams(location.search);
      var keys = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'utm_source', 'utm_medium', 'utm_campaign'];
      var parts = [];
      for (var i = 0; i < keys.length; i++) {
        var v = p.get(keys[i]);
        if (v) parts.push(keys[i] + '=' + v);
      }
      return parts.join('&');
    })();
    var campPrev = getCookie('arbor_camp') || '';
    var newCampaign = !!campNow && campNow !== campPrev;

    if (!sid || !sidTs || now - sidTs > SID_MIN * 60000 || newCampaign) { sid = uuid(); }
    setCookie('arbor_sid', sid, SID_MIN * 60);
    setCookie('arbor_sid_ts', String(now), SID_MIN * 60);
    // Remember the campaign this session belongs to, so the NEXT load can tell a
    // genuinely new touch from a reload of the same one. Only written when the URL
    // actually carries campaign params — an internal navigation must not clear it.
    if (campNow) setCookie('arbor_camp', campNow, SID_MIN * 60);

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
        // sendBeacon returns false when it can't queue the event (quota, size) —
        // fall through to fetch instead of dropping it.
        if (navigator.sendBeacon &&
            navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) {
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

    // base.url is the entry URL, captured once. A pageview for a later page must
    // override it — merge applies its argument last, so passing url wins.
    function pageview() { send(merge({ event: 'pageview', url: location.href })); }

    pageview();

    // arbor-mgmt.com is a React SPA, so every navigation after the first is
    // client-side and fires no page load. Without these hooks the tracker sees
    // exactly one page per visit — the entry page — and a visitor who lands on
    // the home page, reads a location page and then calls is recorded as having
    // only ever seen the home page. The DNI swap already had to solve this (see
    // the MutationObserver below); the pageview beacon never did.
    (function trackRouteChanges() {
      // Compared on path + query, deliberately NOT the full href: the site's own
      // CTAs are #free-quote anchors, and a jump to an anchor is not a new page.
      // Including the hash would bill every one of those as a pageview and
      // overwrite last_page with the same path it already held.
      function key() { return location.pathname + location.search; }
      var last = key();
      function onRouteChange() {
        if (key() === last) return;
        last = key();
        pageview();
      }
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        if (typeof orig !== 'function') return;
        history[m] = function () {
          var r = orig.apply(this, arguments);
          // The URL is only updated after the original runs.
          try { onRouteChange(); } catch (e) {}
          return r;
        };
      });
      window.addEventListener('popstate', onRouteChange);
      window.addEventListener('hashchange', onRouteChange);
    })();

    // Pool-based DNI — swap displayed numbers to this session's tracking number.
    //
    // The swap CANNOT be a one-shot pass. arbor-mgmt.com is a React SPA: this
    // snippet is async in <head>, so the assign response lands before React has
    // rendered anything and querySelectorAll matches zero tel: links. The number
    // then never swaps, which silently costs every website call its click id —
    // the whole point of DNI. Client-side routing re-renders the same problem on
    // every navigation. So keep the assigned number and re-apply it whenever the
    // DOM changes. swapNumbers compares before it writes, so re-runs are cheap,
    // idempotent, and able to REPAIR an element a re-render reverted.
    var assigned = null;
    var swapQueued = false;
    var writes = 0;

    function applySwap() {
      swapQueued = false;
      if (assigned) swapNumbers(assigned.e164, assigned.display);
    }

    function queueSwap() {
      if (swapQueued || !assigned) return;
      swapQueued = true;
      // rAF coalesces a burst of React mutations into one pass; the setTimeout
      // fallback covers background tabs, where rAF may never fire.
      if (window.requestAnimationFrame) window.requestAnimationFrame(applySwap);
      else setTimeout(applySwap, 16);
    }

    function watchForLateNodes() {
      if (!window.MutationObserver) {
        // No observer (very old browsers): poll briefly so a render that lands
        // after the assign response still gets swapped.
        var tries = 0;
        var iv = setInterval(function () {
          applySwap();
          if (++tries > 40) clearInterval(iv); // ~10s
        }, 250);
        return;
      }
      new MutationObserver(queueSwap).observe(document.documentElement, {
        childList: true, subtree: true
      });
    }

    // Compare before writing, rather than marking an element done. A "swapped"
    // marker looks equivalent but is NOT: if the framework later re-renders that
    // same element back to the hard-coded number, the marker makes us skip it and
    // the swap is lost for good. Comparing is self-healing, and it is still safe
    // against an observer loop — once values match we stop writing, so we stop
    // generating mutations.
    function swapNumbers(e164, display) {
      var tel = 'tel:' + e164;
      var n = 0;
      var marked = document.querySelectorAll('[data-arbor-phone]');
      for (var i = 0; i < marked.length; i++) {
        var el = marked[i];
        if (el.textContent !== display) { el.textContent = display; n++; }
        if (el.tagName === 'A' && el.getAttribute('href') !== tel) {
          el.setAttribute('href', tel); n++;
        }
      }
      var links = document.querySelectorAll('a[href^="tel:"]');
      for (var j = 0; j < links.length; j++) {
        var a = links[j];
        // Opt-out, same attribute the form capture honours. Without it EVERY tel:
        // link on the page collapses to the one leased number — so a page listing
        // both the Edwardsville and O'Fallon offices (or an emergency/partner
        // line) would silently send callers to the wrong one. Mark the link, or
        // any ancestor, with data-arbor-ignore to leave it alone.
        if (a.closest && a.closest('[data-arbor-ignore]')) continue;
        if (a.getAttribute('href') !== tel) { a.setAttribute('href', tel); n++; }
        // Only rewrite link text that IS a phone number — the CTA buttons read
        // "Call Now" and must keep their label. textContent would also delete
        // their child <button>, so this guard is load-bearing, not cosmetic.
        var t = a.textContent || '';
        if (/\d{3}[^\d]*\d{4}/.test(t) && t !== display) { a.textContent = display; n++; }
      }
      writes += n;
      // Support hook: check window.__arborDNI in the console to see whether a
      // number was assigned and whether anything on the page actually changed.
      window.__arborDNI = { number: e164, display: display, writes: writes, tels: links.length };
      return n;
    }
    (function () {
      // Shadow run: no assign call at all — it would both swap the number and burn a
      // pool lease for a visitor whose displayed number CallRail still controls.
      if (SHADOW) return;
      var ASSIGN = new URL('/api/dni/assign', script ? script.src : location.origin).toString();
      var body = JSON.stringify({
        vid: vid, sid: sid, url: location.href, referrer: document.referrer || undefined,
        utm: base.utm, click: base.click
      });
      fetch(ASSIGN, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.number) return;
          assigned = { e164: d.number, display: d.display || d.number };
          applySwap();          // whatever is already rendered
          watchForLateNodes();  // everything React renders afterwards
          startHeartbeat(ASSIGN, body);
        })
        .catch(function () {});
    })();

    // Keep the lease alive while the tab is open. The lease runs 30 minutes and is
    // only renewed by a call to /api/dni/assign, which the snippet otherwise makes
    // once per hard page load — so a visitor who reads for 40 minutes before
    // dialing (entirely normal when deciding on tree work) can be looking at a
    // number whose lease expired and was recycled to someone else, and their call
    // then freezes the NEW lease's source onto the wrong lead. Re-asserting the
    // same session id returns and extends the existing lease, so this is a
    // renewal, not a second number.
    function startHeartbeat(url, payload) {
      var EVERY_MS = 10 * 60 * 1000;
      setInterval(function () {
        // Don't renew for a backgrounded tab — if they come back, visibilitychange
        // renews immediately.
        if (document.hidden) return;
        fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' } })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.number) return;
            // A different number means the old lease was already gone; adopt it.
            if (d.number !== assigned.e164) {
              assigned = { e164: d.number, display: d.display || d.number };
              applySwap();
            }
          })
          .catch(function () {});
      }, EVERY_MS);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          fetch(url, { method: 'POST', body: payload, headers: { 'Content-Type': 'text/plain' } })
            .catch(function () {});
        }
      });
    }

    // Form capture — never block the site's own submit (capture phase, no preventDefault).
    document.addEventListener('submit', function (ev) {
      var form = ev.target;
      if (!form || form.tagName !== 'FORM') return;
      if (form.hasAttribute('data-arbor-ignore')) return;
      var fields = {};
      try {
        // FormData can't tell input types apart — inspect form.elements so
        // password values never leave the page.
        var secret = {};
        for (var fi = 0; fi < form.elements.length; fi++) {
          var fe = form.elements[fi];
          if (fe && fe.type === 'password' && fe.name) secret[fe.name] = 1;
        }
        new FormData(form).forEach(function (v, k) {
          if (typeof v === 'string' && secret[k] !== 1) fields[k] = v;
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
