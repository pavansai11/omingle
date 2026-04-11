const isDev = process.env.NODE_ENV !== 'production';
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)
const primaryOrigin = allowedOrigins[0] || (isDev ? 'http://localhost:3000' : (process.env.NEXT_PUBLIC_BASE_URL || 'https://hippichat.com'))
const connectSrc = ["'self'", 'https://accounts.google.com', 'https://oauth2.googleapis.com', 'https://rtc.live.cloudflare.com', 'https://ipapi.co', 'https:', 'wss:'].join(' ')
const scriptSrc = ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://pagead2.googlesyndication.com', 'https://pl29014129.profitablecpmratenetwork.com', 'https://theoreticalassertshame.com'].join(' ')
const frameSrc = ["'self'", 'https://accounts.google.com', 'https://googleads.g.doubleclick.net', 'https://tpc.googlesyndication.com', 'https://pl29014129.profitablecpmratenetwork.com', 'https://theoreticalassertshame.com'].join(' ')
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
  // Keep development artifacts isolated from production/build artifacts.
  // This avoids `.next` manifest/chunk corruption when switching between
  // `yarn build` and the custom Socket.IO dev server.
  distDir: isDev ? '.next-dev' : '.next',
  images: {
    unoptimized: true,
  },
  experimental: {
    // Remove if not using Server Components
    serverComponentsExternalPackages: ['mongodb'],
  },
  webpack(config, { dev }) {
    if (dev) {
      // Reduce CPU/memory from file watching
      config.watchOptions = {
        poll: 2000, // check every 2 seconds
        aggregateTimeout: 300, // wait before rebuilding
        ignored: ['**/node_modules'],
      };
    }
    return config;
  },
  // Keep more dev assets/chunks alive.
  // Very small on-demand entry buffers can cause `/_next/static/*` 404s
  // with the app router + custom server during local development.
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
