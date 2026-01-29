/**
 * Background Service Worker for Gmail Real-time Notifications
 * Features:
 * - 30-second polling with chrome.alarms
 * - Incremental sync using Gmail historyId
 * - Rich notifications with Archive/Delete actions
 * - Token refresh on 401 errors
 * - Real-time detection via content script messages
 */

console.log('[Background] Service worker initialized');

// ============================================
// Offscreen Document Management
// ============================================
async function hasOffscreenDocument(path) {
    if ('getContexts' in chrome.runtime) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [path]
        });
        return contexts.length > 0;
    } else {
        const matchedClients = await clients.matchAll();
        return matchedClients.some(client =>
            client.url.includes(chrome.runtime.getURL(path))
        );
    }
}

async function setupOffscreenDocument(path) {
    if (!(await hasOffscreenDocument(path))) {
        if (creating) {
            await creating;
        } else {
            creating = chrome.offscreen.createDocument({
                url: path,
                reasons: ['AUDIO_PLAYBACK'],
                justification: 'Notification sound playback',
            });
            await creating;
            creating = null;
        }
    }
}

let creating; // Singleton promise for offscreen creation
// Token Snatcher Logic
function snatchTokenFromUrl(urlStr, tabId) {
    if (!urlStr) return false;

    // LOG EVERY URL CHECKED FOR DEBUGGING
    if (urlStr.includes("chromiumapp.org")) {
        console.log(`[Snatcher DEBUG] Checking URL: ${urlStr}`);
    }

    const tokenMatch = urlStr.match(/[#?&]access_token=([^&]+)/);
    const token = tokenMatch ? tokenMatch[1] : null;

    if (token) {
        console.log("[Background] Token Snatcher: !!! TOKEN DETECTED !!!");
        stopScavenger();

        // Set persistent flag and logged-in state for forever login
        const authTimestamp = Date.now();
        // Google access tokens typically expire in 3600 seconds (1 hour)
        const tokenExpiryTime = authTimestamp + (3500 * 1000);
        chrome.storage.local.set({
            "google_access_token": token,
            "isLoggedIn": true,
            "google_user_persistent": true,
            "google_auth_timestamp": authTimestamp,
            "google_token_expiry": tokenExpiryTime
        }, () => {
            console.log(`[Background] Token Snatcher: Token saved. Expiry: ${new Date(tokenExpiryTime).toISOString()}`);

            if (tabId) {
                chrome.tabs.remove(tabId).catch(err => console.error("[Snatcher] Failed to close tab:", err));
            }

            chrome.runtime.sendMessage({ type: "token_captured", token: token }).catch(() => { });
            initializeHistoryId(token);
        });
        return true;
    }
    return false;
}

let scavengerInterval = null;
let scavengerTimeout = null;

function stopScavenger() {
    if (scavengerInterval) {
        clearInterval(scavengerInterval);
        scavengerInterval = null;
        console.log("[Background] Token Scavenger: Stopped polling.");
    }
    if (scavengerTimeout) {
        clearTimeout(scavengerTimeout);
        scavengerTimeout = null;
    }
}

function startScavenger() {
    stopScavenger(); // Reset if already running
    console.log("[Background] Token Scavenger: Started active polling (500ms)...");

    scavengerInterval = setInterval(async () => {
        try {
            const tabs = await chrome.tabs.query({});
            console.log(`[Scavenger] Scanning ${tabs.length} tabs...`);
            for (const tab of tabs) {
                const urlToCheck = tab.url || tab.pendingUrl;
                if (urlToCheck) {
                    console.log(` - Checking tab ${tab.id}: ${urlToCheck.substring(0, 60)}...`);
                    if (snatchTokenFromUrl(urlToCheck, tab.id)) {
                        console.log("[Background] Token Scavenger: SUCCESS!");
                        return; // snatchTokenFromUrl calls stopScavenger()
                    }
                }
            }
        } catch (e) {
            console.error("[Background] Scavenger error:", e);
        }
    }, 1000);

    // Auto-stop after 2 minutes to save resources
    scavengerTimeout = setTimeout(() => {
        if (scavengerInterval) {
            console.warn("[Background] Token Scavenger: Timeout reached, stopping.");
            stopScavenger();
        }
    }, 120000);
}

// Listen for scavenger start signal
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'START_TOKEN_SCAVENGER') {
        startScavenger();
    }
});

// 1. Monitor tab updates (Standard backup)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    snatchTokenFromUrl(changeInfo.url || tab.url, tabId);
});

// 2. Monitor navigation (More robust for "instant" redirects)
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
    if (details.frameId === 0) { // Only main frame
        snatchTokenFromUrl(details.url, details.tabId);
    }
});

chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) {
        snatchTokenFromUrl(details.url, details.tabId);
    }
});

// 3. Monitor fragment updates
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.frameId === 0) snatchTokenFromUrl(details.url, details.tabId);
});

// 4. Monitor Errors (Crucial for DNS failures)
chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId === 0) {
        console.log("[Background] Snatcher: Caught error page. Checking URL...");
        snatchTokenFromUrl(details.url, details.tabId);
    }
});

// 5. Monitor History changes
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) snatchTokenFromUrl(details.url, details.tabId);
});

// 3. Monitor fragment updates (Crucial for #access_token redirects)
chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
    if (details.frameId === 0) {
        console.log("[Background] Token Snatcher: Fragment updated, checking URL...");
        snatchTokenFromUrl(details.url, details.tabId);
    }
});

// ============================================
// First Install Detection & Initialization
// ============================================
chrome.runtime.onInstalled.addListener((details) => {



    // Create alarm for 30-second polling (0.5 minutes)
    chrome.alarms.create("gmail-poll", { periodInMinutes: 0.5 });
    console.log("[Background] Gmail poll alarm created (30-second interval)");
    // Create auth keep-alive alarm (every 30 minutes for proactive refresh)
    chrome.alarms.create("auth-keep-alive", { periodInMinutes: 5 });
    // Validate token on install/update with a slight delay for stability
    setTimeout(() => validateAndRefreshTokenOnStartup(), 1000);
});



// Ensure alarm exists on startup
chrome.runtime.onStartup.addListener(() => {
    chrome.alarms.get("gmail-poll", (alarm) => {
        if (!alarm) {
            chrome.alarms.create("gmail-poll", { periodInMinutes: 0.5 });
            console.log("[Background] Gmail poll alarm recreated on startup");
        }
    });
    // Ensure auth keep-alive alarm exists (every 30 minutes)
    chrome.alarms.get("auth-keep-alive", (alarm) => {
        if (!alarm) {
            chrome.alarms.create("auth-keep-alive", { periodInMinutes: 5 });
            console.log("[Background] Auth keep-alive alarm recreated on startup");
        }
    });
    // Validate token on Chrome startup (PC restart scenario)
    // Add 2s delay to ensure network is likely available
    setTimeout(() => validateAndRefreshTokenOnStartup(), 2000);
});

// ============================================
// Startup Token Validation & Auto-Refresh
// ============================================
async function validateAndRefreshTokenOnStartup() {
    console.log('[Background] Verifying Google auth on startup...');
    try {
        // Check if user is logged in OR has a stored token
        const storage = await chrome.storage.local.get(["isLoggedIn", "google_access_token", "google_user_persistent"]);
        const isLoggedIn = storage.isLoggedIn;
        const storedToken = storage.google_access_token;
        const isPersistent = storage.google_user_persistent;

        // If user has token or is marked as logged in, verify/refresh
        if (!storedToken && !isLoggedIn && !isPersistent) {
            console.log('[Background] User not logged in.');
            return;
        }

        const SCOPES = [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.modify",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/tasks",
            "https://www.googleapis.com/auth/drive.file",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/userinfo.profile"
        ];

        // Step 1: Try silent auth first (interactive: false)
        // Chrome handles token refresh automatically when possible
        chrome.identity.getAuthToken({ interactive: false, scopes: SCOPES }, (token) => {
            if (chrome.runtime.lastError || !token) {
                console.log('[Background] Silent auth failed on startup:', chrome.runtime.lastError?.message);

                // For persistent users, try interactive auth before falling back to UI
                if (isPersistent || isLoggedIn) {
                    console.log('[Background] User is persistent. Trying interactive auth (often succeeds silently)...');

                    // Step 2: Try interactive auth - this often succeeds SILENTLY if:
                    // - User is logged into Chrome with their Google account
                    // - Extension was previously authorized
                    // Chrome will only show a prompt if it truly can't refresh the token
                    chrome.identity.getAuthToken({ interactive: false, scopes: SCOPES }, (interactiveToken) => {
                        if (chrome.runtime.lastError || !interactiveToken) {
                            console.warn('[Background] Proactive silent auth failed:', chrome.runtime.lastError?.message);
                            // Keep flags for UI to handle manual reconnection as last resort
                            chrome.storage.local.set({
                                "isLoggedIn": true,
                                "google_user_persistent": true
                            });
                            // We used to send AUTO_RECONNECT_NEEDED here, but that often triggered
                            // intrusive UI. We'll let the New Tab page handle this when it loads.
                        } else {
                            // Success! Token refreshed via Chrome's Identity API
                            console.log('[Background] Startup silent auth succeeded - token refreshed automatically.');
                            const authTimestamp = Date.now();
                            chrome.storage.local.set({
                                "google_access_token": interactiveToken,
                                "isLoggedIn": true,
                                "google_user_persistent": true,
                                "google_auth_timestamp": authTimestamp
                            });
                        }
                    });
                } else {
                    // Non-persistent user - clear state
                    console.log('[Background] Non-persistent user. Clearing logged-in state.');
                    chrome.storage.local.set({
                        "isLoggedIn": false,
                        "google_access_token": null,
                        "google_user_persistent": false
                    });
                }
            } else {
                console.log('[Background] Token refreshed automatically by Chrome (silent auth succeeded).');
                // Update stored token and ensure logged-in flags are set
                const authTimestamp = Date.now();
                chrome.storage.local.set({
                    "google_access_token": token,
                    "isLoggedIn": true,
                    "google_user_persistent": true,
                    "google_auth_timestamp": authTimestamp
                });
            }
        });

    } catch (err) {
        console.error('[Background] Startup validation error:', err);
    }
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "gmail-poll") {
        pollForChanges();
    }
    if (alarm.name === "auth-keep-alive") {
        console.log("[Background] Running auth keep-alive...");
        // Proactive refresh if token is near expiry (Checker Plus pattern)
        proactiveTokenRefresh().then(token => {
            if (token) {
                processPendingSync(token);
            } else {
                // Fallback to standard token fetch
                getValidToken(false).then(fallbackToken => {
                    if (fallbackToken) processPendingSync(fallbackToken);
                });
            }
        });
    }
});

// ============================================
// Content Script Message Listener
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'newEmailsDetected') {
        console.log('[Background] Content script detected new emails, triggering immediate poll');
        pollForChanges();
    }
    if (message.type === 'trigger-poll') {
        // High-frequency poll from offscreen document
        pollForChanges();
    }

    // Handle browser theme detection from offscreen document
    if (message.type === 'THEME_DETECTED') {
        const theme = message.theme;
        console.log('[Background] Browser theme detected:', theme);

        // Store the detected theme
        chrome.storage.local.set({ 'browser_theme_preference': theme }, () => {
            console.log('[Background] Stored browser theme:', theme);

            // Broadcast theme to all extension pages (tabs, popup, etc.)
            chrome.runtime.sendMessage({
                type: 'BROWSER_THEME_UPDATE',
                theme: theme
            }).catch(err => {
                // It's okay if no one is listening
                console.log('[Background] No listeners for theme update (expected if no tabs open)');
            });
        });
    }

    // Handle domain unblock - refresh all blocked tabs for this domain
    if (message.type === 'domain-unblocked') {
        const unblocked = message.domain;
        console.log(`[Background] Domain unblocked: ${unblocked}, refreshing tabs...`);

        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                // Check if tab is showing blocked.html for this domain
                if (tab.url && tab.url.includes('blocked.html') && tab.url.includes(`domain=${encodeURIComponent(unblocked)}`)) {
                    // Extract original URL from params
                    try {
                        const tabUrl = new URL(tab.url);
                        const originalUrl = tabUrl.searchParams.get('url');
                        if (originalUrl) {
                            console.log(`[Background] Restoring tab ${tab.id} to ${originalUrl}`);
                            chrome.tabs.update(tab.id, { url: originalUrl });
                        } else {
                            chrome.tabs.update(tab.id, { url: `https://${unblocked}` });
                        }
                    } catch (e) {
                        console.error('[Background] Error parsing blocked tab URL:', e);
                    }
                }
            });
        });
    }

    // ============================================
    // Authenticated Request Handler (for script.js/drive.js)
    // Uses ensureToken() pattern for persistent auth
    // ============================================
    if (message.type === 'AUTHENTICATED_REQUEST') {
        (async () => {
            try {
                const response = await sendAuthenticatedRequest(message.url, message.options || {});
                if (response.ok) {
                    const data = await response.json();
                    sendResponse({ success: true, data });
                } else {
                    sendResponse({ success: false, error: `HTTP ${response.status}`, status: response.status });
                }
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true; // Keep channel open for async response
    }

    // Get valid token (with ensureToken) for modules that need raw token
    if (message.type === 'GET_VALID_TOKEN') {
        (async () => {
            try {
                const token = await ensureToken();
                sendResponse({ success: true, token });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    return true;
});

// Create offscreen document immediately to start the 10s loop
setupOffscreenDocument('offscreen.html');

// ============================================
// Token Management
// ============================================
async function getValidToken(forceRefresh = false) {
    return new Promise((resolve) => {
        chrome.storage.local.get(["google_access_token", "google_token_expiry"], async (res) => {
            const token = res.google_access_token;
            const expiry = res.google_token_expiry || 0;

            if (!token) {
                console.log('[Background] No token found in storage');
                resolve(null);
                return;
            }

            // Fast path: if token is known to be expired from cached expiry, just refresh
            if (Date.now() > expiry && expiry > 0) {
                console.log('[Background] Token expired (cached expiry), refreshing...');
                const newToken = await refreshToken(token);
                resolve(newToken || token);
                return;
            }

            if (forceRefresh) {
                const newToken = await refreshToken(token);
                // If refresh fails, keep the old token rather than returning null
                resolve(newToken || token);
                return;
            }

            // Validate token with timeout and better error handling
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const response = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + token, {
                    signal: controller.signal
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                    const data = await response.json();
                    if (data.error && (data.error === 'invalid_token' || data.error === 'invalid_request')) {
                        console.log('[Background] Token invalid, attempting refresh...');
                        const newToken = await refreshToken(token);
                        if (!newToken) {
                            // Check if user is persistent - if so, interactive auth is already triggered
                            const authVars = await chrome.storage.local.get(["google_user_persistent"]);
                            const isPersistent = authVars.google_user_persistent;
                            if (!isPersistent) {
                                console.warn('[Background] Silent refresh failed after invalid token detected.');
                                chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH_FAILED', silent: true }).catch(() => { });
                            } else {
                                console.log('[Background] Token invalid but user is persistent. Interactive auth triggered.');
                            }
                        }
                        resolve(newToken || token);
                    } else {
                        resolve(token);
                    }
                } else if (response.status === 401 || response.status === 403) {
                    console.log('[Background] Token expired (401/403), attempting refresh...');
                    const newToken = await refreshToken(token);
                    if (!newToken) {
                        // Check if user is persistent - if so, interactive auth is already triggered
                        const authVars = await chrome.storage.local.get(["google_user_persistent"]);
                        const isPersistent = authVars.google_user_persistent;
                        if (!isPersistent) {
                            console.warn('[Background] Silent refresh failed after 401/403.');
                            chrome.runtime.sendMessage({ type: 'GOOGLE_AUTH_FAILED', silent: true }).catch(() => { });
                        } else {
                            console.log('[Background] Token expired but user is persistent. Interactive auth triggered.');
                        }
                    }
                    resolve(newToken || token);
                } else {
                    console.warn('[Background] Token validation returned non-auth error, keeping token');
                    resolve(token);
                }
            } catch (e) {
                console.warn('[Background] Token validation network error (keeping token):', e.message);
                resolve(token);
            }
        });
    });
}

async function refreshToken(oldToken) {
    return new Promise((resolve) => {
        try {
            // First, remove the invalid token from cache if provided
            if (oldToken) {
                console.log('[Background] Removing stale token from cache');
                chrome.identity.removeCachedAuthToken({ token: oldToken }, () => {
                    // Continue even if removal fails
                    if (chrome.runtime.lastError) {
                        console.warn('[Background] Failed to remove cached token (continuing anyway):', chrome.runtime.lastError);
                    }
                    // Now fetch a new one
                    fetchNewToken(resolve);
                });
            } else {
                fetchNewToken(resolve);
            }
        } catch (e) {
            console.error('[Background] Token refresh error:', e);
            // Don't resolve null - let caller decide what to do with old token
            resolve(null);
        }
    });
}

function fetchNewToken(resolve) {
    const SCOPES = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/tasks",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile"
    ];

    // 1. Try getAuthToken (silent)
    chrome.identity.getAuthToken({ interactive: false, scopes: SCOPES }, async (token) => {
        if (chrome.runtime.lastError || !token) {
            console.warn('[Background] Silent getAuthToken failed, checking if user is persistent...', chrome.runtime.lastError?.message);

            // Check if user is persistent - if so, try interactive auth
            const authVars = await new Promise(resolve => chrome.storage.local.get(["google_user_persistent"], resolve));
            const isPersistent = authVars.google_user_persistent;

            if (isPersistent) {
                console.log('[Background] Persistent user detected. Trying interactive auth...');
                // Try interactive auth for persistent users
                chrome.identity.getAuthToken({ interactive: true, scopes: SCOPES }, (interactiveToken) => {
                    if (chrome.runtime.lastError || !interactiveToken) {
                        console.warn('[Background] Interactive auth failed, trying WebAuthFlow tab...', chrome.runtime.lastError?.message);
                        // Fall back to tab-based auth flow
                        tryTabBasedAuth(SCOPES, resolve);
                    } else {
                        console.log('[Background] Interactive auth succeeded for persistent user.');
                        saveAndResolveToken(interactiveToken, resolve);
                    }
                });
                return;
            }

            // 2. Try WebAuthFlow (silent) for non-persistent users
            const clientId = "149193288904-fkjovpramlmte3958822t0cgmlgqr7lh.apps.googleusercontent.com";
            const redirectUri = "https://dchipjncdebfhcfceidlhhlccnogbjjl.chromiumapp.org/";
            const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
            authUrl.searchParams.set('client_id', clientId);
            authUrl.searchParams.set('response_type', 'token');
            authUrl.searchParams.set('redirect_uri', redirectUri);
            authUrl.searchParams.set('scope', SCOPES.join(' '));
            authUrl.searchParams.set('prompt', 'none');

            chrome.identity.launchWebAuthFlow({
                url: authUrl.toString(),
                interactive: false
            }, (responseUrl) => {
                if (chrome.runtime.lastError || !responseUrl) {
                    console.warn('[Background] Silent WebAuthFlow also failed:', chrome.runtime.lastError?.message);
                    resolve(null);
                    return;
                }
                const url = new URL(responseUrl);
                const params = new URLSearchParams(url.hash.substring(1));
                const accessToken = params.get('access_token');
                if (accessToken) {
                    saveAndResolveToken(accessToken, resolve);
                } else {
                    resolve(null);
                }
            });
            return;
        }
        saveAndResolveToken(token, resolve);
    });
}

// Helper function for tab-based auth flow (used as last resort for persistent users)
function tryTabBasedAuth(SCOPES, resolve) {
    console.log('[Background] Triggering tab-based auth flow for persistent user...');
    const clientId = "149193288904-fkjovpramlmte3958822t0cgmlgqr7lh.apps.googleusercontent.com";
    const redirectUri = "https://dchipjncdebfhcfceidlhhlccnogbjjl.chromiumapp.org/";
    const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('prompt', 'select_account consent');

    // Start token scavenger to capture token from tab
    chrome.runtime.sendMessage({ type: 'START_TOKEN_SCAVENGER' }).catch(() => { });

    // Open auth tab - token will be captured by snatcher
    chrome.tabs.create({ url: authUrl.toString() }, () => {
        console.log('[Background] Auth tab opened. Token snatcher will capture token.');
        // Return null - token will be captured asynchronously by snatcher
        resolve(null);
    });
}

function saveAndResolveToken(token, resolve) {
    // Always set persistent flag for forever login
    const authTimestamp = Date.now();
    // Google access tokens typically expire in 3600 seconds (1 hour)
    // Set expiry 100 seconds early to ensure proactive refresh
    const tokenExpiryTime = authTimestamp + (3500 * 1000);
    chrome.storage.local.set({
        "google_access_token": token,
        "google_user_persistent": true,
        "google_auth_timestamp": authTimestamp,
        "google_token_expiry": tokenExpiryTime
    }, () => {
        console.log(`[Background] Token refreshed successfully. Expiry: ${new Date(tokenExpiryTime).toISOString()}`);
        resolve(token);
    });
}

// ============================================
// Token Expiry Check (Checker Plus Pattern)
// ============================================
// Check if token is expired or will expire within 5 minutes
function isExpired(tokenExpiry) {
    const BUFFER_MS = 5 * 60 * 1000; // 5 minutes safety buffer
    return !tokenExpiry || Date.now() > (tokenExpiry - BUFFER_MS);
}

// ============================================
// Ensure Token (THE CORE PATTERN)
// Called BEFORE every Google API request
// ============================================
async function ensureToken() {
    const storage = await chrome.storage.local.get([
        "google_access_token",
        "google_token_expiry",
        "google_user_persistent"
    ]);

    if (!storage.google_access_token) {
        console.warn('[Auth] No token found');
        throw new Error("NO_TOKEN");
    }

    // If token expires within 5 minutes, refresh proactively
    if (isExpired(storage.google_token_expiry)) {
        console.log('[Auth] Token expiring soon, refreshing proactively (ensureToken)...');
        const newToken = await refreshToken(storage.google_access_token);
        if (newToken) {
            console.log('[Auth] Token refreshed successfully via ensureToken');
            return newToken;
        }
        // If refresh fails, return old token (might still work briefly)
        console.warn('[Auth] Refresh failed, using existing token');
        return storage.google_access_token;
    }

    return storage.google_access_token;
}

// ============================================
// Universal Authenticated Request Wrapper
// Calls ensureToken() before every request + retry on 401
// ============================================
async function sendAuthenticatedRequest(url, options = {}) {
    try {
        // Step 1: Ensure token is valid BEFORE making request
        const token = await ensureToken();

        // Step 2: Add Authorization header
        options.headers = {
            ...options.headers,
            Authorization: `Bearer ${token}`
        };

        // Step 3: Make request with retry on 401
        return await fetchWithRetry(url, options);
    } catch (error) {
        console.error('[Auth] sendAuthenticatedRequest error:', error);
        throw error;
    }
}

// ============================================
// Proactive Token Refresh (Checker Plus Pattern)
// ============================================
async function proactiveTokenRefresh() {
    try {
        const storage = await chrome.storage.local.get([
            "google_access_token",
            "google_token_expiry",
            "google_user_persistent"
        ]);

        if (!storage.google_access_token || !storage.google_user_persistent) {
            return null;
        }

        const now = Date.now();
        const expiry = storage.google_token_expiry || 0;
        const timeUntilExpiry = expiry - now;

        // If token expires within 5 minutes, refresh proactively
        if (timeUntilExpiry < 5 * 60 * 1000) {
            console.log(`[Background] Token expiring in ${Math.round(timeUntilExpiry / 1000)}s, proactive refresh...`);
            const newToken = await refreshToken(storage.google_access_token);
            if (newToken) {
                console.log('[Background] Proactive token refresh succeeded.');
                return newToken;
            } else {
                console.warn('[Background] Proactive refresh failed, will retry on next alarm.');
            }
        } else {
            console.log(`[Background] Token valid for ${Math.round(timeUntilExpiry / 60000)} more minutes.`);
        }
        return storage.google_access_token;
    } catch (e) {
        console.error('[Background] Proactive refresh error:', e);
        return null;
    }
}

// ============================================
// Fetch with Retry (Exponential Backoff for 401 errors)
// ============================================
async function fetchWithRetry(url, options = {}, maxRetries = 3) {
    let lastResponse = null;
    let currentToken = options.headers?.Authorization?.replace('Bearer ', '');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);
            lastResponse = response;

            if (response.status === 401) {
                console.log(`[Background] 401 error on attempt ${attempt}/${maxRetries}, refreshing token...`);

                if (attempt < maxRetries) {
                    // Refresh token and update headers
                    const newToken = await refreshToken(currentToken);
                    if (newToken) {
                        currentToken = newToken;
                        options.headers = {
                            ...options.headers,
                            Authorization: `Bearer ${newToken}`
                        };
                        // Exponential backoff: 1s, 2s, 4s
                        const backoffMs = Math.pow(2, attempt - 1) * 1000;
                        console.log(`[Background] Waiting ${backoffMs}ms before retry...`);
                        await new Promise(r => setTimeout(r, backoffMs));
                        continue;
                    }
                }
            }

            return response;
        } catch (error) {
            console.error(`[Background] Fetch error on attempt ${attempt}:`, error);
            if (attempt === maxRetries) throw error;

            // Wait before retry on network errors too
            const backoffMs = Math.pow(2, attempt - 1) * 1000;
            await new Promise(r => setTimeout(r, backoffMs));
        }
    }

    return lastResponse;
}

// ============================================
// History ID Management
// ============================================
async function getStoredHistoryId() {
    return new Promise((resolve) => {
        chrome.storage.sync.get("gmail_history_id", (res) => {
            resolve(res.gmail_history_id || null);
        });
    });
}

async function storeHistoryId(historyId) {
    return new Promise((resolve) => {
        chrome.storage.sync.set({ "gmail_history_id": historyId }, () => {
            console.log('[Background] Stored historyId:', historyId);
            resolve();
        });
    });
}

async function initializeHistoryId(token) {
    try {
        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.ok) {
            const data = await response.json();
            if (data.historyId) {
                await storeHistoryId(data.historyId);
                console.log('[Background] Initialized historyId:', data.historyId);
            }
        }
    } catch (e) {
        console.error('[Background] Failed to initialize historyId:', e);
    }
}

// ============================================
// Main Polling Function
// ============================================
async function pollForChanges() {
    console.log('[Background] Polling for Gmail changes...');

    const token = await getValidToken();
    if (!token) {
        console.log('[Background] No valid token, skipping poll');
        return;
    }

    // Process pending data sync alongside Gmail poll for faster updates
    processPendingSync(token);

    const storedHistoryId = await getStoredHistoryId();

    if (!storedHistoryId) {
        // No history ID stored, initialize and do a fresh check
        console.log('[Background] No historyId stored, initializing...');
        await initializeHistoryId(token);
        await checkNewEmailsFallback(token);
        return;
    }

    try {
        // Use incremental sync with history.list (with auto-retry on 401)
        const response = await fetchWithRetry(
            `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${storedHistoryId}&historyTypes=messageAdded`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!response) {
            console.log('[Background] All retry attempts failed');
            await checkNewEmailsFallback(token);
            return;
        }

        if (response.status === 401) {
            // fetchWithRetry already tried 3 times with token refresh
            console.log('[Background] 401 persisted after retries, checking persistence...');
            const authVars = await chrome.storage.local.get(["google_user_persistent"]);
            if (authVars.google_user_persistent) {
                console.log('[Background] User is persistent. Interactive auth will be triggered.');
            }
            return;
        }

        if (response.status === 404) {
            // History ID is no longer valid, reinitialize
            console.log('[Background] historyId expired, reinitializing...');
            await initializeHistoryId(token);
            await checkNewEmailsFallback(token);
            return;
        }

        if (!response.ok) {
            console.error('[Background] History API error:', response.status);
            // Fallback to traditional check
            await checkNewEmailsFallback(token);
            return;
        }

        const data = await response.json();

        // Update stored historyId
        if (data.historyId) {
            await storeHistoryId(data.historyId);
        }

        // Process new messages
        if (data.history && data.history.length > 0) {
            const newMessageIds = new Set();

            for (const historyRecord of data.history) {
                if (historyRecord.messagesAdded) {
                    for (const added of historyRecord.messagesAdded) {
                        // Only notify for messages in INBOX and UNREAD
                        if (added.message.labelIds &&
                            added.message.labelIds.includes('INBOX') &&
                            added.message.labelIds.includes('UNREAD')) {
                            newMessageIds.add(added.message.id);
                        }
                    }
                }
            }

            console.log(`[Background] Found ${newMessageIds.size} new unread messages`);

            // Fetch details and show notifications for each new message
            for (const messageId of newMessageIds) {
                await fetchAndNotify(token, messageId);
            }

            // Update cached emails for popup
            await updateCachedEmails(token);
        } else {
            console.log('[Background] No new messages');
        }

    } catch (err) {
        console.error('[Background] Poll error:', err);
        // Fallback to traditional check
        await checkNewEmailsFallback(token);
    }
}

// ============================================
// Fallback Email Check (non-incremental)
// ============================================
async function checkNewEmailsFallback(token) {
    console.log('[Background] Using fallback email check...');

    try {
        const response = await fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5',
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!response.ok) return;

        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            // Get previously notified IDs
            const stored = await new Promise(resolve => {
                chrome.storage.local.get("notified_email_ids", (res) => {
                    resolve(res.notified_email_ids || []);
                });
            });

            const notifiedSet = new Set(stored);
            const newNotifiedIds = [...stored];

            for (const msg of data.messages) {
                if (!notifiedSet.has(msg.id)) {
                    await fetchAndNotify(token, msg.id);
                    newNotifiedIds.push(msg.id);
                }
            }

            // Keep only last 50 IDs to prevent storage bloat
            const trimmedIds = newNotifiedIds.slice(-50);
            chrome.storage.local.set({ "notified_email_ids": trimmedIds });
        }

        // Update cached emails
        await updateCachedEmails(token);

    } catch (err) {
        console.error('[Background] Fallback check error:', err);
    }
}

// ============================================
// Fetch Email Details and Show Notification
// ============================================
async function fetchAndNotify(token, messageId) {
    try {
        const response = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!response.ok) return;

        const data = await response.json();

        const subject = data.payload?.headers?.find(h => h.name === 'Subject')?.value || '(No Subject)';
        const fromRaw = data.payload?.headers?.find(h => h.name === 'From')?.value || 'Unknown';
        const from = fromRaw.replace(/<.*>/, '').trim();
        const snippet = data.snippet || '';

        // Create rich notification with action buttons
        chrome.notifications.create(messageId, {
            type: "basic",
            iconUrl: "images/icon128.png",
            title: `📧 ${from}`,
            message: `${subject}\n${snippet.substring(0, 100)}${snippet.length > 100 ? '...' : ''}`,
            priority: 2,
            requireInteraction: true,
            buttons: [
                { title: "📁 Archive" },
                { title: "🗑️ Delete" }
            ]
        }, (notificationId) => {
            if (chrome.runtime.lastError) {
                console.error('[Background] Notification error:', chrome.runtime.lastError.message);
            } else {
                console.log('[Background] Notification created:', notificationId);
                playNotificationSound();
            }
        });

    } catch (err) {
        console.error('[Background] fetchAndNotify error:', err);
    }
}

async function playNotificationSound() {
    try {
        await setupOffscreenDocument('offscreen.html');
        chrome.runtime.sendMessage({
            type: 'play-sound',
            source: chrome.runtime.getURL('notification.wav')
        });
    } catch (e) {
        console.error('[Background] Failed to play sound:', e);
    }
}

// ============================================
// Update Cached Emails for Popup
// ============================================
async function updateCachedEmails(token) {
    try {
        const response = await fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=10',
            { headers: { Authorization: `Bearer ${token}` } }
        );

        if (!response.ok) return;

        const data = await response.json();

        if (data.messages && data.messages.length > 0) {
            const promises = data.messages.map(async (msg) => {
                const detailRes = await fetch(
                    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                return await detailRes.json();
            });

            const messages = await Promise.all(promises);

            // Cache for popup fast-load
            chrome.storage.local.set({
                "gmail_cached_messages": messages.filter(m => m && !m.error),
                "gmail_unread_count": data.resultSizeEstimate || data.messages.length
            });
        } else {
            chrome.storage.local.set({
                "gmail_cached_messages": [],
                "gmail_unread_count": 0
            });
        }
    } catch (err) {
        console.error('[Background] updateCachedEmails error:', err);
    }
}

// ============================================
// Notification Button Click Handlers
// ============================================
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
    console.log(`[Background] Notification button clicked: ${notificationId}, button: ${buttonIndex}`);

    const token = await getValidToken();
    if (!token) {
        console.log('[Background] No token for notification action');
        return;
    }

    try {
        if (buttonIndex === 0) {
            // Archive - Remove from INBOX
            await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${notificationId}/modify`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        removeLabelIds: ['INBOX']
                    })
                }
            );
            console.log('[Background] Email archived:', notificationId);
        } else if (buttonIndex === 1) {
            // Delete - Move to Trash
            await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${notificationId}/trash`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                }
            );
            console.log('[Background] Email trashed:', notificationId);
        }

        // Clear the notification
        chrome.notifications.clear(notificationId);

        // Update cached emails
        await updateCachedEmails(token);

    } catch (err) {
        console.error('[Background] Notification action error:', err);
    }
});

// Handle notification click (open in Gmail)
chrome.notifications.onClicked.addListener((notificationId) => {
    chrome.tabs.create({ url: `https://mail.google.com/mail/u/0/#inbox/${notificationId}` });
    chrome.notifications.clear(notificationId);
});

// ============================================
// Initial Check on Extension Load
// ============================================
(async function initialCheck() {
    console.log('[Background] Running initial check...');
    // Poll immediately on wake up
    pollForChanges();
})();

// Reset stats ONLY when the browser actually starts up, not every SW wake
chrome.runtime.onStartup.addListener(() => {
    resetSessionStats();
});

// Network awareness: Retry recovery when coming back online
// NOTE: SW doesn't have 'window', but we can check navigator.onLine or use other triggers
// Removing window.addEventListener to prevent crash.

// ============================================
// Advanced Site Time Tracking Module
// ============================================
// Architecture: Hybrid event-driven + pulse-based tracker
// - Tracks FOCUS (active tab) + AUDIO (background tabs playing sound)
// - Immediate time accounting on tab switches/URL changes
// - 10-minute pulse for validation and catch-up
// - Idle detection (pauses focus, continues audio)
// - Daily reset at midnight
// - Delta validation to prevent inflated times from browser sleep/close

// State Management
let activeSessions = []; // Array of { tabId, domain, reasons: Set(['focus', 'audio']), lastTick: timestamp, startTime: timestamp }
let isUserIdle = false;
let pulseIntervalId = null;
const PULSE_INTERVAL_MS = 600000; // 10 minutes
const MAX_DELTA_MS = PULSE_INTERVAL_MS * 2; // Maximum reasonable delta (20 minutes) to prevent inflation from sleep/close

// Reset in-memory session stats on browser startup
function resetSessionStats() {
    console.log('[Tracker] Resetting session stats on browser startup');
    activeSessions = [];
    isUserIdle = false;
}

// Helper: Extract domain from URL
function getDomainFromUrl(url) {
    try {
        if (!url) return null;
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return parsed.hostname;
    } catch (e) {
        return null;
    }
}

// Helper: Check if domain is valid (not internal)
function isValidDomain(domain) {
    return domain && !domain.includes('chrome') && !domain.includes('localhost');
}

// Load tracking data from storage
async function loadTrackingData() {
    const data = await chrome.storage.local.get(['site_stats', 'lastResetTimestamp']);
    return {
        stats: data.site_stats || {},
        lastReset: data.lastResetTimestamp || Date.now()
    };
}

// Save tracking data to storage
async function saveTrackingData(stats) {
    await chrome.storage.local.set({ 'site_stats': stats });
}

// Helper wrapper for updateDomainTime that doesn't require iconUrl
async function updateDomainTime(domain, deltaMs, iconUrl = null) {
    if (!isValidDomain(domain) || deltaMs <= 0) return;

    // Check if blocked first
    const blockData = await chrome.storage.local.get("blocked_domains");
    if (blockData.blocked_domains && blockData.blocked_domains[domain]) {
        // Stop tracking if blocked
        return;
    }

    const { stats } = await loadTrackingData();

    if (!stats[domain]) {
        stats[domain] = { time: 0, lastSeen: Date.now(), icon: null };
    }

    // Add delta time
    stats[domain].time += deltaMs;

    // Safeguard: Cap time at 24 hours (86400000ms) per day to prevent inflated numbers
    const maxDailyTime = 86400000; // 24 hours in milliseconds
    if (stats[domain].time > maxDailyTime) {
        console.warn(`[Tracker] Capping time for ${domain} at 24 hours (was ${stats[domain].time}ms)`);
        stats[domain].time = maxDailyTime;
    }

    stats[domain].lastSeen = Date.now();

    // Update icon if provided and not already set
    if (iconUrl && !stats[domain].icon) {
        stats[domain].icon = iconUrl;
    }

    await saveTrackingData(stats);
}

// Helper: Account for time spent on a session before removing/updating it
async function accountForSessionTime(session, endTime = null) {
    if (!session) return;

    const now = endTime || Date.now();
    const delta = now - session.lastTick;

    // Validate delta - prevent inflated times from browser sleep/close
    if (delta > 0 && delta <= MAX_DELTA_MS) {
        // Only account for time if session had valid reasons
        if (session.reasons.size > 0) {
            await updateDomainTime(session.domain, delta);
        }
    } else if (delta > MAX_DELTA_MS) {
        // If delta is too large (browser was closed/slept), cap it at max reasonable time
        console.warn(`[Tracker] Large delta detected (${Math.round(delta / 1000 / 60)}min) for ${session.domain}, capping at ${MAX_DELTA_MS / 1000 / 60}min`);
        if (session.reasons.size > 0) {
            await updateDomainTime(session.domain, MAX_DELTA_MS);
        }
    }
}

// Session Management: Add or update session
async function addOrUpdateSession(tabId, domain, reason) {
    if (!isValidDomain(domain)) return;

    const now = Date.now();
    const existing = activeSessions.find(s => s.tabId === tabId);

    if (existing) {
        // If domain changed, account for time on previous domain first
        if (existing.domain !== domain && existing.reasons.size > 0) {
            await accountForSessionTime(existing, now);
            // Reset for new domain
            existing.domain = domain;
            existing.lastTick = now;
            existing.startTime = now;
        }

        // Check if reason is new before adding
        const isNewReason = !existing.reasons.has(reason);
        existing.reasons.add(reason);

        // If adding a new reason or this is the first reason, account for time and reset tick
        if (isNewReason) {
            await accountForSessionTime(existing, now);
            existing.lastTick = now;
        }
        console.log(`[Tracker] Updated session: ${domain} (${Array.from(existing.reasons).join(', ')})`);
    } else {
        activeSessions.push({
            tabId,
            domain,
            reasons: new Set([reason]),
            lastTick: now,
            startTime: now
        });
        console.log(`[Tracker] New session: ${domain} (${reason})`);
    }
}

// Session Management: Remove session or reason
async function removeSession(tabId, reasonToRemove = null) {
    const session = activeSessions.find(s => s.tabId === tabId);
    if (!session) return;

    if (reasonToRemove) {
        // Account for time before removing reason
        await accountForSessionTime(session);
        session.reasons.delete(reasonToRemove);
        if (session.reasons.size === 0) {
            activeSessions = activeSessions.filter(s => s.tabId !== tabId);
        } else {
            // Reset tick for remaining reasons
            session.lastTick = Date.now();
        }
    } else {
        // Account for all time before removing session completely
        await accountForSessionTime(session);
        activeSessions = activeSessions.filter(s => s.tabId !== tabId);
    }
}

// The Pulse: Called every 10 minutes for validation and catch-up
async function pulseTracking() {
    if (activeSessions.length === 0) return;

    const now = Date.now();
    const validSessions = [];

    for (const session of activeSessions) {
        try {
            // Verify tab still exists
            const tab = await chrome.tabs.get(session.tabId);
            if (!tab) {
                // Tab was closed, account for time before removing
                await accountForSessionTime(session, now);
                continue;
            }

            // Check if reasons are still valid
            const isAudible = tab.audible || false;
            const isFocused = tab.active && tab.windowId && !isUserIdle;

            const validReasons = new Set();
            if (isFocused) validReasons.add('focus');
            if (isAudible) validReasons.add('audio');

            // Calculate delta time
            const delta = now - session.lastTick;

            if (validReasons.size === 0) {
                // No valid reasons, account for time up to now and remove
                await accountForSessionTime(session, now);
                continue;
            }

            // Validate delta - prevent inflated times
            if (delta > 0 && delta <= MAX_DELTA_MS) {
                // Update domain time with validated delta
                await updateDomainTime(session.domain, delta, tab.favIconUrl);
            } else if (delta > MAX_DELTA_MS) {
                // Delta too large (browser was closed/slept), cap it
                console.warn(`[Tracker] Large delta in pulse (${Math.round(delta / 1000 / 60)}min) for ${session.domain}, capping`);
                await updateDomainTime(session.domain, MAX_DELTA_MS, tab.favIconUrl);
            }

            // Update domain if URL changed
            const currentDomain = getDomainFromUrl(tab.url);
            if (currentDomain && currentDomain !== session.domain) {
                // Account for time on old domain
                await accountForSessionTime(session, now);
                session.domain = currentDomain;
                session.lastTick = now;
                session.startTime = now;
            } else {
                // Keep session with updated reasons and tick
                session.lastTick = now;
            }

            session.reasons = validReasons;
            validSessions.push(session);

        } catch (e) {
            // Tab doesn't exist anymore, account for time and skip
            await accountForSessionTime(session, now);
            continue;
        }
    }

    activeSessions = validSessions;
}

// One-time cleanup: Clear corrupted history data from history seeding
async function cleanupInflatedHistory() {
    const storage = await chrome.storage.local.get(['session_history_cleaned_v2', 'session_history', 'site_stats']);

    if (storage.session_history_cleaned_v2) {
        return; // Already cleaned
    }

    console.log('[Tracker] Cleaning up inflated history data (one-time fix)...');

    // Clear both session_history and site_stats to start fresh
    // The inflated data was from seedFromHistory() estimating 3min per visit
    await chrome.storage.local.set({
        'session_history': [],
        'site_stats': {},
        'session_history_cleaned_v2': true,
        'lastResetTimestamp': Date.now()
    });

    console.log('[Tracker] History cleanup complete. Starting fresh with real-time tracking.');
}

// Check and handle daily reset at midnight
async function checkDailyReset() {
    const storage = await chrome.storage.local.get(['site_stats', 'lastResetTimestamp', 'session_history']);
    const lastReset = storage.lastResetTimestamp || 0;
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    if (lastReset < todayMidnight) {
        console.log('[Tracker] Midnight reset triggered (Background)');

        // Save to history before clearing
        const stats = storage.site_stats || {};
        const history = storage.session_history || [];
        const statsArr = [];

        for (const [domain, info] of Object.entries(stats)) {
            if (info.time > 1000) {
                statsArr.push({ domain, time: info.time });
            }
        }

        if (statsArr.length > 0) {
            history.push({
                date: lastReset || todayMidnight - 86400000,
                sites: statsArr
            });
            // Keep only last 30 sessions
            const trimmedHistory = history.slice(-30);
            await chrome.storage.local.set({
                'session_history': trimmedHistory,
                'site_stats': {},
                'lastResetTimestamp': todayMidnight // Set to midnight, not current time
            });
        } else {
            await chrome.storage.local.set({
                'site_stats': {},
                'lastResetTimestamp': todayMidnight // Set to midnight, not current time
            });
        }
    }
}

// Event: Tab activated (focus changed)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        const domain = getDomainFromUrl(tab.url);

        if (domain) {
            // Immediate Block Check
            const data = await chrome.storage.local.get("blocked_domains");
            if (data.blocked_domains && data.blocked_domains[domain]) {
                console.log(`[Tracker] Blocking ${domain} on activation`);
                const blockedPageUrl = chrome.runtime.getURL(`blocked.html?domain=${encodeURIComponent(domain)}&url=${encodeURIComponent(tab.url)}&title=${encodeURIComponent(tab.title || domain)}&favicon=${encodeURIComponent(tab.favIconUrl || '')}`);
                chrome.tabs.update(activeInfo.tabId, { url: blockedPageUrl });
                return; // Stop processing
            }

            const now = Date.now();

            // Account for time on all previously focused tabs before removing focus
            for (const session of activeSessions) {
                if (session.reasons.has('focus')) {
                    await accountForSessionTime(session, now);
                    session.reasons.delete('focus');
                    // Reset tick if session still has other reasons (e.g., audio)
                    if (session.reasons.size > 0) {
                        session.lastTick = now;
                    }
                }
            }

            // Add focus to this tab (immediate time accounting handled in addOrUpdateSession)
            await addOrUpdateSession(tab.id, domain, 'focus');

            // Also add audio if applicable
            if (tab.audible) {
                await addOrUpdateSession(tab.id, domain, 'audio');
            }
        }
    } catch (e) {
        console.error('[Tracker] onActivated error:', e);
    }
});

// Event: Tab updated (URL change, audio change, etc.)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
        const domain = getDomainFromUrl(tab.url);
        if (!domain) return;

        // Handle URL change: account for time on previous domain before switching
        if (changeInfo.url) {
            const session = activeSessions.find(s => s.tabId === tabId);
            if (session && session.domain !== domain && session.reasons.size > 0) {
                // Account for time on old domain
                await accountForSessionTime(session);
                // Update to new domain and reset tick
                session.domain = domain;
                session.lastTick = Date.now();
                session.startTime = Date.now();
            }
        }

        // Handle audio state change
        if (changeInfo.hasOwnProperty('audible')) {
            if (changeInfo.audible) {
                await addOrUpdateSession(tabId, domain, 'audio');
            } else {
                await removeSession(tabId, 'audio');
            }
        }

        // If this tab is active and URL loaded, ensure focus is tracked
        if (changeInfo.status === 'complete' && tab.active) {
            await addOrUpdateSession(tabId, domain, 'focus');
        }

        // Blocking Logic
        if (changeInfo.url || tab.url) {
            const url = changeInfo.url || tab.url;
            const domainToCheck = getDomainFromUrl(url);
            if (domainToCheck) {
                // Skip if already on blocked page
                if (url.includes('blocked.html')) return;

                // Must force fresh read to get latest blocking status
                const data = await chrome.storage.local.get("blocked_domains");
                const blockedDomains = data.blocked_domains || {};

                if (blockedDomains[domainToCheck] === true) {
                    console.log(`[Tracker] Blocking ${domainToCheck}`);
                    const blockedPageUrl = chrome.runtime.getURL(`blocked.html?domain=${encodeURIComponent(domainToCheck)}&url=${encodeURIComponent(url)}&title=${encodeURIComponent(tab.title || domainToCheck)}&favicon=${encodeURIComponent(tab.favIconUrl || '')}`);
                    chrome.tabs.update(tabId, { url: blockedPageUrl });
                }
            }
        }
    } catch (e) {
        console.error('[Tracker] onUpdated error:', e);
    }
});

// Event: Tab removed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    await removeSession(tabId);
});

// Event: Window focus changed
chrome.windows.onFocusChanged.addListener(async (windowId) => {
    const now = Date.now();

    if (windowId === chrome.windows.WINDOW_ID_NONE) {
        // User switched away from browser, account for time and remove all focus reasons
        for (const session of activeSessions) {
            if (session.reasons.has('focus')) {
                await accountForSessionTime(session, now);
                session.reasons.delete('focus');
                if (session.reasons.size > 0) {
                    session.lastTick = now;
                }
            }
        }
    } else {
        // User focused browser, check active tab in focused window
        try {
            const tabs = await chrome.tabs.query({ active: true, windowId: windowId });
            if (tabs.length > 0) {
                const tab = tabs[0];
                const domain = getDomainFromUrl(tab.url);
                if (domain) {
                    // Account for time on all previously focused tabs
                    for (const session of activeSessions) {
                        if (session.reasons.has('focus')) {
                            await accountForSessionTime(session, now);
                            session.reasons.delete('focus');
                            if (session.reasons.size > 0) {
                                session.lastTick = now;
                            }
                        }
                    }
                    // Add focus to this tab
                    await addOrUpdateSession(tab.id, domain, 'focus');
                }
            }
        } catch (e) {
            console.error('[Tracker] onFocusChanged error:', e);
        }
    }
});

// Event: Idle state changed
chrome.idle.onStateChanged.addListener(async (state) => {
    const now = Date.now();
    isUserIdle = (state !== 'active');

    if (isUserIdle) {
        // Account for time and remove focus from all sessions (but keep audio)
        for (const session of activeSessions) {
            if (session.reasons.has('focus')) {
                await accountForSessionTime(session, now);
                session.reasons.delete('focus');
                if (session.reasons.size > 0) {
                    session.lastTick = now;
                }
            }
        }
        console.log('[Tracker] User idle, pausing focus tracking');
    } else {
        console.log('[Tracker] User active again');
        // Re-check focused tab to resume tracking
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            const tab = tabs[0];
            const domain = getDomainFromUrl(tab.url);
            if (domain) {
                await addOrUpdateSession(tab.id, domain, 'focus');
            }
        }
    }
});

// Set idle detection threshold (15 seconds)
chrome.idle.setDetectionInterval(15);

// Start the pulse interval
function startPulse() {
    if (pulseIntervalId) return; // Already running

    console.log('[Tracker] Starting pulse (10 minute interval)');
    pulseIntervalId = setInterval(() => {
        pulseTracking();
    }, PULSE_INTERVAL_MS);

    // Daily reset check - runs every 60 seconds (sufficient for midnight detection)
    setInterval(() => {
        checkDailyReset();
    }, 60000);
}

// Seeding: Populate stats from browser history if empty or forcing a sync
// DISABLED: This was causing Session Focus to show incorrect times based on
// estimated usage from visit counts (1 visit = 3 min) rather than actual tracked time.
// Session Focus should only show REAL time spent, tracked via the pulse mechanism.
async function seedFromHistory() {
    // Skip history seeding entirely - Session Focus should only track real-time usage
    console.log('[Tracker] History seeding disabled - using only real-time tracking.');
    return;

    // Check if we already did a full sync to avoid re-parsing history every boot
    const storage = await chrome.storage.local.get(['site_stats', 'history_synced_v1']);
    const stats = storage.site_stats || {};

    if (storage.history_synced_v1) {
        console.log('[Tracker] History already synced (v1). Skipping.');
        return;
    }

    console.log('[Tracker] syncing stats from browser history (One-Time Merge)...');
    try {
        // Last 90 days - get a good picture of habits
        const historyItems = await chrome.history.search({
            text: '',
            startTime: Date.now() - (90 * 24 * 60 * 60 * 1000),
            maxResults: 5000
        });

        const visitCounts = {};

        for (const item of historyItems) {
            const domain = getDomainFromUrl(item.url);
            if (!domain || !isValidDomain(domain)) continue;

            if (!visitCounts[domain]) {
                visitCounts[domain] = { count: 0, lastVisit: item.lastVisitTime || Date.now() };
            }
            visitCounts[domain].count += (item.visitCount || 1);
            if (item.lastVisitTime && item.lastVisitTime > visitCounts[domain].lastVisit) {
                visitCounts[domain].lastVisit = item.lastVisitTime;
            }
        }

        // Merge logic
        let seeded = 0;
        for (const [domain, info] of Object.entries(visitCounts)) {
            // Heuristic: 1 visit = 3 minutes of estimated "usage"
            // This favors frequently visited sites even if we just started tracking
            const estimatedTime = info.count * 180000;

            if (!stats[domain]) {
                stats[domain] = {
                    time: estimatedTime,
                    lastSeen: info.lastVisit,
                    icon: `https://www.google.com/s2/favicons?domain=${domain}&sz=256`
                };
                seeded++;
            } else {
                // If it exists, boost the time if the history estimate is arguably "stronger"
                // This helps if the user installed the extension recently but has years of history
                if (estimatedTime > stats[domain].time) {
                    stats[domain].time = estimatedTime;
                    seeded++;
                }
            }
        }

        if (seeded > 0) {
            await chrome.storage.local.set({
                'site_stats': stats,
                'history_synced_v1': true // Mark as done so we don't spam this on every boot
            });
            console.log(`[Tracker] Merged ${seeded} domains from history into stats.`);
        } else {
            await chrome.storage.local.set({ 'history_synced_v1': true });
        }

    } catch (e) {
        console.error('[Tracker] History seed failed (permissions?):', e);
    }
}

// Initialize on service worker wake
(async function initTracker() {
    console.log('[Tracker] Initializing pulse tracker...');

    // 0. One-time cleanup of inflated history data (from seedFromHistory bug)
    await cleanupInflatedHistory();

    // 1. Seed from history (Merge Logic) - DISABLED
    await seedFromHistory();

    // 2. Check daily reset
    await checkDailyReset();

    // 3. Start pulse
    startPulse();

    // 4. Query current active tab to bootstrap
    try {
        const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
        const focusedWindow = windows.find(w => w.focused);

        if (focusedWindow) {
            const activeTab = focusedWindow.tabs.find(t => t.active);
            if (activeTab) {
                const domain = getDomainFromUrl(activeTab.url);
                if (domain) {
                    console.log(`[Tracker] Bootstrap: ${domain} (tab ${activeTab.id})`);
                    addOrUpdateSession(activeTab.id, domain, 'focus');
                    if (activeTab.audible) {
                        addOrUpdateSession(activeTab.id, domain, 'audio');
                    }
                } else {
                    console.log(`[Tracker] Bootstrap: Skipped (invalid URL: ${activeTab.url})`);
                }
            }
        } else {
            console.log('[Tracker] Bootstrap: No focused window');
        }
    } catch (e) {
        console.error('[Tracker] Init query error:', e);
    }
})();





// ============================================
// BACKGROUND SYNC (Offline -> Online)
// ============================================
async function processPendingSync(token) {
    chrome.storage.local.get('sync_queue', async (res) => {
        const queue = res.sync_queue || [];
        if (queue.length === 0) return;

        console.log('[Background] Processing pending sync queue:', queue.length, 'items');
        const processed = [];

        for (const item of queue) {
            try {
                if (item.type === 'task') {
                    if (item.action === 'create') {
                        const response = await fetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
                            method: 'POST',
                            headers: {
                                Authorization: `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                title: item.data.title,
                                status: item.data.status || 'needsAction',
                                notes: item.data.notes || '',
                                due: item.data.due || undefined
                            })
                        });
                        if (response.ok) {
                            const googleTask = await response.json();
                            // Can't update runtime state easily, but we can notify
                            console.log('[Background] Synced task creation:', googleTask.id);
                        }
                    } else if (item.action === 'update' && !String(item.data.id).startsWith('temp-')) {
                        await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${item.data.id}`, {
                            method: 'PATCH',
                            headers: {
                                Authorization: `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(item.data.changes)
                        });
                    } else if (item.action === 'delete' && !String(item.data.id).startsWith('temp-')) {
                        await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${item.data.id}`, {
                            method: 'DELETE',
                            headers: { Authorization: `Bearer ${token}` }
                        });
                    }
                } else if (item.type === 'event') {
                    if (item.action === 'create') {
                        const { id, ...resource } = item.data.resource || {};
                        const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(resource)
                        });
                        if (response.ok) console.log('[Background] Synced event creation');
                    } else if (item.action === 'update' && !String(item.data.id).startsWith('temp-')) {
                        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${item.data.id}`, {
                            method: 'PATCH',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(item.data.resource)
                        });
                    } else if (item.action === 'delete' && !String(item.data.id).startsWith('temp-')) {
                        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${item.data.id}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                    }
                }
                processed.push(item.tempId);
            } catch (err) {
                console.error('[Background] Sync item failed:', item, err);
            }
        }

        // Cleanup processed
        const newQueue = queue.filter(i => !processed.includes(i.tempId));
        chrome.storage.local.set({ sync_queue: newQueue });
        console.log('[Background] Sync complete. Remaining:', newQueue.length);
    });
}
