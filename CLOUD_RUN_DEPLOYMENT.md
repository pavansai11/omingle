# HippiChat deployment with Hostinger domain + Google Cloud Run

This is the recommended low-cost path for the current app:

- **Domain/DNS:** Hostinger
- **App hosting:** Google Cloud Run
- **Database:** MongoDB Atlas
- **Auth:** Google OAuth (Web application)

Because your app uses a custom `server.js` + Socket.IO and currently keeps queue/matchmaking state **in memory**, deploy it with:

- **Cloud Run max instances = 1**

If you scale beyond one instance later, matchmaking should be moved to Redis / a shared store.

---

## 1. Prepare the code

Push your project to GitHub:

```bash
git add .
git commit -m "Prepare HippiChat for Cloud Run"
git push origin main
```

This repo already includes:

- `Dockerfile`
- `.dockerignore`
- `.env.production.example`
- `.github/workflows/deploy-cloud-run.yml`

---

## 2. Create a Google Cloud project

In Google Cloud Console:

1. Create a new project (or use an existing one)
2. Enable billing (Cloud Run free tier still typically needs billing enabled)
3. Enable these APIs:
   - Cloud Run API
   - Cloud Build API
   - Artifact Registry API

---

## 3. Install Google Cloud CLI locally (optional but recommended)

On macOS:

```bash
brew install --cask google-cloud-sdk
gcloud init
```

Then select your project.

---

## 4. Create an Artifact Registry repository

```bash
gcloud artifacts repositories create hippichat \
  --repository-format=docker \
  --location=asia-south1 \
  --description="HippiChat containers"
```

You can choose a different region, but keep it consistent everywhere.

---

## 5. Configure your production environment variables

Use the template already in the repo:

```bash
cp .env.production.example .env.production.local
```

Important values you must finalize:

- `NEXT_PUBLIC_BASE_URL=https://hippichat.com`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID=...`
- `GOOGLE_CLIENT_ID=...`
- `GOOGLE_CLIENT_SECRET=...`
- `MONGODB_URI=...` *(recommended)*
- `REDIS_URL=rediss://...`
- `UPSTASH_REDIS_REST_URL=...`
- `UPSTASH_REDIS_REST_TOKEN=...`
- `COTURN_STATIC_AUTH_SECRET=...`
- `TURN_HOST=turn.hippichat.com`
- `TURN_PORT=3478`
- `TURN_CREDENTIAL_TTL_SECONDS=3600`

For production, prefer a full **MongoDB Atlas** connection string.

---

## 6. Build and deploy manually the first time

From the project root:

```bash
IMAGE="asia-south1-docker.pkg.dev/YOUR_GCP_PROJECT_ID/hippichat/hippichat:initial"
gcloud auth configure-docker asia-south1-docker.pkg.dev --quiet
gcloud builds submit --tag "$IMAGE"
gcloud run deploy hippichat \
  --image "$IMAGE" \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --max-instances=1
```

When prompted, set your environment variables in Cloud Run, or add them later from the Cloud Run console.

---

## 7. Set environment variables in Cloud Run

In Google Cloud Console:

**Cloud Run → hippichat → Edit & Deploy New Revision → Variables & Secrets**

Add all production variables from `.env.production.example`.

At minimum:

- `NEXT_PUBLIC_BASE_URL=https://hippichat.com`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID=...`
- `GOOGLE_CLIENT_ID=...`
- `GOOGLE_CLIENT_SECRET=...`
- `MONGODB_URI=...`
- `DB_NAME=HippiChat`
- `REDIS_URL=rediss://...`
- `UPSTASH_REDIS_REST_URL=...`
- `UPSTASH_REDIS_REST_TOKEN=...`
- `CORS_ORIGINS=https://hippichat.com,https://www.hippichat.com,http://localhost:3000,http://127.0.0.1:3000`
- `COTURN_STATIC_AUTH_SECRET=...`
- `TURN_HOST=turn.hippichat.com`
- `TURN_PORT=3478`
- `TURN_CREDENTIAL_TTL_SECONDS=3600`

Then redeploy.

---

## 8. Connect your Hostinger domain to Cloud Run

In Google Cloud Console:

**Cloud Run → Manage Custom Domains**

Map:

- `hippichat.com`
- optionally `www.hippichat.com`

Google will show DNS records you must add in Hostinger DNS.

Usually this will involve:

- a verification TXT record
- A/AAAA or CNAME records depending on the mapping flow

Add those records in **Hostinger DNS Zone**.

Once verified, Google will provision HTTPS automatically for the custom domain.

---

## 9. Fix Google Sign-In properly

In **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs**:

Make sure your OAuth client is of type **Web application**.

### Authorized JavaScript origins

Add:

- `http://localhost:3000`
- `http://127.0.0.1:3000`
- `https://hippichat.com`
- `https://www.hippichat.com`

Also, while testing the raw Cloud Run URL, you may add the generated:

- `https://YOUR-SERVICE-URL.run.app`

### OAuth consent screen

If app is in **Testing**:
- add your Gmail as a **test user**

Later publish when ready.

---

## 10. Automatic deploy on every code push

This repo already includes `.github/workflows/deploy-cloud-run.yml`.

Add these GitHub repository secrets:

- `GCP_SA_KEY` → service account JSON key
- `GCP_PROJECT_ID` → your Google Cloud project ID
- `GCP_REGION` → e.g. `asia-south1`
- `GCP_ARTIFACT_REPOSITORY` → e.g. `hippichat`

Then every push to `main` will:

1. build the Docker image
2. push it to Artifact Registry
3. deploy it to Cloud Run

So later, your update flow becomes:

```bash
git add .
git commit -m "update"
git push
```

and your production site updates automatically.

---

## 11. Suggested service account permissions

Create a deploy service account and give it roles like:

- Cloud Run Admin
- Cloud Build Editor
- Artifact Registry Writer
- Service Account User

Then create a JSON key and store it in GitHub secret `GCP_SA_KEY`.

---

## 12. Verify everything

After deployment, test:

1. `https://hippichat.com`
2. Google sign-in works
3. Start Chat asks for sign-in if logged out
4. Chat page opens correctly
5. WebSocket / Socket.IO works
6. History/Friends stay closed until clicked

---

## 13. Important limitations for now

### Matchmaking scaling
Redis-backed infrastructure is now required for safe multi-instance scale. Until the full rollout is validated in production, keep:

- `max instances = 1`

After validation, you can raise max instances gradually.

### MongoDB
You still need a real production DB target.
Best option: **MongoDB Atlas URI**.

---

## 14. Fastest practical path

If you want the simplest path right now:

1. Create GCP project
2. Enable Cloud Run + Cloud Build + Artifact Registry
3. Create Artifact Registry repo
4. Deploy once manually
5. Connect `hippichat.com`
6. Configure Google OAuth origins
7. Add GitHub secrets for auto-deploy

Then future code pushes update the live site automatically.
