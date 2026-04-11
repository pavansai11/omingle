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

function getTcpClient() {
  const url = getRedisTcpUrl();
  if (!Redis || !url) return null;
  if (!tcpCache.client) {
    tcpCache.client = buildRedisClient(url);
  }
  return tcpCache.client;
}

async function command(cmd, args = []) {
  const client = getTcpClient();
  if (!client) {
    if (isProduction) {
      throw new Error('Missing REDIS_URL or Redis TCP client unavailable in production');
    }
    return null;
  }

  const normalizedArgs = args.map((value) => (
    typeof value === 'string' || Buffer.isBuffer(value) ? value : String(value)
  ));

  return await client.call(cmd, ...normalizedArgs);
}

async function setJson(key, value, ttlSeconds) {
  const client = getTcpClient();
  if (!client) return false;
  const payload = serialize(value);
  if (ttlSeconds) {
    await client.set(key, payload, 'EX', ttlSeconds);
  } else {
    await client.set(key, payload);
  }
  return true;
}

async function getJson(key) {
  const client = getTcpClient();
  if (!client) return null;
  const value = await client.get(key);
  return deserialize(value);
}

async function delKey(key) {
  const client = getTcpClient();
  if (!client) return 0;
  return await client.del(key);
}

async function incr(key, ttlSeconds) {
  const client = getTcpClient();
  if (!client) return 0;
  const next = await client.incr(key);
  if (ttlSeconds && Number(next) === 1) {
    await client.expire(key, ttlSeconds);
  }
  return Number(next || 0);
}

async function expire(key, ttlSeconds) {
  const client = getTcpClient();
  if (!client) return 0;
  return await client.expire(key, ttlSeconds);
}

async function checkRateLimit(key, limit, windowSeconds) {
  const count = await incr(key, windowSeconds);
  return count <= limit;
}

async function lpush(key, ...values) {
  const client = getTcpClient();
  if (!client || !values.length) return 0;
  return Number(await client.lpush(key, ...values) || 0);
}

async function rpush(key, ...values) {
  const client = getTcpClient();
  if (!client || !values.length) return 0;
  return Number(await client.rpush(key, ...values) || 0);
}

async function lrange(key, start = 0, stop = -1) {
  const client = getTcpClient();
  if (!client) return [];
  return await client.lrange(key, start, stop) || [];
}

async function lrem(key, count, value) {
  const client = getTcpClient();
  if (!client) return 0;
  return Number(await client.lrem(key, count, value) || 0);
}

async function llen(key) {
  const client = getTcpClient();
  if (!client) return 0;
  return Number(await client.llen(key) || 0);
}

async function sadd(key, ...values) {
  const client = getTcpClient();
  if (!client || !values.length) return 0;
  return Number(await client.sadd(key, ...values) || 0);
}

async function srem(key, ...values) {
  const client = getTcpClient();
  if (!client || !values.length) return 0;
  return Number(await client.srem(key, ...values) || 0);
}

async function smembers(key) {
  const client = getTcpClient();
  if (!client) return [];
  return await client.smembers(key) || [];
}

async function scard(key) {
  const client = getTcpClient();
  if (!client) return 0;
  return Number(await client.scard(key) || 0);
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
  command,
  setJson,
  getJson,
  delKey,
  incr,
  expire,
  checkRateLimit,
  lpush,
  rpush,
  lrange,
  lrem,
  llen,
  sadd,
  srem,
  smembers,
  scard,
  getTcpClient,
  createSocketIoAdapter,
};