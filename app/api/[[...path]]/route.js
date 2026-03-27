import { NextResponse } from 'next/server';
import { createUserSession, deleteUserSession, getSessionCookieName, getUserSession, updateUserProfile, upsertGoogleUser } from '@/lib/auth-store';

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

async function microsoftTranslate(text, fromLang, toLang) {
  const apiKey = process.env.AZURE_TRANSLATOR_KEY;
  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT;
  const region = process.env.AZURE_TRANSLATOR_REGION;

  if (!apiKey || !endpoint || !region) {
    throw new Error('Azure Translator is not configured. Missing AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_ENDPOINT / AZURE_TRANSLATOR_REGION');
  }

  const baseUrl = endpoint.replace(/\/$/, '');
  const url = `${baseUrl}/translate?api-version=3.0&from=${encodeURIComponent(fromLang)}&to=${encodeURIComponent(toLang)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Ocp-Apim-Subscription-Region': region,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{ Text: text }]),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Azure Translator HTTP ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const translated = data?.[0]?.translations?.[0]?.text;

    if (!translated || typeof translated !== 'string') {
      throw new Error('Azure Translator returned an unexpected response shape');
    }

    return translated;
  } finally {
    clearTimeout(timeout);
  }
}

function getSpeechTokenUrl() {
  const speechEndpoint = process.env.AZURE_SPEECH_ENDPOINT;
  const speechRegion = process.env.AZURE_SPEECH_REGION;

  if (speechEndpoint) {
    return `${speechEndpoint.replace(/\/$/, '')}/sts/v1.0/issueToken`;
  }

  if (!speechRegion) return null;
  return `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
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

      const { name, primaryLanguage, additionalLanguages, countryCode, countryName, countryFlag } = await request.json();
      const hasName = typeof name === 'string' && !!name.trim();
      const hasPrimaryLanguage = !!primaryLanguage;
      const hasAdditionalLanguages = Array.isArray(additionalLanguages);
      const hasCountry = typeof countryName === 'string' || typeof countryFlag === 'string' || typeof countryCode === 'string';

      if (!hasName && !hasPrimaryLanguage && !hasAdditionalLanguages && !hasCountry) {
        return NextResponse.json({ error: 'At least one profile field is required' }, { status: 400 });
      }

      const user = await updateUserProfile(session.user.id, {
        name,
        primaryLanguage,
        additionalLanguages,
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

  if (path === 'speech-token') {
    try {
      const speechKey = process.env.AZURE_SPEECH_KEY;
      const speechRegion = process.env.AZURE_SPEECH_REGION;
      const tokenUrl = getSpeechTokenUrl();

      if (!speechKey || !speechRegion || !tokenUrl) {
        return NextResponse.json({
          error: 'Speech service not configured. Missing AZURE_SPEECH_KEY / AZURE_SPEECH_REGION',
        }, { status: 500 });
      }

      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: '',
      });

      if (!res.ok) {
        const errText = await res.text();
        return NextResponse.json({
          error: 'Failed to issue speech token',
          details: errText.slice(0, 200),
        }, { status: 502 });
      }

      const token = await res.text();

      return NextResponse.json({
        token,
        region: speechRegion,
        expiresIn: 540,
      });
    } catch (error) {
      console.error('[Speech] Token endpoint error:', error);
      return NextResponse.json({ error: 'Speech token request failed' }, { status: 500 });
    }
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

      try {
        const translatedText = await microsoftTranslate(text, sourceLang, targetLang);
        return NextResponse.json({
          translatedText,
          provider: 'azure-translator',
          sourceLang,
          targetLang,
        });
      } catch (translationError) {
        console.error('[Translation] Azure translation failed:', translationError?.message || translationError);
        // Graceful fallback to preserve chat continuity
        return NextResponse.json({
          translatedText: text,
          fallback: true,
          provider: 'fallback-original',
          sourceLang,
          targetLang,
        });
      }
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
