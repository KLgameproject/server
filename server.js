const express = require('express');
const cors = require('cors');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 30000;

// === CACHING ===
const cache = new Map();
const CACHE_MAX_SIZE = 100 * 1024 * 1024; // 100MB max cache
const CACHE_MAX_AGE = 10 * 60 * 1000; // 10 minutes
let cacheSize = 0;

// Cacheable content types
const CACHEABLE_TYPES = [
  'image/', 'font/', 'application/font', 'text/css', 
  'application/javascript', 'text/javascript'
];

function shouldCache(contentType) {
  return CACHEABLE_TYPES.some(t => contentType.includes(t));
}

function getCacheKey(url) {
  return url;
}

function getFromCache(key) {
  const item = cache.get(key);
  if (item && Date.now() - item.timestamp < CACHE_MAX_AGE) {
    return item;
  }
  if (item) {
    cacheSize -= item.data.length;
    cache.delete(key);
  }
  return null;
}

function addToCache(key, data, contentType) {
  // Evict old items if cache is too big
  while (cacheSize + data.length > CACHE_MAX_SIZE && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cacheSize -= oldest.data.length;
    cache.delete(oldestKey);
  }
  
  cache.set(key, { data, contentType, timestamp: Date.now() });
  cacheSize += data.length;
}

// Clean cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_MAX_AGE) {
      cacheSize -= value.data.length;
      cache.delete(key);
    }
  }
}, 60 * 1000);

// === MIDDLEWARE ===
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(cors({ 
  origin: '*', 
  exposedHeaders: ['X-Cache-Status']
}));

app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  next();
});

// === COOKIES ===
const cookieStore = new Map();

// === ROUTES ===
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '4.0.0',
    cache: {
      entries: cache.size,
      sizeMB: (cacheSize / 1024 / 1024).toFixed(2)
    }
  });
});

app.all('/browse', async (req, res) => {
  const targetUrl = req.query.url;
  const sessionId = req.query.session || 'default';
  
  if (!targetUrl) {
    return res.status(400).send('Missing url');
  }

  let fullUrl = targetUrl;
  if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
    fullUrl = 'https://' + fullUrl;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(fullUrl);
  } catch {
    return res.status(400).send('Invalid URL');
  }

  // Check cache first for static assets
  const cacheKey = getCacheKey(fullUrl);
  const cached = getFromCache(cacheKey);
  if (cached && req.method === 'GET') {
    res.set('Content-Type', cached.contentType);
    res.set('X-Cache-Status', 'HIT');
    return res.send(cached.data);
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    };

    // Add cookies
    const session = cookieStore.get(sessionId);
    if (session?.cookies) {
      headers['Cookie'] = session.cookies;
    }

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    };

    // Add body for POST
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      if (typeof req.body === 'object') {
        fetchOptions.body = new URLSearchParams(req.body).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        fetchOptions.body = req.body;
      }
    }

    const response = await fetch(fullUrl, fetchOptions);

    // Store cookies
    const setCookies = response.headers.getSetCookie?.() || [];
    if (setCookies.length > 0) {
      const existing = cookieStore.get(sessionId)?.cookies || '';
      const newCookies = setCookies.map(c => c.split(';')[0]).join('; ');
      cookieStore.set(sessionId, {
        cookies: existing ? `${existing}; ${newCookies}` : newCookies,
        timestamp: Date.now()
      });
    }

    const contentType = response.headers.get('content-type') || '';
    const finalUrl = response.url || fullUrl;
    const baseUrl = new URL(finalUrl).origin;
    const proxyBase = `${req.protocol}://${req.get('host')}/browse?session=${sessionId}&url=`;

    res.set('X-Cache-Status', 'MISS');

    // === STATIC ASSETS (cacheable, no rewrite needed) ===
    if (contentType.startsWith('image/') || 
        contentType.includes('font') ||
        contentType.includes('audio/') ||
        contentType.includes('video/')) {
      
      const buffer = Buffer.from(await response.arrayBuffer());
      
      // Cache it
      if (shouldCache(contentType) && buffer.length < 5 * 1024 * 1024) {
        addToCache(cacheKey, buffer, contentType);
      }
      
      res.set('Content-Type', contentType);
      return res.send(buffer);
    }

    // === CSS ===
    if (contentType.includes('text/css')) {
      let css = await response.text();
      css = rewriteCss(css, baseUrl, proxyBase, finalUrl);
      
      const buffer = Buffer.from(css);
      if (buffer.length < 1024 * 1024) {
        addToCache(cacheKey, buffer, 'text/css');
      }
      
      res.set('Content-Type', 'text/css');
      return res.send(css);
    }

    // === JAVASCRIPT (don't modify, just cache) ===
    if (contentType.includes('javascript')) {
      const buffer = Buffer.from(await response.arrayBuffer());
      
      if (buffer.length < 2 * 1024 * 1024) {
        addToCache(cacheKey, buffer, contentType);
      }
      
      res.set('Content-Type', contentType);
      return res.send(buffer);
    }

    // === HTML (rewrite and stream) ===
    if (contentType.includes('text/html')) {
      let html = await response.text();
      
      // Quick rewrites
      html = rewriteHtml(html, baseUrl, proxyBase, finalUrl);
      
      // Inject script
      const script = createScript(proxyBase, baseUrl, finalUrl);
      if (html.includes('</head>')) {
        html = html.replace('</head>', script + '</head>');
      } else {
        html = script + html;
      }
      
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    // === OTHER (pass through) ===
    const buffer = Buffer.from(await response.arrayBuffer());
    res.set('Content-Type', contentType || 'application/octet-stream');
    return res.send(buffer);

  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return res.status(504).send('Timeout');
    }
    
    res.status(500).send(`
      <html><body style="font-family:system-ui;padding:40px;text-align:center;background:#111;color:#fff">
        <h2>Failed to load</h2>
        <p style="color:#888">${error.message}</p>
        <a href="javascript:history.back()" style="color:#58f">Go back</a>
      </body></html>
    `);
  }
});

// === REWRITE FUNCTIONS (optimized) ===

function rewriteHtml(html, baseUrl, proxyBase, currentUrl) {
  // Remove blocking attributes
  html = html.replace(/\s+(integrity|nonce|crossorigin)=["'][^"']*["']/gi, '');
  html = html.replace(/<meta[^>]*content-security-policy[^>]*>/gi, '');
  
  // Rewrite common attributes in one pass using a map
  const attrPatterns = [
    [/(<[^>]+\s)(href|src|action|poster|data-src)=["']([^"']+)["']/gi, (m, pre, attr, url) => {
      if (!shouldRewrite(url)) return m;
      return `${pre}${attr}="${makeProxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }],
    [/srcset=["']([^"']+)["']/gi, (m, srcset) => {
      return `srcset="${rewriteSrcset(srcset, baseUrl, proxyBase, currentUrl)}"`;
    }]
  ];
  
  for (const [pattern, replacer] of attrPatterns) {
    html = html.replace(pattern, replacer);
  }
  
  // Rewrite inline styles
  html = html.replace(/style=["']([^"']*url\([^)]+\)[^"']*)["']/gi, (m, style) => {
    return `style="${rewriteCssUrls(style, baseUrl, proxyBase, currentUrl)}"`;
  });
  
  // Rewrite style blocks
  html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
    return m.replace(css, rewriteCss(css, baseUrl, proxyBase, currentUrl));
  });
  
  return html;
}

function rewriteCss(css, baseUrl, proxyBase, currentUrl) {
  // Rewrite url()
  css = rewriteCssUrls(css, baseUrl, proxyBase, currentUrl);
  
  // Rewrite @import
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (m, url) => {
    if (!shouldRewrite(url)) return m;
    return `@import "${makeProxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
  });
  
  css = css.replace(/@import\s+url\(["']?([^"')]+)["']?\)/gi, (m, url) => {
    if (!shouldRewrite(url)) return m;
    return `@import url("${makeProxyUrl(url, baseUrl, proxyBase, currentUrl)}")`;
  });
  
  return css;
}

function rewriteCssUrls(css, baseUrl, proxyBase, currentUrl) {
  return css.replace(/url\(["']?([^"')]+)["']?\)/gi, (m, url) => {
    if (!shouldRewrite(url)) return m;
    return `url("${makeProxyUrl(url, baseUrl, proxyBase, currentUrl)}")`;
  });
}

function rewriteSrcset(srcset, baseUrl, proxyBase, currentUrl) {
  return srcset.split(',').map(part => {
    const [url, ...rest] = part.trim().split(/\s+/);
    if (!shouldRewrite(url)) return part;
    return [makeProxyUrl(url, baseUrl, proxyBase, currentUrl), ...rest].join(' ');
  }).join(', ');
}

function shouldRewrite(url) {
  if (!url) return false;
  if (url.startsWith('data:') || url.startsWith('blob:') || 
      url.startsWith('javascript:') || url.startsWith('#') ||
      url.startsWith('about:')) return false;
  return true;
}

function makeProxyUrl(url, baseUrl, proxyBase, currentUrl) {
  try {
    let abs;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      abs = url;
    } else if (url.startsWith('//')) {
      abs = 'https:' + url;
    } else if (url.startsWith('/')) {
      abs = baseUrl + url;
    } else {
      abs = new URL(url, currentUrl).href;
    }
    return proxyBase + encodeURIComponent(abs);
  } catch {
    return url;
  }
}

function createScript(proxyBase, baseUrl, currentUrl) {
  return `<script>(function(){
const P='${proxyBase}',B='${baseUrl}',C='${currentUrl}';
function px(u){
  if(!u||u[0]=='#'||u.startsWith('javascript:'))return u;
  try{
    let a;
    if(u.startsWith('http'))a=u;
    else if(u.startsWith('//'))a='https:'+u;
    else if(u[0]=='/')a=B+u;
    else a=new URL(u,C).href;
    return P+encodeURIComponent(a);
  }catch{return u}
}
document.addEventListener('click',e=>{
  const a=e.target.closest('a[href]');
  if(a){
    const h=a.getAttribute('href');
    if(h&&h[0]!='#'&&!h.startsWith('javascript:')){
      e.preventDefault();
      const url=h.startsWith('http')?h:new URL(h,C).href;
      if(parent!==window)parent.postMessage({type:'navigate',url},'*');
      else location.href=px(h);
    }
  }
},true);
document.addEventListener('submit',e=>{
  e.preventDefault();
  const f=e.target,m=(f.method||'GET').toUpperCase();
  let a=f.action||C;
  if(!a.startsWith('http'))a=a[0]=='/'?B+a:new URL(a,C).href;
  const d=new URLSearchParams(new FormData(f));
  if(m=='GET'){
    parent.postMessage({type:'navigate',url:a+(a.includes('?')?'&':'?')+d},'*');
  }else{
    const nf=document.createElement('form');
    nf.method='POST';nf.action=P+encodeURIComponent(a);nf.style.display='none';
    for(const[k,v]of d){const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;nf.appendChild(i)}
    document.body.appendChild(nf);nf.submit();
  }
},true);
})();</script>`;
}

// === ROOT & 404 ===
app.get('/', (req, res) => {
  res.json({ name: 'Web Proxy', version: '4.0.0', cache: `${cache.size} items` });
});

app.use((req, res) => res.status(404).send('Not found'));

// === START ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════╗
║     ⚡ Fast Web Proxy v4.0.0               ║
╠════════════════════════════════════════════╣
║  Port: ${PORT}                                 ║
║  Cache: 100MB max, 10min TTL               ║
║                                            ║
║  ⚠️  Make port ${PORT} PUBLIC!                 ║
╚════════════════════════════════════════════╝
  `);
});
