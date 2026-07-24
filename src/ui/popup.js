/**
 * Popup UI Controller
 * Handles user interactions and communicates with background script
 */

// DOM Elements
const hashtagInput = document.getElementById('hashtagInput');
const addBtn = document.getElementById('addBtn');
const queueList = document.getElementById('queueList');
const clearBtn = document.getElementById('clearBtn');
const exportBtn = document.getElementById('exportBtn');
const exportFormat = document.getElementById('exportFormat');
const statusBadge = document.getElementById('statusBadge');
const currentHashtagDiv = document.getElementById('currentHashtag');
const hashtagNameSpan = document.getElementById('hashtagName');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const messageArea = document.getElementById('messageArea');
const totalPostsEl = document.getElementById('totalPosts');
const totalHashtagsEl = document.getElementById('totalHashtags');
const refreshStatsBtn = document.getElementById('refreshStatsBtn');
const circuitBreakerWarning = document.getElementById('circuitBreakerWarning');
const resetCircuitBtn = document.getElementById('resetCircuitBtn');

// State
let queue = [];

/**
 * Initialize popup
 */
async function init() {
  await loadQueue();
  await updateStatus();
  await loadStats();
  
  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'session') {
      if (changes.scraping_queue) {
        loadQueue();
      }
      if (changes.scraping_state) {
        updateStatus();
      }
    }
  });
  
  // Listen for messages from background
  chrome.runtime.onMessage.addListener(handleMessage);
}

/**
 * Load scraping queue from storage
 */
async function loadQueue() {
  try {
    const result = await chrome.storage.session.get(['scraping_queue']);
    queue = result.scraping_queue || [];
    renderQueue();
  } catch (error) {
    console.error('Failed to load queue:', error);
  }
}

/**
 * Render queue in UI
 */
function renderQueue() {
  if (queue.length === 0) {
    queueList.innerHTML = '<div style="color: #999; text-align: center; padding: 20px;">Queue is empty</div>';
    return;
  }
  
  queueList.innerHTML = queue.map((hashtag, index) => `
    <div class="queue-item">
      <span class="hashtag-tag">#${hashtag}</span>
      <button class="remove-btn" data-index="${index}">×</button>
    </div>
  `).join('');
  
  // Add event listeners to remove buttons
  queueList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeFromQueue(parseInt(btn.dataset.index)));
  });
}

/**
 * Add hashtag to queue
 */
async function addToQueue() {
  const hashtag = hashtagInput.value.trim().replace(/^#/, '').toLowerCase();
  
  if (!hashtag) {
    showMessage('Please enter a valid hashtag', 'error');
    return;
  }
  
  // Validate hashtag format
  if (!/^[a-z0-9_]+$/.test(hashtag)) {
    showMessage('Hashtag can only contain letters, numbers, and underscores', 'error');
    return;
  }
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'ADD_TO_QUEUE',
      hashtag: hashtag
    });
    
    if (response.success) {
      await loadQueue();
      hashtagInput.value = '';
      showMessage(`Added #${hashtag} to queue`, 'success');
    } else {
      showMessage(response.error || 'Failed to add to queue', 'error');
    }
  } catch (error) {
    showMessage('Failed to communicate with background script', 'error');
    console.error(error);
  }
}

/**
 * Remove hashtag from queue
 */
async function removeFromQueue(index) {
  queue.splice(index, 1);
  await chrome.storage.session.set({ scraping_queue: queue });
  renderQueue();
}

/**
 * Clear entire queue
 */
async function clearQueue() {
  try {
    await chrome.runtime.sendMessage({ action: 'CLEAR_QUEUE' });
    await loadQueue();
    showMessage('Queue cleared', 'success');
  } catch (error) {
    showMessage('Failed to clear queue', 'error');
  }
}

/**
 * Update status display with enhanced information
 */
async function updateStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
    
    if (response.is_scraping) {
      statusBadge.textContent = 'Scraping...';
      statusBadge.className = 'status-badge status-active';
      currentHashtagDiv.classList.remove('hidden');
      hashtagNameSpan.textContent = '#' + response.current_hashtag;
      
      // Show login warning if not logged in
      if (!response.is_logged_in) {
        showMessage('⚠️ Please log into Instagram to continue scraping', 'error');
      }
      
      if (response.circuit_breaker?.active) {
        statusBadge.textContent = 'Paused';
        statusBadge.className = 'status-badge status-warning';
        circuitBreakerWarning.classList.remove('hidden');
      }
    } else {
      statusBadge.textContent = 'Idle';
      statusBadge.className = 'status-badge status-idle';
      currentHashtagDiv.classList.add('hidden');
      
      // Check for circuit breaker with countdown
      if (response.circuit_breaker?.active) {
        circuitBreakerWarning.classList.remove('hidden');
        const remainingMins = response.remaining_cooldown_minutes || 0;
        
        if (remainingMins > 0) {
          document.getElementById('circuitBreakerMessage').textContent = 
            `⚠️ Scraping paused due to rate limiting. Please wait ${remainingMins} minute(s) before continuing.`;
        }
      } else {
        circuitBreakerWarning.classList.add('hidden');
      }
      
      // Warn if not logged in
      if (!response.is_logged_in && response.queue_length > 0) {
        showMessage('⚠️ You are not logged in. Please log into Instagram first.', 'error');
      }
    }
  } catch (error) {
    console.error('Failed to get status:', error);
  }
}

/**
 * Load database statistics
 */
async function loadStats() {
  try {
    const db = await openDatabase();
    const tx = db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    
    const count = await new Promise(resolve => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
    });
    
    // Get unique hashtags
    const allHashtags = new Set();
    await new Promise(resolve => {
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          cursor.value.found_in_hashtags.forEach(h => allHashtags.add(h));
          cursor.continue();
        } else {
          resolve();
        }
      };
    });
    
    totalPostsEl.textContent = count.toLocaleString();
    totalHashtagsEl.textContent = allHashtags.size;
  } catch (error) {
    console.error('Failed to load stats:', error);
    totalPostsEl.textContent = '0';
    totalHashtagsEl.textContent = '0';
  }
}

/**
 * Open IndexedDB
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('instagram-scraper-db', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Export data
 */
async function exportData() {
  const format = exportFormat.value;
  
  try {
    showMessage(`Preparing ${format.toUpperCase()} export...`, 'success');
    
    await chrome.runtime.sendMessage({
      action: 'EXPORT_DATA',
      format: format,
      hashtags: []
    });
    
    showMessage('Export started! Check your downloads folder.', 'success');
  } catch (error) {
    showMessage('Export failed: ' + error.message, 'error');
  }
}

/**
 * Reset circuit breaker
 */
async function resetCircuitBreaker() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.instagram.com/*' });
    
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'RESET_CIRCUIT_BREAKER' });
      } catch (e) {
        // Tab might not have content script
      }
    }
    
    circuitBreakerWarning.classList.add('hidden');
    await updateStatus();
    showMessage('Circuit breaker reset. You can resume scraping.', 'success');
  } catch (error) {
    showMessage('Failed to reset circuit breaker', 'error');
  }
}

/**
 * Show message to user
 */
function showMessage(text, type) {
  messageArea.textContent = text;
  messageArea.className = `message message-${type}`;
  messageArea.classList.remove('hidden');
  
  setTimeout(() => {
    messageArea.classList.add('hidden');
  }, 5000);
}

/**
 * Handle messages from background script
 */
function handleMessage(message, sender, sendResponse) {
  switch (message.action) {
    case 'SCRAPING_STARTED':
      updateStatus();
      break;
      
    case 'SCRAPING_COMPLETED':
      updateStatus();
      loadStats();
      break;
      
    case 'CIRCUIT_BREAKER_TRIGGERED':
      updateStatus();
      showMessage(`Scraping paused: ${message.reason}`, 'error');
      break;
      
    case 'EXPORT_PROGRESS':
      const percent = (message.processed / message.total) * 100;
      progressBar.classList.remove('hidden');
      progressFill.style.width = percent + '%';
      break;
      
    case 'EXPORT_COMPLETE':
      progressBar.classList.add('hidden');
      progressFill.style.width = '0%';
      loadStats();
      break;
      
    case 'EXPORT_ERROR':
      progressBar.classList.add('hidden');
      showMessage('Export failed: ' + message.error, 'error');
      break;
  }
  
  return true;
}

// Event Listeners
addBtn.addEventListener('click', addToQueue);
hashtagInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') addToQueue();
});
clearBtn.addEventListener('click', clearQueue);
exportBtn.addEventListener('click', exportData);
refreshStatsBtn.addEventListener('click', loadStats);
resetCircuitBtn.addEventListener('click', resetCircuitBreaker);

// Initialize on load
init();
