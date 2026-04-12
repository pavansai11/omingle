const isDev = process.env.NODE_ENV !== 'production';
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean)
const primaryOrigin = allowedOrigins[0] || (isDev ? 'http://localhost:3000' : (process.env.NEXT_PUBLIC_BASE_URL || 'https://hippichat.com'))

// ── CSP source lists ──────────────────────────────────────────────────────────

const connectSrc = [
  "'self'",
  'https://accounts.google.com',
  'https://oauth2.googleapis.com',
  'https://rtc.live.cloudflare.com',
  'https://ipapi.co',
  'https://cdn.jsdelivr.net',          // face-api model weight fetches
  'https://cloudflareinsights.com',    // CF beacon ping
  'https://n6wxm.com',                 // Monetag vignette endpoint
  'https://ophoacit.com',              // Monetag fallback
  'https:',
  'wss:',
].join(' ')

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  // Google / AdSense
  'https://accounts.google.com',
  'https://pagead2.googlesyndication.com',
  'https://ep2.adtrafficquality.google',   // sodar2.js — injected by AdSense
  'https://adtrafficquality.google',
  // Adsterra
  'https://theoreticalassertshame.com',
  'https://pl29014129.profitablecpmratenetwork.com',
  // Monetag vignette — new correct CDN
  'https://n6wxm.com',
  'https://ophoacit.com',              // kept for cached refs
  // face-api.js from jsDelivr
  'https://cdn.jsdelivr.net',
  // Cloudflare Analytics beacon
  'https://static.cloudflareinsights.com',
  'https://cloudflareinsights.com',
].join(' ')

const frameSrc = [
  "'self'",
  'https://accounts.google.com',
  'https://googleads.g.doubleclick.net',
  'https://tpc.googlesyndication.com',
  'https://theoreticalassertshame.com',
  'https://pl29014129.profitablecpmratenetwork.com',
].join(' ')

const imgSrc = ["'self'", 'data:', 'blob:', 'https:'].join(' ')

const csp = [
  "default-src 'self'",
  `img-src ${imgSrc}`,
  "media-src 'self' blob: https:",
  `connect-src ${connectSrc}`,
  `script-src ${scriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  `frame-src ${frameSrc}`,
  `child-src ${frameSrc}`,
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
].join('; ')

const nextConfig = {
  output: 'standalone',
  distDir: isDev ? '.next-dev' : '.next',
  images: { unoptimized: true },
  experimental: {
    serverComponentsExternalPackages: ['mongodb'],
  },
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = { poll: 2000, aggregateTimeout: 300, ignored: ['**/node_modules'] }
    }
    return config
  },
  onDemandEntries: { maxInactiveAge: 60 * 1000, pagesBufferLength: 8 },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: isDev ? 'SAMEORIGIN' : 'DENY' },
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Access-Control-Allow-Origin', value: primaryOrigin },
          { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, DELETE, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
        ],
      },
    ]
  },
}

module.exports = nextConfig