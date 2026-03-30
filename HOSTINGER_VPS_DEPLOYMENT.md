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
- `COTURN_STATIC_AUTH_SECRET`
- `TURN_HOST=turn.hippichat.com`
- `TURN_PORT=3478`
- `TURN_CREDENTIAL_TTL_SECONDS=3600`

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

In **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs**:

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

To enable auto-deploy from GitHub, add these GitHub repo secrets:

- `HOSTINGER_HOST` → VPS IP / hostname
- `HOSTINGER_USER` → SSH username (e.g. `root`)
- `HOSTINGER_SSH_KEY` → private SSH key
- `HOSTINGER_PORT` → usually `22`
- `HOSTINGER_APP_DIR` → `/var/www/hippichat`

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

## 11. Optional staging/testing environment on the same VPS

If you want to test a `testing` branch safely without touching prod:

### Cloudflare DNS
- Add `A testing -> YOUR_VPS_IP`
- Use `testing.hippichat.com`

### Clone a separate directory

```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/pavansai11/omingle.git hippichat-testing
cd /var/www/hippichat-testing
git checkout testing
```

### Testing `.env`
Use a separate `.env` for testing with at least:

- `PORT=3001`
- `NEXT_PUBLIC_BASE_URL=https://testing.hippichat.com`
- `DB_NAME=HippiChatTesting`
- separate Redis/Upstash credentials if possible

### PM2 testing process

```bash
cd /var/www/hippichat-testing
PM2_APP_NAME=hippichat-testing PORT=3001 pm2 start ecosystem.config.js --env production
pm2 save
```

### Nginx testing host

```bash
cp deploy/nginx-testing.hippichat.com.conf /etc/nginx/sites-available/testing.hippichat.com
ln -s /etc/nginx/sites-available/testing.hippichat.com /etc/nginx/sites-enabled/testing.hippichat.com
nginx -t
systemctl reload nginx
certbot --nginx -d testing.hippichat.com
```

### GitHub Actions for testing branch
Add repo secret:
- `HOSTINGER_TESTING_APP_DIR=/var/www/hippichat-testing`

The repo now includes a separate workflow that deploys pushes to `testing` into that directory using:
- PM2 app name: `hippichat-testing`
- port: `3001`

## 12. Synthetic 100-user load testing

The repo now includes a socket-based load generator:

```bash
LOAD_URL=https://testing.hippichat.com \
LOAD_USERS=100 \
LOAD_RAMP_MS=150 \
LOAD_HOLD_MIN_MS=30000 \
LOAD_HOLD_MAX_MS=90000 \
LOAD_SKIP_CHANCE=0.35 \
yarn load:test:sockets
```

What it does:
- opens synthetic Socket.IO clients
- identifies users anonymously
- joins queue
- matches pairs
- holds for a random duration
- optionally skips and rejoins

This is good for testing:
- queue stability
- room creation
- websocket resilience
- VPS memory growth

It does **not** fully simulate real WebRTC media bandwidth/TURN load.

## 13. Browser + fake-media WebRTC test

After socket-level testing, you can do a more realistic browser test using Playwright with fake camera/mic.

### Install browser dependency once

```bash
cd /var/www/hippichat-testing
yarn install --frozen-lockfile
npx playwright install chromium
```

### Run 2–10 browser users first

```bash
cd /var/www/hippichat-testing
LOAD_URL=http://72.60.170.97:3001 \
BROWSER_USERS=10 \
RAMP_MS=500 \
HOLD_MIN_MS=30000 \
HOLD_MAX_MS=90000 \
SKIP_CHANCE=0.35 \
TEST_DURATION_MS=120000 \
yarn load:test:browsers
```

What it tests:
- real browser page loads
- fake media permission flow
- match/start/skip transitions
- frontend + socket + WebRTC handshake behavior

Recommended progression:
- 2 users
- 10 users
- 20–30 users

Do **not** jump straight to 100 full browsers on one machine unless you have a strong load generator machine, because then you may end up testing the load generator itself more than the app.

## Notes

- If you only have Hostinger shared hosting, use **Hostinger VPS** or host the app on Railway/Render/Fly and keep DNS on Hostinger.
- For stable production persistence, prefer a full `MONGODB_URI` from MongoDB Atlas.
- After changing `.env`, rebuild/restart:

```bash
cd /var/www/hippichat
yarn build
pm2 restart hippichat
```
