const isProduction = process.env.NODE_ENV === 'production';
let Redis = null;
let createAdapter = null;

try {
  Redis = require('ioredis');
  ({ createAdapter } = require('@socket.io/redis-adapter'));
} catch (error) {
  if (isProduction) {
    console.warn('[Redis] TCP adapter dependencies unavailable:', error?.message || error);
  }
}

const tcpCache = {
  client: null,
  adapter: null,
  pub: null,
  sub: null,
};

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

function getRedisTcpUrl() {
  return process.env.REDIS_URL || null;
}

function buildRedisClient(url) {
  if (!Redis || !url) return null;
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (error) => {
    console.error('[Redis TCP] Client error:', error?.message || error);
  });
  return client;
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

function getTcpClient() {
  const url = getRedisTcpUrl();
  if (!Redis || !url) return null;
  if (!tcpCache.client) {
    tcpCache.client = buildRedisClient(url);
  }
  return tcpCache.client;
}

function createSocketIoAdapter() {
  const url = getRedisTcpUrl();
  if (!Redis || !createAdapter || !url) return null;
  if (tcpCache.adapter) return tcpCache.adapter;

  tcpCache.pub = buildRedisClient(url);
  tcpCache.sub = tcpCache.pub?.duplicate();

  if (!tcpCache.pub || !tcpCache.sub) return null;

  tcpCache.sub.on('error', (error) => {
    console.error('[Redis TCP] Subscriber error:', error?.message || error);
  });

  tcpCache.adapter = createAdapter(tcpCache.pub, tcpCache.sub);
  return tcpCache.adapter;
}

module.exports = {
  setJson,
  getJson,
  delKey,
  incr,
  expire,
  checkRateLimit,
  getTcpClient,
  createSocketIoAdapter,
};
