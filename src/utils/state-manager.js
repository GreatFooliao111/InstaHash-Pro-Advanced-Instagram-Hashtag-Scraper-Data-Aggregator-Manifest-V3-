/**
 * State Manager Utility
 * Handles scraper state persistence and recovery
 */

const STORAGE_KEYS = {
  SCRAPING_STATE: 'scraper_scraping_state',
  CIRCUIT_BREAKER: 'scraper_circuit_breaker',
  QUEUE: 'scraper_queue',
  CONFIG: 'scraper_config'
};

/**
 * Get current scraping state
 */
export async function getScrapingState() {
  try {
    const result = await chrome.storage.session.get([STORAGE_KEYS.SCRAPING_STATE]);
    return result[STORAGE_KEYS.SCRAPING_STATE] || {
      active: false,
      hashtag: null,
      started_at: null
    };
  } catch (error) {
    console.error('Failed to get scraping state:', error);
    return { active: false, hashtag: null };
  }
}

/**
 * Set scraping state
 */
export async function setScrapingState(state) {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEYS.SCRAPING_STATE]: {
        ...state,
        updated_at: Date.now()
      }
    });
  } catch (error) {
    console.error('Failed to set scraping state:', error);
  }
}

/**
 * Get circuit breaker state
 */
export async function getCircuitBreakerState() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.CIRCUIT_BREAKER]);
    return result[STORAGE_KEYS.CIRCUIT_BREAKER] || {
      active: false,
      reason: null,
      timestamp: null,
      hashtag: null
    };
  } catch (error) {
    console.error('Failed to get circuit breaker state:', error);
    return { active: false };
  }
}

/**
 * Set circuit breaker state
 */
export async function setCircuitBreakerState(state) {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.CIRCUIT_BREAKER]: {
        ...state,
        timestamp: state.timestamp || Date.now()
      }
    });
  } catch (error) {
    console.error('Failed to set circuit breaker state:', error);
  }
}

/**
 * Check if circuit breaker allows operation
 * Returns true if scraping can proceed
 */
export async function canProceed() {
  const state = await getCircuitBreakerState();
  
  if (!state.active) {
    return true;
  }
  
  // Check if cooldown period has passed (5 minutes)
  const cooldownMs = 5 * 60 * 1000;
  const elapsed = Date.now() - state.timestamp;
  
  if (elapsed >= cooldownMs) {
    // Cooldown expired, reset circuit breaker
    await setCircuitBreakerState({ active: false });
    return true;
  }
  
  return false;
}

/**
 * Get scraping queue
 */
export async function getQueue() {
  try {
    const result = await chrome.storage.session.get([STORAGE_KEYS.QUEUE]);
    return result[STORAGE_KEYS.QUEUE] || [];
  } catch (error) {
    console.error('Failed to get queue:', error);
    return [];
  }
}

/**
 * Set scraping queue
 */
export async function setQueue(queue) {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEYS.QUEUE]: queue
    });
  } catch (error) {
    console.error('Failed to set queue:', error);
  }
}

/**
 * Add item to queue
 */
export async function addToQueue(item) {
  const queue = await getQueue();
  
  if (!queue.includes(item)) {
    queue.push(item);
    await setQueue(queue);
  }
  
  return queue;
}

/**
 * Remove item from queue
 */
export async function removeFromQueue(item) {
  const queue = await getQueue();
  const index = queue.indexOf(item);
  
  if (index > -1) {
    queue.splice(index, 1);
    await setQueue(queue);
  }
  
  return queue;
}

/**
 * Get next item from queue (FIFO)
 */
export async function getNextFromQueue() {
  const queue = await getQueue();
  
  if (queue.length === 0) {
    return null;
  }
  
  const item = queue.shift();
  await setQueue(queue);
  
  return item;
}

/**
 * Clear queue
 */
export async function clearQueue() {
  await setQueue([]);
}

/**
 * Get configuration
 */
export async function getConfig() {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.CONFIG]);
    return result[STORAGE_KEYS.CONFIG] || {
      max_posts_per_hashtag: 1000,
      scroll_delay_ms: 1500,
      export_format: 'csv',
      auto_export: false
    };
  } catch (error) {
    console.error('Failed to get config:', error);
    return {};
  }
}

/**
 * Save configuration
 */
export async function saveConfig(config) {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.CONFIG]: config
    });
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

/**
 * Record failure for circuit breaker
 */
export async function recordFailure(reason) {
  const state = await getCircuitBreakerState();
  
  // Increment failure count
  const failureCount = (state.failureCount || 0) + 1;
  
  // Trigger circuit breaker after 3 consecutive failures
  if (failureCount >= 3) {
    await setCircuitBreakerState({
      active: true,
      reason: reason || 'consecutive_failures',
      failureCount: failureCount
    });
    return true; // Circuit breaker triggered
  }
  
  await setCircuitBreakerState({
    ...state,
    failureCount: failureCount
  });
  
  return false; // Circuit breaker not triggered yet
}

/**
 * Reset failure count on success
 */
export async function resetFailureCount() {
  const state = await getCircuitBreakerState();
  await setCircuitBreakerState({
    ...state,
    failureCount: 0
  });
}

/**
 * Reset circuit breaker manually
 */
export async function resetCircuitBreaker() {
  await setCircuitBreakerState({
    active: false,
    reason: null,
    timestamp: null,
    failureCount: 0
  });
}
