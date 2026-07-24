/**
 * CSV Generator Utility
 * Handles streaming CSV generation with proper escaping
 */

/**
 * Escape a field for CSV output
 * Handles commas, quotes, newlines per RFC 4180
 */
export function escapeCSVField(value) {
  if (value === null || value === undefined) {
    return '';
  }
  
  const stringValue = String(value);
  
  // If contains special characters, wrap in quotes and escape internal quotes
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n') || stringValue.includes('\r')) {
    return '"' + stringValue.replace(/"/g, '""') + '"';
  }
  
  return stringValue;
}

/**
 * Convert a post object to CSV row
 */
export function postToCSVRow(post) {
  const fields = [
    post.shortcode,
    post.id,
    (post.caption || '').replace(/\n/g, ' ').replace(/\r/g, ''),
    post.likes_count || 0,
    post.comments_count || 0,
    post.display_url || '',
    post.video_url || '',
    post.media_type || 'image',
    post.alt_text || '',
    post.is_video ? 'true' : 'false',
    post.owner_username || '',
    post.owner_id || '',
    post.owner_full_name || '',
    post.taken_at_timestamp ? new Date(post.taken_at_timestamp).toISOString() : '',
    post.location || '',
    (post.found_in_hashtags || []).join(';'),
    post.dimensions?.width || 0,
    post.dimensions?.height || 0
  ];
  
  return fields.map(escapeCSVField).join(',');
}

/**
 * Generate CSV header row
 */
export function getCSVHeader() {
  return 'shortcode,id,caption,likes,comments,display_url,video_url,media_type,alt_text,is_video,owner_username,owner_id,owner_full_name,taken_at,location,hashtags,width,height';
}

/**
 * Create CSV content with UTF-8 BOM for Excel compatibility
 * Processes posts in chunks to avoid memory issues
 */
export async function generateCSV(posts, chunkSize = 1000) {
  // UTF-8 BOM for Excel compatibility
  const BOM = '\uFEFF';
  const header = getCSVHeader();
  
  let csvContent = BOM + header + '\n';
  
  // Process in chunks
  for (let i = 0; i < posts.length; i += chunkSize) {
    const chunk = posts.slice(i, i + chunkSize);
    const rows = chunk.map(postToCSVRow).join('\n');
    csvContent += rows + '\n';
    
    // Yield to event loop to prevent blocking
    if (i % (chunkSize * 10) === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  
  return csvContent.trim();
}

/**
 * Download CSV file
 */
export function downloadCSV(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  // Clean up
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
