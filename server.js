const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const dns = require('dns').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT = 30000; // 30 seconds

// Trust proxy for rate limiting behind reverse proxies
app.set('trust proxy', 1);

// Body parsing - order matters!
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.text({ type: 'text/*', limit: '10mb' }));

// CORS configuration - allow all origins for GitHub Pages access
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: '*',
  exposedHeaders: ['Content-Length', 'Content-Type', 'X-Proxy-Status'],
  credentials: false,
  maxAge: 86400 // 24 hours
}));

// Handle preflight requests
app.options('*', cors());

// Health check endpoint - BEFORE rate limiter so it's not limited
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: '2.1.0'
  });
});

// Rate limiting - 200 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please try again later.', retryAfter: '15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Handle x-forwarded-for which can be comma-separated
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
    return req.ip || 'unknown';
  },
  skip: (req) => req.path === '/health' // Double-ensure health is not limited
});

app.use(limiter);

// Root endpoint with usage info
app.get('/', (req, res) => {
  res.json({
    name: 'GitHub Codespace Proxy Server',
    version: '2.1.0',
    endpoints: {
      health: 'GET /health',
      proxy: 'ANY /proxy?url=<encoded_url>'
    },
    supportedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
    example: '/proxy?url=' + encodeURIComponent('https://api.github.com'),
    limits: {
      requestsPerWindow: '200 requests per 15 minutes',
      bodySize: '10MB max',
      timeout: '30 seconds'
    }
  });
});

/**
 * Check if an IP address is private/internal
 */
function isPrivateIP(hostname) {
  // Block localhost variants
  const localhostPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
  if (localhostPatterns.includes(hostname.toLowerCase())) {
    return true;
  }

  // Check for IP address patterns
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    // Extract only the capture groups (indices 1-4), not the full match (index 0)
    const a = parseInt(ipv4Match[1], 10);
    const b = parseInt(ipv4Match[2], 10);
    const c = parseInt(ipv4Match[3], 10);
    const d = parseInt(ipv4Match[4], 10);
    
    // Validate each octet is in valid range
    if ([a, b, c, d].some(n => n < 0 || n > 255)) {
      return true; // Invalid IP, block it
    }
    
    // 10.0.0.0/8 - Private
    if (a === 10) return true;
    
    // 172.16.0.0/12 - Private
    if (a === 172 && b >= 16 && b <= 31) return true;
    
    // 192.168.0.0/16 - Private
    if (a === 192 && b === 168) return true;
    
    // 169.254.0.0/16 - Link-local
    if (a === 169 && b === 254) return true;
    
    // 127.0.0.0/8 - Loopback
    if (a === 127) return true;
    
    // 0.0.0.0/8 - Current network
    if (a === 0) return true;
    
    // 100.64.0.0/10 - Carrier-grade NAT
    if (a === 100 && b >= 64 && b <= 127) return true;
    
    // 198.18.0.0/15 - Benchmark testing
    if (a === 198 && (b === 18 || b === 19)) return true;
  }

  // Block .local and .internal domains
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    return true;
  }

  return false;
}

/**
 * Resolve hostname and check if it points to a private IP (DNS rebinding protection)
 */
async function resolveAndCheckIP(hostname) {
  // If it's already an IP, just check it directly
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    return isPrivateIP(hostname);
  }

  try {
    const addresses = await dns.resolve4(hostname);
    for (const ip of addresses) {
      if (isPrivateIP(ip)) {
        return true;
      }
    }
  } catch (err) {
    // DNS resolution failed - could be IPv6 only or invalid domain
    // Try IPv6 as fallback
    try {
      await dns.resolve6(hostname);
      // If IPv6 resolves, allow it (we mainly protect against IPv4 private ranges)
    } catch {
      // If both fail, let the request proceed and fail naturally
    }
  }

  return false;
}

/**
 * Validate and parse target URL
 */
function validateTargetUrl(urlString) {
  if (!urlString) {
    return { valid: false, error: 'Missing url parameter', usage: '/proxy?url=<encoded_url>' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch (e) {
    return { valid: false, error: 'Invalid URL format', provided: urlString };
  }

  // Only allow http and https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
  }

  // Block URLs with credentials (username:password)
  if (parsedUrl.username || parsedUrl.password) {
    return { valid: false, error: 'URLs with credentials are not allowed' };
  }

  // Block private/internal IPs (basic check)
  if (isPrivateIP(parsedUrl.hostname)) {
    return { valid: false, error: 'Proxying to private/internal addresses is not allowed' };
  }

  return { valid: true, url: parsedUrl };
}

/**
 * Main proxy endpoint - handles all HTTP methods
 */
app.all('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  
  // Validate URL
  const validation = validateTargetUrl(targetUrl);
  if (!validation.valid) {
    return res.status(400).json({ 
      error: validation.error,
      usage: validation.usage || undefined
    });
  }

  const { url: parsedUrl } = validation;
  const method = req.method;

  // DNS rebinding protection - resolve hostname and check if it points to private IP
  try {
    const isPrivate = await resolveAndCheckIP(parsedUrl.hostname);
    if (isPrivate) {
      return res.status(403).json({
        error: 'Proxying to private/internal addresses is not allowed',
        target: targetUrl
      });
    }
  } catch (err) {
    // Continue if DNS check fails - the fetch will fail with proper error
  }
  
  console.log(`[${new Date().toISOString()}] ${method} ${targetUrl}`);

  // Prepare headers to forward (exclude hop-by-hop headers)
  const hopByHopHeaders = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length'
  ]);
  
  const forwardHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (!hopByHopHeaders.has(lowerKey) && !lowerKey.startsWith('x-forwarded')) {
      forwardHeaders[key] = value;
    }
  }

  // Prepare request options
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  const fetchOptions = {
    method: method,
    headers: forwardHeaders,
    redirect: 'follow',
    signal: controller.signal
  };

  // Add body for methods that support it
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) {
        fetchOptions.body = req.body;
      } else if (typeof req.body === 'string') {
        fetchOptions.body = req.body;
      } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
        fetchOptions.body = JSON.stringify(req.body);
        fetchOptions.headers['content-type'] = 'application/json';
      }
    }
  }

  try {
    const response = await fetch(parsedUrl.href, fetchOptions);
    clearTimeout(timeoutId);
    
    // Set status code
    res.status(response.status);
    
    // Forward response headers (with modifications for CORS)
    const excludeHeaders = new Set([
      'content-encoding', 'transfer-encoding', 'connection',
      'x-frame-options', 'content-security-policy', 'x-content-type-options',
      'strict-transport-security', 'content-security-policy-report-only'
    ]);
    
    for (const [key, value] of response.headers.entries()) {
      if (!excludeHeaders.has(key.toLowerCase())) {
        try {
          res.setHeader(key, value);
        } catch (e) {
          // Skip invalid headers
        }
      }
    }
    
    // Ensure CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('X-Proxy-Status', 'success');

    // HEAD requests should not return body
    if (method === 'HEAD') {
      return res.end();
    }
    
    // Get response body
    const contentType = response.headers.get('content-type') || '';
    
    try {
      if (contentType.includes('application/json')) {
        const text = await response.text();
        // Try to parse as JSON, but send as text if it fails
        try {
          const data = JSON.parse(text);
          res.json(data);
        } catch {
          res.type('application/json').send(text);
        }
      } else if (
        contentType.includes('text/') || 
        contentType.includes('application/xml') || 
        contentType.includes('application/javascript') ||
        contentType.includes('application/x-www-form-urlencoded')
      ) {
        const text = await response.text();
        res.send(text);
      } else {
        // Binary data
        const buffer = await response.arrayBuffer();
        res.send(Buffer.from(buffer));
      }
    } catch (bodyError) {
      // If we can't read body, just end the response
      console.error('Error reading response body:', bodyError.message);
      res.end();
    }
    
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`[${new Date().toISOString()}] Proxy error:`, error.message);
    
    // Determine error type
    let status = 502;
    let message = error.message;
    
    if (error.name === 'AbortError') {
      status = 504;
      message = `Request timeout after ${REQUEST_TIMEOUT / 1000} seconds`;
    } else if (error.cause?.code === 'ENOTFOUND' || error.code === 'ENOTFOUND') {
      status = 502;
      message = 'Target host not found';
    } else if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') {
      status = 502;
      message = 'Connection refused by target server';
    } else if (error.cause?.code === 'ECONNRESET' || error.code === 'ECONNRESET') {
      status = 502;
      message = 'Connection reset by target server';
    } else if (
      error.code === 'CERT_HAS_EXPIRED' || 
      error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      error.message.includes('certificate')
    ) {
      status = 502;
      message = 'SSL certificate error on target server';
    }
    
    // Don't send error if headers already sent
    if (!res.headersSent) {
      res.status(status).json({
        error: 'Proxy request failed',
        message: message,
        target: targetUrl
      });
    }
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Endpoint ${req.method} ${req.path} does not exist`,
    availableEndpoints: ['/', '/health', '/proxy']
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
    });
  }
});

// Graceful shutdown
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down gracefully...`);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│         GitHub Codespace Proxy Server v2.1.0                │
├─────────────────────────────────────────────────────────────┤
│  Status:  Running                                           │
│  Port:    ${PORT}                                                │
│  Health:  http://localhost:${PORT}/health                        │
│  Proxy:   http://localhost:${PORT}/proxy?url=<url>               │
├─────────────────────────────────────────────────────────────┤
│  ⚠️  IMPORTANT: Make port ${PORT} PUBLIC in the Ports tab!       │
└─────────────────────────────────────────────────────────────┘
  `);
});
