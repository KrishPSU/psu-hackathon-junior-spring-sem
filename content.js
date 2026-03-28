// ─── platform detection ───────────────────────────────────────
const platform = location.hostname.includes('youtube') ? 'youtube' : 'reddit';

// ─── per-platform item selectors ─────────────────────────────
const SELECTORS = {
  youtube: 'ytd-reel-video-renderer',
  reddit:  'shreddit-post'
};

// ─── logging helper ──────────────────────────────────────────
const _ffLogs = [];
function log(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  _ffLogs.push(msg);
  console.log('[FeedFilter]', ...args);
  let el = document.getElementById('ff-debug-log');
  if (!el) {
    el = document.createElement('pre');
    el.id = 'ff-debug-log';
    el.style.display = 'none';
    document.documentElement.appendChild(el);
  }
  el.textContent = _ffLogs.slice(-80).join('\n');
}

// ─── inject CSS: hide reel completely by default ─────────────
if (platform === 'youtube') {
  const style = document.createElement('style');
  style.id = 'ff-hide-style';
  style.textContent = `
    ytd-reel-video-renderer:not([data-ff-approved]) {
      opacity: 0 !important;
      pointer-events: none !important;
    }
  `;
  document.documentElement.appendChild(style);
  log('INJECTED: hide-by-default CSS');
}

// ─── extract metadata from a DOM node ────────────────────────
function extractMetadata(node) {
  try {
    if (platform === 'youtube') {
      const title = (
        node.querySelector('yt-shorts-video-title-view-model')?.textContent?.trim() ||
        node.querySelector('h2')?.textContent?.trim() ||
        node.querySelector('#video-title')?.textContent?.trim() ||
        ''
      );
      const channelEl = node.querySelector('a[href*="/@"]');
      const channel = channelEl?.textContent?.trim() || '';
      const channelUrl = channelEl?.href || '';
      const hashtags = [...node.querySelectorAll('a[href*="hashtag"]')].map(a => a.textContent.trim());

      // Try to get description / overlay text
      const descEl = node.querySelector('#description, .description, yt-attributed-string');
      const description = descEl?.textContent?.trim() || '';

      // Try to get like count
      const likeBtn = node.querySelector('#like-button, [aria-label*="like"]');
      const likeText = likeBtn?.getAttribute('aria-label') || likeBtn?.textContent?.trim() || '';

      return { title, channel, channelUrl, hashtags, description, likeText };
    }
    if (platform === 'reddit') {
      return {
        title:      node.getAttribute('post-title') || node.querySelector('h1, h2, h3, [slot="title"]')?.textContent?.trim() || '',
        channel:    node.getAttribute('subreddit-prefixed-name') || '',
        channelUrl: '',
        hashtags:   [],
        description: '',
        likeText:   ''
      };
    }
  } catch (e) {
    log('ERROR extractMetadata:', e.message);
  }
  return null;
}

// ─── wait for metadata to appear ─────────────────────────────
function waitForMetadata(node, timeout = 4000) {
  return new Promise(resolve => {
    const check = () => {
      const item = extractMetadata(node);
      if (item && item.title) return item;
      return null;
    };
    const immediate = check();
    if (immediate) return resolve(immediate);

    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 150;
      const item = check();
      if (item) { clearInterval(interval); resolve(item); }
      else if (elapsed >= timeout) { clearInterval(interval); resolve(null); }
    }, 150);
  });
}

// ─── classify a node ─────────────────────────────────────────
async function classifyNode(node) {
  const item = await waitForMetadata(node);
  if (!item) return { item: null, result: { decision: 'SHOW', source: 'no-metadata' } };

  const prefs = await getPrefs();
  if (prefs.mode === 'off') return { item, result: { decision: 'SHOW', source: 'mode-off' } };

  // Log personalization factors being used
  log('────────────────────────────────────────');
  log('PERSONALIZATION FACTORS:');
  log('  Title:       "' + item.title + '"');
  log('  Channel:     "' + item.channel + '"');
  log('  Hashtags:    ' + (item.hashtags.length ? item.hashtags.join(', ') : '(none)'));
  log('  Description: ' + (item.description || '(none)').substring(0, 100));
  log('  Likes:       ' + (item.likeText || '(none)'));
  log('  Mode:        ' + prefs.mode);
  log('  Preferred:   ' + (prefs.preferred.join(', ') || '(none)'));
  log('  Blocked:     ' + (prefs.blocked.join(', ') || '(none)'));

  const result = await classify(item, prefs);

  const emoji = result.decision === 'BLOCK' ? 'BLOCKED' : result.decision === 'SKIP' ? 'SKIPPED' : 'APPROVED';
  log('>>> ' + emoji + ': "' + item.title + '" [via ' + result.source + '] reason: ' + (result.reason || 'n/a'));
  log('────────────────────────────────────────');

  return { item, result };
}

// ─── click the actual "Next video" button ────────────────────
function clickNextVideo() {
  const btn = document.querySelector('#navigation-button-down button') ||
              document.querySelector('button[aria-label="Next video"]');
  if (btn) {
    btn.click();
    return true;
  }
  log('WARN: could not find Next video button');
  return false;
}

// ─── wait for URL to change ──────────────────────────────────
function waitForUrlChange(timeoutMs = 3000) {
  const startUrl = location.href;
  return new Promise(resolve => {
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 80;
      if (location.href !== startUrl) {
        clearInterval(interval);
        resolve(true);
      } else if (elapsed > timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 80);
  });
}

// ─── main loop: keep skipping until approved content ─────────
let _processing = false;
const MAX_SKIPS = 25;

async function processCurrentShort() {
  if (_processing) return;
  if (!location.pathname.startsWith('/shorts')) return;
  _processing = true;

  let skips = 0;

  while (skips < MAX_SKIPS) {
    const node = document.querySelector(SELECTORS.youtube);
    if (!node) { log('WARN: no reel node found'); break; }

    // Ensure hidden while classifying
    node.removeAttribute('data-ff-approved');

    const { item, result } = await classifyNode(node);

    if (result.decision === 'SHOW') {
      // APPROVED — reveal instantly, no animation
      node.setAttribute('data-ff-approved', '');
      incrementStat('shown');
      break;
    }

    // BLOCK or SKIP — content stays hidden, immediately go next
    incrementStat(result.decision === 'BLOCK' ? 'blocked' : 'skipped');
    skips++;
    log('AUTO-SKIP #' + skips + ': navigating to next short (content hidden)');

    // Click actual navigation button
    if (!clickNextVideo()) {
      log('FALLBACK: no nav button, showing current');
      node.setAttribute('data-ff-approved', '');
      break;
    }

    // Wait for YouTube to load next video
    const changed = await waitForUrlChange();
    if (!changed) {
      log('TIMEOUT: URL did not change, showing current');
      node.setAttribute('data-ff-approved', '');
      break;
    }

    // Small wait for new metadata to populate the recycled renderer
    await new Promise(r => setTimeout(r, 300));
  }

  if (skips >= MAX_SKIPS) {
    log('HIT MAX SKIPS (' + MAX_SKIPS + '), showing current content');
    const node = document.querySelector(SELECTORS.youtube);
    if (node) node.setAttribute('data-ff-approved', '');
  }

  _processing = false;
}

// ─── intercept History API for instant response ──────────────
if (platform === 'youtube') {
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  history.pushState = function(...args) {
    origPushState(...args);
    onYouTubeNav();
  };
  history.replaceState = function(...args) {
    origReplaceState(...args);
    onYouTubeNav();
  };
  window.addEventListener('popstate', onYouTubeNav);

  function onYouTubeNav() {
    // Hide immediately on any navigation
    const node = document.querySelector(SELECTORS.youtube);
    if (node) node.removeAttribute('data-ff-approved');
    // Debounce — only process if not already processing
    if (!_processing) {
      setTimeout(() => processCurrentShort(), 400);
    }
  }
}

// ─── Reddit: remove posts from DOM ───────────────────────────
async function handleRedditPost(node) {
  if (node.dataset.ffProcessed) return;
  node.dataset.ffProcessed = 'true';

  const { item, result } = await classifyNode(node);
  if (result.decision === 'BLOCK' || result.decision === 'SKIP') {
    log('REMOVING from DOM: "' + (item?.title || 'unknown') + '"');
    node.remove();
    incrementStat(result.decision === 'BLOCK' ? 'blocked' : 'skipped');
  } else {
    incrementStat('shown');
  }
}

// ─── MutationObserver ────────────────────────────────────────
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (platform === 'reddit') {
        const sel = SELECTORS.reddit;
        if (node.matches?.(sel)) handleRedditPost(node);
        else node.querySelectorAll?.(sel).forEach(handleRedditPost);
      }
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// ─── initial load ────────────────────────────────────────────
if (platform === 'youtube') {
  setTimeout(() => processCurrentShort(), 1500);
} else {
  document.querySelectorAll(SELECTORS.reddit).forEach(handleRedditPost);
}

log('LOADED: Feed Filter on ' + platform);
