/**
 * Advanced Data Analytics Module
 * 
 * Provides real-time analytics on scraped data:
 * - Engagement rate calculations
 * - Hashtag performance metrics
 * - Owner influence scoring
 * - Time-based posting patterns
 * - Media type distribution
 */

/**
 * Calculate engagement rate for a post
 * Formula: (likes + comments) / followers * 100
 * Note: We use likes as proxy for followers when unavailable
 */
export function calculateEngagementRate(post) {
  const likes = post.likes_count || 0;
  const comments = post.comments_count || 0;
  
  // Use owner's average likes as follower proxy if available
  const followerProxy = post.owner_avg_likes || Math.max(likes, 1);
  
  const engagement = ((likes + comments) / followerProxy) * 100;
  return parseFloat(engagement.toFixed(2));
}

/**
 * Analyze hashtag performance across all posts
 */
export async function analyzeHashtagPerformance(db, hashtags = []) {
  const tx = db.transaction('posts', 'readonly');
  const store = tx.objectStore('posts');
  const hashtagIndex = store.index('hashtags');
  
  const results = {};
  
  for (const hashtag of hashtags) {
    const posts = await new Promise((resolve, reject) => {
      const request = hashtagIndex.getAll(hashtag);
      request.onsuccess = () => resolve(request.result);
      request.onerror = reject;
    });
    
    if (posts.length === 0) continue;
    
    // Calculate metrics
    const totalLikes = posts.reduce((sum, p) => sum + (p.likes_count || 0), 0);
    const totalComments = posts.reduce((sum, p) => sum + (p.comments_count || 0), 0);
    const avgLikes = totalLikes / posts.length;
    const avgComments = totalComments / posts.length;
    
    // Media type distribution
    const mediaTypes = { image: 0, video: 0, carousel: 0 };
    posts.forEach(p => {
      mediaTypes[p.media_type || 'image']++;
    });
    
    // Time distribution (hour of day)
    const hourDistribution = new Array(24).fill(0);
    posts.forEach(p => {
      if (p.taken_at_timestamp) {
        const hour = new Date(p.taken_at_timestamp).getHours();
        hourDistribution[hour]++;
      }
    });
    
    // Best performing hour
    const bestHour = hourDistribution.indexOf(Math.max(...hourDistribution));
    
    results[hashtag] = {
      total_posts: posts.length,
      avg_likes: parseFloat(avgLikes.toFixed(2)),
      avg_comments: parseFloat(avgComments.toFixed(2)),
      engagement_rate: parseFloat(((avgLikes + avgComments) / Math.max(avgLikes, 1) * 100).toFixed(2)),
      media_distribution: mediaTypes,
      best_posting_hour: bestHour,
      top_posts: posts
        .sort((a, b) => (b.likes_count + b.comments_count) - (a.likes_count + a.comments_count))
        .slice(0, 5)
        .map(p => ({
          shortcode: p.shortcode,
          likes: p.likes_count,
          comments: p.comments_count
        }))
    };
  }
  
  return results;
}

/**
 * Calculate owner influence score based on their posts
 */
export function calculateOwnerInfluence(posts) {
  if (!posts || posts.length === 0) return null;
  
  const groupedByOwner = posts.reduce((acc, post) => {
    const owner = post.owner_username || 'unknown';
    if (!acc[owner]) {
      acc[owner] = [];
    }
    acc[owner].push(post);
    return acc;
  }, {});
  
  const influenceScores = [];
  
  for (const [owner, ownerPosts] of Object.entries(groupedByOwner)) {
    const totalLikes = ownerPosts.reduce((sum, p) => sum + (p.likes_count || 0), 0);
    const totalComments = ownerPosts.reduce((sum, p) => sum + (p.comments_count || 0), 0);
    const avgLikes = totalLikes / ownerPosts.length;
    const avgComments = totalComments / ownerPosts.length;
    
    // Influence score formula:
    // (avg_engagement * post_count_consistency * recency_bonus)
    const avgEngagement = avgLikes + avgComments;
    const consistencyBonus = Math.min(ownerPosts.length, 10) * 0.1;
    
    // Recency bonus (posts from last 30 days get bonus)
    const recentPosts = ownerPosts.filter(p => {
      const postDate = new Date(p.taken_at_timestamp || 0);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      return postDate > thirtyDaysAgo;
    }).length;
    const recencyBonus = recentPosts * 0.05;
    
    const influenceScore = (avgEngagement * (1 + consistencyBonus + recencyBonus)).toFixed(2);
    
    influenceScores.push({
      owner_username: owner,
      owner_id: ownerPosts[0]?.owner_id || '',
      post_count: ownerPosts.length,
      avg_likes: parseFloat(avgLikes.toFixed(2)),
      avg_comments: parseFloat(avgComments.toFixed(2)),
      influence_score: parseFloat(influenceScore),
      recent_activity: recentPosts
    });
  }
  
  // Sort by influence score
  return influenceScores.sort((a, b) => b.influence_score - a.influence_score);
}

/**
 * Detect optimal posting times based on high-engagement posts
 */
export function detectOptimalPostingTimes(posts, topPercentile = 0.2) {
  if (!posts || posts.length === 0) return null;
  
  // Sort posts by engagement
  const sortedByEngagement = [...posts].sort((a, b) => {
    const engagementA = (a.likes_count || 0) + (a.comments_count || 0);
    const engagementB = (b.likes_count || 0) + (b.comments_count || 0);
    return engagementB - engagementA;
  });
  
  // Take top X% performing posts
  const topCount = Math.max(1, Math.floor(posts.length * topPercentile));
  const topPosts = sortedByEngagement.slice(0, topCount);
  
  // Analyze time patterns
  const hourCounts = new Array(24).fill(0);
  const dayCounts = new Array(7).fill(0); // 0 = Sunday
  
  topPosts.forEach(post => {
    if (post.taken_at_timestamp) {
      const date = new Date(post.taken_at_timestamp);
      hourCounts[date.getHours()]++;
      dayCounts[date.getDay()]++;
    }
  });
  
  // Find peak hours
  const peakHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(h => h.hour);
  
  // Find peak days
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const peakDays = dayCounts
    .map((count, day) => ({ day: dayNames[day], count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(d => d.day);
  
  return {
    peak_hours: peakHours,
    peak_days: peakDays,
    total_analyzed: topPosts.length
  };
}

/**
 * Generate comprehensive analytics report
 */
export async function generateAnalyticsReport(db, hashtags = []) {
  try {
    const tx = db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    
    // Get all posts or filter by hashtags
    let allPosts = [];
    
    if (hashtags.length === 0) {
      await new Promise((resolve, reject) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            allPosts.push(cursor.value);
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorRequest.onerror = reject;
      });
    } else {
      const hashtagIndex = store.index('hashtags');
      for (const hashtag of hashtags) {
        const posts = await new Promise((resolve, reject) => {
          const request = hashtagIndex.getAll(hashtag);
          request.onsuccess = () => resolve(request.result);
          request.onerror = reject;
        });
        allPosts.push(...posts);
      }
      
      // Deduplicate by shortcode
      const uniqueMap = new Map();
      allPosts.forEach(p => {
        if (!uniqueMap.has(p.shortcode)) {
          uniqueMap.set(p.shortcode, p);
        }
      });
      allPosts = Array.from(uniqueMap.values());
    }
    
    if (allPosts.length === 0) {
      return { error: 'No posts found' };
    }
    
    // Calculate overall metrics
    const totalLikes = allPosts.reduce((sum, p) => sum + (p.likes_count || 0), 0);
    const totalComments = allPosts.reduce((sum, p) => sum + (p.comments_count || 0), 0);
    const avgLikes = totalLikes / allPosts.length;
    const avgComments = totalComments / allPosts.length;
    
    // Media type distribution
    const mediaDistribution = { image: 0, video: 0, carousel: 0 };
    allPosts.forEach(p => {
      mediaDistribution[p.media_type || 'image']++;
    });
    
    // Unique owners
    const uniqueOwners = new Set(allPosts.map(p => p.owner_username).filter(Boolean));
    
    // Date range
    const timestamps = allPosts
      .map(p => p.taken_at_timestamp)
      .filter(Boolean)
      .sort((a, b) => a - b);
    
    const oldestPost = timestamps[0] ? new Date(timestamps[0]).toISOString() : 'N/A';
    const newestPost = timestamps[timestamps.length - 1] 
      ? new Date(timestamps[timestamps.length - 1]).toISOString() 
      : 'N/A';
    
    // Top performing posts
    const topPosts = [...allPosts]
      .sort((a, b) => {
        const engagementA = (a.likes_count || 0) + (a.comments_count || 0);
        const engagementB = (b.likes_count || 0) + (b.comments_count || 0);
        return engagementB - engagementA;
      })
      .slice(0, 10)
      .map(p => ({
        shortcode: p.shortcode,
        caption: (p.caption || '').slice(0, 100),
        likes: p.likes_count,
        comments: p.comments_count,
        media_type: p.media_type,
        owner: p.owner_username
      }));
    
    // Influencer analysis
    const influencers = calculateOwnerInfluence(allPosts);
    
    // Optimal posting times
    const optimalTimes = detectOptimalPostingTimes(allPosts);
    
    return {
      summary: {
        total_posts: allPosts.length,
        total_likes: totalLikes,
        total_comments: totalComments,
        avg_likes: parseFloat(avgLikes.toFixed(2)),
        avg_comments: parseFloat(avgComments.toFixed(2)),
        unique_owners: uniqueOwners.size,
        date_range: {
          oldest: oldestPost,
          newest: newestPost
        }
      },
      media_distribution: mediaDistribution,
      top_posts: topPosts,
      top_influencers: influencers.slice(0, 10),
      optimal_posting_times: optimalTimes,
      generated_at: new Date().toISOString()
    };
  } catch (error) {
    console.error('Failed to generate analytics:', error);
    return { error: error.message };
  }
}

/**
 * Export analytics report as JSON
 */
export function exportAnalyticsReport(report) {
  const jsonStr = JSON.stringify(report, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = `instagram_analytics_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
