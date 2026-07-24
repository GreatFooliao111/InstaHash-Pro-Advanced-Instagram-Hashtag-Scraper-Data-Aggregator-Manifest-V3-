/**
 * Options Page Controller
 * Handles settings management and database statistics
 */

// DOM Elements
const maxPostsInput = document.getElementById('maxPosts');
const scrollDelayInput = document.getElementById('scrollDelay');
const exportFormatSelect = document.getElementById('exportFormat');
const autoExportToggle = document.getElementById('autoExport');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const saveMessage = document.getElementById('saveMessage');
const refreshStatsBtn = document.getElementById('refreshStatsBtn');
const clearDataBtn = document.getElementById('clearDataBtn');
const totalPostsStat = document.getElementById('totalPostsStat');
const uniqueHashtagsStat = document.getElementById('uniqueHashtagsStat');
const storageSizeStat = document.getElementById('storageSizeStat');

// Default settings
const DEFAULT_SETTINGS = {
  max_posts_per_hashtag: 1000,
  scroll_delay_ms: 1500,
  export_format: 'csv',
  auto_export: false
};

/**
 * Initialize options page
 */
async function init() {
  await loadSettings();
  await loadStatistics();
}

/**
 * Load settings from storage
 */
async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['scraper_config']);
    const config = result.scraper_config || DEFAULT_SETTINGS;
    
    maxPostsInput.value = config.max_posts_per_hashtag || DEFAULT_SETTINGS.max_posts_per_hashtag;
    scrollDelayInput.value = config.scroll_delay_ms || DEFAULT_SETTINGS.scroll_delay_ms;
    exportFormatSelect.value = config.export_format || DEFAULT_SETTINGS.export_format;
    autoExportToggle.checked = config.auto_export || DEFAULT_SETTINGS.auto_export;
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

/**
 * Save settings to storage
 */
async function saveSettings() {
  try {
    const config = {
      max_posts_per_hashtag: parseInt(maxPostsInput.value) || DEFAULT_SETTINGS.max_posts_per_hashtag,
      scroll_delay_ms: parseInt(scrollDelayInput.value) || DEFAULT_SETTINGS.scroll_delay_ms,
      export_format: exportFormatSelect.value,
      auto_export: autoExportToggle.checked
    };
    
    await chrome.storage.local.set({ scraper_config: config });
    
    // Show success message
    saveMessage.style.display = 'block';
    setTimeout(() => {
      saveMessage.style.display = 'none';
    }, 3000);
    
    console.log('Settings saved:', config);
  } catch (error) {
    console.error('Failed to save settings:', error);
    alert('Failed to save settings: ' + error.message);
  }
}

/**
 * Reset settings to defaults
 */
async function resetSettings() {
  if (!confirm('Are you sure you want to reset all settings to defaults?')) {
    return;
  }
  
  try {
    await chrome.storage.local.set({ scraper_config: DEFAULT_SETTINGS });
    await loadSettings();
    
    saveMessage.textContent = 'Settings reset to defaults!';
    saveMessage.style.display = 'block';
    setTimeout(() => {
      saveMessage.style.display = 'none';
      saveMessage.textContent = 'Settings saved successfully!';
    }, 3000);
  } catch (error) {
    console.error('Failed to reset settings:', error);
  }
}

/**
 * Load database statistics
 */
async function loadStatistics() {
  try {
    const db = await openDatabase();
    const tx = db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    
    // Get total count
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
    
    // Estimate storage size (rough estimate)
    const storageEstimate = await navigator.storage.estimate();
    const usageMB = (storageEstimate.usage / (1024 * 1024)).toFixed(2);
    
    totalPostsStat.textContent = count.toLocaleString();
    uniqueHashtagsStat.textContent = allHashtags.size;
    storageSizeStat.textContent = `${usageMB} MB`;
  } catch (error) {
    console.error('Failed to load statistics:', error);
    totalPostsStat.textContent = 'Error';
    uniqueHashtagsStat.textContent = 'Error';
    storageSizeStat.textContent = 'Error';
  }
}

/**
 * Open IndexedDB connection
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('instagram-scraper-db', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Clear all data from database
 */
async function clearAllData() {
  if (!confirm('⚠️ WARNING: This will delete ALL scraped posts from the database. This action cannot be undone!\n\nAre you sure you want to continue?')) {
    return;
  }
  
  try {
    const db = await openDatabase();
    const tx = db.transaction('posts', 'readwrite');
    const store = tx.objectStore('posts');
    
    await new Promise((resolve, reject) => {
      const request = store.clear();
      request.onsuccess = resolve;
      request.onerror = reject;
    });
    
    await tx.done;
    
    alert('All data cleared successfully!');
    await loadStatistics();
  } catch (error) {
    console.error('Failed to clear data:', error);
    alert('Failed to clear data: ' + error.message);
  }
}

// Event Listeners
saveBtn.addEventListener('click', saveSettings);
resetBtn.addEventListener('click', resetSettings);
refreshStatsBtn.addEventListener('click', loadStatistics);
clearDataBtn.addEventListener('click', clearAllData);

// Initialize on load
init();
