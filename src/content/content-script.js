/**
 * Content Script - DOM Interaction & Scroll Controller
 * 
 * MV3 Architecture Notes:
 * - Receives data from main-world.js via window.postMessage
 * - Forwards data to background script via chrome.runtime.sendMessage
 * - Handles DOM scrolling (NOT in background - service workers can't access DOM)
 * - Implements Circuit Breaker pattern for anti-detection
 * 
 * IMPROVEMENTS (v2.0):
 * - Smart delay configuration from background
 * - Enhanced login state detection
 * - Better CAPTCHA/rate limit detection
 * - Support for multiple hashtag queuing
 */

// State management
let isScraping = false;
let currentHashtag = null;
let consecutiveFailures = 0;
let scrollAttempts = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
let SCROLL_DELAY_MS = 2000; // Default, overridden by background
let isLoggedIn = true; // Assume logged in until proven otherwise
let maxPostsLimit = 100; // Default max posts per hashtag
let collectedPostsCount = 0; // Track collected posts count

// Circuit Breaker State
let circuitBreakerOpen = false;
let circuitBreakerResetTime = null;

// Human-like behavior configuration
const HUMAN_BEHAVIOR = {
  minScrollDelay: 1500,
  maxScrollDelay: 4000,
  randomPauseChance: 0.3, // 30% chance to pause briefly
  minPauseDuration: 500,
  maxPauseDuration: 2000
};

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
    // Update collected posts count
    collectedPostsCount += (data.posts ? data.posts.length : 0);
    
    // Check if we've reached the max posts limit
    if (maxPostsLimit > 0 && collectedPostsCount >= maxPostsLimit) {
      console.log(`[Content Script] Max posts limit (${maxPostsLimit}) reached. Stopping.`);
      isScraping = false;
      chrome.runtime.sendMessage({
        action: 'SCRAPING_COMPLETED',
        hashtag: currentHashtag,
        scroll_attempts: scrollAttempts,
        reason: 'max_posts_reached'
      });
      return;
    }
    
    // Forward to background script for processing
    chrome.runtime.sendMessage({
      action: 'HASHTAG_DATA_RECEIVED',
      hashtag: currentHashtag,
      posts: data.posts,
      has_next_page: data.has_next_page,
      end_cursor: data.end_cursor,
      collected_count: collectedPostsCount,
      max_posts: maxPostsLimit
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
 * Enhanced detection with multiple indicators
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
    'login required',
    'try again later',
    'something went wrong'
  ];
  
  // Check URL for challenge redirects
  if (window.location.href.includes('/challenge/') ||
      window.location.href.includes('/checkpoint/')) {
    return true;
  }
  
  // Check for block messages
  for (const indicator of blockIndicators) {
    if (bodyText.includes(indicator)) {
      console.warn(`[Content Script] Block indicator found: ${indicator}`);
      return true;
    }
  }
  
  // Check if page suddenly changed (navigation away from hashtag)
  const currentPath = window.location.pathname;
  if (!currentPath.includes('/explore/tags/') && currentHashtag) {
    return true;
  }
  
  // Check for login modal overlay
  const loginModal = document.querySelector('[role="dialog"]');
  if (loginModal && loginModal.innerText.toLowerCase().includes('log in')) {
    isLoggedIn = false;
    return true;
  }
  
  // Check if content grid is empty (possible shadowban)
  const mediaGrid = document.querySelector('article, ._aagc');
  if (!mediaGrid && currentPath.includes('/explore/tags/')) {
    console.warn('[Content Script] No media content detected');
    // Don't return true immediately - might still be loading
  }
  
  return false;
}

/**
 * Check login state by looking for profile icon or login button
 */
function checkLoginState() {
  // Look for profile picture in header (indicates logged in)
  const profileIcon = document.querySelector('img[alt*="profile"]');
  const loginButtons = document.querySelectorAll('[role="button"]');
  
  let loggedIn = false;
  
  // Method 1: Check for profile icon
  if (profileIcon) {
    loggedIn = true;
  }
  
  // Method 2: Check if login/signup buttons are absent
  const hasLoginButton = Array.from(loginButtons).some(btn => 
    btn.innerText.toLowerCase().includes('log in') ||
    btn.innerText.toLowerCase().includes('sign up')
  );
  
  if (!hasLoginButton && !loggedIn) {
    loggedIn = true; // No login buttons suggests logged in
  }
  
  isLoggedIn = loggedIn;
  
  // Notify background of login state
  chrome.runtime.sendMessage({
    action: 'LOGIN_STATE_UPDATE',
    loggedIn: isLoggedIn
  });
  
  return isLoggedIn;
}

/**
 * Scroll down the page with human-like behavior
 * Includes random pauses and variable scroll amounts
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
    
    // Calculate delay with human-like variation
    const baseDelay = SCROLL_DELAY_MS;
    const randomVariation = Math.random() * (HUMAN_BEHAVIOR.maxScrollDelay - HUMAN_BEHAVIOR.minScrollDelay);
    let totalDelay = baseDelay + randomVariation;
    
    // 30% chance to add an extra pause (human behavior)
    if (Math.random() < HUMAN_BEHAVIOR.randomPauseChance) {
      const extraPause = Math.random() * (HUMAN_BEHAVIOR.maxPauseDuration - HUMAN_BEHAVIOR.minPauseDuration) + HUMAN_BEHAVIOR.minPauseDuration;
      totalDelay += extraPause;
      console.log('[Content Script] Adding human-like pause');
    }
    
    // Wait for scroll to complete plus random delay
    setTimeout(() => {
      resolve();
    }, totalDelay);
  });
}

/**
 * Main scraping loop - controlled by background script
 * Uses requestAnimationFrame for smooth scrolling
 */
async function startScraping(hashtag, customDelay = null, maxPosts = null) {
  if (isScraping) {
    console.log('[Content Script] Already scraping');
    return;
  }
  
  // Apply custom delay from background if provided
  if (customDelay) {
    SCROLL_DELAY_MS = customDelay;
    console.log(`[Content Script] Using custom delay: ${customDelay}ms`);
  }
  
  // Get max posts limit (from parameter or config)
  const postsLimit = maxPosts || await getMaxPostsFromConfig();
  let collectedPostsCount = 0;
  
  isScraping = true;
  currentHashtag = hashtag;
  consecutiveFailures = 0;
  scrollAttempts = 0;
  circuitBreakerOpen = false;
  
  // Check login state at start
  checkLoginState();
  
  console.log(`[Content Script] Starting scrape for #${hashtag} (max: ${postsLimit} posts)`);
  
  // Notify background that scraping started
  chrome.runtime.sendMessage({
    action: 'SCRAPING_STARTED',
    hashtag: hashtag,
    max_posts: postsLimit
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
 * Get max posts limit from configuration
 */
async function getMaxPostsFromConfig() {
  try {
    const result = await chrome.storage.local.get(['scraper_config']);
    const config = result.scraper_config || {};
    return config.max_posts_per_hashtag || 100;
  } catch (error) {
    console.error('[Content Script] Failed to get config:', error);
    return 100; // Default fallback
  }
}

/**
 * Initialize content script
 */
function initialize() {
  console.log('[Content Script] Initializing v2.0...');

  // Load configuration
  getMaxPostsFromConfig().then(limit => {
    maxPostsLimit = limit;
    console.log(`[Content Script] Max posts limit: ${maxPostsLimit}`);
  });

  // Inject main-world script for network interception
  injectMainWorldScript();

  // Listen for commands from background/popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
      case 'START_SCRAPING':
        startScraping(message.hashtag, message.delay_ms, message.max_posts);
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
          consecutive_failures: consecutiveFailures,
          is_logged_in: isLoggedIn,
          collected_count: collectedPostsCount,
          max_posts: maxPostsLimit
        });
        break;

      case 'RESET_CIRCUIT_BREAKER':
        circuitBreakerOpen = false;
        consecutiveFailures = 0;
        localStorage.removeItem('scraper_circuit_breaker');
        sendResponse({ status: 'reset' });
        break;

      case 'CHECK_LOGIN_STATE':
        const loggedIn = checkLoginState();
        sendResponse({ loggedIn: loggedIn });
        break;

      default:
        sendResponse({ error: 'Unknown action' });
    }
    
    return true;
  });

  // Check for previous session recovery
  const savedState = localStorage.getItem('scraper_circuit_breaker');
  if (savedState) {
    try {
      const state = JSON.parse(savedState);
      console.warn('[Content Script] Previous session ended with circuit breaker:', state.reason);
    } catch (e) {
      localStorage.removeItem('scraper_circuit_breaker');
    }
  }

  // Initial login state check
  setTimeout(() => checkLoginState(), 2000);
}

// Start initialization when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
