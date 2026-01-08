const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 30000;

// Parse body for POST requests
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.text({ type: '*/*', limit: '50mb' }));

// CORS
app.use(cors({ 
  origin: '*', 
  credentials: true,
  exposedHeaders: ['X-Proxy-Final-Url', 'X-Proxy-Status']
}));

// Remove security headers that break iframe embedding
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('X-Content-Type-Options');
  next();
});

// Store cookies per session (simple in-memory with cleanup)
const cookieStore = new Map();
const COOKIE_MAX_AGE = 30 * 60 * 1000; // 30 minutes

// Clean old cookies periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cookieStore.entries()) {
    if (now - value.timestamp > COOKIE_MAX_AGE) {
      cookieStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(), 
    version: '3.0.0',
    activeSessions: cookieStore.size
  });
});

// Main proxy - supports GET and POST
app.all('/browse', async (req, res) => {
  const targetUrl = req.query.url;
  const sessionId = req.query.session || 'default';
  
  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  // Add https if no protocol
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

  console.log(`[${req.method}] ${fullUrl}`);

  try {
    // Build headers
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity', // Don't ask for compressed
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };

    // Add cookies from store
    const storedSession = cookieStore.get(sessionId);
    if (storedSession && storedSession.cookies) {
      headers['Cookie'] = storedSession.cookies;
    }

    // Forward some original headers
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'];
    }
    if (req.headers['referer']) {
      try {
        const refUrl = new URL(decodeURIComponent(req.headers['referer'].split('url=')[1]));
        headers['Referer'] = refUrl.href;
      } catch {}
    }

    // Prepare fetch options
    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    };

    // Add body for POST/PUT
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (typeof req.body === 'string') {
        fetchOptions.body = req.body;
      } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        if (req.headers['content-type']?.includes('application/json')) {
          fetchOptions.body = JSON.stringify(req.body);
        } else {
          // Form data
          fetchOptions.body = new URLSearchParams(req.body).toString();
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      }
    }

    const response = await fetch(fullUrl, fetchOptions);

    // Store cookies from response
    const setCookies = response.headers.getSetCookie?.() || [];
    if (setCookies.length > 0) {
      const existing = cookieStore.get(sessionId);
      const existingCookies = existing ? existing.cookies : '';
      const newCookies = setCookies.map(c => c.split(';')[0]).join('; ');
      cookieStore.set(sessionId, {
        cookies: existingCookies ? `${existingCookies}; ${newCookies}` : newCookies,
        timestamp: Date.now()
      });
    } else if (cookieStore.has(sessionId)) {
      // Update timestamp to keep session alive
      const existing = cookieStore.get(sessionId);
      existing.timestamp = Date.now();
    }

    const contentType = response.headers.get('content-type') || '';
    
    // Handle redirects that fetch followed
    const finalUrl = response.url || fullUrl;
    const finalParsed = new URL(finalUrl);
    const baseUrl = finalParsed.origin;

    // Non-HTML content handling
    if (!contentType.includes('text/html')) {
      const buffer = await response.arrayBuffer();
      
      // Set appropriate headers
      res.set('Content-Type', contentType);
      
      // Handle CSS - rewrite url() and @import
      if (contentType.includes('text/css')) {
        let css = Buffer.from(buffer).toString('utf-8');
        const proxyBase = `${req.protocol}://${req.get('host')}/browse?session=${sessionId}&url=`;
        css = rewriteCss(css, baseUrl, proxyBase, finalUrl);
        return res.send(css);
      }
      
      // Handle JavaScript - might contain URLs (basic rewrite)
      if (contentType.includes('javascript') || contentType.includes('application/json')) {
        let text = Buffer.from(buffer).toString('utf-8');
        // Don't modify JS too much, just return as-is
        return res.send(text);
      }
      
      // Handle web manifest
      if (contentType.includes('manifest+json')) {
        let manifest = Buffer.from(buffer).toString('utf-8');
        try {
          const json = JSON.parse(manifest);
          const proxyBase = `${req.protocol}://${req.get('host')}/browse?session=${sessionId}&url=`;
          if (json.icons) {
            json.icons = json.icons.map(icon => ({
              ...icon,
              src: proxyUrl(icon.src, baseUrl, proxyBase, finalUrl)
            }));
          }
          if (json.start_url) {
            json.start_url = proxyUrl(json.start_url, baseUrl, proxyBase, finalUrl);
          }
          return res.json(json);
        } catch {
          return res.send(manifest);
        }
      }

      // Handle SVG
      if (contentType.includes('image/svg+xml')) {
        let svg = Buffer.from(buffer).toString('utf-8');
        const proxyBase = `${req.protocol}://${req.get('host')}/browse?session=${sessionId}&url=`;
        // Rewrite xlink:href and href in SVG
        svg = svg.replace(/xlink:href\s*=\s*["']([^"']+)["']/gi, (match, url) => {
          if (shouldProxy(url)) {
            return `xlink:href="${proxyUrl(url, baseUrl, proxyBase, finalUrl)}"`;
          }
          return match;
        });
        svg = svg.replace(/(<(?:use|image|a)[^>]*\s)href\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
          if (shouldProxy(url) && !url.startsWith('#')) {
            return `${prefix}href="${proxyUrl(url, baseUrl, proxyBase, finalUrl)}"`;
          }
          return match;
        });
        res.set('Content-Type', 'image/svg+xml');
        return res.send(svg);
      }
      
      // Binary files (images, fonts, etc) - pass through
      return res.send(Buffer.from(buffer));
    }

    // For HTML, rewrite URLs
    let html = await response.text();
    const proxyBase = `${req.protocol}://${req.get('host')}/browse?session=${sessionId}&url=`;

    // Rewrite HTML
    html = rewriteHtml(html, baseUrl, proxyBase, finalUrl);

    // Inject navigation script
    const injectedScript = createInjectedScript(proxyBase, baseUrl, finalUrl, sessionId);

    if (html.includes('</head>')) {
      html = html.replace('</head>', `${injectedScript}</head>`);
    } else if (html.includes('<body')) {
      html = html.replace(/<body([^>]*)>/i, `<body$1>${injectedScript}`);
    } else {
      html = injectedScript + html;
    }

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);

  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Error</title></head>
        <body style="font-family: system-ui; padding: 40px; text-align: center; background: #1a1a2e; color: #fff;">
          <h2>⚠️ Failed to load page</h2>
          <p style="color: #888;">${escapeHtml(error.message)}</p>
          <p><a href="javascript:history.back()" style="color: #4f8cff;">Go back</a></p>
        </body>
      </html>
    `);
  }
});

// Rewrite HTML
function rewriteHtml(html, baseUrl, proxyBase, currentUrl) {
  // Remove integrity, nonce, crossorigin attributes (break with proxy)
  html = html.replace(/\s+(integrity|nonce|crossorigin)\s*=\s*["'][^"']*["']/gi, '');
  html = html.replace(/\s+(integrity|nonce|crossorigin)\s*=\s*[^\s>"']+/gi, '');
  
  // Remove CSP meta tags
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  
  // Remove X-Frame-Options meta
  html = html.replace(/<meta[^>]*http-equiv\s*=\s*["']?x-frame-options["']?[^>]*>/gi, '');
  
  // Rewrite meta refresh redirects
  html = html.replace(/<meta([^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*)>/gi, (match, attrs) => {
    return match.replace(/content\s*=\s*["'](\d+)\s*;\s*url\s*=\s*([^"']+)["']/i, (m, time, url) => {
      const proxiedUrl = proxyUrl(url.trim(), baseUrl, proxyBase, currentUrl);
      return `content="${time}; url=${proxiedUrl}"`;
    });
  });
  
  // Rewrite SVG xlink:href
  html = html.replace(/xlink:href\s*=\s*["']([^"']+)["']/gi, (match, url) => {
    if (shouldProxy(url)) {
      return `xlink:href="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });
  
  // Rewrite SVG href (modern)
  html = html.replace(/(<(?:use|image|a)[^>]*\s)href\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url) && !url.startsWith('#')) {
      return `${prefix}href="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });
  
  // Rewrite href
  html = html.replace(/(<[^>]+\s)href\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}href="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite src
  html = html.replace(/(<[^>]+\s)src\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}src="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite srcset
  html = html.replace(/(<img[^>]+\s)srcset\s*=\s*["']([^"']+)["']/gi, (match, prefix, srcset) => {
    const newSrcset = rewriteSrcset(srcset, baseUrl, proxyBase, currentUrl);
    return `${prefix}srcset="${newSrcset}"`;
  });

  // Rewrite action
  html = html.replace(/(<form[^>]+\s)action\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}action="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite poster (video)
  html = html.replace(/poster\s*=\s*["']([^"']+)["']/gi, (match, url) => {
    if (shouldProxy(url)) {
      return `poster="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite data-src (lazy loading)
  html = html.replace(/data-src\s*=\s*["']([^"']+)["']/gi, (match, url) => {
    if (shouldProxy(url)) {
      return `data-src="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite data-srcset (lazy loading)
  html = html.replace(/data-srcset\s*=\s*["']([^"']+)["']/gi, (match, srcset) => {
    const newSrcset = rewriteSrcset(srcset, baseUrl, proxyBase, currentUrl);
    return `data-srcset="${newSrcset}"`;
  });

  // Rewrite object data
  html = html.replace(/(<object[^>]+\s)data\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}data="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite embed src
  html = html.replace(/(<embed[^>]+\s)src\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}src="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite source src (video/audio)
  html = html.replace(/(<source[^>]+\s)src\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}src="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite source srcset (picture element)
  html = html.replace(/(<source[^>]+\s)srcset\s*=\s*["']([^"']+)["']/gi, (match, prefix, srcset) => {
    const newSrcset = rewriteSrcset(srcset, baseUrl, proxyBase, currentUrl);
    return `${prefix}srcset="${newSrcset}"`;
  });

  // Rewrite track src (subtitles)
  html = html.replace(/(<track[^>]+\s)src\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}src="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite link href (stylesheets, icons)
  html = html.replace(/(<link[^>]+\s)href\s*=\s*["']([^"']+)["']/gi, (match, prefix, url) => {
    if (shouldProxy(url)) {
      return `${prefix}href="${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  // Rewrite inline style url()
  html = html.replace(/style\s*=\s*["']([^"']+)["']/gi, (match, style) => {
    const newStyle = rewriteCssUrls(style, baseUrl, proxyBase, currentUrl);
    return `style="${newStyle}"`;
  });

  // Rewrite <style> blocks
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, css) => {
    const newCss = rewriteCss(css, baseUrl, proxyBase, currentUrl);
    return `<style${attrs}>${newCss}</style>`;
  });

  // Add base tag if not present
  if (!/<base\s/i.test(html)) {
    if (html.includes('<head>')) {
      html = html.replace('<head>', `<head><base href="${baseUrl}/">`);
    } else if (/<head\s+/i.test(html)) {
      html = html.replace(/<head(\s+[^>]*)>/i, `<head$1><base href="${baseUrl}/">`);
    }
  }

  return html;
}

// Rewrite CSS
function rewriteCss(css, baseUrl, proxyBase, currentUrl) {
  // Rewrite url()
  css = rewriteCssUrls(css, baseUrl, proxyBase, currentUrl);
  
  // Rewrite @import
  css = css.replace(/@import\s+["']([^"']+)["']/gi, (match, url) => {
    if (shouldProxy(url)) {
      return `@import "${proxyUrl(url, baseUrl, proxyBase, currentUrl)}"`;
    }
    return match;
  });

  css = css.replace(/@import\s+url\(["']?([^"')]+)["']?\)/gi, (match, url) => {
    if (shouldProxy(url)) {
      return `@import url("${proxyUrl(url, baseUrl, proxyBase, currentUrl)}")`;
    }
    return match;
  });

  return css;
}

// Rewrite url() in CSS
function rewriteCssUrls(css, baseUrl, proxyBase, currentUrl) {
  return css.replace(/url\(["']?([^"')]+)["']?\)/gi, (match, url) => {
    if (shouldProxy(url)) {
      return `url("${proxyUrl(url, baseUrl, proxyBase, currentUrl)}")`;
    }
    return match;
  });
}

// Rewrite srcset attribute value
function rewriteSrcset(srcset, baseUrl, proxyBase, currentUrl) {
  return srcset.split(',').map(part => {
    const parts = part.trim().split(/\s+/);
    const url = parts[0];
    const rest = parts.slice(1).join(' ');
    if (shouldProxy(url)) {
      const newUrl = proxyUrl(url, baseUrl, proxyBase, currentUrl);
      return rest ? `${newUrl} ${rest}` : newUrl;
    }
    return part;
  }).join(', ');
}

// Check if URL should be proxied
function shouldProxy(url) {
  if (!url) return false;
  if (url.startsWith('data:')) return false;
  if (url.startsWith('blob:')) return false;
  if (url.startsWith('javascript:')) return false;
  if (url.startsWith('#')) return false;
  if (url.startsWith('about:')) return false;
  return true;
}

// Convert URL to proxied URL
function proxyUrl(url, baseUrl, proxyBase, currentUrl) {
  try {
    let absoluteUrl;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      absoluteUrl = url;
    } else if (url.startsWith('//')) {
      absoluteUrl = 'https:' + url;
    } else if (url.startsWith('/')) {
      absoluteUrl = baseUrl + url;
    } else {
      absoluteUrl = new URL(url, currentUrl).href;
    }
    return proxyBase + encodeURIComponent(absoluteUrl);
  } catch {
    return url;
  }
}

// Create injected script for navigation handling
function createInjectedScript(proxyBase, baseUrl, currentUrl, sessionId) {
  return `
<script>
(function() {
  const PROXY_BASE = '${proxyBase}';
  const BASE_URL = '${baseUrl}';
  const CURRENT_URL = '${currentUrl}';
  const SESSION = '${sessionId}';

  function makeProxyUrl(url) {
    try {
      let abs;
      if (url.startsWith('http://') || url.startsWith('https://')) {
        abs = url;
      } else if (url.startsWith('//')) {
        abs = 'https:' + url;
      } else if (url.startsWith('/')) {
        abs = BASE_URL + url;
      } else if (url.startsWith('#') || url.startsWith('javascript:')) {
        return url;
      } else {
        abs = new URL(url, CURRENT_URL).href;
      }
      return PROXY_BASE + encodeURIComponent(abs);
    } catch(e) {
      return url;
    }
  }

  // Intercept clicks
  document.addEventListener('click', function(e) {
    const link = e.target.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        e.preventDefault();
        e.stopPropagation();
        const newUrl = makeProxyUrl(href);
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'navigate', url: href.startsWith('http') ? href : new URL(href, CURRENT_URL).href }, '*');
        } else {
          window.location.href = newUrl;
        }
      }
    }
  }, true);

  // Intercept form submissions
  document.addEventListener('submit', function(e) {
    const form = e.target;
    e.preventDefault();
    e.stopPropagation();
    
    const action = form.getAttribute('action') || CURRENT_URL;
    const method = (form.getAttribute('method') || 'GET').toUpperCase();
    const formData = new FormData(form);
    
    let targetUrl;
    if (action.startsWith('http')) {
      targetUrl = action;
    } else if (action.startsWith('/')) {
      targetUrl = BASE_URL + action;
    } else {
      targetUrl = new URL(action, CURRENT_URL).href;
    }

    if (method === 'GET') {
      const params = new URLSearchParams(formData).toString();
      const fullUrl = targetUrl + (targetUrl.includes('?') ? '&' : '?') + params;
      window.parent.postMessage({ type: 'navigate', url: fullUrl }, '*');
    } else {
      // POST - submit through proxy
      const proxyUrl = PROXY_BASE + encodeURIComponent(targetUrl);
      const newForm = document.createElement('form');
      newForm.method = 'POST';
      newForm.action = proxyUrl;
      newForm.style.display = 'none';
      
      for (const [key, value] of formData.entries()) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        newForm.appendChild(input);
      }
      
      document.body.appendChild(newForm);
      newForm.submit();
    }
  }, true);

  // Override window.open
  const origOpen = window.open;
  window.open = function(url, target, features) {
    if (url) {
      const proxied = makeProxyUrl(url);
      return origOpen.call(this, proxied, target, features);
    }
    return origOpen.call(this, url, target, features);
  };

  // Override location setter
  try {
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      get: function() { return origLocation; },
      set: function(url) {
        origLocation.href = makeProxyUrl(url);
      }
    });
  } catch(e) {}

})();
</script>`;
}

// Escape HTML
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Web Proxy Server',
    version: '3.0.0',
    endpoints: {
      browse: '/browse?url=<url>&session=<optional_session_id>',
      health: '/health'
    }
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         Web Proxy Server v3.0.0                   ║
╠═══════════════════════════════════════════════════╣
║  Port: ${PORT}                                        ║
║  Browse: /browse?url=https://example.com          ║
║                                                   ║
║  ⚠️  Make port ${PORT} PUBLIC in Codespaces!          ║
╚═══════════════════════════════════════════════════╝
  `);
});
