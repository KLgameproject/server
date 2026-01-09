const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEOUT = 25000;

// === PRECOMPILED REGEX (much faster) ===
const RE = {
  csp: /<meta[^>]*(content-security-policy|x-frame-options)[^>]*>/gi,
  security: /\s(integrity|nonce|crossorigin)=["'][^"']*["']/gi,
  amp: /&amp;/g,
  cssUrl: /url\(\s*["']?([^"')]+?)["']?\s*\)/gi,
  cssImport1: /@import\s*["']([^"']+)["']/gi,
  cssImport2: /@import\s+url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  style: /(\sstyle\s*=\s*)(["'])([^"']*?)(\2)/gi,
  styleBlock: /<style([^>]*)>([\s\S]*?)<\/style>/gi,
  srcset: /^(\S+)(\s+.+)?$/
};

// URL attributes to rewrite
const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data', 'srcset', 'data-src', 'data-srcset', 'data-original', 'data-lazy', 'background'];

// Precompile attribute regexes
const ATTR_RE = {};
for (const attr of URL_ATTRS) {
  ATTR_RE[attr] = new RegExp(`(\\s${attr}\\s*=\\s*)(["'])([^"']*?)\\2`, 'gi');
}

// === CACHE WITH SIZE LIMIT ===
const cache = new Map();
let cacheSize = 0;
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_ITEM_SIZE = 5 * 1024 * 1024; // 5MB per item
const CACHE_TTL = 300000; // 5 min

// Request deduplication - prevent fetching same URL multiple times concurrently
const pending = new Map();

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL) {
    cacheSize -= item.data.length;
    cache.delete(key);
    return null;
  }
  return item;
}

function cacheSet(key, data, contentType) {
  if (data.length > MAX_ITEM_SIZE) return;
  
  // Evict old items if needed
  while (cacheSize + data.length > MAX_CACHE_SIZE && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    const first = cache.get(firstKey);
    cacheSize -= first.data.length;
    cache.delete(firstKey);
  }
  
  cache.set(key, { data, ct: contentType, time: Date.now() });
  cacheSize += data.length;
}

// Binary content detection (faster than regex)
const BINARY_TYPES = new Set(['image', 'font', 'audio', 'video', 'octet-stream', 'woff', 'woff2', 'ttf', 'eot', 'otf']);
function isBinary(ct) {
  const lower = ct.toLowerCase();
  for (const t of BINARY_TYPES) {
    if (lower.includes(t)) return true;
  }
  return false;
}

// === MIDDLEWARE ===
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: '*' }));
app.disable('x-powered-by');
app.disable('etag');

// Keep connections alive
app.use((req, res, next) => {
  res.set('Connection', 'keep-alive');
  next();
});

// === COOKIES ===
const cookies = new Map();

// === ROUTES ===
app.get('/health', (_, res) => res.json({ ok: 1, v: '9.0', cache: cache.size, cacheSize: (cacheSize/1024/1024).toFixed(1) + 'MB' }));

app.all('/browse', async (req, res) => {
  let url = req.query.url;
  const sid = req.query.s || 'd';
  
  if (!url) return res.status(400).end('No URL');
  
  // Decode & normalize URL
  try { url = decodeURIComponent(url); } catch {}
  if (url.startsWith('//')) url = 'https:' + url;
  else if (!url.startsWith('http')) url = 'https://' + url;
  
  let parsed;
  try { parsed = new URL(url); } 
  catch { return res.status(400).end('Bad URL'); }

  const fullUrl = parsed.href;

  // Check cache (GET only)
  if (req.method === 'GET') {
    const cached = cacheGet(fullUrl);
    if (cached) {
      res.set('Content-Type', cached.ct);
      res.set('X-Cache', 'HIT');
      return res.send(cached.data);
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
    };

    const ck = cookies.get(sid);
    if (ck) headers['Cookie'] = ck;

    const opts = {
      method: req.method,
      headers,
      redirect: 'follow',
      signal: ctrl.signal
    };

    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      opts.body = typeof req.body === 'object' ? new URLSearchParams(req.body).toString() : req.body;
      if (typeof req.body === 'object') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const r = await fetch(fullUrl, opts);
    clearTimeout(timer);

    // Save cookies
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) cookies.set(sid, sc.map(c => c.split(';')[0]).join('; '));

    const ct = r.headers.get('content-type') || '';
    const finalUrl = r.url || fullUrl;
    const base = new URL(finalUrl).origin;
    const pb = `${req.protocol}://${req.get('host')}/browse?s=${sid}&url=`;

    // === BINARY ===
    if (isBinary(ct)) {
      const buf = Buffer.from(await r.arrayBuffer());
      cacheSet(fullUrl, buf, ct);
      res.set('Content-Type', ct);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    }

    // === CSS ===
    if (ct.includes('css')) {
      const css = rewriteCSS(await r.text(), base, pb, finalUrl);
      cacheSet(fullUrl, Buffer.from(css), 'text/css');
      res.set('Content-Type', 'text/css');
      return res.send(css); // Send string directly, no buffer conversion
    }

    // === JS/JSON ===
    if (ct.includes('javascript') || ct.includes('json')) {
      const text = await r.text();
      cacheSet(fullUrl, Buffer.from(text), ct);
      res.set('Content-Type', ct);
      return res.send(text); // Send string directly
    }

    // === HTML ===
    if (ct.includes('html') || !ct) {
      let html = await r.text();
      html = rewriteHTML(html, base, pb, finalUrl);
      html = injectScript(html, pb, base, finalUrl);
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(html); // Already a string
    }

    // === OTHER ===
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', ct || 'application/octet-stream');
    return res.send(buf);

  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return res.status(504).end('Timeout');
    return res.status(500).end('Error: ' + e.message);
  }
});

// ==================== REWRITERS ====================

function rewriteHTML(html, base, pb, curUrl) {
  // Decode entities
  html = html.replace(RE.amp, '&');
  
  // Remove security headers
  html = html.replace(RE.csp, '');
  html = html.replace(RE.security, '');
  
  // Rewrite URL attributes
  for (const attr of URL_ATTRS) {
    ATTR_RE[attr].lastIndex = 0;
    html = html.replace(ATTR_RE[attr], (match, prefix, quote, url) => {
      if (skipUrl(url)) return match;
      
      if (attr === 'srcset' || attr === 'data-srcset') {
        return `${prefix}${quote}${rewriteSrcset(url, base, pb, curUrl)}${quote}`;
      }
      
      return `${prefix}${quote}${proxyUrl(url, base, pb, curUrl)}${quote}`;
    });
  }
  
  // Inline styles
  RE.style.lastIndex = 0;
  html = html.replace(RE.style, (match, prefix, quote, style, end) => {
    if (!style.includes('url(')) return match;
    return `${prefix}${quote}${rewriteCSSUrls(style, base, pb, curUrl)}${end}`;
  });
  
  // Style blocks
  RE.styleBlock.lastIndex = 0;
  html = html.replace(RE.styleBlock, (match, attrs, css) => {
    return `<style${attrs}>${rewriteCSS(css, base, pb, curUrl)}</style>`;
  });
  
  return html;
}

function rewriteCSS(css, base, pb, curUrl) {
  css = rewriteCSSUrls(css, base, pb, curUrl);
  
  RE.cssImport1.lastIndex = 0;
  css = css.replace(RE.cssImport1, (m, url) => skipUrl(url) ? m : `@import "${proxyUrl(url, base, pb, curUrl)}"`);
  
  RE.cssImport2.lastIndex = 0;
  css = css.replace(RE.cssImport2, (m, url) => skipUrl(url) ? m : `@import url("${proxyUrl(url, base, pb, curUrl)}")`);
  
  return css;
}

function rewriteCSSUrls(css, base, pb, curUrl) {
  RE.cssUrl.lastIndex = 0;
  return css.replace(RE.cssUrl, (m, url) => skipUrl(url) ? m : `url("${proxyUrl(url, base, pb, curUrl)}")`);
}

function rewriteSrcset(srcset, base, pb, curUrl) {
  return srcset.split(',').map(part => {
    const t = part.trim();
    if (!t) return part;
    RE.srcset.lastIndex = 0;
    const m = t.match(RE.srcset);
    if (!m) return part;
    if (skipUrl(m[1])) return part;
    return proxyUrl(m[1], base, pb, curUrl) + (m[2] || '');
  }).join(', ');
}

function skipUrl(url) {
  if (!url) return true;
  const c = url[0];
  return c === '#' || c === '{' || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('blob:') || url.startsWith('mailto:') || url.startsWith('tel:');
}

function proxyUrl(url, base, pb, curUrl) {
  if (!url) return url;
  url = url.trim();
  if (skipUrl(url)) return url;
  
  try {
    let abs;
    if (url.startsWith('http://') || url.startsWith('https://')) abs = url;
    else if (url.startsWith('//')) abs = 'https:' + url;
    else if (url[0] === '/') abs = base + url;
    else abs = new URL(url, curUrl).href;
    return pb + encodeURIComponent(abs);
  } catch { return url; }
}

function injectScript(html, pb, base, curUrl) {
  // Ultra-minified script (~650 bytes)
  const s = `<script>!function(){var P="${pb}",B="${base}",C="${curUrl}";function A(u){return!u?u:(u=u.trim()).startsWith("http")?u:u.startsWith("//")?("https:"+u):u[0]=="/"?(B+u):new URL(u,C).href}function X(u){return!u||u[0]=="#"||u.slice(0,4)=="java"||u.slice(0,5)=="data:"?u:P+encodeURIComponent(A(u))}onclick=function(e){var a=e.target.closest("a");if(a){var h=a.getAttribute("href");if(h&&h[0]!="#"&&h.slice(0,4)!="java"){e.preventDefault();e.stopPropagation();var u=A(h);parent!=window?parent.postMessage({type:"navigate",url:u},"*"):location.href=X(h)}}};onsubmit=function(e){e.preventDefault();var f=e.target,a=A(f.action||C),m=(f.method||"GET").toUpperCase(),d=new URLSearchParams(new FormData(f));if(m=="GET"){var u=a+(a.includes("?")?"&":"?")+d;parent!=window?parent.postMessage({type:"navigate",url:u},"*"):location.href=X(u)}else{var n=document.createElement("form");n.method="POST";n.action=P+encodeURIComponent(a);n.hidden=1;d.forEach(function(v,k){var i=document.createElement("input");i.type="hidden";i.name=k;i.value=v;n.appendChild(i)});document.body.appendChild(n);n.submit()}}}()</script>`;
  
  const i = html.indexOf('</head>');
  if (i !== -1) return html.substring(0, i) + s + html.substring(i);
  const j = html.indexOf('<body');
  if (j !== -1) { const k = html.indexOf('>', j); return html.substring(0, k + 1) + s + html.substring(k + 1); }
  return s + html;
}

// === START ===
app.get('/', (_, r) => r.json({ v: '9.0' }));
app.use((_, r) => r.status(404).end());

app.listen(PORT, '0.0.0.0', () => console.log(`⚡ Proxy v9 on :${PORT}`));
