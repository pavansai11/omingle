import { MongoClient } from 'mongodb'

const isProduction = process.env.NODE_ENV === 'production'

function resolveMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI

  const username = process.env.MONGO_USERNAME
  const password = process.env.MONGO_PASSWORD
  const host = process.env.MONGO_HOST

  if (username && password && host) {
    return `mongodb+srv://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}`
  }

  if (process.env.MONGO_URL) return process.env.MONGO_URL

  return null
}

function getMongoCache() {
  if (!globalThis.__omingleMongoCache) {
    globalThis.__omingleMongoCache = {
      client: null,
      db: null,
      promise: null,
      failed: false,
    }
  }

  return globalThis.__omingleMongoCache
}

export async function getDatabase() {
  const uri = resolveMongoUri()
  if (!uri) {
    if (isProduction) {
      throw new Error('MongoDB is required in production, but no URI/host configuration was provided')
    }
    return null
  }

  const cache = getMongoCache()
  if (cache.failed) return null
  if (cache.db) return cache.db

  try {
    if (!cache.promise) {
      const client = new MongoClient(uri)
      cache.promise = client.connect().then((connectedClient) => {
        cache.client = connectedClient
        cache.db = connectedClient.db(process.env.DB_NAME || 'HippiChat')
        return cache.db
      })
    }

    return await cache.promise
  } catch (error) {
    if (isProduction) {
      cache.promise = null
      throw error
    }
    console.error('[MongoDB] Connection unavailable, falling back to memory store:', error?.message || error)
    cache.failed = true
    cache.promise = null
    return null
  }
}
