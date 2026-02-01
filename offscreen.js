/**
 * Offscreen script for audio playback
 * Listens for messages from the background script
 */

console.log('[Offscreen] Offscreen document loaded');

// ============================================
// Browser Theme Detection
// ============================================
function detectAndSendTheme() {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = isDark ? 'dark' : 'light';
    console.log('[Offscreen] Browser theme detected:', theme);

    chrome.runtime.sendMessage({
        type: 'THEME_DETECTED',
        theme: theme
    }).catch(() => {
        // Silent failure for theme updates
    });
}

// Detect theme on load
detectAndSendTheme();

// Listen for theme changes
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkModeQuery.addEventListener('change', (e) => {
    console.log('[Offscreen] Browser theme changed');
    detectAndSendTheme();
});

// Listen for messages from background.js
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (msg.type === 'play-sound') {
        console.log('[Offscreen] Playing notification sound');
        await playSound(msg.source);
        sendResponse(true);
        return true;
    }
});

async function playSound(source) {
    try {
        const audio = new Audio(source);
        audio.volume = 1.0;
        await audio.play();
        console.log('[Offscreen] Audio played successfully');
    } catch (e) {
        console.error('[Offscreen] Audio playback failed:', e);
    }
}

// Note: High-frequency polling removed for battery optimization.
// The 30-second chrome.alarm + content script MutationObserver
// provides sufficient real-time email detection.
