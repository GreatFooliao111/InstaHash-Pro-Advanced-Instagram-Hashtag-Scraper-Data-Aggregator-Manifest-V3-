/**
 * IDB Database Manager using idb library
 * Handles all IndexedDB operations with proper transaction management
 * Primary Key: post shortcode (ensures 100% deduplication)
 */

import { openDB } from 'https://cdn.jsdelivr.net/npm/idb@8.0.0/+esm';

const DB_NAME = 'instagram-scraper-db';
const DB_VERSION = 1;
const STORE_NAME = 'posts';

/**
 * Initialize the database with proper schema
 * Uses shortcode as keyPath for automatic deduplication
 * found_in_hashtags array tracks which hashtags a post appeared in
 */
export async function initDB() {
  return await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Create object store with shortcode as primary key
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'shortcode' });
        
        // Indexes for efficient querying
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('likes', 'likes_count');
        store.createIndex('comments', 'comments_count');
        store.createIndex('owner', 'owner_username');
        store.createIndex('hashtags', 'found_in_hashtags', { multiEntry: true });
      }
    },
  });
}

/**
 * Get or create database connection (singleton pattern)
 */
let dbInstance = null;

export async function getDB() {
  if (!dbInstance) {
    dbInstance = await initDB();
  }
  return dbInstance;
}

/**
 * Upsert a post - handles deduplication automatically
 * If post exists, merges found_in_hashtags array
 * @param {Object} post - Post data with shortcode as primary key
 * @param {string} currentHashtag - Hashtag this post was found under
 */
export async function upsertPost(post, currentHashtag) {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  
  try {
    const existing = await tx.store.get(post.shortcode);
    
    if (existing) {
      // Merge found_in_hashtags if not already present
      if (!existing.found_in_hashtags.includes(currentHashtag)) {
        existing.found_in_hashtags.push(currentHashtag);
      }
      // Update timestamp
      existing.last_updated = Date.now();
      await tx.store.put(existing);
    } else {
      // New post - initialize found_in_hashtags
      post.found_in_hashtags = [currentHashtag];
      post.timestamp = Date.now();
      post.last_updated = Date.now();
      await tx.store.put(post);
    }
    
    await tx.done;
    return true;
  } catch (error) {
    console.error('Error upserting post:', error);
    throw error;
  }
}

/**
 * Bulk upsert posts with proper transaction handling
 * @param {Array} posts - Array of post objects
 * @param {string} currentHashtag - Current hashtag being scraped
 */
export async function bulkUpsertPosts(posts, currentHashtag) {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  
  try {
    for (const post of posts) {
      const existing = await tx.store.get(post.shortcode);
      
      if (existing) {
        if (!existing.found_in_hashtags.includes(currentHashtag)) {
          existing.found_in_hashtags.push(currentHashtag);
        }
        existing.last_updated = Date.now();
        await tx.store.put(existing);
      } else {
        post.found_in_hashtags = [currentHashtag];
        post.timestamp = Date.now();
        post.last_updated = Date.now();
        await tx.store.put(post);
      }
    }
    
    await tx.done;
    return posts.length;
  } catch (error) {
    console.error('Error bulk upserting posts:', error);
    throw error;
  }
}

/**
 * Get all posts count
 */
export async function getPostsCount() {
  const db = await getDB();
  return await db.count(STORE_NAME);
}

/**
 * Get posts in chunks for streaming export
 * @param {number} offset - Starting offset
 * @param {number} limit - Number of records to fetch
 */
export async function getPostsChunk(offset = 0, limit = 1000) {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  
  // Use cursor for efficient chunked reading
  const results = [];
  let count = 0;
  let skip = offset;
  
  await tx.store.iterate((value) => {
    if (skip > 0) {
      skip--;
      return;
    }
    if (count >= limit) {
      return;
    }
    results.push(value);
    count++;
  });
  
  return results;
}

/**
 * Get all posts matching specific hashtags
 * @param {Array} hashtags - Array of hashtags to filter by
 */
export async function getPostsByHashtags(hashtags) {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const index = tx.store.index('hashtags');
  
  const results = [];
  for (const hashtag of hashtags) {
    const matches = await index.getAll(hashtag);
    results.push(...matches);
  }
  
  // Deduplicate by shortcode
  const unique = new Map();
  results.forEach(post => {
    if (!unique.has(post.shortcode)) {
      unique.set(post.shortcode, post);
    }
  });
  
  return Array.from(unique.values());
}

/**
 * Clear all posts from database
 */
export async function clearAllPosts() {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  await tx.store.clear();
  await tx.done;
}

/**
 * Delete posts by shortcode
 * @param {Array} shortcodes - Array of shortcodes to delete
 */
export async function deletePosts(shortcodes) {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  
  for (const shortcode of shortcodes) {
    await tx.store.delete(shortcode);
  }
  
  await tx.done;
}

/**
 * Export database stats
 */
export async function getDBStats() {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  
  const count = await tx.store.count();
  
  // Get unique hashtags
  const allHashtags = new Set();
  await tx.store.iterate((post) => {
    post.found_in_hashtags.forEach(h => allHashtags.add(h));
  });
  
  return {
    total_posts: count,
    unique_hashtags: allHashtags.size,
    hashtags: Array.from(allHashtags)
  };
}
