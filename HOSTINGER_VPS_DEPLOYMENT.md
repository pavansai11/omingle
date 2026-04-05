# HippiChat deployment on Hostinger VPS

This app uses a custom `server.js` + Socket.IO, so it should be hosted on a **Hostinger VPS**.
Shared hosting is not suitable for this setup.

## 1. Point your domain

In Hostinger DNS, create/update:

- `A` record for `@` → your VPS public IP
- `A` record for `www` → your VPS public IP

## 2. SSH into the VPS

```bash
ssh root@YOUR_VPS_IP
```

## 3. Install base packages

```bash
apt update && apt upgrade -y
apt install -y curl git nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2 yarn
```

## 4. Clone the project

```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/pavansai11/omingle.git hippichat
cd /var/www/hippichat
```

## 5. Configure environment variables

Create your production env file:

```bash
cp .env.production.example .env
nano .env
```

At minimum, set:

- `NEXT_PUBLIC_BASE_URL=https://hippichat.com`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `MONGODB_URI` *(recommended)*
- `REDIS_URL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `CORS_ORIGINS=https://hippichat.com,https://www.hippichat.com`
- `CLOUDFLARE_TURN_TOKEN_ID`
- `CLOUDFLARE_TURN_API_TOKEN`
- `TURN_CREDENTIAL_TTL_SECONDS=3600`

Cloudflare TURN now handles relay credentials for WebRTC, so you do **not** need to run a separate self-hosted TURN service on this VPS.

## 6. Build and start with PM2

```bash
cd /var/www/hippichat
yarn install --frozen-lockfile
yarn build
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`.

## 7. Configure Nginx

Copy the provided config:

```bash
cp deploy/nginx-omingle.fun.conf /etc/nginx/sites-available/hippichat.com
ln -s /etc/nginx/sites-available/hippichat.com /etc/nginx/sites-enabled/hippichat.com
nginx -t
systemctl reload nginx
```

## 8. Enable HTTPS

```bash
certbot --nginx -d hippichat.com -d www.hippichat.com
```

## 9. Google OAuth settings

In **Google APIs & Services → Credentials → OAuth 2.0 Client IDs**:

- client type must be **Web application**
- add **Authorized JavaScript origins**:
  - `http://localhost:3000`
  - `http://127.0.0.1:3000`
  - `https://hippichat.com`
  - `https://www.hippichat.com`

If the OAuth consent screen is still in **Testing**, add your Gmail as a test user.

## 10. Automatic updates when you push code

This repo includes:

- `ecosystem.config.js`
- `scripts/deploy-hostinger.sh`
- `.github/workflows/deploy-hostinger.yml`

The workflow is already pinned to this VPS and app path:

- Host: `72.60.170.97`
- User: `root`
- Port: `22`
- App dir: `/var/www/hippichat`

To enable auto-deploy from GitHub, add **one** authentication method as repo secrets:

- `HOSTINGER_PASSWORD` → VPS password for `root`

Or, if you prefer SSH key auth instead of password:

- `HOSTINGER_SSH_KEY` → private SSH key
- `HOSTINGER_SSH_PASSPHRASE` → optional key passphrase

Recommended PM2 memory guard for this VPS path:

- `max_memory_restart: 4G`

Recommended runtime:

- `NODE_OPTIONS=--max-old-space-size=4096`

After that, every push to `main` will:

1. SSH into the VPS
2. `git fetch && git reset --hard origin/main`
3. `yarn install`
4. `yarn build`
5. `pm2 startOrReload ecosystem.config.js --env production`

## Notes

- If you only have Hostinger shared hosting, use **Hostinger VPS** or host the app on Railway/Render/Fly and keep DNS on Hostinger.
- For stable production persistence, prefer a full `MONGODB_URI` from MongoDB Atlas.
- After changing `.env`, rebuild/restart:

```bash
cd /var/www/hippichat
yarn build
pm2 restart hippichat
```
