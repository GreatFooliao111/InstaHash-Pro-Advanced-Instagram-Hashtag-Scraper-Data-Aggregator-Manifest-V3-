/**
 * Background Service Worker - Queue Manager & State Controller
 * 
 * MV3 Architecture Notes:
 * - NO infinite loops or setInterval (service worker gets terminated)
 * - Uses chrome.storage.session for ephemeral state
 * - Uses chrome.storage.local for persistent state (survives restarts)
 * - Manages hashtag queue and coordinates scraping across tabs
 * - Handles offscreen document for heavy export operations
 */

// Queue state - stored in chrome.storage.session (ephemeral)
let scrapingQueue = [];
let currentHashtag = null;
let isScraping = false;

// Circuit breaker state
let circuitBreakerState = {
  active: false,
  reason: null,
  timestamp: null
};

/**
 * Initialize service worker
 */
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] Extension installed');
  
  // Initialize storage
  await chrome.storage.local.set({
    scraper_config: {
      max_posts_per_hashtag: 1000,
      scroll_delay_ms: 1500,
      auto_export: false,
      export_format: 'csv'
    },
    scraper_stats: {
      total_scraped: 0,
      sessions: 0
    }
  });
});

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
 * Start scraping a hashtag
 */
async function startScraping(hashtag) {
  if (isScraping) {
    console.warn('[Background] Already scraping');
    return { success: false, error: 'Already scraping' };
  }
  
  // Check circuit breaker
  if (circuitBreakerState.active) {
    const timeSinceTrigger = Date.now() - circuitBreakerState.timestamp;
    if (timeSinceTrigger < 300000) { // 5 minute cooldown
      return { 
        success: false, 
        error: 'Circuit breaker active',
        reason: circuitBreakerState.reason
      };
    }
    // Reset circuit breaker after cooldown
    circuitBreakerState.active = false;
  }
  
  currentHashtag = hashtag;
  isScraping = true;
  
  // Update session storage
  await chrome.storage.session.set({
    scraping_state: {
      active: true,
      hashtag: hashtag,
      started_at: Date.now()
    }
  });
  
  // Get or create Instagram tab
  const tab = await getOrCreateInstagramTab();
  
  // Navigate to hashtag page
  const hashtagUrl = `https://www.instagram.com/explore/tags/${hashtag}/`;
  
  try {
    await chrome.tabs.update(tab.id, { url: hashtagUrl });
    
    // Wait for page to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Send start command to content script
    await chrome.tabs.sendMessage(tab.id, {
      action: 'START_SCRAPING',
      hashtag: hashtag
    });
    
    console.log(`[Background] Started scraping #${hashtag}`);
    return { success: true, tab_id: tab.id };
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
          
          sendResponse({ status: 'received' });
          break;
          
        case 'SCRAPING_STARTED':
          console.log(`[Background] Scraping started for #${message.hashtag}`);
          sendResponse({ status: 'acknowledged' });
          break;
          
        case 'SCRAPING_COMPLETED':
          console.log(`[Background] Scraping completed for #${message.hashtag}`);
          isScraping = false;
          
          // Process next in queue if available
          await processQueue();
          
          sendResponse({ status: 'completed' });
          break;
          
        case 'CIRCUIT_BREAKER_TRIGGERED':
          console.error(`[Background] Circuit breaker triggered: ${message.reason}`);
          circuitBreakerState.active = true;
          circuitBreakerState.reason = message.reason;
          circuitBreakerState.timestamp = Date.now();
          
          isScraping = false;
          
          // Save to persistent storage
          await chrome.storage.local.set({
            circuit_breaker: circuitBreakerState
          });
          
          sendResponse({ status: 'circuit_breaker_active' });
          break;
          
        case 'GET_STATUS':
          sendResponse({
            is_scraping: isScraping,
            current_hashtag: currentHashtag,
            queue_length: scrapingQueue.length,
            circuit_breaker: circuitBreakerState
          });
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
