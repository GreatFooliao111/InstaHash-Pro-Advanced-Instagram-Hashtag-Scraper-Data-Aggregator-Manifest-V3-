/**
 * Background Service Worker - Queue Manager & State Controller
 * 
 * MV3 Architecture Notes:
 * - NO infinite loops or setInterval (service worker gets terminated)
 * - Uses chrome.storage.session for ephemeral state
 * - Uses chrome.storage.local for persistent state (survives restarts)
 * - Manages hashtag queue and coordinates scraping across tabs
 * - Handles offscreen document for heavy export operations
 * 
 * IMPROVEMENTS (v2.0):
 * - Smart exponential backoff for rate limiting
 * - Multi-hashtag batch selection and processing
 * - Instagram login state detection
 * - Advanced circuit breaker with adaptive cooldown
 * - Request throttling with human-like delays
 */

// Queue state - stored in chrome.storage.session (ephemeral)
let scrapingQueue = [];
let currentHashtag = null;
let isScraping = false;
let isLoggedIn = false;

// Circuit breaker state with adaptive cooldown
let circuitBreakerState = {
  active: false,
  reason: null,
  timestamp: null,
  cooldownMinutes: 5, // Adaptive: increases with repeated violations
  violationCount: 0
};

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
  minDelayBetweenRequests: 2000, // 2 seconds minimum
  maxDelayBetweenRequests: 8000, // 8 seconds maximum
  baseCooldownMinutes: 5,
  maxCooldownMinutes: 60,
  maxViolations: 5
};

/**
 * Initialize service worker
 */
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] Extension installed');
  
  // Initialize storage with enhanced configuration
  await chrome.storage.local.set({
    scraper_config: {
      max_posts_per_hashtag: 100,  // Default: 100 posts per hashtag (user-configurable)
      scroll_delay_ms: 2000, // Increased for safety
      auto_export: false,
      export_format: 'csv',
      enable_smart_delay: true, // New: adaptive delays
      login_reminder: true, // New: remind user to login
      media_types: ['all'], // Filter by media type: all, image, video, carousel
      min_likes: 0, // Minimum likes filter
      min_comments: 0, // Minimum comments filter
      date_range_days: 365, // Only scrape posts from last N days
      enable_filters: false // Enable/disable filtering
    },
    scraper_stats: {
      total_scraped: 0,
      sessions: 0,
      last_session: null
    },
    circuit_breaker_history: [] // Track violations over time
  });
});

/**
 * Check if user is logged into Instagram
 */
async function checkInstagramLogin() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
    if (tabs.length === 0) return false;
    
    // Send message to content script to check login state
    const response = await chrome.tabs.sendMessage(tabs[0].id, {
      action: 'CHECK_LOGIN_STATE'
    });
    
    isLoggedIn = response?.loggedIn || false;
    return isLoggedIn;
  } catch (error) {
    console.warn('[Background] Could not check login state:', error);
    return false;
  }
}

/**
 * Calculate smart delay based on recent activity
 * Implements exponential backoff with jitter
 */
function calculateSmartDelay() {
  const baseDelay = RATE_LIMIT_CONFIG.minDelayBetweenRequests;
  const maxDelay = RATE_LIMIT_CONFIG.maxDelayBetweenRequests;
  
  // Add randomness (jitter) to avoid patterns
  const jitter = Math.random() * 2000;
  
  // Increase delay if we've had recent violations
  const violationMultiplier = Math.min(
    1 + (circuitBreakerState.violationCount * 0.5),
    3
  );
  
  const calculatedDelay = (baseDelay * violationMultiplier) + jitter;
  return Math.min(calculatedDelay, maxDelay);
}

/**
 * Update circuit breaker with adaptive cooldown
 */
function updateCircuitBreaker(reason) {
  circuitBreakerState.active = true;
  circuitBreakerState.reason = reason;
  circuitBreakerState.timestamp = Date.now();
  circuitBreakerState.violationCount++;
  
  // Adaptive cooldown: increase with each violation
  const newCooldown = Math.min(
    RATE_LIMIT_CONFIG.baseCooldownMinutes * Math.pow(1.5, circuitBreakerState.violationCount - 1),
    RATE_LIMIT_CONFIG.maxCooldownMinutes
  );
  circuitBreakerState.cooldownMinutes = Math.round(newCooldown);
  
  console.log(`[Background] Circuit breaker: ${circuitBreakerState.cooldownMinutes} min cooldown`);
}

/**
 * Reset circuit breaker after successful operation
 */
function resetCircuitBreakerProgress() {
  if (circuitBreakerState.violationCount > 0) {
    circuitBreakerState.violationCount = Math.max(0, circuitBreakerState.violationCount - 1);
    circuitBreakerState.cooldownMinutes = Math.max(
      RATE_LIMIT_CONFIG.baseCooldownMinutes,
      circuitBreakerState.cooldownMinutes * 0.8
    );
  }
}

/**
 * Get the active Instagram tab or create one
 */
async function getOrCreateInstagramTab() {
  const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  
  if (tabs.length > 0) {
    return tabs[0];
  }
  
  // Create new tab
  const tab = await chrome.tabs.create({
    url: 'https://www.instagram.com/'
  });
  
  return tab;
}

/**
 * Start scraping a hashtag with enhanced rate limiting
 */
async function startScraping(hashtag) {
  if (isScraping) {
    console.warn('[Background] Already scraping');
    return { success: false, error: 'Already scraping' };
  }
  
  // Check circuit breaker with adaptive cooldown
  if (circuitBreakerState.active) {
    const timeSinceTrigger = Date.now() - circuitBreakerState.timestamp;
    const cooldownMs = circuitBreakerState.cooldownMinutes * 60 * 1000;
    
    if (timeSinceTrigger < cooldownMs) {
      const remainingMinutes = Math.ceil((cooldownMs - timeSinceTrigger) / 60000);
      return { 
        success: false, 
        error: 'Circuit breaker active',
        reason: circuitBreakerState.reason,
        retry_after_minutes: remainingMinutes
      };
    }
    // Cooldown expired - reset circuit breaker
    circuitBreakerState.active = false;
    resetCircuitBreakerProgress();
  }
  
  // Check login state
  await checkInstagramLogin();
  if (!isLoggedIn) {
    return {
      success: false,
      error: 'Not logged in',
      message: 'Please log into Instagram before scraping'
    };
  }
  
  currentHashtag = hashtag;
  isScraping = true;
  
  // Calculate smart delay for this session
  const smartDelay = calculateSmartDelay();
  console.log(`[Background] Using ${Math.round(smartDelay)}ms delay for #${hashtag}`);
  
  // Update session storage
  await chrome.storage.session.set({
    scraping_state: {
      active: true,
      hashtag: hashtag,
      started_at: Date.now(),
      delay_ms: smartDelay
    }
  });
  
  // Get or create Instagram tab
  const tab = await getOrCreateInstagramTab();
  
  // Navigate to hashtag page
  const hashtagUrl = `https://www.instagram.com/explore/tags/${hashtag}/`;
  
  try {
    await chrome.tabs.update(tab.id, { url: hashtagUrl });
    
    // Wait for page to load (with smart delay)
    await new Promise(resolve => setTimeout(resolve, 3000 + smartDelay));
    
    // Send start command to content script with smart delay
    await chrome.tabs.sendMessage(tab.id, {
      action: 'START_SCRAPING',
      hashtag: hashtag,
      delay_ms: smartDelay
    });
    
    console.log(`[Background] Started scraping #${hashtag}`);
    return { success: true, tab_id: tab.id, delay_ms: smartDelay };
  } catch (error) {
    console.error('[Background] Failed to start scraping:', error);
    isScraping = false;
    return { success: false, error: error.message };
  }
}

/**
 * Stop current scraping operation
 */
async function stopScraping() {
  const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
  
  for (const tab of tabs) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'STOP_SCRAPING' });
    } catch (e) {
      // Tab might not have content script loaded
    }
  }
  
  isScraping = false;
  currentHashtag = null;
  
  await chrome.storage.session.set({
    scraping_state: {
      active: false,
      hashtag: null,
      stopped_at: Date.now()
    }
  });
  
  console.log('[Background] Scraping stopped');
  return { success: true };
}

/**
 * Handle messages from content scripts
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'HASHTAG_DATA_RECEIVED':
          // Forward data to database (via db module would be called in real impl)
          // For now, just acknowledge receipt
          console.log(`[Background] Received ${message.posts.length} posts for #${message.hashtag}`);
          
          // Store posts in IndexedDB via message to offscreen or direct call
          // In MV3, we need to handle this carefully
          await storePosts(message.posts, message.hashtag);
          
          // Success! Reset circuit breaker progress
          resetCircuitBreakerProgress();
          
          sendResponse({ status: 'received' });
          break;
          
        case 'SCRAPING_STARTED':
          console.log(`[Background] Scraping started for #${message.hashtag}`);
          sendResponse({ status: 'acknowledged' });
          break;
          
        case 'SCRAPING_COMPLETED':
          console.log(`[Background] Scraping completed for #${message.hashtag}`);
          isScraping = false;
          
          // Update stats
          const stats = await chrome.storage.local.get(['scraper_stats']);
          const currentStats = stats.scraper_stats || { total_scraped: 0, sessions: 0 };
          currentStats.sessions++;
          currentStats.last_session = Date.now();
          await chrome.storage.local.set({ scraper_stats: currentStats });
          
          // Process next in queue if available
          await processQueue();
          
          sendResponse({ status: 'completed' });
          break;
          
        case 'CIRCUIT_BREAKER_TRIGGERED':
          console.error(`[Background] Circuit breaker triggered: ${message.reason}`);
          updateCircuitBreaker(message.reason);
          
          isScraping = false;
          
          // Save to persistent storage
          await chrome.storage.local.set({
            circuit_breaker: circuitBreakerState,
            circuit_breaker_history: [
              ...(await chrome.storage.local.get(['circuit_breaker_history'])).circuit_breaker_history || [],
              {
                reason: message.reason,
                timestamp: Date.now(),
                hashtag: message.hashtag
              }
            ].slice(-20) // Keep last 20 violations
          });
          
          sendResponse({ 
            status: 'circuit_breaker_active',
            cooldown_minutes: circuitBreakerState.cooldownMinutes
          });
          break;
          
        case 'GET_STATUS':
          const timeSinceTrigger = circuitBreakerState.active 
            ? Date.now() - circuitBreakerState.timestamp 
            : 0;
          const remainingCooldown = circuitBreakerState.active
            ? Math.max(0, circuitBreakerState.cooldownMinutes - Math.floor(timeSinceTrigger / 60000))
            : 0;
            
          sendResponse({
            is_scraping: isScraping,
            current_hashtag: currentHashtag,
            queue_length: scrapingQueue.length,
            circuit_breaker: circuitBreakerState,
            remaining_cooldown_minutes: remainingCooldown,
            is_logged_in: isLoggedIn
          });
          break;
          
        case 'LOGIN_STATE_UPDATE':
          isLoggedIn = message.loggedIn;
          sendResponse({ status: 'updated' });
          break;
          
        default:
          sendResponse({ error: 'Unknown action' });
      }
    } catch (error) {
      console.error('[Background] Message handler error:', error);
      sendResponse({ error: error.message });
    }
  })();
  
  return true; // Keep channel open for async response
});

/**
 * Store posts in IndexedDB
 * This would normally use the db module, but in service worker context
 * we need to either import the module or use a different approach
 */
async function storePosts(posts, hashtag) {
  // In production, this would call the db module
  // For MV3 service worker, we'll use a simplified approach
  // The actual implementation uses idb library
  
  try {
    // Open database
    const db = await openDatabase();
    const tx = db.transaction('posts', 'readwrite');
    const store = tx.objectStore('posts');
    
    for (const post of posts) {
      const existing = await store.get(post.shortcode);
      
      if (existing) {
        // Merge hashtags
        if (!existing.found_in_hashtags.includes(hashtag)) {
          existing.found_in_hashtags.push(hashtag);
        }
        existing.last_updated = Date.now();
        await store.put(existing);
      } else {
        post.found_in_hashtags = [hashtag];
        post.timestamp = Date.now();
        post.last_updated = Date.now();
        await store.put(post);
      }
    }
    
    await tx.done;
    console.log(`[Background] Stored ${posts.length} posts`);
  } catch (error) {
    console.error('[Background] Failed to store posts:', error);
  }
}

/**
 * Open IndexedDB in service worker
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('instagram-scraper-db', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      if (!db.objectStoreNames.contains('posts')) {
        const store = db.createObjectStore('posts', { keyPath: 'shortcode' });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('hashtags', 'found_in_hashtags', { multiEntry: true });
      }
    };
  });
}

/**
 * Add hashtag to scraping queue
 */
async function addToQueue(hashtag) {
  // Load current queue
  const result = await chrome.storage.session.get(['scraping_queue']);
  scrapingQueue = result.scraping_queue || [];
  
  // Add if not already in queue
  if (!scrapingQueue.includes(hashtag)) {
    scrapingQueue.push(hashtag);
    await chrome.storage.session.set({ scraping_queue: scrapingQueue });
    console.log(`[Background] Added #${hashtag} to queue`);
  }
  
  // If not currently scraping, start processing queue
  if (!isScraping) {
    await processQueue();
  }
  
  return { success: true, queue_length: scrapingQueue.length };
}

/**
 * Process next hashtag in queue
 */
async function processQueue() {
  const result = await chrome.storage.session.get(['scraping_queue']);
  scrapingQueue = result.scraping_queue || [];
  
  if (scrapingQueue.length === 0 || isScraping) {
    return;
  }
  
  const nextHashtag = scrapingQueue.shift();
  await chrome.storage.session.set({ scraping_queue: scrapingQueue });
  
  await startScraping(nextHashtag);
}

/**
 * Clear the scraping queue
 */
async function clearQueue() {
  scrapingQueue = [];
  await chrome.storage.session.set({ scraping_queue: [] });
  return { success: true };
}

/**
 * Export data to CSV/JSON using offscreen document
 */
async function exportData(format = 'csv', hashtags = []) {
  try {
    // Create offscreen document for heavy processing
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/offscreen/export-worker.html'),
      reasons: ['DOM_PARSER'],
      justification: 'Export data to CSV/JSON without blocking main thread'
    });
    
    // Send export command to offscreen document
    chrome.runtime.sendMessage({
      action: 'EXPORT_DATA',
      format: format,
      hashtags: hashtags
    });
    
    return { success: true };
  } catch (error) {
    console.error('[Background] Export failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Listen for offscreen document messages
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'EXPORT_COMPLETE') {
    console.log('[Background] Export complete:', message.download_url);
    // Trigger download
    chrome.downloads.download({
      url: message.download_url,
      filename: message.filename
    });
  }
  return true;
});

// Queue management from popup/options
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case 'ADD_TO_QUEUE':
        sendResponse(await addToQueue(message.hashtag));
        break;
      case 'CLEAR_QUEUE':
        sendResponse(await clearQueue());
        break;
      case 'START_SCRAPING':
        sendResponse(await startScraping(message.hashtag));
        break;
      case 'STOP_SCRAPING':
        sendResponse(await stopScraping());
        break;
      case 'EXPORT_DATA':
        sendResponse(await exportData(message.format, message.hashtags));
        break;
    }
  })();
  return true;
});

console.log('[Background] Service worker initialized');
