/**
 * MAIN World Script for Network Interception
 * CRITICAL: This runs in the MAIN world to intercept Instagram's native fetch/XHR calls
 * Content scripts run in ISOLATED world and CANNOT intercept page's network requests
 * 
 * Architecture:
 * 1. Override window.fetch to capture GraphQL responses
 * 2. Parse response data for hashtag media
 * 3. Send intercepted data to content script via window.postMessage
 */

(function() {
  'use strict';

  // Store original fetch
  const originalFetch = window.fetch;

  /**
   * Regex patterns to identify Instagram GraphQL endpoints dynamically
   * We don't hardcode endpoint names as they can change
   */
  const GRAPHQL_PATTERNS = [
    /\/graphql\/query/,
    /\/api\/graphql/,
    /\/questions\/.+/,
  ];

  /**
   * Check if URL matches Instagram GraphQL patterns
   */
  function isInstagramGraphQL(url) {
    return url.includes('instagram.com') && 
           GRAPHQL_PATTERNS.some(pattern => pattern.test(url));
  }

  /**
   * Parse GraphQL response to extract hashtag media data
   * Uses structural analysis rather than hardcoded endpoint names
   */
  function parseHashtagData(data) {
    if (!data || typeof data !== 'object') return null;

    // Look for edge_hashtag_to_media or similar structures
    // Instagram's response structure is consistent even if endpoint names change
    const findMediaEdge = (obj) => {
      if (!obj || typeof obj !== 'object') return null;
      
      // Direct match for hashtag media edge
      if (obj.edge_hashtag_to_media) {
        return obj.edge_hashtag_to_media;
      }
      
      // Recursive search through object
      for (const key of Object.keys(obj)) {
        if (key.includes('edge_hashtag')) {
          return obj[key];
        }
        if (key === 'edge_sidecar_to_children' && obj[key]?.edges) {
          // This is a carousel post, handle separately
          return obj[key];
        }
      }
      
      return null;
    };

    const mediaEdge = findMediaEdge(data);
    
    if (!mediaEdge || !mediaEdge.edges) {
      return null;
    }

    // Extract page_info for pagination
    const pageInfo = mediaEdge.page_info || {};
    
    // Extract edges (actual posts)
    const edges = mediaEdge.edges || [];
    
    // Parse each edge into standardized format
    const posts = edges.map(edge => {
      const node = edge.node;
      if (!node) return null;

      // Extract owner info safely
      const owner = node.owner || {};
      
      // Extract display resources
      const displayUrl = node.display_url || '';
      const videoUrl = node.video_url || null;
      
      // Extract engagement metrics
      const likesCount = node.edge_liked_by?.count || node.likes_count || 0;
      const commentsCount = node.edge_media_to_comment?.count || node.comments_count || 0;
      
      // Extract caption from edge_media_to_caption
      let caption = '';
      if (node.edge_media_to_caption?.edges?.[0]?.node?.text) {
        caption = node.edge_media_to_caption.edges[0].node.text;
      }
      
      // Extract alt text
      const altText = node.accessibility_caption || '';
      
      // Determine media type
      let mediaType = 'image';
      if (node.is_video) {
        mediaType = 'video';
      } else if (node.edge_sidecar_to_children) {
        mediaType = 'carousel';
      }
      
      // Extract carousel media if present
      const carouselMedia = [];
      if (node.edge_sidecar_to_children?.edges) {
        node.edge_sidecar_to_children.edges.forEach(childEdge => {
          const childNode = childEdge.node;
          if (childNode) {
            carouselMedia.push({
              display_url: childNode.display_url || '',
              is_video: childNode.is_video || false,
              video_url: childNode.video_url || null
            });
          }
        });
      }

      return {
        shortcode: node.shortcode || '',
        id: node.id || '',
        caption: caption,
        likes_count: likesCount,
        comments_count: commentsCount,
        display_url: displayUrl,
        video_url: videoUrl,
        media_type: mediaType,
        carousel_media: carouselMedia,
        alt_text: altText,
        is_video: node.is_video || false,
        taken_at_timestamp: node.taken_at_timestamp || Date.now(),
        location: node.location?.name || '',
        owner_username: owner.username || '',
        owner_id: owner.id || '',
        owner_full_name: owner.full_name || '',
        owner_profile_pic_url: owner.profile_pic_url || '',
        dimensions: {
          height: node.dimensions?.height || 0,
          width: node.dimensions?.width || 0
        }
      };
    }).filter(Boolean);

    if (posts.length === 0) {
      return null;
    }

    return {
      posts: posts,
      has_next_page: pageInfo.has_next_page || false,
      end_cursor: pageInfo.end_cursor || null
    };
  }

  /**
   * Override fetch to intercept Instagram GraphQL calls
   */
  window.fetch = async function(...args) {
    const [resource, options] = args;
    const url = typeof resource === 'string' ? resource : resource.url;

    // Only intercept Instagram GraphQL calls
    if (isInstagramGraphQL(url)) {
      try {
        const response = await originalFetch.apply(this, args);
        
        // Clone response to read body without consuming it
        const clonedResponse = response.clone();
        
        try {
          const jsonData = await clonedResponse.json();
          
          // Try to parse as hashtag data
          const parsedData = parseHashtagData(jsonData.data || jsonData);
          
          if (parsedData && parsedData.posts.length > 0) {
            // Send intercepted data to content script
            window.postMessage({
              type: 'INSTAGRAM_SCRAPER_DATA',
              source: 'main-world-interceptor',
              data: parsedData,
              timestamp: Date.now()
            }, '*');
          }
        } catch (e) {
          // Not JSON or parsing failed, ignore
        }
        
        return response;
      } catch (error) {
        console.error('Fetch interception error:', error);
        return originalFetch.apply(this, args);
      }
    }

    // Pass through non-Instagram calls
    return originalFetch.apply(this, args);
  };

  /**
   * Also intercept XMLHttpRequest for older Instagram API calls
   */
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._scraper_url = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    const xhr = this;
    const url = this._scraper_url;

    if (url && isInstagramGraphQL(url)) {
      this.addEventListener('load', function() {
        try {
          const jsonData = JSON.parse(this.responseText);
          const parsedData = parseHashtagData(jsonData.data || jsonData);
          
          if (parsedData && parsedData.posts.length > 0) {
            window.postMessage({
              type: 'INSTAGRAM_SCRAPER_DATA',
              source: 'xhr-interceptor',
              data: parsedData,
              timestamp: Date.now()
            }, '*');
          }
        } catch (e) {
          // Not JSON or parsing failed
        }
      });
    }

    return originalXHRSend.apply(this, args);
  };

  console.log('[Instagram Scraper] Main world injection successful');
})();
