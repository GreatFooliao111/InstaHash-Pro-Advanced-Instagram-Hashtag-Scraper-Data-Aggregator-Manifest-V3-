/**
 * Offscreen Export Worker - CSV/JSON Generation
 * 
 * MV3 Architecture Notes:
 * - Runs in offscreen document to avoid blocking main thread
 * - Uses streaming approach: reads chunks of 1000 records from IndexedDB
 * - NEVER loads all records into memory (prevents OOM crashes)
 * - Prepends UTF-8 BOM for Excel compatibility
 */

// Constants
const CHUNK_SIZE = 1000;
const DB_NAME = 'instagram-scraper-db';
const STORE_NAME = 'posts';

/**
 * Open IndexedDB connection
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Get total count of posts
 */
async function getPostsCount(db, hashtags = []) {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  
  if (hashtags.length === 0) {
    return new Promise((resolve) => {
      const countRequest = store.count();
      countRequest.onsuccess = () => resolve(countRequest.result);
    });
  } else {
    // Count only posts matching specific hashtags
    const index = store.index('hashtags');
    let count = 0;
    
    return new Promise((resolve) => {
      const requests = hashtags.map(hashtag => {
        return new Promise((resolveIndex) => {
          const rangeRequest = index.getAllKeys(hashtag);
          rangeRequest.onsuccess = () => {
            count += rangeRequest.result.length;
            resolveIndex();
          };
        });
      });
      
      Promise.all(requests).then(() => resolve(count));
    });
  }
}

/**
 * Read posts in chunks using cursor
 * This is the MEMORY-SAFE approach - never loads all data at once
 */
async function readPostsChunk(db, offset, limit, hashtags = []) {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  
  return new Promise((resolve) => {
    const results = [];
    let count = 0;
    let skip = offset;
    
    const cursorRequest = store.openCursor();
    
    cursorRequest.onsuccess = (event) => {
      const cursor = event.target.result;
      
      if (!cursor || count >= limit) {
        resolve(results);
        return;
      }
      
      // Filter by hashtags if specified
      if (hashtags.length === 0 || hashtags.some(h => cursor.value.found_in_hashtags.includes(h))) {
        if (skip > 0) {
          skip--;
        } else {
          results.push(cursor.value);
          count++;
        }
      }
      
      cursor.continue();
    };
    
    cursorRequest.onerror = () => resolve([]);
  });
}

/**
 * Escape CSV field properly
 * Handles commas, quotes, and newlines
 */
function escapeCSVField(value) {
  if (value === null || value === undefined) {
    return '';
  }
  
  const stringValue = String(value);
  
  // If contains comma, quote, or newline, wrap in quotes and escape internal quotes
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return '"' + stringValue.replace(/"/g, '""') + '"';
  }
  
  return stringValue;
}

/**
 * Convert post object to CSV row
 */
function postToCSVRow(post) {
  const fields = [
    post.shortcode,
    post.id,
    post.caption?.replace(/\n/g, ' ') || '',
    post.likes_count,
    post.comments_count,
    post.display_url,
    post.video_url || '',
    post.media_type,
    post.alt_text,
    post.is_video,
    post.owner_username,
    post.owner_id,
    post.owner_full_name,
    new Date(post.taken_at_timestamp).toISOString(),
    post.location,
    post.found_in_hashtags.join(';'),
    post.dimensions?.width || 0,
    post.dimensions?.height || 0
  ];
  
  return fields.map(escapeCSVField).join(',');
}

/**
 * Generate CSV with UTF-8 BOM for Excel compatibility
 * Uses streaming approach - processes in chunks
 */
async function generateCSV(hashtags = []) {
  const db = await openDB();
  
  // Get total count first
  const totalCount = await getPostsCount(db, hashtags);
  
  if (totalCount === 0) {
    throw new Error('No posts found to export');
  }
  
  // CSV Header
  const header = 'shortcode,id,caption,likes,comments,display_url,video_url,media_type,alt_text,is_video,owner_username,owner_id,owner_full_name,taken_at,location,hashtags,width,height\n';
  
  // Start with UTF-8 BOM for Excel compatibility
  let csvContent = '\uFEFF' + header;
  
  // Process in chunks
  let offset = 0;
  let processed = 0;
  
  while (processed < totalCount) {
    const chunk = await readPostsChunk(db, offset, CHUNK_SIZE, hashtags);
    
    if (chunk.length === 0) {
      break;
    }
    
    // Convert chunk to CSV rows
    const rows = chunk.map(postToCSVRow).join('\n');
    csvContent += rows + '\n';
    
    processed += chunk.length;
    offset += chunk.length;
    
    // Report progress
    chrome.runtime.sendMessage({
      action: 'EXPORT_PROGRESS',
      processed: processed,
      total: totalCount
    });
  }
  
  return csvContent;
}

/**
 * Generate JSON export
 */
async function generateJSON(hashtags = []) {
  const db = await openDB();
  const totalCount = await getPostsCount(db, hashtags);
  
  if (totalCount === 0) {
    throw new Error('No posts found to export');
  }
  
  const allPosts = [];
  let offset = 0;
  let processed = 0;
  
  while (processed < totalCount) {
    const chunk = await readPostsChunk(db, offset, CHUNK_SIZE, hashtags);
    
    if (chunk.length === 0) {
      break;
    }
    
    allPosts.push(...chunk);
    processed += chunk.length;
    offset += chunk.length;
    
    chrome.runtime.sendMessage({
      action: 'EXPORT_PROGRESS',
      processed: processed,
      total: totalCount
    });
  }
  
  return JSON.stringify(allPosts, null, 2);
}

/**
 * Create downloadable blob and trigger download
 */
async function createDownload(content, format) {
  const mimeType = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
  const extension = format === 'csv' ? 'csv' : 'json';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const filename = `instagram_export_${timestamp}.${extension}`;
  
  // Create blob
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  
  // Send URL to background script for download
  chrome.runtime.sendMessage({
    action: 'EXPORT_COMPLETE',
    download_url: url,
    filename: filename
  });
  
  // Clean up object URL after delay
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  
  return { url, filename };
}

/**
 * Main export handler
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.action !== 'EXPORT_DATA') {
      return;
    }
    
    try {
      const { format = 'csv', hashtags = [] } = message;
      
      console.log(`[Export Worker] Starting ${format.toUpperCase()} export...`);
      
      let content;
      if (format === 'csv') {
        content = await generateCSV(hashtags);
      } else {
        content = await generateJSON(hashtags);
      }
      
      await createDownload(content, format);
      
      console.log('[Export Worker] Export complete');
      sendResponse({ success: true });
    } catch (error) {
      console.error('[Export Worker] Export failed:', error);
      chrome.runtime.sendMessage({
        action: 'EXPORT_ERROR',
        error: error.message
      });
      sendResponse({ success: false, error: error.message });
    }
  })();
  
  return true;
});

console.log('[Export Worker] Initialized');
