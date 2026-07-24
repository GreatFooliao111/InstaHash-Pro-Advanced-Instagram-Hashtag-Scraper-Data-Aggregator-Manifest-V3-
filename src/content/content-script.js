/**
 * Content Script - DOM Interaction & Scroll Controller
 * 
 * MV3 Architecture Notes:
 * - Receives data from main-world.js via window.postMessage
 * - Forwards data to background script via chrome.runtime.sendMessage
 * - Handles DOM scrolling (NOT in background - service workers can't access DOM)
 * - Implements Circuit Breaker pattern for anti-detection
 */

// State management
let isScraping = false;
let currentHashtag = null;
let consecutiveFailures = 0;
let scrollAttempts = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
const SCROLL_DELAY_MS = 1500; // Human-like scrolling

// Circuit Breaker State
let circuitBreakerOpen = false;
let circuitBreakerResetTime = null;

/**
 * Inject the main-world script for network interception
 * This is required because content scripts run in isolated world
 */
function injectMainWorldScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/injected/main-world.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

/**
 * Listen for messages from main-world interceptor
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  
  const { type, data, source } = event.data;
  
  if (type === 'INSTAGRAM_SCRAPER_DATA' && source === 'main-world-interceptor') {
    // Forward to background script for processing
    chrome.runtime.sendMessage({
      action: 'HASHTAG_DATA_RECEIVED',
      hashtag: currentHashtag,
      posts: data.posts,
      has_next_page: data.has_next_page,
      end_cursor: data.end_cursor
    }).catch(err => {
      console.error('[Content Script] Failed to send to background:', err);
    });
    
    // Reset failure counter on successful data reception
    consecutiveFailures = 0;
  }
});

/**
 * Check if we're on a hashtag page and extract the hashtag
 */
function getCurrentHashtag() {
  const match = window.location.pathname.match(/^\/explore\/tags\/([^/]+)\//i);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * Detect if Instagram is showing CAPTCHA or rate limit
 */
function detectCaptchaOrBlock() {
  // Check for common Instagram block indicators
  const bodyText = document.body.innerText.toLowerCase();
  
  const blockIndicators = [
    'suspicious activity',
    'please wait a few minutes',
    'rate limited',
    'challenge_required',
    'checkpoint_required',
    'login required'
  ];
  
  // Check URL for challenge redirects
  if (window.location.href.includes('/challenge/') ||
      window.location.href.includes('/checkpoint/')) {
    return true;
  }
  
  // Check for block messages
  for (const indicator of blockIndicators) {
    if (bodyText.includes(indicator)) {
      return true;
    }
  }
  
  // Check if page suddenly changed (navigation away from hashtag)
  const currentPath = window.location.pathname;
  if (!currentPath.includes('/explore/tags/') && currentHashtag) {
    return true;
  }
  
  return false;
}

/**
 * Scroll down the page with human-like behavior
 */
async function scrollToBottom() {
  return new Promise((resolve) => {
    const scrollHeight = document.documentElement.scrollHeight;
    const currentScroll = document.documentElement.scrollTop;
    
    // Add some randomness to scroll amount (human-like)
    const scrollAmount = Math.floor(Math.random() * 300) + 200;
    const targetScroll = Math.min(currentScroll + scrollAmount, scrollHeight);
    
    window.scrollTo({
      top: targetScroll,
      behavior: 'smooth'
    });
    
    // Wait for scroll to complete plus random delay
    const delay = SCROLL_DELAY_MS + Math.random() * 1000;
    setTimeout(() => {
      resolve();
    }, delay);
  });
}

/**
 * Main scraping loop - controlled by background script
 * Uses requestAnimationFrame for smooth scrolling
 */
async function startScraping(hashtag) {
  if (isScraping) {
    console.log('[Content Script] Already scraping');
    return;
  }
  
  isScraping = true;
  currentHashtag = hashtag;
  consecutiveFailures = 0;
  scrollAttempts = 0;
  circuitBreakerOpen = false;
  
  console.log(`[Content Script] Starting scrape for #${hashtag}`);
  
  // Notify background that scraping started
  chrome.runtime.sendMessage({
    action: 'SCRAPING_STARTED',
    hashtag: hashtag
  });
  
  // Scrape loop
  while (isScraping && !circuitBreakerOpen) {
    // Check for CAPTCHA/block
    if (detectCaptchaOrBlock()) {
      console.warn('[Content Script] CAPTCHA or block detected!');
      await triggerCircuitBreaker('captcha_detected');
      break;
    }
    
    // Verify we're still on the correct hashtag page
    const pageHashtag = getCurrentHashtag();
    if (pageHashtag !== currentHashtag) {
      console.warn('[Content Script] Navigated away from hashtag page');
      break;
    }
    
    // Perform scroll
    await scrollToBottom();
    scrollAttempts++;
    
    // Check if we've reached the bottom (no more content)
    const newScrollHeight = document.documentElement.scrollHeight;
    const currentScroll = document.documentElement.scrollTop;
    const windowHeight = window.innerHeight;
    
    if (currentScroll + windowHeight >= newScrollHeight - 100) {
      // Reached bottom - check if there's more to load
      // Wait a bit longer to see if new content loads
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const finalScrollHeight = document.documentElement.scrollHeight;
      if (finalScrollHeight <= newScrollHeight + 50) {
        console.log('[Content Script] End of content reached');
        break;
      }
    }
    
    // Safety limit - don't scroll forever
    if (scrollAttempts >= 100) {
      console.log('[Content Script] Max scroll attempts reached');
      break;
    }
  }
  
  // Cleanup
  isScraping = false;
  currentHashtag = null;
  
  chrome.runtime.sendMessage({
    action: 'SCRAPING_COMPLETED',
    hashtag: hashtag,
    scroll_attempts: scrollAttempts
  });
}

/**
 * Stop scraping immediately
 */
function stopScraping() {
  isScraping = false;
  console.log('[Content Script] Scraping stopped');
}

/**
 * Trigger circuit breaker - pause scraping due to errors
 */
async function triggerCircuitBreaker(reason) {
  circuitBreakerOpen = true;
  consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
  
  // Save state to localStorage for recovery
  const state = {
    hashtag: currentHashtag,
    reason: reason,
    timestamp: Date.now(),
    scrollAttempts: scrollAttempts
  };
  
  localStorage.setItem('scraper_circuit_breaker', JSON.stringify(state));
  
  // Notify background
  chrome.runtime.sendMessage({
    action: 'CIRCUIT_BREAKER_TRIGGERED',
    reason: reason,
    hashtag: currentHashtag
  });
  
  console.error(`[Content Script] Circuit breaker triggered: ${reason}`);
}

/**
 * Record a network/request failure
 */
function recordFailure() {
  consecutiveFailures++;
  
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    triggerCircuitBreaker('consecutive_failures');
  }
}

/**
 * Initialize content script
 */
function initialize() {
  console.log('[Content Script] Initializing...');
  
  // Inject main-world script for network interception
  injectMainWorldScript();
  
  // Listen for commands from background/popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'START_SCRAPING':
        startScraping(message.hashtag);
        sendResponse({ status: 'started' });
        break;
        
      case 'STOP_SCRAPING':
        stopScraping();
        sendResponse({ status: 'stopped' });
        break;
        
      case 'GET_STATUS':
        sendResponse({
          is_scraping: isScraping,
          current_hashtag: currentHashtag,
          circuit_breaker_open: circuitBreakerOpen,
          consecutive_failures: consecutiveFailures
        });
        break;
        
      case 'RESET_CIRCUIT_BREAKER':
        circuitBreakerOpen = false;
        consecutiveFailures = 0;
        localStorage.removeItem('scraper_circuit_breaker');
        sendResponse({ status: 'reset' });
        break;
        
      default:
        sendResponse({ error: 'Unknown action' });
    }
    
    return true; // Keep message channel open for async response
  });
  
  // Check for circuit breaker recovery on page reload
  const savedState = localStorage.getItem('scraper_circuit_breaker');
  if (savedState) {
    try {
      const state = JSON.parse(savedState);
      console.warn('[Content Script] Previous session ended with circuit breaker:', state.reason);
    } catch (e) {
      localStorage.removeItem('scraper_circuit_breaker');
    }
  }
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
