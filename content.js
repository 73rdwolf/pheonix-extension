/**
 * Gmail Content Script
 * Detects new emails in real-time by monitoring the Gmail UI
 */

console.log('[Gmail Content Script] Loaded on Gmail tab');

let lastUnreadCount = -1;
let observerActive = false;

/**
 * Extract unread count from Gmail's UI
 * Gmail uses various selectors depending on version, try multiple
 */
function getUnreadCount() {
    // Try multiple selectors for different Gmail versions
    const selectors = [
        // Modern Gmail - Inbox link with count
        'a[href*="#inbox"] .bsU',
        // Alternative: Element with inbox tooltip
        '[data-tooltip*="Inbox"] .bsU',
        // Fallback: Any element showing unread count in navigation
        '.aim[data-tooltip*="Inbox"] .bsU',
        // Another fallback for unread indicator
        'div[role="navigation"] a[href*="inbox"] .bsU'
    ];

    for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) {
            const text = element.textContent.trim();
            const count = parseInt(text.replace(/[^0-9]/g, ''), 10);
            if (!isNaN(count)) {
                return count;
            }
        }
    }

    // Try to get from page title (e.g., "Inbox (5) - user@gmail.com")
    const titleMatch = document.title.match(/\((\d+)\)/);
    if (titleMatch) {
        return parseInt(titleMatch[1], 10);
    }

    return 0;
}

/**
 * Check for unread count changes and notify background
 */
function checkUnreadCount() {
    const currentCount = getUnreadCount();

    // Check document title as primary source (often faster/more reliable)
    // Format: "Inbox (5) - user@gmail.com - Gmail"
    const titleMatch = document.title.match(/Inbox \((\d+)\)/);
    const titleCount = titleMatch ? parseInt(titleMatch[1], 10) : 0;

    // Use the larger of the two counts to be safe
    const finalCount = Math.max(currentCount, titleCount);

    if (lastUnreadCount === -1) {
        lastUnreadCount = finalCount;
        console.log(`[Gmail Content Script] Initial unread count: ${finalCount}`);
        return;
    }

    if (finalCount > lastUnreadCount) {
        console.log(`[Gmail Content Script] New emails detected! Count: ${lastUnreadCount} → ${finalCount}`);

        chrome.runtime.sendMessage({
            type: 'newEmailsDetected',
            previousCount: lastUnreadCount,
            currentCount: finalCount
        });
    }

    lastUnreadCount = finalCount;
}

/**
 * Initialize MutationObserver for real-time detection
 */
function initObserver() {
    if (observerActive) return;

    let debounceTimer = null;
    const DEBOUNCE_MS = 300; // Wait 300ms after last mutation before checking

    // Debounced check function
    const debouncedCheck = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            checkUnreadCount();
        }, DEBOUNCE_MS);
    };

    // Observe title changes specifically (very robust for Gmail)
    const titleObserver = new MutationObserver(debouncedCheck);
    const titleElement = document.querySelector('title');
    if (titleElement) {
        titleObserver.observe(titleElement, { childList: true });
        console.log('[Gmail Content Script] Title observer initialized');
    }

    // Observe body for other changes
    const observer = new MutationObserver(debouncedCheck);

    // Observe the entire body for changes
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    observerActive = true;
    console.log('[Gmail Content Script] DOM observer initialized');
}

/**
 * Fallback: Poll every 10 seconds in case MutationObserver misses changes
 */
function initFallbackPolling() {
    setInterval(() => {
        checkUnreadCount();
    }, 10000); // Increased from 5s to 10s for better efficiency
    console.log('[Gmail Content Script] Fallback polling initialized (10s interval)');
}

/**
 * Wait for Gmail to fully load before initializing
 */
function init() {
    // Initial check immediately
    checkUnreadCount();
    initObserver();
    initFallbackPolling();
}

// --- DASHBOARD STORAGE BRIDGE ---
// This runs on the local Dashboard file to relay settings to the extension
if (location.protocol === 'file:' && location.href.includes('index.html')) {
    console.log('[Essentials Bridge] Initializing storage sync...');

    function syncSettingsToExtension() {
        const settings = {
            theme_preference: localStorage.getItem('theme_preference'),
            accent_color: localStorage.getItem('accent_color')
        };
        chrome.storage.local.set(settings, () => {
            console.log('[Essentials Bridge] Settings synced to extension:', settings);
        });
    }

    // Initial sync
    syncSettingsToExtension();

    // Listen for custom dispatch from script.js
    window.addEventListener('essentials_settings_changed', syncSettingsToExtension);

    // Fallback: Sync on visibility change
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncSettingsToExtension();
    });
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
