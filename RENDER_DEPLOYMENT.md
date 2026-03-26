# HappiChat deployment on Render with Hostinger domain

This is the simplest low-cost deployment path for the current app.

- **Domain / DNS:** Hostinger
- **App hosting:** Render Web Service
- **Database:** MongoDB Atlas
- **Auth:** Google OAuth Web application client

> Important: your current queue / matchmaking / room state is still stored **in memory**, so keep the service as a **single instance** for now. Do not scale horizontally until we move matchmaking state to Redis or another shared store.

---

## 1) Push clean code to GitHub

First make sure your repo pushes cleanly (without `.env`):

```bash
git push -u origin main --force
```

If GitHub still blocks the push, rotate any exposed secrets and verify `.env` is not tracked.

---

## 2) Create MongoDB Atlas first

For production, do not rely on the in-memory auth fallback.

1. Go to **MongoDB Atlas**
2. Create a free cluster
3. Create a DB user
4. Allow network access (temporarily `0.0.0.0/0` while testing)
5. Copy your connection string

Example:

```env
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/HappiChat?retryWrites=true&w=majority
```

---

## 3) Create the Render Web Service

1. Open **https://render.com**
2. Sign in with GitHub
3. Click **New +** → **Web Service**
4. Select your repo: `pavansai11/happichat`

### Use these settings

- **Name:** `happichat`
- **Runtime:** `Node`
- **Branch:** `main`
- **Build Command:**

```bash
yarn install --frozen-lockfile && yarn build
```

- **Start Command:**

```bash
yarn start
```

- **Instance type:** use the cheapest/free option available
- **Auto Deploy:** enabled

You can also use the included `render.yaml` blueprint if Render offers the blueprint flow in your account.

---

## 4) Add environment variables in Render

In your Render service → **Environment**, add:

```env
NEXT_PUBLIC_BASE_URL=https://happichat.com
NEXT_PUBLIC_GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET
MONGODB_URI=YOUR_MONGODB_URI
DB_NAME=HappiChat
CORS_ORIGINS=https://happichat.com,https://www.happichat.com,http://localhost:3000,http://127.0.0.1:3000
AZURE_TRANSLATOR_KEY=...
AZURE_TRANSLATOR_ENDPOINT=https://api.cognitive.microsofttranslator.com/
AZURE_TRANSLATOR_REGION=centralindia
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=southeastasia
AZURE_SPEECH_ENDPOINT=https://southeastasia.api.cognitive.microsoft.com/
```

Do **not** commit real secrets to GitHub. Keep them only in Render.

---

## 5) First deploy

After saving env vars, click **Deploy latest commit**.

Render will build and start the app, then give you a URL like:

```text
https://happichat.onrender.com
```

Test this URL before connecting your custom domain.

---

## 6) Fix Google Sign-In properly

In **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs**:

- make sure the client type is **Web application**

### Add Authorized JavaScript origins

Add all origins you use:

- `http://localhost:3000`
- `http://127.0.0.1:3000`
- `https://happichat.onrender.com`
- `https://happichat.com`
- `https://www.happichat.com`

### OAuth consent screen

If your app is still in **Testing**:
- add your Gmail as a **test user**

Later publish it when ready.

---

## 7) Connect Hostinger domain to Render

### In Render
Go to your service → **Settings** → **Custom Domains**

Add:
- `happichat.com`
- optionally `www.happichat.com`

Render will show the DNS records to add.

### In Hostinger DNS
Add the exact records Render gives you.

Usually:
- `www` → CNAME to Render target
- root / apex `@` → A/ALIAS-style setup depending on Render instructions

Wait for propagation.

Render will provision SSL automatically once the domain is verified.

---

## 8) How future updates work

Render supports GitHub auto-deploy by default.

So your future update flow is:

```bash
git add .
git commit -m "update"
git push
```

Render will automatically:
1. pull the new commit
2. install dependencies
3. build the app
4. restart the service

So yes, once hosted, code updates can reflect automatically after push.

---

## 9) Important free-tier caveats

If you use the free/lowest Render tier:
- service may **sleep** after inactivity
- first request may be slow while it wakes up

Also, because matchmaking is in memory:
- keep it as **single instance only**
- do not scale horizontally yet

---

## 10) Exact order to follow

1. Push clean repo to GitHub
2. Create MongoDB Atlas and get `MONGODB_URI`
3. Create Render Web Service
4. Add env vars in Render
5. Deploy and test `onrender.com` URL
6. Add Render URL + `happichat.com` to Google OAuth origins
7. Add custom domain in Render
8. Add DNS records in Hostinger
9. Test Google sign-in on `https://happichat.com`
10. Push future updates normally with git

---

## 11) Files already prepared in this repo

You now already have:

- `Dockerfile`
- `.dockerignore`
- `.env.production.example`
- `.github/workflows/deploy-cloud-run.yml`
- `CLOUD_RUN_DEPLOYMENT.md`
- `render.yaml`
- `RENDER_DEPLOYMENT.md`

So the project is already structured for deployment planning.
