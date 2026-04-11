import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { createUserSession, deleteUserSession, getSessionCookieName, getUserSession, updateUserProfile, upsertGoogleUser } from '@/lib/auth-store';
import { getDatabase } from '@/lib/mongodb';

const memoryAdEngagement = new Map();
const AD_GATE_MIN_MS = 0;
const AD_GATE_MAX_MS = 10 * 60 * 1000;
const ALLOWED_GATE_REASONS = new Set(['skip', 'add-friend', 'filters']);
const ALLOWED_GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const MAX_NAME_LENGTH = 60;
const MAX_IMAGE_URL_LENGTH = 500;
const MAX_LANGUAGE_CODE_LENGTH = 32;
const MAX_TRANSLATION_TEXT_LENGTH = 500;

function getAllowedOrigins() {
  const raw = process.env.CORS_ORIGINS || '';
  const parsed = raw.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (parsed.length) return parsed;
  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.NEXT_PUBLIC_BASE_URL || 'https://hippichat.com',
  ].filter(Boolean);
}

function buildCorsHeaders(request) {
  const allowedOrigins = new Set(getAllowedOrigins());
  const requestOrigin = request.headers.get('origin');
  const allowOrigin = requestOrigin && allowedOrigins.has(requestOrigin)
    ? requestOrigin
    : getAllowedOrigins()[0] || 'https://hippichat.com';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function validateStateChangingRequest(request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return true;

  try {
    const originUrl = new URL(origin);
    return originUrl.host === host || getAllowedOrigins().includes(originUrl.origin);
  } catch (error) {
    return false;
  }
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLength);
}

function sanitizeLanguageSelection(language) {
  if (!language || typeof language !== 'object') return undefined;
  const code = sanitizeString(language.code, MAX_LANGUAGE_CODE_LENGTH);
  if (!code) return undefined;
  return {
    code,
    name: sanitizeString(language.name, 80) || code,
    flag: sanitizeString(language.flag, 12) || '🌐',
  };
}

function sanitizeLanguageSelections(languages) {
  if (!Array.isArray(languages)) return undefined;
  return languages
    .map((language) => sanitizeLanguageSelection(language))
    .filter(Boolean)
    .slice(0, 5);
}

function sanitizeImageUrl(value) {
  const trimmed = sanitizeString(value, MAX_IMAGE_URL_LENGTH);
  if (typeof trimmed === 'undefined') return undefined;
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch (error) {
    return null;
  }
}

function sanitizeCountryField(value, maxLength) {
  const trimmed = sanitizeString(value, maxLength);
  return typeof trimmed === 'undefined' ? undefined : trimmed;
}

async function resolveAuthenticatedUser(request) {
  const sessionId = request.cookies.get(getSessionCookieName())?.value;
  const session = await getUserSession(sessionId);
  return session?.user || null;
}

async function getAdEngagementForUser(userId) {
  if (!userId) return null;
  const db = await getDatabase();

  if (!db) {
    const existing = memoryAdEngagement.get(userId) || { skipCount: 0, lastUpdatedAt: new Date().toISOString(), pendingGate: null };
    memoryAdEngagement.set(userId, existing);
    return existing;
  }

  const users = db.collection('users');
  const user = await users.findOne({ $or: [{ userId }, { googleId: userId }] }, { projection: { adEngagement: 1 } });
  const current = user?.adEngagement || { skipCount: 0 };
  const pendingGate = current?.pendingGate || null;
  return {
    skipCount: Number.isFinite(current.skipCount) ? Number(current.skipCount) : 0,
    lastUpdatedAt: current.lastUpdatedAt || new Date().toISOString(),
    pendingGate: pendingGate && pendingGate?.nonce
      ? {
          reason: pendingGate.reason || null,
          nonce: pendingGate.nonce,
          gateOpenedAt: pendingGate.gateOpenedAt || null,
          minEligibleAt: pendingGate.minEligibleAt || null,
          expiresAt: pendingGate.expiresAt || null,
        }
      : null,
  };
}

async function setAdEngagementForUser(userId, engagement) {
  if (!userId) return null;
  const sanitized = {
    skipCount: Math.max(0, Number(engagement?.skipCount || 0)),
    lastUpdatedAt: new Date().toISOString(),
    pendingGate: engagement?.pendingGate?.nonce
      ? {
          reason: String(engagement.pendingGate.reason || ''),
          nonce: String(engagement.pendingGate.nonce),
          gateOpenedAt: String(engagement.pendingGate.gateOpenedAt || new Date().toISOString()),
          minEligibleAt: String(engagement.pendingGate.minEligibleAt || new Date(Date.now() + AD_GATE_MIN_MS).toISOString()),
          expiresAt: String(engagement.pendingGate.expiresAt || new Date(Date.now() + AD_GATE_MAX_MS).toISOString()),
        }
      : null,
  };

  const db = await getDatabase();
  if (!db) {
    memoryAdEngagement.set(userId, sanitized);
    return sanitized;
  }

  const users = db.collection('users');
  await users.updateOne(
    { $or: [{ userId }, { googleId: userId }] },
    { $set: { adEngagement: sanitized, updatedAt: new Date() } }
  );
  return sanitized;
}

function normalizeLangCode(lang) {
  if (!lang || typeof lang !== 'string') return '';

  const raw = lang.trim();
  const lower = raw.toLowerCase();

  const aliasMap = {
    'jp': 'ja',
    'iw': 'he',
    'zh-cn': 'zh-Hans',
    'zh-tw': 'zh-Hant',
    'zh-hk': 'zh-Hant',
    'pt-br': 'pt-BR',
    'pt-pt': 'pt-PT',
  };

  if (aliasMap[lower]) return aliasMap[lower];

  // Keep Azure script variants intact
  if (lower === 'zh-hans') return 'zh-Hans';
  if (lower === 'zh-hant') return 'zh-Hant';
  if (lower === 'sr-cyrl') return 'sr-Cyrl';
  if (lower === 'sr-latn') return 'sr-Latn';

  // Normalize regional variants (en-US -> en)
  if (lower.includes('-')) {
    return lower.split('-')[0];
  }

  return lower;
}

async function getTurnCredentialPayload() {
  const tokenId = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  const ttlSeconds = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 3600);

  if (!tokenId) {
    throw new Error('CLOUDFLARE_TURN_TOKEN_ID is not configured');
  }

  if (!apiToken) {
    throw new Error('CLOUDFLARE_TURN_API_TOKEN is not configured');
  }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(tokenId)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
    }
  );

  const data = await response.json().catch(() => null);
  const iceServers = Array.isArray(data?.iceServers)
    ? data.iceServers
    : Array.isArray(data?.result?.iceServers)
      ? data.result.iceServers
      : null;

  if (!response.ok) {
    throw new Error(`Cloudflare TURN API request failed with status ${response.status}: ${JSON.stringify(data)}`);
  }

  if (!iceServers?.length) {
    throw new Error('Cloudflare TURN API returned no iceServers');
  }

  return {
    iceServers,
    ttlSeconds,
    provider: 'cloudflare',
  };
}

export async function GET(request, { params }) {
  const pathSegments = params?.path || [];
  const path = pathSegments.join('/');

  if (path === '' || path === 'health') {
    return NextResponse.json({ status: 'ok', message: 'HippiChat API running' });
  }

  if (path === 'auth/session') {
    const sessionId = request.cookies.get(getSessionCookieName())?.value;
    const session = await getUserSession(sessionId);
    return NextResponse.json({
      user: session?.user || null,
      authenticated: !!session?.user,
    });
  }

  if (path === 'turn-credentials') {
    try {
      return NextResponse.json(await getTurnCredentialPayload());
    } catch (error) {
      console.error('[TURN] Failed to issue TURN credentials:', error);
      return NextResponse.json({ error: 'TURN credentials unavailable' }, { status: 500 });
    }
  }

  if (path === 'ad-engagement') {
    const user = await resolveAuthenticatedUser(request);
    if (!user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const engagement = await getAdEngagementForUser(user.id);
    return NextResponse.json({
      skipCount: engagement?.skipCount || 0,
      shouldGateOnNextSkip: (engagement?.skipCount || 0) >= 9,
      updatedAt: engagement?.lastUpdatedAt || null,
      pendingGate: engagement?.pendingGate || null,
    });
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request, { params }) {
  const pathSegments = params?.path || [];
  const path = pathSegments.join('/');

  if (!validateStateChangingRequest(request)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }

  if (path === 'profile') {
    try {
      const sessionId = request.cookies.get(getSessionCookieName())?.value;
      const session = await getUserSession(sessionId);
      if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const { name, primaryLanguage, additionalLanguages, customImage, countryCode, countryName, countryFlag } = await request.json();
      const safeName = sanitizeString(name, MAX_NAME_LENGTH);
      const safePrimaryLanguage = sanitizeLanguageSelection(primaryLanguage);
      const safeAdditionalLanguages = sanitizeLanguageSelections(additionalLanguages);
      const safeCustomImage = sanitizeImageUrl(customImage);
      const safeCountryCode = sanitizeCountryField(countryCode, 8);
      const safeCountryName = sanitizeCountryField(countryName, 80);
      const safeCountryFlag = sanitizeCountryField(countryFlag, 12);

      if (safeCustomImage === null) {
        return NextResponse.json({ error: 'Profile photo URL must be a valid HTTPS URL' }, { status: 400 });
      }

      const hasName = typeof safeName === 'string' && !!safeName;
      const hasPrimaryLanguage = !!safePrimaryLanguage;
      const hasAdditionalLanguages = typeof safeAdditionalLanguages !== 'undefined';
      const hasCustomImage = typeof safeCustomImage === 'string';
      const hasCountry = typeof safeCountryName === 'string' || typeof safeCountryFlag === 'string' || typeof safeCountryCode === 'string';

      if (!hasName && !hasPrimaryLanguage && !hasAdditionalLanguages && !hasCustomImage && !hasCountry) {
        return NextResponse.json({ error: 'At least one profile field is required' }, { status: 400 });
      }

      const user = await updateUserProfile(session.user.id, {
        name: safeName,
        primaryLanguage: safePrimaryLanguage,
        additionalLanguages: safeAdditionalLanguages,
        customImage: safeCustomImage,
        countryCode: safeCountryCode,
        countryName: safeCountryName,
        countryFlag: safeCountryFlag,
      });
      return NextResponse.json({ user });
    } catch (error) {
      console.error('[Profile] Update failed');
      return NextResponse.json({ error: 'Profile update failed' }, { status: 500 });
    }
  }

  if (path === 'auth/google') {
    try {
      const { credential } = await request.json();
      const safeCredential = sanitizeString(credential, 4096);

      if (!safeCredential) {
        return NextResponse.json({ error: 'Missing Google credential' }, { status: 400 });
      }

      const expectedAudience = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
      if (!expectedAudience) {
        return NextResponse.json({ error: 'Google sign-in is not configured' }, { status: 500 });
      }

      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(safeCredential)}`);
      const verifyData = await verifyRes.json();

      if (!verifyRes.ok) {
        return NextResponse.json({ error: 'Invalid Google token' }, { status: 401 });
      }

      if (verifyData.aud !== expectedAudience) {
        return NextResponse.json({ error: 'Google token audience mismatch' }, { status: 401 });
      }

      if (!ALLOWED_GOOGLE_ISSUERS.has(verifyData.iss)) {
        return NextResponse.json({ error: 'Google token issuer mismatch' }, { status: 401 });
      }

      if (verifyData.email_verified !== 'true') {
        return NextResponse.json({ error: 'Google account email is not verified' }, { status: 401 });
      }

      const user = await upsertGoogleUser(verifyData);
      const session = await createUserSession(user);
      const response = NextResponse.json({ user });

      response.cookies.set({
        name: getSessionCookieName(),
        value: session.sessionId,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        expires: new Date(session.expiresAt),
      });

      return response;
    } catch (error) {
      console.error('[Auth] Google sign-in failed');
      return NextResponse.json({ error: 'Google sign-in failed' }, { status: 500 });
    }
  }

  if (path === 'auth/logout') {
    const sessionId = request.cookies.get(getSessionCookieName())?.value;
    if (sessionId) {
      await deleteUserSession(sessionId);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: getSessionCookieName(),
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: new Date(0),
    });

    return response;
  }

  if (path === 'ad-engagement') {
    const user = await resolveAuthenticatedUser(request);
    if (!user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let payload = {};
    try {
      payload = await request.json();
    } catch (error) {}

    const action = sanitizeString(payload?.action, 40);
    if (!action) {
      return NextResponse.json({ error: 'Missing action' }, { status: 400 });
    }

    const engagement = await getAdEngagementForUser(user.id);
    const currentSkipCount = engagement?.skipCount || 0;

    if (action === 'open-gate') {
      const reason = sanitizeString(payload?.reason, 40) || '';
      if (!ALLOWED_GATE_REASONS.has(reason)) {
        return NextResponse.json({ error: 'Unsupported gate reason' }, { status: 400 });
      }

      const now = Date.now();
      const pendingGate = {
        reason,
        nonce: crypto.randomUUID(),
        gateOpenedAt: new Date(now).toISOString(),
        minEligibleAt: new Date(now + AD_GATE_MIN_MS).toISOString(),
        expiresAt: new Date(now + AD_GATE_MAX_MS).toISOString(),
      };

      const saved = await setAdEngagementForUser(user.id, {
        skipCount: currentSkipCount,
        pendingGate,
      });
      return NextResponse.json({
        ok: true,
        pendingGate: saved.pendingGate,
        serverNow: new Date().toISOString(),
      });
    }

    if (action === 'skip-attempt') {
      const nextSkipCount = currentSkipCount + 1;
      const shouldGate = nextSkipCount % 10 === 0;
      const saved = await setAdEngagementForUser(user.id, {
        skipCount: nextSkipCount,
        pendingGate: engagement?.pendingGate || null,
      });
      return NextResponse.json({
        skipCount: saved.skipCount,
        shouldGate,
      });
    }

    if (action === 'complete-gate') {
      const reason = sanitizeString(payload?.reason, 40) || 'unknown';
      const nonce = sanitizeString(payload?.nonce, 128) || '';
      const pendingGate = engagement?.pendingGate || null;
      if (!pendingGate?.nonce) {
        return NextResponse.json({ error: 'No pending gate' }, { status: 400 });
      }
      if (pendingGate.nonce !== nonce || pendingGate.reason !== reason) {
        return NextResponse.json({ error: 'Invalid gate token' }, { status: 403 });
      }

      const now = Date.now();
      const minEligibleAt = new Date(pendingGate.minEligibleAt).getTime();
      const expiresAt = new Date(pendingGate.expiresAt).getTime();
      if (Number.isFinite(expiresAt) && now > expiresAt) {
        const cleared = await setAdEngagementForUser(user.id, {
          skipCount: currentSkipCount,
          pendingGate: null,
        });
        return NextResponse.json({ error: 'Gate expired', skipCount: cleared.skipCount }, { status: 410 });
      }
      if (Number.isFinite(minEligibleAt) && now < minEligibleAt) {
        return NextResponse.json({ error: 'Gate not eligible yet', retryAfterMs: minEligibleAt - now }, { status: 403 });
      }

      const nextSkipCount = reason === 'skip' ? 0 : currentSkipCount;
      const saved = await setAdEngagementForUser(user.id, {
        skipCount: nextSkipCount,
        pendingGate: null,
      });
      return NextResponse.json({
        ok: true,
        reason,
        skipCount: saved.skipCount,
      });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  }

  if (path === 'speech-token') {
    return NextResponse.json({ error: 'Speech services are disabled' }, { status: 501 });
  }

  if (path === 'translate') {
    try {
      const { text, from, to } = await request.json();
      const safeText = sanitizeString(text, MAX_TRANSLATION_TEXT_LENGTH);
      const safeFrom = sanitizeString(from, MAX_LANGUAGE_CODE_LENGTH);
      const safeTo = sanitizeString(to, MAX_LANGUAGE_CODE_LENGTH);
      
      if (!safeText || !safeFrom || !safeTo) {
        return NextResponse.json({ error: 'Missing fields: text, from, to required' }, { status: 400 });
      }
      
      if (safeText.trim().length === 0) {
        return NextResponse.json({ translatedText: '' });
      }

      const sourceLang = normalizeLangCode(safeFrom);
      const targetLang = normalizeLangCode(safeTo);

      if (!sourceLang || !targetLang) {
        return NextResponse.json({ error: 'Invalid language code(s)' }, { status: 400 });
      }

      if (sourceLang === targetLang) {
        return NextResponse.json({ translatedText: safeText });
      }

      return NextResponse.json({
        translatedText: safeText,
        provider: 'disabled-no-azure',
        fallback: true,
        sourceLang,
        targetLang,
      });
    } catch (error) {
      console.error('[Translate] Translation failed');
      return NextResponse.json({ error: 'Translation failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function OPTIONS(request) {
  return NextResponse.json({}, {
    headers: {
      ...buildCorsHeaders(request),
    },
  });
}
