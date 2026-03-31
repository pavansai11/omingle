import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { createUserSession, deleteUserSession, getSessionCookieName, getUserSession, updateUserProfile, upsertGoogleUser } from '@/lib/auth-store';
import { getDatabase } from '@/lib/mongodb';

const memoryAdEngagement = new Map();

async function resolveAuthenticatedUser(request) {
  const sessionId = request.cookies.get(getSessionCookieName())?.value;
  const session = await getUserSession(sessionId);
  return session?.user || null;
}

async function getAdEngagementForUser(userId) {
  if (!userId) return null;
  const db = await getDatabase();

  if (!db) {
    const existing = memoryAdEngagement.get(userId) || { skipCount: 0, lastUpdatedAt: new Date().toISOString() };
    memoryAdEngagement.set(userId, existing);
    return existing;
  }

  const users = db.collection('users');
  const user = await users.findOne({ $or: [{ userId }, { googleId: userId }] }, { projection: { adEngagement: 1 } });
  const current = user?.adEngagement || { skipCount: 0 };
  return {
    skipCount: Number.isFinite(current.skipCount) ? Number(current.skipCount) : 0,
    lastUpdatedAt: current.lastUpdatedAt || new Date().toISOString(),
  };
}

async function setAdEngagementForUser(userId, engagement) {
  if (!userId) return null;
  const sanitized = {
    skipCount: Math.max(0, Number(engagement?.skipCount || 0)),
    lastUpdatedAt: new Date().toISOString(),
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

function getTurnCredentialPayload(identity = 'guest') {
  const secret = process.env.COTURN_STATIC_AUTH_SECRET;
  if (!secret) {
    throw new Error('COTURN_STATIC_AUTH_SECRET is not configured');
  }

  const host = process.env.NEXT_PUBLIC_TURN_HOST || process.env.TURN_HOST || 'turn.hippichat.com';
  const port = Number(process.env.NEXT_PUBLIC_TURN_PORT || process.env.TURN_PORT || 3478);
  const ttlSeconds = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 3600);
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiresAt}:${identity}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');

  return {
    username,
    credential,
    ttlSeconds,
    urls: [
      `turn:${host}:${port}?transport=udp`,
      `turn:${host}:${port}?transport=tcp`,
    ],
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
      const sessionId = request.cookies.get(getSessionCookieName())?.value;
      const session = await getUserSession(sessionId);
      const identity = session?.user?.id || session?.user?.googleId || crypto.randomUUID();
      return NextResponse.json(getTurnCredentialPayload(identity));
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
    });
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function POST(request, { params }) {
  const pathSegments = params?.path || [];
  const path = pathSegments.join('/');

  if (path === 'profile') {
    try {
      const sessionId = request.cookies.get(getSessionCookieName())?.value;
      const session = await getUserSession(sessionId);
      if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const { name, primaryLanguage, additionalLanguages, customImage, countryCode, countryName, countryFlag } = await request.json();
      const hasName = typeof name === 'string' && !!name.trim();
      const hasPrimaryLanguage = !!primaryLanguage;
      const hasAdditionalLanguages = Array.isArray(additionalLanguages);
      const hasCustomImage = typeof customImage === 'string';
      const hasCountry = typeof countryName === 'string' || typeof countryFlag === 'string' || typeof countryCode === 'string';

      if (!hasName && !hasPrimaryLanguage && !hasAdditionalLanguages && !hasCustomImage && !hasCountry) {
        return NextResponse.json({ error: 'At least one profile field is required' }, { status: 400 });
      }

      const user = await updateUserProfile(session.user.id, {
        name,
        primaryLanguage,
        additionalLanguages,
        customImage,
        countryCode,
        countryName,
        countryFlag,
      });
      return NextResponse.json({ user });
    } catch (error) {
      console.error('[Profile] Update failed:', error);
      return NextResponse.json({ error: 'Profile update failed' }, { status: 500 });
    }
  }

  if (path === 'auth/google') {
    try {
      const { credential } = await request.json();

      if (!credential) {
        return NextResponse.json({ error: 'Missing Google credential' }, { status: 400 });
      }

      const expectedAudience = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
      if (!expectedAudience) {
        return NextResponse.json({ error: 'Google sign-in is not configured' }, { status: 500 });
      }

      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      const verifyData = await verifyRes.json();

      if (!verifyRes.ok) {
        return NextResponse.json({
          error: 'Invalid Google token',
          details: verifyData?.error_description || verifyData?.error || null,
        }, { status: 401 });
      }

      if (verifyData.aud !== expectedAudience) {
        return NextResponse.json({ error: 'Google token audience mismatch' }, { status: 401 });
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
      console.error('[Auth] Google sign-in failed:', error);
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

    const action = payload?.action;
    if (!action) {
      return NextResponse.json({ error: 'Missing action' }, { status: 400 });
    }

    const engagement = await getAdEngagementForUser(user.id);
    const currentSkipCount = engagement?.skipCount || 0;

    if (action === 'skip-attempt') {
      const nextSkipCount = currentSkipCount + 1;
      const shouldGate = nextSkipCount % 10 === 0;
      const saved = await setAdEngagementForUser(user.id, { skipCount: nextSkipCount });
      return NextResponse.json({
        skipCount: saved.skipCount,
        shouldGate,
      });
    }

    if (action === 'complete-gate') {
      const reason = payload?.reason || 'unknown';
      const nextSkipCount = reason === 'skip' ? 0 : currentSkipCount;
      const saved = await setAdEngagementForUser(user.id, { skipCount: nextSkipCount });
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
      
      if (!text || !from || !to) {
        return NextResponse.json({ error: 'Missing fields: text, from, to required' }, { status: 400 });
      }
      
      if (text.trim().length === 0) {
        return NextResponse.json({ translatedText: '' });
      }

      const sourceLang = normalizeLangCode(from);
      const targetLang = normalizeLangCode(to);

      if (!sourceLang || !targetLang) {
        return NextResponse.json({ error: 'Invalid language code(s)' }, { status: 400 });
      }

      if (sourceLang === targetLang) {
        return NextResponse.json({ translatedText: text });
      }

      return NextResponse.json({
        translatedText: text,
        provider: 'disabled-no-azure',
        fallback: true,
        sourceLang,
        targetLang,
      });
    } catch (error) {
      console.error('Translation error:', error);
      return NextResponse.json({ error: 'Translation failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export async function OPTIONS() {
  return NextResponse.json({}, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
