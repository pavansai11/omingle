const appName = process.env.PM2_APP_NAME || 'hippichat'
const appPort = Number(process.env.PORT || 3000)

module.exports = {
  apps: [
    {
      name: appName,
      script: 'server.js',
      interpreter: 'node',
      node_args: '--max-old-space-size=4096',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: appPort,
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
      env_production: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: appPort,
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
    },
  ],
}
