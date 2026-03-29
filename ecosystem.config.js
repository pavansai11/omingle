module.exports = {
  apps: [
    {
      name: 'hippichat',
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
        PORT: 3000,
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
      env_production: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 3000,
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
    },
  ],
}
