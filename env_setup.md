# 🔐 Environment Variables Setup

## Netlify Environment Variables

Set these environment variables in your Netlify dashboard:
**Site Settings → Build & deploy → Environment → Environment variables**

### Required Variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `S_URL` | Supabase Project URL | `https://xxxxx.supabase.co` |
| `ANON_KEY` | Supabase Anon/Public Key | `eyJhbGciOiJIUzI1...` |
| `GCID` | Google OAuth Client ID | `123456-abc.apps.googleusercontent.com` |
| `CAPTCHA_KEY` | hCaptcha Site Key (optional) | `10000000-ffff-ffff...` |
| `GROQ_API_KEY` | Groq API key for AI advisor | `gsk_live_...` |

---

## 🚀 How to Set Environment Variables

### Option 1: Netlify UI
1. Go to **Netlify Dashboard**
2. Select your site
3. Navigate to **Site settings**
4. Click **Build & deploy** → **Environment**
5. Click **Add variable**
6. Add each variable with its value
7. Click **Save**

### Option 2: Netlify CLI
```bash
netlify env:set S_URL "https://your-project.supabase.co"
netlify env:set ANON_KEY "your-supabase-anon-key"
netlify env:set GCID "your-google-client-id.apps.googleusercontent.com"
netlify env:set CAPTCHA_KEY "your-hcaptcha-key"
netlify env:set GROQ_API_KEY "gsk_live_..."
```

### Option 3: netlify.toml (NOT RECOMMENDED - Don't commit secrets!)
```toml
# ❌ Don't do this - secrets will be in git!
[build.environment]
  S_URL = "https://..."  # NO!
```

---

## 🔍 How It Works

### Before (❌ Insecure):
```javascript
// script.js - EXPOSED to public!
const CONFIG = {
    SUPABASE_URL: 'https://your-project.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',  // 🚨 VISIBLE!
    GOOGLE_CLIENT_ID: 'your-google-client-id.apps.googleusercontent.com'
};
```

### After (✅ Secure):
```javascript
// script.js - Clean!
const CONFIG = await fetch('/api/config').then(r => r.json());
// Keys are loaded from server, not hardcoded!
```

```javascript
// api/config.js - Runs on server, not exposed!
exports.handler = async () => {
    return {
        body: JSON.stringify({
            supabaseUrl: process.env.S_URL,        // ✅ Secure!
            supabaseKey: process.env.ANON_KEY,     // ✅ Secure!
            googleClientId: process.env.GCID       // ✅ Secure!
        })
    };
};
```

---

## 📝 Migration Checklist

- [x] Create `api/config.js` Netlify Function
- [x] Update `script.js` to load config from `/api/config`
- [x] Add environment variables in Netlify dashboard
- [ ] Remove hardcoded keys from git history (optional but recommended):
  ```bash
  # Use BFG Repo-Cleaner to remove sensitive data from git history
  # https://rtyley.github.io/bfg-repo-cleaner/
  ```
- [ ] Deploy to Netlify
- [ ] Test that login/database features work

---

## 🧪 Testing

### Local Development with Netlify Dev:
```bash
# Install Netlify CLI if not installed
npm install -g netlify-cli

# Set local environment variables
netlify env:set S_URL "https://..." --context dev
netlify env:set ANON_KEY "..." --context dev
netlify env:set GCID "..." --context dev

# Run local dev server
netlify dev
```

### Test the config endpoint:
```bash
curl http://localhost:8888/api/config
```

Should return:
```json
{
  "supabaseUrl": "https://...",
  "supabaseKey": "eyJ...",
  "googleClientId": "your-google-client-id...",
  "captchaKey": "..."
}
```

---

## 🔒 Security Benefits

| Before | After |
|--------|-------|
| ❌ Keys in client-side JS | ✅ Keys in server environment |
| ❌ Visible in browser DevTools | ✅ Not accessible via DevTools |
| ❌ Exposed in git repository | ✅ Never committed to git |
| ❌ Can be scraped by bots | ✅ Served via secure endpoint |
| ❌ Same keys for all environments | ✅ Different keys per environment (dev/prod) |

---

## ⚠️ Important Notes

1. **Anon Key is still public**: The Supabase `ANON_KEY` is meant to be public-facing and is protected by Row Level Security (RLS) in Supabase.

2. **Service Role Key**: NEVER expose `SERVICE_ROLE_KEY` on the client. That one must stay server-side only.

3. **Cache Control**: The `/api/config` endpoint is cached for 1 hour to reduce API calls.

4. **Error Handling**: If config fails to load, the app will alert the user and log the error.

---

## 📚 Additional Resources

- [Netlify Environment Variables](https://docs.netlify.com/configure-builds/environment-variables/)
- [Supabase Security Best Practices](https://supabase.com/docs/guides/api/securing-your-api)
- [Google OAuth Setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid)

---

**Last Updated**: October 5, 2025
