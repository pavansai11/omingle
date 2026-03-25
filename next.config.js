const isDev = process.env.NODE_ENV !== 'production';
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)
const primaryOrigin = allowedOrigins[0] || (isDev ? '*' : (process.env.NEXT_PUBLIC_BASE_URL || 'https://omingle.fun'))

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
          { key: "Content-Security-Policy", value: "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob: https:; connect-src 'self' https: wss:; script-src 'self' 'unsafe-inline' https://accounts.google.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; frame-ancestors 'self';" },
          { key: "Access-Control-Allow-Origin", value: primaryOrigin },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "*" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
