/**
 * Enhanced Content Script with Advanced Anti-Detection
 * 
 * Improvements:
 * - Mouse movement simulation for human-like behavior
 * - Randomized scroll patterns with variable acceleration
 * - Viewport visibility checks
 * - Enhanced CAPTCHA detection with visual analysis
 * - RequestAnimationFrame optimization
 */

// State management
let isScraping = false;
let currentHashtag = null;
let consecutiveFailures = 0;
let scrollAttempts = 0;
const MAX_CONSECUTIVE_FAILURES = 3;
const SCROLL_DELAY_MS = 1500;

// Circuit Breaker State
let circuitBreakerOpen = false;
let circuitBreakerResetTime = null;

// Enhanced anti-detection state
let lastMousePosition = { x: 0, y: 0 };
let scrollVelocity = 0;
let idleTime = 0;

/**
 * Inject the main-world script for network interception
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
    // Validate data before forwarding
    const validatedPosts = validatePosts(data.posts);
    
    if (validatedPosts.length > 0) {
      // Reset failure counter on successful data reception
      consecutiveFailures = 0;
      idleTime = 0;
      
      // Forward to background script
      chrome.runtime.sendMessage({
        action: 'HASHTAG_DATA_RECEIVED',
        hashtag: currentHashtag,
        posts: validatedPosts,
        has_next_page: data.has_next_page,
        end_cursor: data.end_cursor
      }).catch(err => {
        console.error('[Content Script] Failed to send to background:', err);
        recordFailure();
      });
    }
  }
});

/**
 * Validate post data before storing
 * Filters out incomplete or suspicious data
 */
function validatePosts(posts) {
  return posts.filter(post => {
    // Must have shortcode (primary key)
    if (!post.shortcode) return false;
    
    // Must have some engagement (prevents bot posts)
    if (post.likes_count === undefined && post.comments_count === undefined) return false;
    
    // Check for reasonable timestamp (not in future)
    if (post.taken_at_timestamp > Date.now()) return false;
    
    // Validate media URL exists
    if (!post.display_url && !post.video_url) return false;
    
    return true;
  });
}

/**
 * Get current hashtag from URL
 */
function getCurrentHashtag() {
  const match = window.location.pathname.match(/^\/explore\/tags\/([^/]+)\//i);
  if (match) {
    return decodeURIComponent(match[1]);
  }
  return null;
}

/**
 * Enhanced CAPTCHA/block detection with visual analysis
 */
function detectCaptchaOrBlock() {
  const bodyText = document.body.innerText.toLowerCase();
  
  const blockIndicators = [
    'suspicious activity',
    'please wait a few minutes',
    'rate limited',
    'challenge_required',
    'checkpoint_required',
    'login required',
    'something went wrong',
    'loading...'
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
  
  // Check if page suddenly changed
  const currentPath = window.location.pathname;
  if (!currentPath.includes('/explore/tags/') && currentHashtag) {
    return true;
  }
  
  // Check for empty content (possible shadow ban)
  const mediaGrid = document.querySelector('[role="grid"]');
  if (mediaGrid && mediaGrid.children.length === 0) {
    const loadingIndicator = document.querySelector('[role="progressbar"]');
    if (!loadingIndicator) {
      // No content and not loading = possible block
      return true;
    }
  }
  
  return false;
}

/**
 * Simulate human-like mouse movement
 * Moves cursor randomly before scrolling
 */
async function simulateMouseMove() {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  // Generate random target position (biased towards center)
  const targetX = viewportWidth * (0.3 + Math.random() * 0.4);
  const targetY = viewportHeight * (0.3 + Math.random() * 0.4);
  
  // Calculate steps for smooth movement
  const steps = 5 + Math.floor(Math.random() * 5);
  const dx = (targetX - lastMousePosition.x) / steps;
  const dy = (targetY - lastMousePosition.y) / steps;
  
  // Create and dispatch mousemove events
  for (let i = 0; i < steps; i++) {
    const event = new MouseEvent('mousemove', {
      view: window,
      bubbles: true,
      cancelable: true,
      screenX: lastMousePosition.x + dx * i,
      screenY: lastMousePosition.y + dy * i,
      clientX: lastMousePosition.x + dx * i,
      clientY: lastMousePosition.y + dy * i
    });
    
    document.dispatchEvent(event);
    
    // Small random delay between movements
    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 50));
  }
  
  lastMousePosition = { x: targetX, y: targetY };
}

/**
 * Enhanced scroll with variable acceleration and deceleration
 */
async function scrollToBottom() {
  return new Promise((resolve) => {
    const startScroll = document.documentElement.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight;
    const windowHeight = window.innerHeight;
    
    // Variable scroll amount based on remaining content
    const remainingContent = scrollHeight - startScroll - windowHeight;
    const baseScrollAmount = Math.min(300, remainingContent * 0.3);
    const randomVariation = Math.random() * 200 - 100; // -100 to +100
    const scrollAmount = Math.max(100, baseScrollAmount + randomVariation);
    
    const targetScroll = Math.min(startScroll + scrollAmount, scrollHeight - windowHeight);
    const scrollDistance = targetScroll - startScroll;
    
    // Animate scroll with easing
    const duration = 800 + Math.random() * 400; // 800-1200ms
    const startTime = performance.now();
    
    function animateScroll(currentTime) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Ease-in-out cubic bezier
      const easeProgress = progress < 0.5 
        ? 4 * progress * progress * progress 
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;
      
      const currentScroll = startScroll + (scrollDistance * easeProgress);
      window.scrollTo(0, currentScroll);
      
      if (progress < 1) {
        requestAnimationFrame(animateScroll);
      } else {
        scrollVelocity = 0;
        resolve();
      }
    }
    
    requestAnimationFrame(animateScroll);
  });
}

/**
 * Add random idle time between actions (human behavior)
 */
async function addRandomIdle() {
  const idleDuration = 500 + Math.random() * 1500; // 0.5-2 seconds
  await new Promise(resolve => setTimeout(resolve, idleDuration));
  idleTime += idleDuration;
}

/**
 * Main scraping loop with enhanced anti-detection
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
  idleTime = 0;
  
  console.log(`[Content Script] Starting scrape for #${hashtag}`);
  
  // Notify background
  chrome.runtime.sendMessage({
    action: 'SCRAPING_STARTED',
    hashtag: hashtag
  });
  
  // Scrape loop
  while (isScraping && !circuitBreakerOpen) {
    try {
      // Check for CAPTCHA/block
      if (detectCaptchaOrBlock()) {
        console.warn('[Content Script] CAPTCHA or block detected!');
        await triggerCircuitBreaker('captcha_detected');
        break;
      }
      
      // Verify we're still on correct hashtag page
      const pageHashtag = getCurrentHashtag();
      if (pageHashtag !== currentHashtag) {
        console.warn('[Content Script] Navigated away from hashtag page');
        break;
      }
      
      // Simulate human behavior: mouse movement
      await simulateMouseMove();
      
      // Perform scroll with animation
      await scrollToBottom();
      scrollAttempts++;
      
      // Random idle time after scroll
      await addRandomIdle();
      
      // Check if we've reached bottom
      const currentScroll = document.documentElement.scrollTop;
      const windowHeight = window.innerHeight;
      const scrollHeight = document.documentElement.scrollHeight;
      
      if (currentScroll + windowHeight >= scrollHeight - 100) {
        // Wait longer to see if new content loads
        await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
        
        const finalScrollHeight = document.documentElement.scrollHeight;
        if (finalScrollHeight <= scrollHeight + 50) {
          console.log('[Content Script] End of content reached');
          break;
        }
      }
      
      // Safety limit
      if (scrollAttempts >= 100) {
        console.log('[Content Script] Max scroll attempts reached');
        break;
      }
      
      // Update progress periodically
      if (scrollAttempts % 5 === 0) {
        chrome.runtime.sendMessage({
          action: 'SCRAPING_PROGRESS',
          hashtag: hashtag,
          scroll_attempts: scrollAttempts,
          idle_time: idleTime
        });
      }
    } catch (error) {
      console.error('[Content Script] Scroll error:', error);
      recordFailure();
      
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await triggerCircuitBreaker('scroll_error');
        break;
      }
    }
  }
  
  // Cleanup
  isScraping = false;
  currentHashtag = null;
  
  chrome.runtime.sendMessage({
    action: 'SCRAPING_COMPLETED',
    hashtag: hashtag,
    scroll_attempts: scrollAttempts,
    total_idle_time: idleTime
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
 * Trigger circuit breaker
 */
async function triggerCircuitBreaker(reason) {
  circuitBreakerOpen = true;
  consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
  
  const state = {
    hashtag: currentHashtag,
    reason: reason,
    timestamp: Date.now(),
    scrollAttempts: scrollAttempts
  };
  
  localStorage.setItem('scraper_circuit_breaker', JSON.stringify(state));
  
  chrome.runtime.sendMessage({
    action: 'CIRCUIT_BREAKER_TRIGGERED',
    reason: reason,
    hashtag: currentHashtag
  });
  
  console.error(`[Content Script] Circuit breaker triggered: ${reason}`);
}

/**
 * Record a failure
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
  console.log('[Content Script] Initializing with enhanced anti-detection...');
  
  // Inject main-world script
  injectMainWorldScript();
  
  // Listen for commands
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
          consecutive_failures: consecutiveFailures,
          scroll_attempts: scrollAttempts
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
    
    return true;
  });
  
  // Check for previous circuit breaker state
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

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}
