/**
 * Performance Optimization Utilities
 * Makes the app snappier by optimizing API calls, DOM updates, and storage operations
 */

// ============================================
// Request Deduplication & Caching
// ============================================
const requestCache = new Map();
const pendingRequests = new Map();
const CACHE_TTL = 30000; // 30 seconds default

/**
 * Cached fetch with deduplication
 * Prevents duplicate requests and caches responses
 */
async function cachedFetch(url, options = {}, cacheKey = null, ttl = CACHE_TTL) {
  const key = cacheKey || url;
  const now = Date.now();

  // Skip cache if requested
  if (options.skipCache) {
    console.log(`[Performance] Skipping cache for: ${key}`);
    return fetch(url, options);
  }

  // Check cache first
  const cached = requestCache.get(key);
  if (cached && (now - cached.timestamp) < ttl) {
    console.log(`[Performance] Cache hit: ${key}`);
    return cached.response.clone();
  }

  // Check if request is already pending
  if (pendingRequests.has(key)) {
    console.log(`[Performance] Deduplicating request: ${key}`);
    const response = await pendingRequests.get(key);
    return response.clone();
  }

  // Make request and cache it
  const requestPromise = fetch(url, options)
    .then(async (response) => {
      // Only cache successful responses
      if (response.ok) {
        requestCache.set(key, {
          response: response.clone(),
          timestamp: now
        });
      }
      pendingRequests.delete(key);
      return response;
    })
    .catch((error) => {
      pendingRequests.delete(key);
      throw error;
    });

  pendingRequests.set(key, requestPromise);
  return requestPromise.then(res => res.clone());
}

/**
 * Clear cache for a specific key or all cache
 */
function clearCache(key = null) {
  if (key) {
    requestCache.delete(key);
    console.log(`[Performance] Cleared cache for: ${key}`);
  } else {
    requestCache.clear();
    console.log('[Performance] Cleared all cache');
  }
}

// ============================================
// DOM Update Batching
// ============================================
let domUpdateQueue = [];
let rafScheduled = false;

/**
 * Batch DOM updates using requestAnimationFrame
 */
function batchDOMUpdate(callback) {
  domUpdateQueue.push(callback);

  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(() => {
      // Execute all queued updates
      const queue = domUpdateQueue.slice();
      domUpdateQueue = [];
      rafScheduled = false;

      queue.forEach(fn => {
        try {
          fn();
        } catch (e) {
          console.error('[Performance] DOM update error:', e);
        }
      });
    });
  }
}

/**
 * Create DocumentFragment for batch DOM operations
 */
function createFragment() {
  return document.createDocumentFragment();
}

/**
 * Batch append children to parent
 */
function batchAppend(parent, children) {
  const fragment = createFragment();
  children.forEach(child => fragment.appendChild(child));
  parent.appendChild(fragment);
}

// ============================================
// Storage Operation Debouncing
// ============================================
const storageQueue = new Map();
let storageTimeout = null;
const STORAGE_DEBOUNCE_MS = 100;

/**
 * Debounced storage write
 * Batches multiple writes into a single operation
 */
function debouncedStorageWrite(key, value) {
  storageQueue.set(key, value);

  if (storageTimeout) {
    clearTimeout(storageTimeout);
  }

  storageTimeout = setTimeout(() => {
    const updates = Object.fromEntries(storageQueue);
    storageQueue.clear();

    chrome.storage.local.set(updates, () => {
      console.log(`[Performance] Batched ${Object.keys(updates).length} storage writes`);
    });
  }, STORAGE_DEBOUNCE_MS);
}

/**
 * Immediate storage write (for critical data)
 */
function immediateStorageWrite(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

// ============================================
// Timer Management
// ============================================
const activeTimers = new Set();

/**
 * Managed setInterval that tracks timers
 */
function managedSetInterval(callback, delay) {
  const id = setInterval(() => {
    try {
      callback();
    } catch (e) {
      console.error('[Performance] Timer callback error:', e);
    }
  }, delay);

  activeTimers.add(id);
  return id;
}

/**
 * Managed setTimeout
 */
function managedSetTimeout(callback, delay) {
  const id = setTimeout(() => {
    activeTimers.delete(id);
    try {
      callback();
    } catch (e) {
      console.error('[Performance] Timer callback error:', e);
    }
  }, delay);

  activeTimers.add(id);
  return id;
}

/**
 * Clear all managed timers
 */
function clearAllTimers() {
  activeTimers.forEach(id => {
    clearInterval(id);
    clearTimeout(id);
  });
  activeTimers.clear();
  console.log('[Performance] Cleared all managed timers');
}

// ============================================
// Idle Callback for Non-Critical Updates
// ============================================
/**
 * Execute callback when browser is idle
 * Falls back to setTimeout if requestIdleCallback is not available
 */
function idleCallback(callback, timeout = 5000) {
  if ('requestIdleCallback' in window) {
    return requestIdleCallback(callback, { timeout });
  } else {
    return setTimeout(callback, 0);
  }
}

// ============================================
// Throttle & Debounce Utilities
// ============================================
function throttle(func, limit) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// ============================================
// Memory Management
// ============================================
/**
 * Clean up old cache entries
 */
function cleanupCache(maxAge = 60000) {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, value] of requestCache.entries()) {
    if (now - value.timestamp > maxAge) {
      requestCache.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[Performance] Cleaned up ${cleaned} old cache entries`);
  }
}

// Run cleanup every 5 minutes
setInterval(() => cleanupCache(), 5 * 60 * 1000);

// ============================================
// Export
// ============================================
if (typeof window !== 'undefined') {
  window.PerformanceUtils = {
    cachedFetch,
    clearCache,
    batchDOMUpdate,
    createFragment,
    batchAppend,
    debouncedStorageWrite,
    immediateStorageWrite,
    managedSetInterval,
    managedSetTimeout,
    clearAllTimers,
    idleCallback,
    throttle,
    debounce,
    cleanupCache
  };
}

// For Node/Service Worker environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    cachedFetch,
    clearCache,
    batchDOMUpdate,
    createFragment,
    batchAppend,
    debouncedStorageWrite,
    immediateStorageWrite,
    managedSetInterval,
    managedSetTimeout,
    clearAllTimers,
    idleCallback,
    throttle,
    debounce,
    cleanupCache
  };
}
