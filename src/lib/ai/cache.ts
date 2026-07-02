// Redis-based cache layer for LLM responses.
//
// Cache key: MD5 hash of the prompt string.
// Cache TTL: 168 hours (7 days) by default, configurable via AI_CACHE_TTL_HOURS.
//
// Behavior:
//   - Cache hit: return the cached response immediately.
//   - Cache miss: call the upstream API, store the result in cache, then return it.
//   - Redis unavailable: silently fall back to no caching (bypass).
//
// Design notes:
//   - The cache is keyed purely by the prompt MD5. Callers that need
//     per-model or per-temperature variants should fold those into the
//     prompt string or wrap this layer themselves.
//   - Values are stored as raw strings (the verbatim LLM output text).
//   - All errors are swallowed with a warning log — a cache outage must
//     never break the user-facing AI features.

import { createHash } from 'crypto';
import Redis from 'ioredis';

const CACHE_KEY_PREFIX = 'ai_cache:';
const DEFAULT_TTL_SECONDS = 168 * 3600; // 168 hours = 7 days

let redisClient: Redis | null | undefined;

function getTtlSeconds(): number {
  const envHours = process.env.AI_CACHE_TTL_HOURS;
  if (envHours) {
    const hours = parseInt(envHours, 10);
    if (!isNaN(hours) && hours > 0) return hours * 3600;
  }
  return DEFAULT_TTL_SECONDS;
}

function getRedisUrl(): string | undefined {
  return process.env.REDIS_URL?.trim() || undefined;
}

export function getRedis(): Redis | null {
  const url = getRedisUrl();
  if (!url) return null;

  if (redisClient !== undefined) return redisClient;

  try {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 2000,
      commandTimeout: 1000,
    });
    redisClient.on('error', (err) => {
      console.warn('[ai-cache] Redis error:', err.message);
    });
  } catch (err) {
    console.warn('[ai-cache] Failed to create Redis client:', (err as Error).message);
    redisClient = null;
  }

  return redisClient;
}

export function md5Prompt(prompt: string): string {
  return createHash('md5').update(prompt, 'utf8').digest('hex');
}

function cacheKey(prompt: string): string {
  return `${CACHE_KEY_PREFIX}${md5Prompt(prompt)}`;
}

export async function getCachedResponse(prompt: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const value = await redis.get(cacheKey(prompt));
    if (value !== null) {
      console.debug('[ai-cache] HIT', md5Prompt(prompt).slice(0, 8));
    }
    return value;
  } catch (err) {
    console.warn('[ai-cache] get failed:', (err as Error).message);
    return null;
  }
}

export async function setCachedResponse(
  prompt: string,
  response: string,
  ttlSeconds?: number
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const ttl = ttlSeconds ?? getTtlSeconds();

  try {
    await redis.set(cacheKey(prompt), response, 'EX', ttl);
  } catch (err) {
    console.warn('[ai-cache] set failed:', (err as Error).message);
  }
}

export async function withAiCache<T extends string>(
  prompt: string,
  fetchFn: () => Promise<T>
): Promise<T> {
  const cached = await getCachedResponse(prompt);
  if (cached !== null) {
    return cached as T;
  }

  const result = await fetchFn();
  await setCachedResponse(prompt, result);
  return result;
}
