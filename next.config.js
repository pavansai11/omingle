const isDev = process.env.NODE_ENV !== 'production';
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)
const primaryOrigin = allowedOrigins[0] || (isDev ? 'http://localhost:3000' : (process.env.NEXT_PUBLIC_BASE_URL || 'https://hippichat.com'))

// ── Adsterra domains ──────────────────────────────────────────────────────────
// theoreticalassertshame.com already present; add the Google ad-quality domain
// that Adsense/Adsterra injects at runtime, plus the sodar subdomain.
const adsterraDomain = 'https://theoreticalassertshame.com'
const googleAdDomains = [
  'https://pagead2.googlesyndication.com',
  'https://ep2.adtrafficquality.google',       // sodar2.js parent — was blocked
  'https://adtrafficquality.google',
  'https://tpc.googlesyndication.com',
  'https://googleads.g.doubleclick.net',
]

// ── Monetag vignette ──────────────────────────────────────────────────────────
// The working script URL is n6wxm.com (not ophoacit.com which was old/wrong).
const moneTagDomains = [
  'https://n6wxm.com',       // vignette loader — new correct URL
  'https://ophoacit.com',    // kept for fallback / old cached references
]

// ── face-api model + CDN ──────────────────────────────────────────────────────
// face-api.js is loaded dynamically from jsDelivr; its model weights are also
// fetched from jsDelivr, so both the script and the fetch() must be allowed.
const faceApiDomains = [
  'https://cdn.jsdelivr.net',
]

// ── Cloudflare Analytics (beacon) ─────────────────────────────────────────────
// Cloudflare injects its beacon script from static.cloudflareinsights.com.
// Allow it to avoid noisy CSP errors, but it is non-critical.
const cloudflareDomains = [
  'https://static.cloudflareinsights.com',
  'https://cloudflareinsights.com',
]

// ── Adsterra native/banner (profitablecpmratenetwork) ────────────────────────
const profitDomain = 'https://pl29014129.profitablecpmratenetwork.com'

// Assemble directives
const connectSrc = [
  "'self'",
  'https://accounts.google.com',
  'https://oauth2.googleapis.com',
  'https://rtc.live.cloudflare.com',
  'https://ipapi.co',
  'https://cdn.jsdelivr.net',        // face-api model weights (fetch)
  'https://cloudflareinsights.com',  // beacon ping
  'https:',
  'wss:',
].join(' ')

const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  'https://accounts.google.com',
  ...googleAdDomains,
  adsterraDomain,
  profitDomain,
  ...moneTagDomains,
  ...faceApiDomains,
  ...cloudflareDomains,
].join(' ')

const frameSrc = [
  "'self'",
  'https://accounts.google.com',
  ...googleAdDomains,
  adsterraDomain,
  profitDomain,
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
  images: {
    unoptimized: true,
  },
  experimental: {
    serverComponentsExternalPackages: ['mongodb'],
  },
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        poll: 2000,
        aggregateTimeout: 300,
        ignored: ['**/node_modules'],
      };
    }
    return config;
  },
  onDemandEntries: {
    maxInactiveAge: 60 * 1000,
    pagesBufferLength: 8,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: isDev ? "SAMEORIGIN" : "DENY" },
          { key: "Content-Security-Policy", value: csp },
          { key: "Access-Control-Allow-Origin", value: primaryOrigin },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "*" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;