# 📸 Instagram Hashtag Scraper Pro

Enterprise-grade Chrome Extension (Manifest V3) for scraping Instagram hashtag data with deduplication, circuit breaker protection, and optimized CSV/JSON export.

## ⚡ Quick Start

### Installation

1. **Clone or download** this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer Mode** (toggle in top-right corner)
4. Click **"Load unpacked"**
5. Select the folder containing this extension
6. The extension icon should appear in your toolbar

### Basic Usage

1. **Click the extension icon** to open the popup
2. **Enter a hashtag** (without the # symbol) in the input field
3. Click **"Add to Queue"**
4. Navigate to any Instagram page - the extension will automatically open/switch to Instagram
5. Watch the scraping progress in real-time
6. Click **"Export Data"** to download your scraped posts as CSV or JSON

## 🏗️ Architecture Overview

This extension follows strict Manifest V3 guidelines with a modular, production-ready architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                     USER INTERFACE                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Popup     │  │   Options   │  │   Content Script    │ │
│  │  (popup.js) │  │ (options.js)│  │  (content-script.js)│ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  BACKGROUND SERVICE WORKER                   │
│  • Queue Management    • State Coordination                 │
│  • Message Routing     • Offscreen Document Control         │
│  (NO infinite loops - MV3 compliant!)                       │
└─────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │ MAIN WORLD   │ │  OFFSCREEN   │ │  INDEXEDDB   │
    │ INTERCEPTOR  │ │   EXPORTER   │ │   DATABASE   │
    │ (fetch/XHR)  │ │  (CSV/JSON)  │ │  (idb lib)   │
    └──────────────┘ └──────────────┘ └──────────────┘
```

## 📁 Project Structure

```
instagram-scraper/
├── manifest.json              # MV3 manifest with all permissions
├── src/
│   ├── background/
│   │   └── service-worker.js  # Service worker (no setInterval!)
│   ├── content/
│   │   ├── content-script.js  # DOM interaction & scroll controller
│   │   └── content-script-enhanced.js  # Enhanced anti-detection version
│   ├── injected/
│   │   └── main-world.js      # Network interception (MAIN world)
│   ├── db/
│   │   └── database.js        # IndexedDB with idb library
│   ├── offscreen/
│   │   ├── export-worker.html # Offscreen document for exports
│   │   └── export-worker.js   # Streaming CSV/JSON generation
│   ├── ui/
│   │   ├── popup.html         # Main popup interface
│   │   ├── popup.js           # Popup logic
│   │   ├── options.html       # Settings page
│   │   └── options.js         # Options logic
│   └── utils/
│       ├── csv-generator.js   # CSV utilities with BOM
│       ├── state-manager.js   # State persistence helpers
│       └── analytics.js       # Advanced data analytics *(NEW)*
├── icons/                     # Extension icons
└── README.md                  # This file
```

## 🔑 Key Features

### 1. Manifest V3 Compliance ✅

- **No infinite loops in background**: Scrolling logic runs in Content Script
- **Proper state management**: Uses `chrome.storage.session` for ephemeral state
- **Offscreen documents**: Heavy export operations run in isolated context
- **Service Worker lifecycle**: Handles termination gracefully

### 2. Network Interception 🌐

- **Main World injection**: Fetch/XHR override runs in MAIN world (not isolated)
- **Dynamic endpoint detection**: Uses regex patterns, not hardcoded URLs
- **Structural parsing**: Identifies data by JSON structure (`edge_hashtag_to_media`)
- **Resilient to API changes**: Works even if Instagram changes endpoint names

### 3. Database & Deduplication 💾

- **IndexedDB with idb**: Promise-based wrapper prevents transaction errors
- **Shortcode as primary key**: Ensures 100% deduplication at database level
- **found_in_hashtags array**: Tracks which hashtags each post appeared in
- **Efficient indexing**: Multiple indexes for fast queries

### 4. Advanced Anti-Detection 🛡️

#### Circuit Breaker Pattern
- **Automatic pause** after 3 consecutive failures
- **5-minute cooldown** before allowing retry
- **State persistence** survives page reloads

#### Human-Like Behavior
- **Mouse movement simulation**: Random cursor movements before scrolling
- **Variable scroll acceleration**: Ease-in/out scroll animations
- **Random idle times**: 0.5-2 second pauses between actions
- **Viewport visibility checks**: Detects empty content grids

#### Enhanced CAPTCHA Detection
- **Text analysis**: Monitors for rate limit keywords
- **URL monitoring**: Detects challenge/checkpoint redirects
- **Visual analysis**: Checks for empty loading states
- **Shadow ban detection**: Identifies suspicious content blocks

### 5. Memory-Safe Export 📊

- **Chunked processing**: Reads 1000 records at a time from IndexedDB
- **Never loads all data**: Prevents Out-Of-Memory crashes on large datasets
- **UTF-8 BOM**: Prepends `\uFEFF` for proper Excel character encoding
- **Streaming approach**: Builds CSV incrementally, not in one massive string

### 6. Advanced Analytics 📈 *(NEW)*

- **Engagement rate calculation**: (likes + comments) / follower proxy
- **Hashtag performance metrics**: Avg engagement per hashtag
- **Owner influence scoring**: Ranks users by engagement consistency
- **Optimal posting times**: Analyzes peak hours and days
- **Media type distribution**: Image vs video vs carousel breakdown

## 📊 Extracted Data Fields

Each post includes:

| Field | Description |
|-------|-------------|
| `shortcode` | Unique post identifier (primary key) |
| `id` | Instagram's internal ID |
| `caption` | Post caption text |
| `likes_count` | Number of likes |
| `comments_count` | Number of comments |
| `display_url` | Main image/video URL |
| `video_url` | Video URL (if applicable) |
| `media_type` | image / video / carousel |
| `alt_text` | Accessibility caption |
| `is_video` | Boolean flag |
| `owner_username` | Poster's username |
| `owner_id` | Poster's ID |
| `owner_full_name` | Poster's display name |
| `taken_at` | Post timestamp (ISO 8601) |
| `location` | Tagged location name |
| `hashtags` | Which hashtags this post appeared in |
| `width` | Media width in pixels |
| `height` | Media height in pixels |

## ⚙️ Configuration

Access the Options page to customize:

- **Max Posts per Hashtag**: Limit scraping depth (default: 1000)
- **Scroll Delay**: Human-like delay between scrolls (default: 1500ms)
- **Export Format**: CSV or JSON (default: CSV)
- **Auto-Export**: Automatically export when scraping completes

## 🔒 Privacy & Security

- **No external servers**: All data stored locally in IndexedDB
- **No tracking**: Extension doesn't collect or transmit user data
- **Instagram ToS**: Use responsibly and respect Instagram's Terms of Service
- **Rate limiting**: Built-in circuit breaker prevents aggressive scraping

## 🐛 Troubleshooting

### "Circuit breaker triggered" message

**Cause**: Instagram detected unusual activity or returned errors 3 times consecutively.

**Solution**:
1. Wait 5 minutes for the cooldown period
2. Click "Resume Scraping" in the popup
3. Consider increasing the scroll delay in settings

### No data being collected

**Possible causes**:
1. Not logged into Instagram (some content requires login)
2. Instagram changed their GraphQL structure
3. You're being rate-limited

**Solutions**:
1. Ensure you're logged in to Instagram
2. Check browser console for errors
3. Try a different hashtag or wait before retrying

### Export fails or produces empty file

**Cause**: No posts in database or export process interrupted.

**Solution**:
1. Check the Statistics section to confirm data exists
2. Refresh the popup and try again
3. Try JSON format instead of CSV

## 🧪 Development

### Testing the Extension

1. Open `chrome://extensions/` and enable Developer Mode
2. Click "Reload" after making code changes
3. Open the popup DevTools (right-click → Inspect) for debugging
4. Check Service Worker logs in `chrome://extensions/` → Inspect views: Service Worker

### Using Enhanced Anti-Detection

For maximum stealth, you can replace the default content script with the enhanced version:

```javascript
// In manifest.json, change:
"js": ["src/content/content-script.js"]

// To:
"js": ["src/content/content-script-enhanced.js"]
```

The enhanced version includes:
- Mouse movement simulation
- Variable scroll acceleration (ease-in/out)
- Random idle times between actions
- Enhanced CAPTCHA detection with visual analysis

### Building for Production

```bash
# Zip the extension for distribution
zip -r instagram-scraper.zip \
  manifest.json \
  src/ \
  icons/
```

### Code Quality

- All files use ES6+ modules
- Comprehensive JSDoc comments
- Error handling on all async operations
- No inline event handlers

## 📝 License

MIT License - Feel free to use and modify for your projects.

## ⚠️ Disclaimer

This extension is for educational purposes. Always respect:
- Instagram's Terms of Service
- Website robots.txt files
- Rate limits and server resources
- Copyright and intellectual property rights

Use responsibly and ethically.

## 🤝 Contributing

Contributions welcome! Please ensure:
- Code follows existing patterns
- All functions have JSDoc comments
- No breaking changes to existing APIs
- Test thoroughly before submitting

---

**Built with ❤️ following Manifest V3 best practices**
