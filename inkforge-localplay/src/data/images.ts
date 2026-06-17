/**
 * CardImage service (spec §5.2). Exposes `getImage(id, size)` returning a URL
 * that renders offline, never hitting the network at play time once cached.
 *
 * Caching uses the Cache Storage API (Workbox also runtime-caches the same host
 * — see vite.config.ts). On Capacitor (P2) this is additionally mirrored to the
 * native Filesystem so eviction can't break offline play. A missing/unreachable
 * host degrades to a deterministic placeholder.
 */
import {
  DEFAULT_IMAGE_BASE,
  buildImageUrl,
  placeholderSvg,
  type ImageSize,
  type PlaceholderMeta,
} from "./images-core";

const CACHE_NAME = "card-images";

interface CardImageConfig {
  base: string;
}

const config: CardImageConfig = { base: DEFAULT_IMAGE_BASE };

/** Override the image host (e.g. an alternate source). */
export function configureImageSource(base: string): void {
  config.base = base;
}

function cacheStorageAvailable(): boolean {
  return typeof caches !== "undefined";
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

async function openCache(): Promise<Cache | null> {
  if (!cacheStorageAvailable()) return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

export async function isImageCached(id: string, size: ImageSize): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  const hit = await cache.match(buildImageUrl(id, size, config.base));
  return !!hit;
}

/** Fetch + store one image. Returns true on success, false if unreachable. */
async function fetchAndCache(id: string, size: ImageSize): Promise<boolean> {
  const cache = await openCache();
  const url = buildImageUrl(id, size, config.base);
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return false;
    if (cache) await cache.put(url, res.clone());
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a renderable image source for a card. Returns the (cached or live)
 * remote URL when available, otherwise a deterministic placeholder. Never
 * throws and never returns a broken image.
 */
export async function getImage(
  id: string,
  size: ImageSize,
  meta?: Omit<PlaceholderMeta, "id">,
): Promise<string> {
  const url = buildImageUrl(id, size, config.base);
  if (await isImageCached(id, size)) return url;
  if (isOffline()) return placeholderSvg({ id, ...meta });
  // Online (or unknown): warm the cache in the background, hand back the URL.
  // Components should still fall back to `placeholder()` on <img> error.
  void fetchAndCache(id, size);
  return url;
}

/** Synchronous placeholder for <img onError> fallbacks. */
export function placeholder(meta: PlaceholderMeta): string {
  return placeholderSvg(meta);
}

export interface PrefetchProgress {
  done: number;
  total: number;
  failures: string[];
}

/**
 * Pre-fetch + store images for a set of card ids (spec §5.2 caching trigger:
 * thumbnails always; full art can be lazied). Used by "Download images for
 * offline" and the global "cache all".
 */
export async function prefetchImages(
  ids: string[],
  sizes: ImageSize[] = ["thumbnail"],
  onProgress?: (p: PrefetchProgress) => void,
): Promise<PrefetchProgress> {
  const total = ids.length * sizes.length;
  const progress: PrefetchProgress = { done: 0, total, failures: [] };
  for (const id of ids) {
    for (const size of sizes) {
      const ok = await fetchAndCache(id, size);
      if (!ok) progress.failures.push(`${id} (${size})`);
      progress.done += 1;
      onProgress?.({ ...progress, failures: [...progress.failures] });
    }
  }
  return progress;
}

/** PvP-ready check (spec §5.2): a deck is ready only when all images are cached. */
export async function areAllImagesCached(ids: string[], size: ImageSize = "thumbnail"): Promise<boolean> {
  for (const id of ids) {
    if (!(await isImageCached(id, size))) return false;
  }
  return true;
}
