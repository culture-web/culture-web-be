# NUS SoC LaaS (`SOCLAAS_API_KEY`) Setup & Rotation Guide

This guide explains how a new developer or maintainer can configure or rotate the **NUS SoC LaaS (LLM-as-a-Service)** API key (`SOCLAAS_API_KEY`) across both **Local Development** and **Production**.

---

## 1. Architecture Overview

In [`client/groqClient.js`](../client/groqClient.js), LLM requests use the following provider priority (with automatic runtime fallback):

1. **NUS SoC LaaS (`soclaas`)** — Primary provider (`https://soclaas-api.comp.nus.edu.sg/v1`, model: `default`)
2. **Groq (`groq`)** — Secondary fallback (`openai/gpt-oss-120b`)
3. **OpenAI (`openai`)** — Last-resort fallback

### Quick Key & Model Catalog Check

Before updating your environments, verify that your new `SOCLAAS_API_KEY` is active and check visible models (`GET /v1/models`):

```bash
curl -s \
  -H "Authorization: Bearer <YOUR_NEW_SOCLAAS_API_KEY>" \
  https://soclaas-api.comp.nus.edu.sg/v1/models | jq .
```

To test a chat completion directly against SoC LaaS:

```bash
curl -s https://soclaas-api.comp.nus.edu.sg/v1/chat/completions \
  -H "Authorization: Bearer <YOUR_NEW_SOCLAAS_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"Say hello"}],"max_tokens":20}'
```

---

## 2. Updating Local Development (`culture-web-be`)

1. Open `.env` in the root of `culture-web-be` (copy from [`.env.example`](../.env.example) if setting up for the first time).
2. Set or update the SoC LaaS variables:
   ```dotenv
   # NUS SoC LaaS (Primary LLM provider)
   SOCLAAS_BASE_URL=https://soclaas-api.comp.nus.edu.sg/v1
   SOCLAAS_API_KEY=<YOUR_NEW_SOCLAAS_API_KEY>
   SOCLAAS_MODEL=default
   ```
3. Restart your local backend server (`npm run dev` or `npm start`).
4. When a chat request is made, verify the console prints:
   ```text
   ✅ [LLMClient] Initialized NUS SoC LaaS client (model: default)
   ```

---

## 3. Updating Production (`culture-web-be` CI $\rightarrow$ `culture-web/cd` VM)

> **Important Architecture Rule (Build-Time Secret Injection):**
> In `culture-web-be`, production secrets are injected into `.env` **at Docker build time** by [`.github/workflows/build-image.yml`](../.github/workflows/build-image.yml) and packaged into the published Docker image (`culture4web/culture-web-be:<tag>`).
> - **Do NOT** add `SOCLAAS_API_KEY` to `docker-compose.yml` in `culture-web/cd`.
> - **Do NOT** add `SOCLAAS_API_KEY` to `.env.production` on the VM.

### Step 1: Update the GitHub Actions Secret in `culture-web/culture-web-be`

**Via GitHub Web UI:**
1. Go to **`culture-web/culture-web-be` $\rightarrow$ Settings $\rightarrow$ Secrets and variables $\rightarrow$ Actions**.
2. Locate **`SOCLAAS_API_KEY`**, click **Update**, paste the new key, and save.

**Or via GitHub CLI (`gh`):**
```bash
gh secret set SOCLAAS_API_KEY --repo culture-web/culture-web-be --body "<YOUR_NEW_SOCLAAS_API_KEY>"
```

### Step 2: Build and Push a New Backend Docker Image

Trigger the **Build Image CI** workflow ([`.github/workflows/build-image.yml`](../.github/workflows/build-image.yml)) with a bumped version tag (e.g., if `culture-web/cd/docker-compose.yml` is currently on `v2.14.3`, use `v2.14.4`):

**Via GitHub Web UI:**
1. Go to **`culture-web/culture-web-be` $\rightarrow$ Actions $\rightarrow$ Build Image CI**.
2. Click **Run workflow**, select branch `develop`, enter the new `image-tag` (e.g. `v2.14.4`), and click **Run workflow**.
3. Wait ~1–2 minutes for the build and DockerHub push to complete.

**Or via GitHub CLI (`gh`):**
```bash
gh workflow run build-image.yml --repo culture-web/culture-web-be --ref develop -f image-tag=v2.14.4
```

### Step 3: Bump the Image Tag in `culture-web/cd`

In the [`culture-web/cd`](https://github.com/culture-web/cd) repository (`develop` branch), update **only** the `be` service image tag in `docker-compose.yml`:

```yaml
  be:
    image: culture4web/culture-web-be:v2.14.4
```

Commit and push to `develop`.

### Step 4: Deploy on the Production VM

SSH into the production VM, navigate to the `cd` directory (`~/CP4101/cd`), and run `./startup.sh` (which automatically runs `git pull origin develop`, pulls the new Docker image, and restarts the containers):

```bash
cd ~/CP4101/cd
./startup.sh
```

---

## 4. Verifying Production After Deployment

Run the following commands on the VM (`~/CP4101/cd`) after `./startup.sh` completes:

1. **Confirm the new key is baked into the running `be` container:**
   ```bash
   docker compose --env-file .env.production exec be grep SOCLAAS_API_KEY .env
   ```

2. **Verify `groqClient` resolves to `soclaas` and completes a live request:**
   ```bash
   docker compose --env-file .env.production exec be node -e "require('dotenv').config(); const g = require('./client/groqClient'); const c = g.getInstance(); c.chat.completions.create({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }).then(r => console.log({ activeProvider: g.getProvider(), baseURL: c.raw.baseURL, responseModel: r.model, reply: r.choices[0].message.content }))"
   ```
   Expected output:
   ```text
   ✅ [LLMClient] Initialized NUS SoC LaaS client (model: default)
   {
     activeProvider: 'soclaas',
     baseURL: 'https://soclaas-api.comp.nus.edu.sg/v1',
     responseModel: 'qwen3.6:35b',
     reply: 'Hello! How can I help you today?'
   }
   ```

3. **Test the end-to-end backend `/api/kathakali/chat` route:**
   ```bash
   curl -s -X POST http://localhost/api/kathakali/chat \
     -F "message=Hello, what is Kathakali in one sentence?"
   ```

