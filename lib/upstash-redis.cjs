const isProduction = process.env.NODE_ENV === 'production';

function getConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (isProduction) {
      throw new Error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in production');
    }
    return null;
  }

  return { url: url.replace(/\/$/, ''), token };
}

async function command(cmd, args = []) {
  const config = getConfig();
  if (!config) return null;

  const path = [cmd, ...args.map((value) => encodeURIComponent(String(value)))].join('/');
  const response = await fetch(`${config.url}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Upstash ${cmd} failed with ${response.status}`);
  }

  return payload?.result ?? null;
}

function serialize(value) {
  return JSON.stringify(value);
}

function deserialize(value) {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function setJson(key, value, ttlSeconds) {
  await command('set', [key, serialize(value)]);
  if (ttlSeconds) {
    await command('expire', [key, ttlSeconds]);
  }
  return true;
}

async function getJson(key) {
  const value = await command('get', [key]);
  return deserialize(value);
}

async function delKey(key) {
  return command('del', [key]);
}

async function incr(key, ttlSeconds) {
  const next = await command('incr', [key]);
  if (ttlSeconds && Number(next) === 1) {
    await command('expire', [key, ttlSeconds]);
  }
  return Number(next || 0);
}

async function expire(key, ttlSeconds) {
  return command('expire', [key, ttlSeconds]);
}

async function checkRateLimit(key, limit, windowSeconds) {
  const count = await incr(key, windowSeconds);
  return count <= limit;
}

module.exports = {
  setJson,
  getJson,
  delKey,
  incr,
  expire,
  checkRateLimit,
};
