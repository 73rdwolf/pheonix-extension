document.addEventListener('DOMContentLoaded', async () => {
  console.log("🔥🔥🔥 SCRIPT.JS NEW VERSION LOADED - POLLING FIX 🔥🔥🔥");
  console.log("DASHBOARD DOM LOADED");



  // --- STATE VARIABLES (HOISTED FOR SCOPED ACCESS) ---
  let currentViewDate = new Date();
  let localEvents = [];
  let siteStatsInterval;
  let activeTasks = [];
  let completedTasks = [];
  let isCalendarSyncing = false;

  // --- AUTH CONSTANTS (HOISTED) ---
  // Cloudflare Worker endpoint for persistent auth
  const WORKER_URL = "https://pheonix-auth.pixelarenaltd.workers.dev";

  // Google OAuth scopes
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

  // --- UI HELPERS (HOISTED) ---
  const showConnectUI = () => {
    const loginRow = document.getElementById('login-row');
    const loginBtn = document.getElementById('login-btn');
    const headerLoginBtn = document.getElementById('header-login-btn');
    const headerLogoutBtn = document.getElementById('header-logout-btn');
    if (loginRow) loginRow.style.display = 'flex';
    if (headerLoginBtn) headerLoginBtn.style.display = 'block';
    if (headerLogoutBtn) headerLogoutBtn.style.display = 'none';
    if (loginBtn) {
      loginBtn.textContent = "CONNECT GOOGLE";
      loginBtn.style.display = 'block';
    }
    document.body.classList.remove('logged-in');
  };

  const hideConnectUI = () => {
    const loginRow = document.getElementById('login-row');
    const loginBtn = document.getElementById('login-btn');
    const headerLoginBtn = document.getElementById('header-login-btn');
    const headerLogoutBtn = document.getElementById('header-logout-btn');
    if (loginRow) loginRow.style.display = 'none';
    if (headerLoginBtn) headerLoginBtn.style.display = 'none';
    if (headerLogoutBtn) headerLogoutBtn.style.display = 'block';
    if (loginBtn) loginBtn.style.display = 'none';
    document.body.classList.add('logged-in');
  };

  // ============================================
  // OFFLINE-FIRST SYNC QUEUE
  // Queues changes when offline, pushes on reconnect
  // ============================================
  const SyncQueue = {
    queue: [],

    async init() {
      const data = await new Promise(r => chrome.storage.local.get('sync_queue', r));
      this.queue = data.sync_queue || [];
      console.log('[SyncQueue] Initialized with', this.queue.length, 'pending items');
    },

    add(action, type, data) {
      // action: "create" | "update" | "delete"
      // type: "task" | "event"
      const item = { action, type, data, timestamp: Date.now(), tempId: data.id };
      this.queue.push(item);
      chrome.storage.local.set({ sync_queue: this.queue });
      console.log('[SyncQueue] Added:', action, type, data.id || data.title);
    },

    remove(tempId) {
      this.queue = this.queue.filter(item => item.tempId !== tempId);
      chrome.storage.local.set({ sync_queue: this.queue });
    },

    async processQueue(token) {
      if (this.queue.length === 0) return;
      console.log('[SyncQueue] Processing', this.queue.length, 'pending items...');

      const processed = [];
      const failed = [];

      for (const item of this.queue) {
        try {
          if (item.type === 'task') {
            if (item.action === 'create') {
              const response = await googleApiFetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
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
              const googleTask = await response.json();
              const localIndex = activeTasks.findIndex(t => t.id === item.tempId);
              if (localIndex !== -1) {
                activeTasks[localIndex] = { ...activeTasks[localIndex], id: googleTask.id, googleId: googleTask.id, syncStatus: 'synced' };
              }
            } else if (item.action === 'update' && !String(item.data.id).startsWith('temp-')) {
              await googleApiFetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${item.data.id}`, {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(item.data.changes)
              });
            } else if (item.action === 'delete' && !String(item.data.id).startsWith('temp-')) {
              await googleApiFetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${item.data.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
              });
            }
          } else if (item.type === 'event') {
            if (item.action === 'create') {
              const { id: _, ...safePayload } = item.data.resource || {};
              const response = await googleApiFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(safePayload)
              });
              const googleEvent = await response.json();

              const idx = localEvents.findIndex(e => e.id === item.tempId);
              if (idx !== -1) {
                localEvents[idx] = { ...googleEvent, syncStatus: 'synced', source: 'google' };
                localStorage.setItem('calendar_events_cache', JSON.stringify(localEvents));
              }
            } else if (item.action === 'update') {
              const eventId = item.data.id;
              if (!String(eventId).startsWith('temp-')) {
                await googleApiFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
                  method: 'PATCH',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(item.data.resource)
                });
              }
            } else if (item.action === 'delete') {
              const eventId = item.data.id;
              if (!String(eventId).startsWith('temp-')) {
                await googleApiFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
                  method: 'DELETE',
                  headers: { Authorization: `Bearer ${token}` }
                });
              }
            }
          }
          processed.push(item.tempId);
        } catch (err) {
          console.error('[SyncQueue] Failed to process item:', item, err);
          failed.push(item);
        }
      }

      this.queue = this.queue.filter(item => !processed.includes(item.tempId));
      chrome.storage.local.set({ sync_queue: this.queue });

      if (processed.length > 0) {
        if (typeof saveLocalTasks === 'function') saveLocalTasks();
        if (typeof renderTasks === 'function') renderTasks();

        if (typeof renderCalendarMonth === 'function' && typeof currentViewDate !== 'undefined') {
          renderCalendarMonth(currentViewDate, localEvents, 'none');
        }

        // If event modal is open, refresh the list to remove "pending" state
        const modal = document.getElementById('event-modal');
        const dateDisplay = document.getElementById('event-date-display');
        if (modal && !modal.classList.contains('hidden') && dateDisplay && dateDisplay.value) {
          const dateStr = dateDisplay.value;
          const dayEvents = localEvents.filter(e => {
            if (!e.start) return false;
            let eDate;
            if (e.start.date) eDate = e.start.date;
            else if (e.start.dateTime) eDate = e.start.dateTime.split('T')[0];
            return eDate === dateStr;
          });
          if (typeof renderEventList === 'function') renderEventList(dayEvents, dateStr);
        }
      }
      console.log('[SyncQueue] Processing complete. Remaining:', this.queue.length);
    }
  };

  // Listen for browser coming back online to process queue
  window.addEventListener('online', () => {
    console.log('[SyncQueue] Browser online. Processing queue...');
    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  });

  // Initialize SyncQueue on load
  SyncQueue.init();

  // Link Handler Definition
  const LinkPasteHandler = {
    // State
    lastPasteTime: 0,
    debounceMs: 500,
    currentLinkTaskId: null,
    dateOverlayTimeout: null,

    // Initialize paste listener
    init() {
      document.addEventListener('paste', (e) => this.handlePaste(e));
      this.initDateOverlay();
      console.log('LinkPasteHandler initialized');
    },

    // Handle paste event
    async handlePaste(e) {
      // Debounce rapid pastes
      const now = Date.now();
      if (now - this.lastPasteTime < this.debounceMs) return;
      this.lastPasteTime = now;

      // Skip if pasting into an input field
      const activeEl = document.activeElement;
      const isInputField = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable
      );
      if (isInputField) return;

      // Try to read from clipboard
      let text = '';
      try {
        // Prefer async clipboard API
        if (navigator.clipboard && navigator.clipboard.readText) {
          text = await navigator.clipboard.readText();
        } else {
          // Fallback to clipboardData
          text = e.clipboardData?.getData('text/plain') || '';
        }
      } catch (err) {
        // Permission denied or unavailable
        text = e.clipboardData?.getData('text/plain') || '';
      }

      text = text.trim();

      // Validate URL (http/https only)
      if (!this.isValidUrl(text)) return;

      // Create link task card
      await this.createLinkTask(text);
    },

    // Check if string is valid http/https URL
    isValidUrl(str) {
      try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },

    // Fetch page title from URL
    async fetchPageTitle(url) {
      try {
        const response = await fetch(url, { mode: 'cors' });
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title = doc.querySelector('title')?.textContent?.trim();
        return title || null;
      } catch {
        // Fetch failed (CORS, offline, etc.)
        return null;
      }
    },

    // Get fallback title from URL
    getFallbackTitle(url) {
      try {
        const parsed = new URL(url);
        // Use hostname without www
        let hostname = parsed.hostname.replace(/^www\./, '');
        // Capitalize first letter
        hostname = hostname.charAt(0).toUpperCase() + hostname.slice(1);
        return hostname;
      } catch {
        return 'Check this link';
      }
    },

    // Create a link task card
    async createLinkTask(url) {
      // Fetch title (with fallback)
      let title = await this.fetchPageTitle(url);
      if (!title) {
        title = this.getFallbackTitle(url);
      }

      // Create task object (temp ID)
      const tempId = 'temp-' + Date.now();
      const newTask = {
        id: tempId,
        title: title,
        notes: url, // Store URL in notes
        status: 'needsAction',
        due: null, // No due date initially
        isLinkTask: true, // Flag for specific styling/behavior
        syncStatus: 'pending' // Mark for sync
      };

      // Add to UI
      activeTasks.unshift(newTask); // Add to top
      renderTasks();
      saveLocalTasks();

      // Sync to Google Tasks
      syncTasks();

      showNotification('Link saved to Tasks', 'success');
    },

    initDateOverlay() {
      // (Optional) If you want date overlay logic, add here
    }
  };


  // Load saved settings from chrome.storage.local FIRST (before any UI initialization)
  await new Promise((resolve) => {
    chrome.storage.local.get([
      'theme_preference', 'theme_mode', 'accent_color', 'gradient_enabled', 'gradient_color_1', 'gradient_color_2', 'clock_swap_enabled', 'font_hud_preference', 'solid_bg_color',
      'isLoggedIn', 'google_user_persistent', 'last_known_email', 'last_known_name', 'last_known_picture'
    ], (result) => {
      console.log('[Dashboard] Loaded settings from chrome.storage.local:', result);

      // --- IMMEDIATE AUTH UI RESTORATION ---
      const isLoggedIn = result.isLoggedIn;
      const isPersistent = result.google_user_persistent;
      if (isLoggedIn || isPersistent) {
        // Enforce logged-in state immediately to prevent flicker
        document.body.classList.add('logged-in');
        const loginRow = document.getElementById('login-row');
        const headerLoginBtn = document.getElementById('header-login-btn');
        if (loginRow) loginRow.style.display = 'none';
        if (headerLoginBtn) headerLoginBtn.style.display = 'none';

        // Restore profile from cache
        const profilePic = document.getElementById('user-profile-pic');
        const profileName = document.getElementById('user-display-name');
        const profileEmail = document.getElementById('user-email');
        if (profileEmail && result.last_known_email) profileEmail.textContent = result.last_known_email.toUpperCase();
        if (profileName && result.last_known_name) profileName.textContent = result.last_known_name;
        if (profilePic && result.last_known_picture) profilePic.src = result.last_known_picture;
      }
      // ------------------------------------

      // Apply theme
      const theme = result.theme_mode || result.theme_preference || 'auto';
      console.log('[Dashboard] Applying theme mode:', theme);

      if (theme === 'light') {
        document.documentElement.classList.add('light-theme');
      } else if (theme === 'dark') {
        document.documentElement.classList.remove('light-theme');
      } else {
        // Auto
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.classList.toggle('light-theme', !prefersDark);
      }

      localStorage.setItem('theme_mode', theme);
      localStorage.setItem('theme_preference', theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme);

      // Apply background color IMMEDIATELY - this is critical to prevent flash
      // Priority: chrome.storage.local > localStorage > theme-based default
      let finalBg = '';
      if (result.solid_bg_color) {
        finalBg = result.solid_bg_color;
        localStorage.setItem('solid_bg_color', result.solid_bg_color);
      } else {
        // Use theme-based default
        const isLightTheme = document.documentElement.classList.contains('light-theme');
        finalBg = isLightTheme ? '#F2F2F2' : '#0A0A0B';
      }

      // Apply immediately with maximum priority
      const doc = document.documentElement;
      doc.style.setProperty('--bg-core', finalBg);
      doc.style.setProperty('--bg-core-inline', finalBg);
      doc.style.backgroundColor = finalBg;

      // Also set body background immediately
      const applyBodyBg = function () {
        if (document.body) {
          document.body.style.setProperty('--bg-core-inline', finalBg);
          document.body.style.backgroundColor = finalBg;
          return true;
        }
        return false;
      };

      if (!applyBodyBg()) {
        // Watch for body creation
        const bodyObserver = new MutationObserver(function () {
          if (applyBodyBg()) {
            bodyObserver.disconnect();
          }
        });
        bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
        // Also try on next tick
        setTimeout(applyBodyBg, 0);
      }


      // Apply font
      if (result.font_hud_preference) {
        console.log('[Dashboard] Applying HUD font:', result.font_hud_preference);
        document.documentElement.style.setProperty('--font-hud', result.font_hud_preference);
        localStorage.setItem('font_hud_preference', result.font_hud_preference);
      }

      // Apply accent color
      if (result.accent_color) {
        console.log('[Dashboard] Applying accent color:', result.accent_color);
        document.documentElement.style.setProperty('--accent-color', result.accent_color);

        // Also set RGB version for RGBA usage
        const cleanHex = result.accent_color.replace('#', '');
        const r = parseInt(cleanHex.slice(0, 2), 16);
        const g = parseInt(cleanHex.slice(2, 4), 16);
        const b = parseInt(cleanHex.slice(4, 6), 16);
        document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);

        localStorage.setItem('accent_color', result.accent_color);
      }

      // Apply gradient colors
      if (result.gradient_color_1 && result.gradient_color_2) {
        console.log('[Dashboard] Applying gradient colors:', result.gradient_color_1, result.gradient_color_2);
        document.documentElement.style.setProperty('--gradient-color-1', result.gradient_color_1);
        document.documentElement.style.setProperty('--gradient-color-2', result.gradient_color_2);
        localStorage.setItem('gradient_color_1', result.gradient_color_1);
        localStorage.setItem('gradient_color_2', result.gradient_color_2);
      }


      // Apply gradient enabled state
      if (result.gradient_enabled !== undefined) {
        console.log('[Dashboard] Applying gradient_enabled:', result.gradient_enabled);
        const gradientLayer = document.querySelector('.gradient-layer');
        if (result.gradient_enabled && gradientLayer) {
          gradientLayer.classList.add('enabled');
        } else if (!result.gradient_enabled && gradientLayer) {
          gradientLayer.classList.remove('enabled');
        }
        localStorage.setItem('gradient_enabled', String(result.gradient_enabled));
      }

      // Apply layout
      if (result.clock_swap_enabled !== undefined) {
        console.log('[Dashboard] Applying clock_swap_enabled:', result.clock_swap_enabled);
        if (result.clock_swap_enabled) {
          document.body.classList.add('swap-header');
          localStorage.setItem('clock_swap_enabled', 'true');
        } else {
          document.body.classList.remove('swap-header');
          localStorage.setItem('clock_swap_enabled', 'false');
        }
      }

      console.log('[Dashboard] Settings application complete, resolving...');
      resolve();
    });
  });

  console.log('[Dashboard] All settings loaded and applied from chrome.storage.local');

  try { initClock(); } catch (e) { console.error("Clock init failed", e); }

  try { loadTasks(); } catch (e) { console.error("Tasks init failed", e); }
  try { initSettings(); } catch (e) { console.error("Settings init failed", e); }
  try { initLogin(); } catch (e) { console.error("Login init failed", e); }
  try { initTaskListeners(); } catch (e) { console.error("Task listeners failed", e); }
  try {
    import('./drive.js').then(module => {
      window.driveModule = module;
      module.initDriveUpload('#drive-target-card');
    }).catch(e => console.error("Drive module load failed", e));
  } catch (e) { console.error("Drive init failed", e); }
  try { initGestureListeners(); } catch (e) { console.error("Gesture listeners failed", e); }
  try { initWeather(); } catch (e) { console.error("Weather init failed", e); }
  try { initCalendarState(); } catch (e) { console.error("Calendar init failed", e); }
  try { initCalendarScrollEffects(); } catch (e) { console.error("Calendar scroll effects init failed", e); }
  try { initRotatingTips(); } catch (e) { console.error("Rotating tips failed", e); }
  try { initSiteTracker(); } catch (e) { console.error("Site Tracker init failed", e); }
  try { initNexus(); } catch (e) { console.error("Nexus Console init failed", e); }
  try { initOnboardingUI(); } catch (e) { console.error("Onboarding init failed", e); }
  try { initModuleResizing(); } catch (e) { console.error("Module resizing failed", e); }
  try { initTaskHoverExpansion(); } catch (e) { console.error("Task hover expansion failed", e); }
  try { if (typeof LinkPasteHandler !== 'undefined') LinkPasteHandler.init(); } catch (e) { console.error("LinkPasteHandler init failed", e); }



  // SIMPLE POLLING APPROACH - Check for token every 500ms and update profile
  let isAuthCheckRunning = false;
  let authCheckInterval = setInterval(async () => {
    if (isAuthCheckRunning) return; // Prevent re-entrancy
    isAuthCheckRunning = true;

    try {
      const result = await chrome.storage.local.get(['google_access_token', 'isLoggedIn']);
      const token = result.google_access_token;
      const isLoggedIn = result.isLoggedIn;

      if (token && isLoggedIn) {
        console.log("[Auth] 🎯 POLLING: Token found in storage! Updating profile...");

        // Hide login UI immediately to reduce flicker
        hideConnectUI();

        // Update profile
        const success = await updateProfileInSettings(token);

        // Stop polling once successful OR if it consistently fails
        if (success) {
          clearInterval(authCheckInterval);
          console.log("[Auth] ✅ Profile updated! Polling stopped.");

          // Sync workspace
          if (typeof syncWorkspace === 'function') {
            syncWorkspace(token);
          }
        } else {
          console.log("[Auth] Profile update failed during polling, will retry in next interval...");
        }
      }
    } catch (err) {
      console.error("[Auth] Polling error:", err);
    } finally {
      isAuthCheckRunning = false;
    }
  }, 500); // Check every 500ms

  // Stop polling after 30 seconds to avoid infinite loop
  setTimeout(() => {
    clearInterval(authCheckInterval);
    console.log("[Auth] ⏱️ Polling timeout - stopped checking for token");
  }, 30000);

  // Wait for fonts to be ready to prevent shifting
  if (document.fonts) {
    await document.fonts.ready;
  }
  document.body.classList.add('loaded');


  // Final pass: enforce background color
  restoreBackgroundSettings();

  // Listen for silent token refresh from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'token_refreshed_silently' && message.token) {
      console.log('[Dashboard] Received silent token refresh notification');
      updateProfileInSettings(message.token);
      syncWorkspace(message.token);
    }
  });

  // Proactive token validation on visibility change (tab becomes active)
  // Track when tab became hidden to detect long idle periods
  let lastVisibilityCheck = 0;
  let hiddenSince = 0;

  document.addEventListener('visibilitychange', async () => {
    const now = Date.now();

    if (document.visibilityState === 'hidden') {
      // Track when tab became hidden
      hiddenSince = now;
      console.log('[Dashboard] Tab hidden - tracking idle start');
    } else if (document.visibilityState === 'visible') {
      const idleTime = hiddenSince > 0 ? now - hiddenSince : 0;
      const idleMinutes = Math.round(idleTime / 60000);

      // If idle for 30+ minutes, ALWAYS refresh token immediately (token likely expired)
      if (idleTime > 30 * 60 * 1000) {
        console.log(`[Dashboard] Returned after ${idleMinutes} min idle - forcing token refresh`);
        lastVisibilityCheck = now;
        hiddenSince = 0;

        // Force immediate token validation and refresh
        try {
          const token = await getValidToken();
          if (token) {
            console.log('[Dashboard] Token refreshed after long idle');
            await updateProfileInSettings(token);
            syncWorkspace(token);
          } else {
            // Token refresh failed - trigger full auth check
            console.log('[Dashboard] Token refresh failed after idle - running full auth check');
            checkAuthStatus();
          }
        } catch (err) {
          console.error('[Dashboard] Error refreshing token after idle:', err);
          checkAuthStatus();
        }
        return;
      }

      // For shorter idle periods (5-30 min), use throttled check
      if (now - lastVisibilityCheck > 5 * 60 * 1000) {
        lastVisibilityCheck = now;
        console.log('[Dashboard] Tab visible - checking auth status proactively');
        checkAuthStatus();
      }

      hiddenSince = 0;
    }
  });

  // Also set up a periodic token keep-alive while tab is visible (every 45 min)
  // This prevents token from expiring during active but idle viewing
  setInterval(async () => {
    if (document.visibilityState === 'visible') {
      console.log('[Dashboard] Periodic token keep-alive check');
      try {
        const token = await getValidToken();
        if (token) {
          console.log('[Dashboard] Token still valid (keep-alive)');
        }
      } catch (err) {
        console.warn('[Dashboard] Keep-alive token check failed:', err.message);
      }
    }
  }, 45 * 60 * 1000); // Every 45 minutes (before 1-hour token expiry)

  /* ═══════════════════════════════════════════════════════════════════════════
     ONBOARDING UI
     ═══════════════════════════════════════════════════════════════════════════ */
  function initOnboardingUI() {
    const modal = document.getElementById('onboarding-modal');
    if (!modal) return;

    // FORCE FULL SCREEN STYLES IN JS TO BE ABSOLUTELY SURE
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.zIndex = '2147483647';
    modal.style.backgroundColor = document.body.classList.contains('light-theme') ? '#FAFAFA' : '#09090B';

    // Check if onboarding has been completed
    chrome.storage.local.get(['onboarding_completed'], (result) => {
      if (result.onboarding_completed) {
        console.log('[Onboarding] Already completed, removing elements from DOM');
        const elementsToRemove = [
          document.getElementById('onboarding-modal'),
          document.getElementById('ob-tour-overlay'),
          document.getElementById('ob-confetti')
        ];
        elementsToRemove.forEach(el => { if (el) el.remove(); });
        return;
      }

      console.log('[Onboarding] Starting onboarding experience');
      modal.classList.add('active');
      initOnboardingLogic();
    });


    function initOnboardingLogic() {
      // State
      let currentPhase = 1;
      const totalPhases = 5;
      let currentTourSlide = 1;
      const totalTourSlides = 5;

      // User Preferences State
      const state = {
        theme: 'auto',
        layout: 'balanced',
        accent: '#FF6B00',
        googleConnected: false,
        gradientEnabled: true,
        clockShowSeconds: false
      };

      // DOM Elements - Navigation
      const phaseElements = document.querySelectorAll('.ob-phase');
      const modal = document.getElementById('onboarding-modal');
      const progressFill = document.getElementById('ob-progress-fill');
      const progressText = document.getElementById('ob-progress-text');
      const currentStepSpan = document.getElementById('ob-current-step');
      const skipLink = document.getElementById('ob-skip-link');

      // Phase 1: Welcome
      const startBtn = document.getElementById('ob-start-btn');
      const skipIntroBtn = document.getElementById('ob-skip-intro');

      // Phase 2: Personalization
      const themeSelector = document.getElementById('ob-theme-selector');
      const layoutOptions = document.getElementById('ob-layout-options');
      const colorSwatches = document.getElementById('ob-color-swatches');
      const applyContinueBtn = document.getElementById('ob-apply-continue');

      // Live Preview Elements
      const livePreviewClock = document.getElementById('ob-preview-clock');
      const livePreviewDate = document.getElementById('ob-preview-date');
      const livePreviewContainer = document.querySelector('.ob-dashboard-preview.ob-live');

      // Phase 3: Google Connect
      const googleConnectBtn = document.getElementById('ob-google-connect-btn');
      const offlineModeBtn = document.getElementById('ob-offline-mode-btn');
      const connectButtons = document.getElementById('ob-connect-buttons');
      const connectSuccess = document.getElementById('ob-connect-success');

      // Phase 4: Command Center
      const enterDashboardBtn = document.getElementById('ob-enter-dashboard-btn');

      // Navigation Bar Elements
      const backBtn = document.getElementById('ob-back-btn');
      const skipBtn = document.getElementById('ob-skip-btn');
      const continueBtn = document.getElementById('ob-continue-btn');

      // Phase 5: Feature Tour (Carousel)
      const tourOverlay = document.getElementById('ob-tour-overlay');
      const tourSlides = document.querySelectorAll('.ob-tour-slide');
      const tourDots = document.getElementById('ob-tour-dots');
      const tourNextBtn = document.getElementById('ob-tour-next');
      const tourSkipBtn = document.getElementById('ob-tour-skip');
      const tourCloseBtn = document.getElementById('ob-tour-close');

      // ─────────────────────────────────────────────────────────────
      // 1. INITIALIZATION & CLOCK
      // ─────────────────────────────────────────────────────────────

      function updatePreviewClock() {
        const now = new Date();
        let hours = now.getHours();
        const minutes = now.getMinutes().toString().padStart(2, '0');
        hours = hours % 12 || 12;

        const timeStr = `${hours}:${minutes}`;
        const options = { weekday: 'long', month: 'long', day: 'numeric' };
        const dateStr = now.toLocaleDateString('en-US', options).toUpperCase();

        if (livePreviewClock) livePreviewClock.textContent = timeStr;
        if (livePreviewDate) livePreviewDate.textContent = dateStr;
      }

      updatePreviewClock();
      setInterval(updatePreviewClock, 1000);

      // ─────────────────────────────────────────────────────────────
      // 2. NAVIGATION LOGIC
      // ─────────────────────────────────────────────────────────────

      function updateProgress() {
        const percentage = (currentPhase / totalPhases) * 100;
        if (progressFill) progressFill.style.width = `${percentage}%`;
        if (progressText) progressText.textContent = `Step ${currentPhase} of ${totalPhases}`;
        if (currentStepSpan) currentStepSpan.textContent = currentPhase;

        // Hide progress bar on final steps if desired
        if (currentPhase === totalPhases && progressText) {
          progressText.textContent = "Final Step";
        }
      }

      function goToPhase(phaseNum) {
        if (phaseNum < 1 || phaseNum > totalPhases) return;

        // Current Phase Cleanup
        phaseElements.forEach(p => {
          if (parseInt(p.dataset.phase) === currentPhase) {
            p.classList.add('exiting');
            p.classList.remove('active');
          }
        });

        // Next Phase Entrance
        setTimeout(() => {
          phaseElements.forEach(p => p.classList.remove('exiting'));

          const targetPhase = modal.querySelector(`.ob-phase[data-phase="${phaseNum}"]`);
          if (targetPhase) {
            targetPhase.classList.add('active');
          }

          currentPhase = phaseNum;
          updateProgress();
          updateNavigation();

          // Special Handling for Tour (Phase 5)
          if (currentPhase === 5) {
            // Show tour overlay
            setTimeout(() => {
              if (tourOverlay) {
                tourOverlay.classList.add('active');
                initTourCarousel();
              }
            }, 300);
          } else {
            // Hide tour overlay if not on phase 5
            if (tourOverlay) {
              tourOverlay.classList.remove('active');
            }
          }
        }, 300);
      }

      function updateNavigation() {
        // Hide global nav on Phase 1 (Welcome) and Phase 5 (Tour)
        const navBar = document.getElementById('ob-navigation');
        if (navBar) {
          if (currentPhase === 1 || currentPhase === 5) {
            navBar.style.opacity = '0';
            navBar.style.pointerEvents = 'none';
          } else {
            navBar.style.opacity = '1';
            navBar.style.pointerEvents = 'auto';
          }
        }

        // Back button
        if (backBtn) {
          backBtn.disabled = currentPhase === 1;
        }

        // Continue button text
        if (continueBtn) {
          if (currentPhase === 1) {
            continueBtn.textContent = 'Continue';
          } else if (currentPhase === 2) {
            continueBtn.textContent = 'Looks good';
          } else if (currentPhase === 3) {
            continueBtn.textContent = 'Continue';
          } else if (currentPhase === 4) {
            continueBtn.textContent = state.googleConnected ? 'Continue' : 'Skip & Continue';
          } else if (currentPhase >= 5) {
            continueBtn.textContent = 'Next';
          }
        }

        // Skip button visibility
        if (skipBtn) {
          skipBtn.style.display = currentPhase < 5 ? 'block' : 'none';
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 3. PHASE 1: WELCOME
      // ─────────────────────────────────────────────────────────────

      // ─────────────────────────────────────────────────────────────
      // 3. PHASE 1: WELCOME & GLOBAL NAVIGATION LISTENERS
      // ─────────────────────────────────────────────────────────────

      // Use delegation for critical buttons to ensure they work even if DOM updates
      if (modal) {
        modal.addEventListener('click', (e) => {
          const target = e.target;

          // 1. START BUTTON
          if (target.closest('#ob-start-btn')) {
            console.log('[Onboarding] Start Clicked');
            goToPhase(2);
            return;
          }

          // Skip Intro / Skip Link
          if (e.target.closest('#ob-skip-intro') || e.target.closest('#ob-skip-btn')) {
            e.preventDefault();
            finishOnboarding();
          }

          // Back Button
          if (e.target.closest('#ob-back-btn')) {
            if (currentPhase > 1 && currentPhase <= totalPhases) {
              goToPhase(currentPhase - 1);
            }
          }

          // Continue Button (Global Nav)
          if (e.target.closest('#ob-continue-btn')) {
            if (currentPhase < totalPhases) {
              // Special checks before proceeding
              if (currentPhase === 2) {
                // Saving done in goToPhase or separate? 
                // Phase 2 is customization, we can just save current state
                saveIntermediateSettings();
              }
              goToPhase(currentPhase + 1);
            } else {
              // Finish if at end (though phase 5 usually handles its own tour)
              // But if we are at Phase 5 in the DOM flow without tour overlay
              if (currentPhase === 5) {
                // Trigger tour or finish?
                // "Take the Tour" is Phase 4 -> Phase 5.
                // Phase 5 loads tour.
              }
            }
          }

          // Apply & Continue (Phase 2 specific)
          if (e.target.closest('#ob-apply-continue')) {
            state.theme = state.theme || 'auto'; // ensure default
            saveIntermediateSettings();
            goToPhase(3);
          }

          // Enter Dashboard (Phase 4)
          if (e.target.closest('#ob-enter-dashboard-btn')) {
            goToPhase(5);
          }
        });
      }

      // Old listeners removed in favor of delegation
      // 3. PHASE 1: WELCOME & GLOBAL NAVIGATION LISTENERS (Handled by delegation above)

      // ─────────────────────────────────────────────────────────────
      // 4. PHASE 2: PERSONALIZATION
      // ─────────────────────────────────────────────────────────────

      // Theme Selector
      if (themeSelector) {
        themeSelector.querySelectorAll('.ob-theme-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            themeSelector.querySelectorAll('.ob-theme-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const theme = btn.dataset.theme;
            state.theme = theme;
            applyThemePreview(theme);
          });
        });
      }

      // Layout Options
      if (layoutOptions) {
        layoutOptions.querySelectorAll('.ob-layout-option').forEach(option => {
          option.addEventListener('click', () => {
            layoutOptions.querySelectorAll('.ob-layout-option').forEach(o => o.classList.remove('active'));
            option.classList.add('active');
            const layout = option.dataset.layout;
            state.layout = layout;
            applyLayoutPreview(layout);
          });
        });
      }

      // Color Swatches
      if (colorSwatches) {
        colorSwatches.querySelectorAll('.ob-color-swatch').forEach(swatch => {
          swatch.addEventListener('click', () => {
            colorSwatches.querySelectorAll('.ob-color-swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');
            const color = swatch.dataset.color;
            state.accent = color;
            applyAccentPreview(color);
          });
        });
      }

      // Live preview helpers
      function applyThemePreview(theme) {
        if (livePreviewContainer) {
          // Since main theme involves body classes, we can't easily preview light/dark 
          // without affecting the whole page. 
          // Mock it by setting background on the preview container
          if (theme === 'light') {
            livePreviewContainer.classList.add('light-preview');
            livePreviewContainer.style.background = '#FFFFFF';
            livePreviewContainer.style.color = '#18181B';
          } else {
            livePreviewContainer.classList.remove('light-preview');
            livePreviewContainer.style.background = 'var(--ob-glass-bg-solid)';
            livePreviewContainer.style.color = 'var(--ob-text-primary)';
          }
        }
      }

      function applyLayoutPreview(layout) {
        if (livePreviewContainer) {
          if (layout === 'clock-first') {
            livePreviewContainer.classList.add('swap-header');
          } else {
            livePreviewContainer.classList.remove('swap-header');
          }
        }
      }

      function applyAccentPreview(color) {
        if (livePreviewContainer) {
          livePreviewContainer.style.setProperty('--ob-accent', color);
          const date = livePreviewContainer.querySelector('.ob-preview-date');
          if (date) date.style.color = color;
        }
      }

      // ─────────────────────────────────────────────────────────────
      // 5. PHASE 3: GOOGLE SYNC
      // ─────────────────────────────────────────────────────────────

      // Google Connect Button - USES WORKER FOR PERSISTENT LOGIN
      if (googleConnectBtn) {
        googleConnectBtn.addEventListener('click', async () => {
          console.log('[Onboarding] Google Connect clicked - using Worker auth');
          try {
            googleConnectBtn.disabled = true;
            googleConnectBtn.textContent = 'Connecting...';

            // Use Worker-based auth flow for persistent login
            const response = await new Promise((resolve, reject) => {
              chrome.runtime.sendMessage({ type: 'START_WORKER_AUTH' }, (result) => {
                if (chrome.runtime.lastError) {
                  reject(chrome.runtime.lastError.message);
                } else if (result && result.success) {
                  resolve(result);
                } else {
                  reject(result?.error || 'Auth flow failed');
                }
              });
            });

            if (response.token) {
              state.googleConnected = true;

              // Show success
              if (connectButtons) connectButtons.classList.add('hidden');
              if (connectSuccess) {
                connectSuccess.classList.remove('hidden');
                connectSuccess.classList.add('visible');
                const successTitle = connectSuccess.querySelector('h3');
                if (successTitle) successTitle.textContent = 'Connected Successfully!';
              }

              updateNavigation();
              console.log('[Onboarding] Google connected successfully via Worker');
            }
          } catch (error) {
            console.error('[Onboarding] Google connect error:', error);
            googleConnectBtn.disabled = false;
            googleConnectBtn.textContent = 'Connect with Google';
          }
        });
      }

      // Offline Mode Button
      if (offlineModeBtn) {
        offlineModeBtn.addEventListener('click', () => {
          console.log('[Onboarding] Offline mode selected');
          state.googleConnected = false;
          if (connectButtons) connectButtons.classList.add('hidden');
          if (connectSuccess) {
            connectSuccess.classList.remove('hidden');
            connectSuccess.classList.add('visible');
            // Update success message for offline mode
            const successTitle = connectSuccess.querySelector('h3');
            if (successTitle) successTitle.textContent = 'Offline Mode Selected';
          }
          updateNavigation();
        });
      }

      // ─────────────────────────────────────────────────────────────
      // 7. PHASE 5: FEATURE TOUR CAROUSEL
      // ─────────────────────────────────────────────────────────────

      function initTourCarousel() {
        showTourSlide(1);
      }

      function showTourSlide(n) {
        if (n < 1 || n > totalTourSlides) return;

        // Hide all slides
        tourSlides.forEach(s => {
          s.classList.remove('active');
          s.classList.remove('prev');
          s.classList.remove('exiting');
        });

        const next = tourOverlay?.querySelector(`.ob-tour-slide[data-slide="${n}"]`);

        if (next) {
          next.classList.add('active');
        }

        // Update dots
        if (tourDots) {
          const dots = tourDots.querySelectorAll('.ob-tour-dot');
          dots.forEach(d => d.classList.remove('active'));
          if (dots[n - 1]) dots[n - 1].classList.add('active');
        }

        // Update button text
        if (tourNextBtn) {
          if (n === totalTourSlides) {
            tourNextBtn.textContent = "I'm Ready — Launch Dashboard!";
          } else {
            tourNextBtn.textContent = "Next";
          }
        }

        currentTourSlide = n;
      }

      if (tourNextBtn) {
        tourNextBtn.addEventListener('click', () => {
          if (currentTourSlide < totalTourSlides) {
            showTourSlide(currentTourSlide + 1);
          } else {
            finishOnboarding();
          }
        });
      }

      if (tourSkipBtn) {
        tourSkipBtn.addEventListener('click', finishOnboarding);
      }

      if (tourCloseBtn) {
        tourCloseBtn.addEventListener('click', finishOnboarding);
      }

      if (tourDots) {
        tourDots.querySelectorAll('.ob-tour-dot').forEach((dot, index) => {
          dot.addEventListener('click', () => {
            showTourSlide(index + 1);
          });
        });
      }

      // ─────────────────────────────────────────────────────────────
      // FINALIZATION
      // ─────────────────────────────────────────────────────────────

      // Apply functions for theme, accent, and layout
      function applyTheme(theme) {
        const themeMode = theme === 'auto' ? 'auto' : theme;
        if (theme === 'light') {
          document.documentElement.classList.add('light-theme');
        } else if (theme === 'dark') {
          document.documentElement.classList.remove('light-theme');
        } else {
          // Auto
          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          document.documentElement.classList.toggle('light-theme', !prefersDark);
        }
        chrome.storage.local.set({
          theme_mode: themeMode,
          theme_preference: themeMode
        });
        localStorage.setItem('theme_mode', themeMode);
        localStorage.setItem('theme_preference', themeMode);
      }

      function applyAccent(color) {
        document.documentElement.style.setProperty('--accent-color', color);
        const cleanHex = color.replace('#', '');
        const r = parseInt(cleanHex.slice(0, 2), 16);
        const g = parseInt(cleanHex.slice(2, 4), 16);
        const b = parseInt(cleanHex.slice(4, 6), 16);
        document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
        chrome.storage.local.set({ accent_color: color });
      }

      function applyLayout(layout) {
        const clockSwapEnabled = layout === 'clock-first';
        if (clockSwapEnabled) {
          document.body.classList.add('swap-header');
        } else {
          document.body.classList.remove('swap-header');
        }
        chrome.storage.local.set({ clock_swap_enabled: clockSwapEnabled });
        localStorage.setItem('clock_swap_enabled', String(clockSwapEnabled));
      }

      function saveIntermediateSettings() {
        const settings = {
          theme_preference: state.theme,
          theme_mode: state.theme,
          accent_color: state.accent,
          clock_swap_enabled: state.layout === 'clock-first'
        };
        chrome.storage.local.set(settings);

        applyTheme(state.theme);
        applyAccent(state.accent);
        applyLayout(state.layout);
      }

      function finishOnboarding() {
        // Save
        const settings = {
          onboarding_completed: true,
          theme_preference: state.theme,
          theme_mode: state.theme,
          accent_color: state.accent,
          clock_swap_enabled: state.layout === 'clock-first'
        };

        chrome.storage.local.set(settings, () => {
          console.log('[Onboarding] Completed & Saved');
        });

        // Celebration
        triggerConfetti();

        // Close
        setTimeout(() => {
          modal.classList.remove('active');
          setTimeout(() => {
            modal.remove();
            const c = document.getElementById('ob-confetti');
            if (c) c.remove();

            // Allow interactions with main page
            document.body.style.overflow = '';
          }, 1000);
        }, 1500);
      }

      // Confetti Helper
      function triggerConfetti() {
        const cContainer = document.getElementById('ob-confetti');
        if (!cContainer) return;

        const colors = ['#FF6B00', '#8B5CF6', '#06B6D4', '#22C55E', '#F43F5E'];

        for (let i = 0; i < 60; i++) {
          const el = document.createElement('div');
          el.className = 'ob-confetti-piece';
          el.style.left = Math.random() * 100 + '%';
          el.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
          el.style.animationDelay = Math.random() * 0.5 + 's';
          cContainer.appendChild(el);

          requestAnimationFrame(() => el.classList.add('animate'));
        }
      }

      // Initialize progress and navigation
      updateProgress();
      setTimeout(() => {
        updateNavigation();
      }, 0);
    }

    // Initialize - these will be called inside initOnboardingLogic
    // The functions are now properly scoped inside initOnboardingLogic
  }


  // GLOBAL UTILS
  function triggerSync() {
    window.dispatchEvent(new CustomEvent('essentials_settings_changed'));
  }

  // HELPER: Robust Google API Fetch with Auto-Refresh & Caching
  // Enhanced to use ensureToken() pattern - validates token BEFORE request
  async function googleApiFetch(url, options = {}, retryCount = 0) {
    try {
      // NEW: Proactively ensure token is valid BEFORE making request
      // This uses background's ensureToken() which refreshes 5 min before expiry
      if (retryCount === 0) {
        try {
          const freshToken = await getValidToken();
          if (!options.headers) options.headers = {};
          options.headers['Authorization'] = `Bearer ${freshToken}`;
        } catch (tokenError) {
          console.warn('[Google API] Could not get valid token, trying with existing:', tokenError);
        }
      }

      // Use cached fetch if available (for GET requests only)
      const isGetRequest = !options.method || options.method === 'GET';
      const useCache = isGetRequest && window.PerformanceUtils;

      let response;
      if (useCache) {
        // Pass skipCache option if present
        const skipCache = options.skipCache === true;
        response = await window.PerformanceUtils.cachedFetch(url, { ...options, skipCache }, url, 30000);
      } else {
        response = await fetch(url, options);
      }

      if ((response.status === 401 || response.status === 403) && retryCount < 2) {
        console.warn(`[Google API] Auth error ${response.status}. Retrying... (${retryCount + 1})`);

        const oldToken = options.headers?.Authorization?.replace('Bearer ', '');
        if (oldToken) {
          await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token: oldToken }, resolve));
        }

        const newToken = await refreshAuthToken();

        if (newToken) {
          const newOptions = { ...options };
          if (!newOptions.headers) newOptions.headers = {};
          newOptions.headers['Authorization'] = `Bearer ${newToken}`;
          return googleApiFetch(url, newOptions, retryCount + 1);
        } else {
          // Silent refresh failed during API call
          // Check if user is persistent - if so, interactive auth is already triggered
          const authVars = await new Promise(resolve => chrome.storage.local.get(["google_user_persistent", "isLoggedIn"], resolve));
          const isPersistent = authVars.google_user_persistent && authVars.isLoggedIn;

          if (isPersistent) {
            // Mark UI as needing reconnect but don't show ugly JSON alert
            console.log("[Google API] Silent refresh failed but user is persistent. Notifying UI.");
            window.dispatchEvent(new CustomEvent('google_auth_failed', { detail: { silent: true } }));
          } else {
            // Only dispatch auth_failed for non-persistent users
            console.error("[Google API] Silent refresh failed during API call. Dispatching auth_failed.");
            window.dispatchEvent(new CustomEvent('google_auth_failed'));
          }
        }
      }
      return response;
    } catch (err) {
      if (err.message?.includes('401') && retryCount < 2) {
        const newToken = await refreshAuthToken();
        if (newToken) {
          const newOptions = { ...options };
          if (!newOptions.headers) newOptions.headers = {};
          newOptions.headers['Authorization'] = `Bearer ${newToken}`;
          return googleApiFetch(url, newOptions, retryCount + 1);
        } else {
          // Check if user is persistent - if so, interactive auth is already triggered
          const authVars = await new Promise(resolve => chrome.storage.local.get(["google_user_persistent", "isLoggedIn"], resolve));
          const isPersistent = authVars.google_user_persistent && authVars.isLoggedIn;
          if (isPersistent) {
            console.log("[Google API] 401 error - persistent user, interactive auth triggered. Waiting for token...");
            // Wait up to 10 seconds for token to be captured, checking every 500ms
            for (let i = 0; i < 20; i++) {
              await new Promise(resolve => setTimeout(resolve, 500));
              const tokenCheck = await new Promise(resolve => chrome.storage.local.get(["google_access_token", "isLoggedIn"], result => resolve(result)));
              if (tokenCheck.google_access_token && tokenCheck.isLoggedIn) {
                console.log("[Google API] Token captured! Retrying API call...");
                const newOptions = { ...options };
                if (!newOptions.headers) newOptions.headers = {};
                newOptions.headers['Authorization'] = `Bearer ${tokenCheck.google_access_token}`;
                return googleApiFetch(url, newOptions, retryCount + 1);
              }
            }
            console.warn("[Google API] Token not captured within timeout. Re-throwing error.");
          }
        }
      }
      throw err;
    }
  }

  let isTokenRefreshInProgress = false;
  async function refreshAuthToken() {
    if (isTokenRefreshInProgress) {
      console.log("[Google API] Token refresh already in progress, waiting...");
      // Wait up to 10 seconds for current refresh
      let waitAttempts = 0;
      while (isTokenRefreshInProgress && waitAttempts < 40) {
        await new Promise(r => setTimeout(r, 250));
        waitAttempts++;
      }
      // Return whatever is in storage now
      const storage = await chrome.storage.local.get(["google_access_token"]);
      return storage.google_access_token;
    }

    isTokenRefreshInProgress = true;
    console.log("[Google API] Token refresh requested - Calling Worker via Background...");

    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'REFRESH_VIA_WORKER' }, (response) => {
        isTokenRefreshInProgress = false;
        if (response && response.token) {
          console.log("[Google API] Token refreshed successfully via Worker!");
          resolve(response.token);
        } else {
          console.warn("[Google API] Worker refresh failed:", response?.error || 'Unknown error');
          resolve(null);
        }
      });
    });
  }

  // Expose functions for drive.js module
  window.googleApiFetch = googleApiFetch;
  window.refreshAuthToken = refreshAuthToken;

  function handleNewToken(token, silent = false) {
    console.log("[Auth] 🎯 handleNewToken called. Silent:", silent);
    console.log("[Auth] Token length:", token?.length || 0);

    // Save logged-in state - this persists forever using chrome.storage.local
    const authTimestamp = Date.now();
    chrome.storage.local.set({
      "google_access_token": token,
      "isLoggedIn": true,
      "google_user_persistent": true,
      "google_auth_timestamp": authTimestamp
    }, () => {
      console.log(`[Auth] ✅ Token saved. User is now logged in (forever login enabled).`);
      console.log(`[Auth] Saved at: ${new Date(authTimestamp).toISOString()}`);

      if (!silent) {
        showNotification("Reconnected to Google", "success");
      }

      // Immediately hide login UI since we have a valid token
      const loginRow = document.getElementById('login-row');
      const loginBtn = document.getElementById('login-btn');
      const headerLoginBtn = document.getElementById('header-login-btn');
      const headerLogoutBtn = document.getElementById('header-logout-btn');

      console.log("[Auth] Hiding login UI...");
      if (loginRow) loginRow.style.display = 'none';
      if (loginBtn) loginBtn.style.display = 'none';
      if (headerLoginBtn) headerLoginBtn.style.display = 'none';
      if (headerLogoutBtn) headerLogoutBtn.style.display = 'block';

      // Update profile with new token
      console.log("[Auth] Calling updateProfileInSettings from handleNewToken...");
      updateProfileInSettings(token);
      // Ensure syncWorkspace is available or safe to call
      if (typeof syncWorkspace === 'function') syncWorkspace(token);
    });
  }

  /**
   * Fetches and displays Google profile info in settings panel
   */
  async function updateProfileInSettings(token, retryCount = 0) {
    console.log('[Auth] updateProfileInSettings called with token:', token ? 'present' : 'missing', `(retry: ${retryCount})`);

    const profilePic = document.getElementById('user-profile-pic');
    const profileName = document.getElementById('user-display-name');
    const profileEmail = document.getElementById('user-email');
    const loginRow = document.getElementById('login-row');
    const loginBtn = document.getElementById('login-btn');
    const headerLoginBtn = document.getElementById('header-login-btn');
    const headerLogoutBtn = document.getElementById('header-logout-btn');

    console.log('[Auth] Profile elements found:', {
      profilePic: !!profilePic,
      profileName: !!profileName,
      profileEmail: !!profileEmail
    });

    if (!profilePic || !profileName || !profileEmail) {
      console.warn('[Auth] Some profile elements missing, but continuing with hiding login UI');
    }

    // If no token provided, try to get it from storage
    if (!token && retryCount === 0) {
      const storage = await new Promise(resolve => chrome.storage.local.get(["google_access_token"], resolve));
      token = storage.google_access_token;
      if (token) {
        console.log('[Auth] Retrieved token from storage for profile update');
      }
    }

    if (!token) {
      console.warn('[Auth] No token available for profile update');
      return false;
    }

    try {
      console.log('[Auth] Fetching user profile from Google API...');
      // Direct fetch to userinfo API
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      console.log('[Auth] Profile API response status:', res.status);

      if (res.ok) {
        const data = await res.json();
        console.log('[Auth] Profile data received:', data.email);

        if (profilePic) profilePic.src = data.picture || 'https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y';
        if (profileName) profileName.textContent = data.name || 'USER';
        if (profileEmail) profileEmail.textContent = data.email || 'CONNECTED';

        // CACHE PROFILE INFO FOR "FOREVER" PERSISTENCE
        chrome.storage.local.set({
          "google_user_email": data.email, // CRITICAL: Match background.js key
          "last_known_email": data.email,
          "last_known_name": data.name,
          "last_known_picture": data.picture
        });

        // UPDATE WORKER MAPPING from temp to real email
        try {
          console.log('[Auth] Updating worker email mapping...');
          await fetch('https://pheonix-auth.pixelarenaltd.workers.dev/update-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              old_email: 'temp@pending.local',
              new_email: data.email
            })
          });
        } catch (e) { console.warn("[Auth] Worker email update failed (might already be updated):", e); }

        if (loginRow) loginRow.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'none';
        if (headerLoginBtn) headerLoginBtn.style.display = 'none';
        if (headerLogoutBtn) headerLogoutBtn.style.display = 'block';

        console.log('[Auth] Profile updated successfully, login UI hidden, logout UI shown');
        return true;
      } else {
        console.warn('[Auth] Profile fetch failed, status:', res.status);
        const errorText = await res.text();
        console.warn('[Auth] Error response:', errorText);

        // Retry once if it's a 401 and we haven't retried yet
        if (res.status === 401 && retryCount === 0) {
          console.log('[Auth] Profile fetch returned 401, retrying with refreshed token...');
          const newToken = await refreshAuthToken();
          if (newToken) {
            return updateProfileInSettings(newToken, 1);
          }
        }

        // If profile fails after retry, still hide login UI if we have a token
        // (token might be valid but profile API might have issues)
        if (token) {
          if (profileEmail) profileEmail.textContent = 'CONNECTED';
          if (loginRow) loginRow.style.display = 'none';
          if (loginBtn) loginBtn.style.display = 'none';
          if (headerLoginBtn) headerLoginBtn.style.display = 'none';
          if (headerLogoutBtn) headerLogoutBtn.style.display = 'block';
        } else {
          if (loginRow) loginRow.style.display = 'flex';
          if (loginBtn) loginBtn.style.display = 'block';
          if (headerLoginBtn) headerLoginBtn.style.display = 'block';
          if (headerLogoutBtn) headerLogoutBtn.style.display = 'none';
        }
        return false;
      }
    } catch (err) {
      console.error('Failed to fetch profile info:', err);

      // Retry once on network errors
      if (retryCount === 0 && (err.message?.includes('network') || err.message?.includes('fetch'))) {
        console.log('[Auth] Network error, retrying profile update...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return updateProfileInSettings(token, 1);
      }

      // If we have a token, still show as connected even if profile fetch fails
      if (token) {
        if (profileEmail) profileEmail.textContent = 'CONNECTED';
        if (loginRow) loginRow.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'none';
        if (headerLoginBtn) headerLoginBtn.style.display = 'none';
        if (headerLogoutBtn) headerLogoutBtn.style.display = 'block';
      } else {
        if (loginRow) loginRow.style.display = 'flex';
        if (loginBtn) loginBtn.style.display = 'block';
        if (headerLoginBtn) headerLoginBtn.style.display = 'block';
        if (headerLogoutBtn) headerLogoutBtn.style.display = 'none';
      }
      return false;
    }
  }


  // WEATHER
  async function initWeather() {
    const container = document.getElementById('weather-container');
    const infoEl = document.getElementById('weather-info');

    if (!container || !infoEl) return;

    // Open-Meteo WMO Weather interpretation codes (WW)
    const WEATHER_CODES = {
      0: 'Clear', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
      45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
      56: 'Freezing Drizzle', 57: 'Freezing Drizzle',
      61: 'Rain', 63: 'Rain', 65: 'Heavy Rain',
      66: 'Freezing Rain', 67: 'Freezing Rain',
      71: 'Snow', 73: 'Snow', 75: 'Heavy Snow',
      77: 'Snow Grains', 80: 'Showers', 81: 'Showers', 82: 'Violent Showers',
      85: 'Snow Showers', 86: 'Snow Showers',
      95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm'
    };

    function updateUI(temp, conditionText, locationName) {
      // Ultra minimal format: 16° CLEAR // TUNGI
      const city = locationName.split(',')[0].trim();
      if (infoEl) {
        infoEl.textContent = `${Math.round(temp)}° ${conditionText.toUpperCase()} // ${city.toUpperCase()}`;
      }

      container.style.opacity = '1';
      container.classList.add('loaded');

      localStorage.setItem('weather_cache', JSON.stringify({
        temp, conditionText, locationName, timestamp: Date.now()
      }));
    }

    async function fetchOpenMeteo(lat, lon) {
      if (!lat || !lon) {
        // Try to recover coords
        try {
          const saved = JSON.parse(localStorage.getItem('weather_last_coords'));
          if (saved && saved.lat) { lat = saved.lat; lon = saved.lon; }
        } catch (e) { }
      }
      if (!lat || !lon) {
        // Fallback to IP-API if no coords? Or just fail silently.
        // For now, if no coords, we can't do much with OpenMeteo.
        // But maybe we can try one last IP-based geo service if we really want to be robust.
        // Let's stick to using saved coords or failing gracefully.
        return;
      }

      try {
        console.log(`[Weather] Fetching from Open-Meteo for ${lat},${lon}...`);
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
        if (!res.ok) throw new Error(`OpenMeteo Error: ${res.status}`);

        const data = await res.json();
        if (data.current_weather) {
          const temp = data.current_weather.temperature;
          const code = data.current_weather.weathercode;
          const conditionText = WEATHER_CODES[code] || "Unknown";

          // Attempt to get city name from cache or use generic
          let cityName = "Local";
          try {
            const cached = JSON.parse(localStorage.getItem('weather_cache'));
            if (cached && cached.locationName) cityName = cached.locationName.split(',')[0];
          } catch (e) { }

          updateUI(temp, conditionText, cityName);
        }
      } catch (err) {
        console.error("OpenMeteo Error:", err);
        if (container) container.classList.add('loaded'); // Show despite error
      }
    }

    async function fetchWeatherData(lat, lon, retryCount = 0) {
      let url = "https://wttr.in/?format=j1";
      if (lat && lon) {
        // Use a cache-busting parameter to bypass some HTTP/2 issues
        url = `https://wttr.in/${lat},${lon}?format=j1&_t=${Date.now()}`;
        localStorage.setItem('weather_last_coords', JSON.stringify({ lat, lon }));
      }

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Weather API Error: ${res.status}`);

        const data = await res.json();
        if (data.current_condition && data.current_condition[0]) {
          const current = data.current_condition[0];
          const temp = current.temp_C;
          const conditionText = current.weatherDesc[0].value;

          let CityName = "Unknown";
          if (data.nearest_area && data.nearest_area[0]) {
            const area = data.nearest_area[0];
            CityName = area.areaName ? area.areaName[0].value : "Unknown";
          }
          updateUI(temp, conditionText, CityName);
        }
      } catch (err) {
        console.error("Weather Error:", err);

        // Retry logic for transient network errors (like ERR_HTTP2_PROTOCOL_ERROR)
        if (retryCount < 2) {
          console.log(`[Weather] Retrying fetch... (${retryCount + 1})`);
          await new Promise(r => setTimeout(r, 2000 * (retryCount + 1)));
          return fetchWeatherData(lat, lon, retryCount + 1);
        }

        // Fallback to OpenMeteo
        console.log("[Weather] Falling back to OpenMeteo...");
        return fetchOpenMeteo(lat, lon);
      }
    }

    // 1. Instant Cache Load
    const cached = JSON.parse(localStorage.getItem('weather_cache'));
    if (cached) {
      updateUI(cached.temp, cached.conditionText, cached.locationName);
    }

    // 2. Background Update
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => fetchWeatherData(pos.coords.latitude, pos.coords.longitude),
        (err) => fetchWeatherData(), // Fallback to IP-based guess
        { timeout: 3000 }
      );
    } else {
      fetchWeatherData(); // Fallback to IP-based guess
    }
  }

  // GLOBAL UTILS
  function showNotification(msg, type = 'info') {
    let notifyEl = document.getElementById('hud-notification');
    if (!notifyEl) {
      notifyEl = document.createElement('div');
      notifyEl.id = 'hud-notification';
      document.body.appendChild(notifyEl);
    }

    // Clear any previous classes and timeouts
    notifyEl.className = '';
    if (notifyEl.hideTimeout) clearTimeout(notifyEl.hideTimeout);

    // Add type class for styling
    notifyEl.classList.add(type);

    // Icons for each type
    const icons = {
      success: '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
      error: '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    // Build content structure
    notifyEl.innerHTML = `
    <span class="notify-icon">${icons[type] || icons.info}</span>
    <span class="notify-msg"></span>
  `;

    // CLEANUP: If msg is a raw Google Error JSON or HTTP 401 status, prettify it or suppress it
    let cleanMsg = msg;
    const isAuthError = typeof msg === 'string' && (
      msg.includes('"code": 401') ||
      msg.includes('HTTP 401') ||
      msg.includes('401.') ||
      msg.includes('invalid authentication credentials') ||
      msg.includes('Login required')
    );

    if (isAuthError) {
      cleanMsg = "SESSION EXPIRED. PLEASE CLICK RECONNECT IN YOUR PROFILE.";
      type = 'warning';
      notifyEl.className = 'warning'; // Update class immediately
    }

    notifyEl.querySelector('.notify-msg').textContent = cleanMsg;

    // Trigger animation
    void notifyEl.offsetWidth; // Force reflow
    notifyEl.classList.add('visible');

    // Auto-hide after 4 seconds
    notifyEl.hideTimeout = setTimeout(() => {
      notifyEl.classList.remove('visible');
    }, 4000);
  }

  // --- GLOBAL SETTINGS SYNC ---
  function saveAllDashboardSettings() {
    const settingsToSave = {
      theme_preference: localStorage.getItem('theme_mode') || 'auto', // Note: script uses 'theme_mode' in applyTheme
      gradient_enabled: localStorage.getItem('gradient_enabled') === 'true',
      gradient_color_1: localStorage.getItem('gradient_color_1') || '#FF6B00',
      gradient_color_2: localStorage.getItem('gradient_color_2') || '#FF4500',
      clock_swap_enabled: localStorage.getItem('clock_swap_enabled') === 'true',
      solid_bg_color: localStorage.getItem('solid_bg_color')
    };

    chrome.storage.local.set(settingsToSave, () => {
      console.log('[Dashboard] All settings synced to chrome.storage.local:', settingsToSave);
    });
  }

  /* --- GLOBAL BACKGROUND RESTORE --- */
  function restoreBackgroundSettings() {
    try {
      const savedColor = localStorage.getItem('solid_bg_color');
      if (savedColor) {
        document.documentElement.style.setProperty('--bg-core', savedColor);
        document.body.style.backgroundColor = savedColor;
        document.body.style.setProperty('--bg-core', savedColor, 'important');

        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ 'solid_bg_color': savedColor });
        }
      }
    } catch (e) {
      console.error("Background restore failed", e);
    }
  }

  /* --- 1. SETTINGS & UI HANDLERS --- */
  function initLogin() {
    const loginBtn = document.getElementById('login-btn');
    const headerLoginBtn = document.getElementById('header-login-btn');
    const loginRow = document.getElementById('login-row');

    // Initially show the connect UI - checkAuthStatus will hide it if user is already logged in
    // This ensures the button is visible by default when there's no account
    if (loginRow) loginRow.style.display = 'flex';
    if (loginBtn) loginBtn.style.display = 'block';
    if (headerLoginBtn) headerLoginBtn.style.display = 'block';


    // Reusable Auth Flow - USES launchWebAuthFlow (works with Web application OAuth client)
    const startAuthFlow = async () => {
      console.log("[Auth] 🚀 LOGIN: Using launchWebAuthFlow for Web OAuth client...");
      console.log("[Auth] 📋 Current Extension ID:", chrome.runtime.id);
      showNotification("CONNECTING TO GOOGLE...", "info");

      try {
        // Clear cache first
        await new Promise((resolve) => {
          chrome.identity.clearAllCachedAuthTokens(() => {
            console.log("[Auth] ✅ All cached tokens cleared");
            resolve();
          });
        });

        // Build OAuth URL
        const scopes = [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/tasks",
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile"
        ];

        const clientId = "635413045241-bh93ib54pa4pd15fj9042qsij99290sp.apps.googleusercontent.com";
        const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

        console.log("⚠️⚠️⚠️ IMPORTANT - CHECK THIS ⚠️⚠️⚠️");
        console.log("[Auth] Extension ID:", chrome.runtime.id);
        console.log("[Auth] Redirect URI:", redirectUri);
        console.log("☝️ This EXACT redirect URI must be in Google Cloud Console!");

        // Use Authorization Code Flow (response_type=code) for proper scope grants
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
          `client_id=${clientId}&` +
          `response_type=code&` +  // Changed from 'token' to 'code'
          `redirect_uri=${encodeURIComponent(redirectUri)}&` +
          `scope=${encodeURIComponent(scopes.join(' '))}&` +
          `access_type=offline&` +  // Request refresh token
          `prompt=consent`;  // Force consent to ensure all scopes granted

        console.log("[Auth] Launching auth flow with URL:", authUrl);

        // Use launchWebAuthFlow (works with Web application OAuth clients)
        const responseUrl = await new Promise((resolve, reject) => {
          chrome.identity.launchWebAuthFlow(
            {
              url: authUrl,
              interactive: true
            },
            (redirectUrl) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(redirectUrl);
              }
            }
          );
        });

        console.log("[Auth] Auth flow completed, response URL:", responseUrl);

        // Extract authorization CODE from URL (format: ?code=xxx&...)
        const params = new URLSearchParams(responseUrl.split('?')[1]);
        const code = params.get('code');

        if (!code) {
          throw new Error("No authorization code in response");
        }

        console.log("[Auth] ✅ Authorization code obtained! Exchanging via Worker...");

        // Exchange code for tokens via Worker - MUST pass redirect_uri!
        const exchangeResponse = await fetch('https://pheonix-auth.pixelarenaltd.workers.dev/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            email: 'temp@pending.local',
            redirect_uri: redirectUri  // CRITICAL: Worker needs this to exchange with Google!
          })
        });

        if (!exchangeResponse.ok) {
          const error = await exchangeResponse.json();
          throw new Error(`Token exchange failed: ${JSON.stringify(error)}`);
        }

        const tokenData = await exchangeResponse.json();
        const token = tokenData.access_token;

        if (!token) {
          throw new Error("No access token received from Worker");
        }

        console.log("[Auth] ✅ Token obtained from Worker exchange!");

        // DIAGNOSTIC: Check what scopes this token actually has
        try {
          const tokenInfoResponse = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`);
          const tokenInfo = await tokenInfoResponse.json();
          console.log("🔍 TOKEN SCOPES:", tokenInfo.scope);
          console.log("⚠️ CHECK: Does it include calendar, drive, tasks?");
        } catch (e) {
          console.error("Failed to get token info:", e);
        }

        // Save to storage
        await chrome.storage.local.set({
          "google_access_token": token,
          "isLoggedIn": true,
          "google_user_persistent": true,
          "google_auth_timestamp": Date.now()
        });

        showNotification("CONNECTED SUCCESSFULLY", "success");

        // Update profile and sync
        if (typeof updateProfileInSettings === 'function') {
          await updateProfileInSettings(token);
        }
        if (typeof syncWorkspace === 'function') {
          await syncWorkspace(token);
        }

        // Hide login UI
        const loginRow = document.getElementById('login-row');
        const loginBtn = document.getElementById('login-btn');
        const headerLoginBtn = document.getElementById('header-login-btn');
        if (loginRow) loginRow.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'none';
        if (headerLoginBtn) headerLoginBtn.style.display = 'none';
        document.body.classList.add('logged-in');

        return;

      } catch (error) {
        console.error("[Auth] Chrome Identity login failed:", error);
        showNotification(`LOGIN FAILED: ${error.message}`, "error");
        return;
      }

      // FALLBACK 1: Try native chrome.identity (for Chrome Web Store published extensions)
      const scopes = [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/tasks",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile"
      ];

      try {
        const token = await new Promise((resolve, reject) => {
          chrome.identity.getAuthToken({ interactive: true, scopes: scopes }, (t) => {
            if (chrome.runtime.lastError || !t) {
              reject(chrome.runtime.lastError?.message || "No token returned");
            } else {
              resolve(t);
            }
          });
        });

        console.log("[Auth] Native chrome.identity success! Token acquired.");

        await chrome.storage.local.set({
          "google_access_token": token,
          "isLoggedIn": true,
          "google_user_persistent": true,
          "google_auth_timestamp": Date.now()
        });

        showNotification("CONNECTED SUCCESSFULLY", "success");

        if (typeof updateProfileInSettings === 'function') {
          updateProfileInSettings(token);
        }
        if (typeof syncWorkspace === 'function') {
          syncWorkspace(token);
        }
        return;
      } catch (error) {
        console.error("[Auth] chrome.identity.getAuthToken failed:", error);
        showNotification(`LOGIN FAILED: ${error}`, "error");
      }
    };

    // Attach Listeners
    if (loginBtn) loginBtn.addEventListener('click', startAuthFlow);
    if (headerLoginBtn) headerLoginBtn.addEventListener('click', startAuthFlow);

    // Listen for local storage token changes to update UI
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.google_access_token) {
        const newToken = changes.google_access_token.newValue;
        if (newToken) {
          console.log("UI: Token update detected!");
          if (loginRow) loginRow.style.display = 'none';
          if (loginBtn) loginBtn.style.display = "none";
          if (headerLoginBtn) headerLoginBtn.style.display = "none";
          // Note: syncWorkspace is NOT called here to avoid duplicates - 
          // handleNewToken and checkAuthStatus already handle syncing after token acquisition
        } else {
          if (loginRow) loginRow.style.display = 'flex';
          if (loginBtn) {
            loginBtn.style.display = "block";
            loginBtn.textContent = "CONNECT GOOGLE";
          }
          if (headerLoginBtn) headerLoginBtn.style.display = "block";
        }
      }
    });


    // Initial check on load - CRITICAL for restart handling
    checkAuthStatus();

    // Also ensure profile is updated after a short delay (in case checkAuthStatus completes before DOM is fully ready)
    setTimeout(() => {
      chrome.storage.local.get(["isLoggedIn", "google_access_token"], (result) => {
        if (result.isLoggedIn && result.google_access_token) {
          const profileEmail = document.getElementById('user-email');
          // Only update if profile still shows default/guest state
          if (profileEmail && (profileEmail.textContent === 'Not connected to Google' || profileEmail.textContent === 'GUEST USER' || profileEmail.textContent === 'CONNECTED')) {
            console.log('[Auth] Profile appears to need update, refreshing...');
            updateProfileInSettings(result.google_access_token).catch(err => {
              console.error('[Auth] Failed to update profile on delayed check:', err);
            });
          }
        }
      });
    }, 2000); // 2 second delay to ensure everything is loaded

    // Listen for global auth failure events
    window.addEventListener('google_auth_failed', async (e) => {
      const isSilent = e.detail?.silent;
      console.warn(`[Auth] Global auth failure detected (silent=${isSilent}).`);

      // Check if user is persistent - if so, auto-reconnect for forever login
      const authVars = await new Promise(resolve => chrome.storage.local.get(["google_user_persistent"], resolve));
      const isPersistent = authVars.google_user_persistent;

      if (isSilent || isPersistent) {
        // For persistent users, avoid automatic tab-based reconnect without user action
        if (isPersistent) {
          console.log("[Auth] Persistent user detected on auth failure. Updating UI for manual reconnect.");
          const profileEmail = document.getElementById('user-email');
          if (profileEmail) profileEmail.textContent = 'SESSION EXPIRED (RECONNECT)';

          // Keep UI in logged-in state to avoid "disconnected" flickers
          const loginRow = document.getElementById('login-row');
          const headerLoginBtn = document.getElementById('header-login-btn');
          if (loginRow) loginRow.style.display = 'none';
          if (headerLoginBtn) headerLoginBtn.style.display = 'none';
          document.body.classList.add('logged-in');

          // We DO NOT trigger attemptInteractiveRefresh(true) here anymore
          return;
        } else {
          // Non-persistent user, just show connecting state
          const profileEmail = document.getElementById('user-email');
          if (profileEmail) profileEmail.textContent = 'CONNECTING...';
          return;
        }
      }

      // Only show login UI for non-persistent users on non-silent failures
      const loginRow = document.getElementById('login-row');
      const headerLoginBtn = document.getElementById('header-login-btn');
      if (loginRow) loginRow.style.display = 'flex';
      if (headerLoginBtn) headerLoginBtn.style.display = 'block';
      document.body.classList.remove('logged-in');

      const profileEmail = document.getElementById('user-email');
      if (profileEmail) profileEmail.textContent = 'SESSION EXPIRED';
    });

    // Listen for background messages
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'token_captured' && message.token) {
        console.log("[Auth] ✅ Token Snatcher captured a token successfully.");
        console.log("[Auth] Token preview:", message.token.substring(0, 20) + "...");

        // Use handleNewToken which will update profile and sync workspace
        console.log("[Auth] Calling handleNewToken...");
        handleNewToken(message.token, false); // Show notification for initial login
        showNotification("CONNECTED TO GOOGLE", "success");

        // Also explicitly update profile to ensure it happens
        setTimeout(() => {
          console.log("[Auth] Calling updateProfileInSettings (delayed)...");
          updateProfileInSettings(message.token).catch(err => {
            console.error("[Auth] ❌ Failed to update profile after token capture:", err);
          });
        }, 500); // Small delay to ensure DOM is ready
      }
      if (message.type === 'GOOGLE_AUTH_FAILED') {
        window.dispatchEvent(new CustomEvent('google_auth_failed', { detail: { silent: message.silent } }));
      }
      if (message.type === 'AUTO_RECONNECT_NEEDED') {
        const profileEmail = document.getElementById('user-email');
        if (profileEmail) profileEmail.textContent = 'SESSION EXPIRED (RECONNECT)';
      }
    });

  }

  function initSettings() {
    const panel = document.getElementById('settings-panel');
    const overlay = document.getElementById('settings-overlay');
    const openBtn = document.getElementById('settings-btn');
    const closeBtn = document.getElementById('close-settings');
    const logoutBtn = document.getElementById('logout-btn');
    const syncBtn = document.getElementById('force-sync-btn');

    // Helper functions for panel
    function openSettingsPanel() {
      if (panel) panel.classList.add('visible');
      if (overlay) overlay.classList.add('visible');

      // Update profile when settings panel opens (in case it wasn't updated on load)
      chrome.storage.local.get(["isLoggedIn", "google_access_token"], (result) => {
        if (result.isLoggedIn && result.google_access_token) {
          console.log('[Settings] User is logged in, updating profile in settings panel...');
          updateProfileInSettings(result.google_access_token).catch(err => {
            console.error('[Settings] Failed to update profile:', err);
          });
        }
      });
    }

    function closeSettingsPanel() {
      if (panel) panel.classList.remove('visible');
      if (overlay) overlay.classList.remove('visible');
    }

    // Panel Toggle
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        if (panel && panel.classList.contains('visible')) {
          closeSettingsPanel();
        } else {
          openSettingsPanel();
        }
      });
    }

    if (overlay) {
      overlay.addEventListener('click', closeSettingsPanel);
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', closeSettingsPanel);
    }

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel && panel.classList.contains('visible')) {
        closeSettingsPanel();
      }
    });

    // Tab System
    const tabBtns = document.querySelectorAll('.settings-tab-btn');
    const tabPanes = document.querySelectorAll('.settings-tab-pane');

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');

        // Remove active from all
        tabBtns.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.classList.remove('active'));

        // Add active to selected
        btn.classList.add('active');
        const targetPane = document.getElementById(`tab-${tabId}`);
        if (targetPane) targetPane.classList.add('active');
      });
    });



    // Logout Logic - Reusable function
    function performLogout() {
      chrome.storage.local.remove(["google_access_token", "drive_folder_id", "google_user_persistent", "google_auth_timestamp", "isLoggedIn"], () => {
        // Also clear logged-in state
        chrome.storage.local.set({ "isLoggedIn": false }, () => {
          showNotification('Disconnected.', 'info');

          const profilePic = document.getElementById('user-profile-pic');
          const profileName = document.getElementById('user-display-name');
          const profileEmail = document.getElementById('user-email');
          const headerLogoutBtn = document.getElementById('header-logout-btn');
          const headerLoginBtn = document.getElementById('header-login-btn');

          // Reset profile UI to guest state
          if (profilePic) profilePic.src = 'images/icon128.png';
          if (profileName) profileName.textContent = 'GUEST USER';
          if (profileEmail) profileEmail.textContent = 'Not connected to Google';
          if (headerLogoutBtn) headerLogoutBtn.style.display = 'none';
          if (headerLoginBtn) headerLoginBtn.style.display = 'block';

          checkAuthStatus();
        });
      });
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', performLogout);
    }

    // Header Logout Button (beside profile section)
    const headerLogoutBtn = document.getElementById('header-logout-btn');
    if (headerLogoutBtn) {
      headerLogoutBtn.addEventListener('click', performLogout);
    }

    // Force Sync Logic
    if (syncBtn) {
      syncBtn.addEventListener('click', () => {
        chrome.storage.local.get("google_access_token", (res) => {
          if (res.google_access_token) syncWorkspace(res.google_access_token);
          else showNotification("PLEASE CONNECT FIRST", "warning");
        });
      });
    }

    // Grid Overlay Controls
    const gridLayer = document.getElementById('grid-layer');
    const gridStyleSelect = document.getElementById('grid-style-select');
    const gridSizeSlider = document.getElementById('grid-size-slider');
    const gridSizeDisplay = document.getElementById('grid-size-display');
    const gridOpacitySlider = document.getElementById('grid-opacity-slider');
    const gridOpacityDisplay = document.getElementById('grid-opacity-display');
    const gridThicknessSlider = document.getElementById('grid-thickness-slider');
    const gridThicknessDisplay = document.getElementById('grid-thickness-display');

    // Persistence Loads
    const savedGridStyle = localStorage.getItem('grid_style') || 'graph-paper';
    const savedGridSize = localStorage.getItem('grid_size') || '90';
    const savedGridOpacity = localStorage.getItem('grid_opacity') || '10';
    const savedGridThickness = localStorage.getItem('grid_thickness') || '1';

    // Apply Initial States
    if (gridLayer) {
      gridLayer.className = 'grid-overlay';
      if (savedGridStyle !== 'lines' && savedGridStyle !== 'none') {
        gridLayer.classList.add(savedGridStyle);
      } else if (savedGridStyle === 'none') {
        gridLayer.classList.add('none');
      }

      gridLayer.style.setProperty('--grid-size', `${savedGridSize}px`);
      gridLayer.style.setProperty('--grid-opacity', savedGridOpacity / 100);
      gridLayer.style.setProperty('--grid-thickness', `${savedGridThickness}px`);
    }

    // Update UI Select/Sliders
    if (gridStyleSelect) gridStyleSelect.value = savedGridStyle;
    if (gridSizeSlider) gridSizeSlider.value = savedGridSize;
    if (gridSizeDisplay) gridSizeDisplay.textContent = `${savedGridSize}px`;
    if (gridOpacitySlider) gridOpacitySlider.value = savedGridOpacity;
    if (gridOpacityDisplay) gridOpacityDisplay.textContent = `${savedGridOpacity}%`;
    if (gridThicknessSlider) gridThicknessSlider.value = savedGridThickness;
    if (gridThicknessDisplay) gridThicknessDisplay.textContent = `${savedGridThickness}px`;

    // Event Listeners
    if (gridStyleSelect) {
      gridStyleSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        gridLayer.className = 'grid-overlay'; // Reset to base class
        if (val !== 'none') {
          gridLayer.classList.add(val);
        }
        localStorage.setItem('grid_style', val);
      });
    }

    // Debounce helper for localStorage saves (instant visual, delayed persist)
    const createDebouncedSave = (key) => {
      let timeout;
      return (val) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => localStorage.setItem(key, val), 150);
      };
    };

    const saveGridSize = createDebouncedSave('grid_size');
    const saveGridOpacity = createDebouncedSave('grid_opacity');
    const saveGridThickness = createDebouncedSave('grid_thickness');
    const saveSolidColor = createDebouncedSave('solid_bg_color');

    if (gridSizeSlider) {
      gridSizeSlider.addEventListener('input', (e) => {
        const val = e.target.value;
        gridLayer.style.setProperty('--grid-size', `${val}px`);
        if (gridSizeDisplay) gridSizeDisplay.textContent = `${val}px`;
        saveGridSize(val);
      });
    }

    if (gridOpacitySlider) {
      gridOpacitySlider.addEventListener('input', (e) => {
        const val = e.target.value;
        gridLayer.style.setProperty('--grid-opacity', val / 100);
        if (gridOpacityDisplay) gridOpacityDisplay.textContent = `${val}%`;
        saveGridOpacity(val);
      });
    }

    if (gridThicknessSlider) {
      gridThicknessSlider.addEventListener('input', (e) => {
        const val = e.target.value;
        gridLayer.style.setProperty('--grid-thickness', `${val}px`);
        if (gridThicknessDisplay) gridThicknessDisplay.textContent = `${val}px`;
        saveGridThickness(val);
      });
    }

    // Blur Toggle




    // Solid Color Picker & Recent Colors
    const solidColorPicker = document.getElementById('solid-color-picker');
    const solidHexInput = document.getElementById('solid-hex-input');
    const applyHexBtn = document.getElementById('apply-solid-hex');
    const recentColorsGrid = document.getElementById('recent-colors-grid');

    const savedSolidColor = localStorage.getItem('solid_bg_color') || '#1a1a2e';
    document.documentElement.style.setProperty('--bg-core', savedSolidColor);

    // Manage Recent Colors (Limit to 6)
    function getRecentColors() {
      const stored = localStorage.getItem('recent_solid_colors');
      return stored ? JSON.parse(stored) : ['#0B0B0B', '#1a1a2e', '#16213e', '#0f3460', '#1e3d59', '#2d4a22'];
    }

    function saveRecentColor(color) {
      let colors = getRecentColors();
      colors = colors.filter(c => c.toLowerCase() !== color.toLowerCase());
      colors.unshift(color);
      colors = colors.slice(0, 6);
      localStorage.setItem('recent_solid_colors', JSON.stringify(colors));
      renderRecentColors();
    }

    function renderRecentColors() {
      if (!recentColorsGrid) return;
      recentColorsGrid.innerHTML = '';
      const colors = getRecentColors();
      colors.forEach(color => {
        const btn = document.createElement('button');
        btn.className = 'solid-preset-btn';
        btn.style.backgroundColor = color;
        btn.addEventListener('click', () => applyColor(color));
        recentColorsGrid.appendChild(btn);
      });
    }

    // Intelligence: Analyze background for contrast
    function checkContrast(hex) {
      if (!hex) return;
      if (hex.startsWith('#')) hex = hex.substring(1);
      // Expand shorthand form (e.g. "03F") to full form
      if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
      if (hex.length !== 6) return;

      const r = parseInt(hex.substr(0, 2), 16);
      const g = parseInt(hex.substr(2, 2), 16);
      const b = parseInt(hex.substr(4, 2), 16);

      // YIQ equation
      const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;

      // Reset classes
      document.body.classList.remove('deep-bg', 'light-bg');

      // Thresholds
      if (yiq < 128) {
        document.body.classList.add('deep-bg');
      } else if (yiq > 200) {
        document.body.classList.add('light-bg');
      }
    }

    // Initial check
    checkContrast(savedSolidColor);

    function applyColor(color) {
      if (!color) return;
      color = color.trim();
      if (color.startsWith('#')) color = color.substring(1); // Strip existing hash
      if (color.startsWith('#')) color = color.substring(1); // Strip double hash if any

      // Validate (3 or 6 chars)
      if (!/^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color)) {
        // If triggered by button, show feedback
        if (document.activeElement === applyHexBtn || document.activeElement === solidHexInput) {
          showNotification('Invalid Hex Code (e.g., 1a1a2e)', 'error');
          if (solidHexInput) {
            solidHexInput.classList.add('input-error');
            setTimeout(() => solidHexInput.classList.remove('input-error'), 500);
          }
        }
        return;
      }

      // Normalize to 6 digits if 3
      if (color.length === 3) {
        color = color.split('').map(c => c + c).join('');
      }

      const finalColor = '#' + color;

      saveSolidColor(finalColor);
      if (window.PerformanceUtils) {
        window.PerformanceUtils.debouncedStorageWrite('solid_bg_color', finalColor);
      }

      // Apply aggressively
      document.documentElement.style.setProperty('--bg-core', finalColor);
      document.body.style.backgroundColor = finalColor;
      document.body.style.setProperty('--bg-core', finalColor, 'important');

      if (solidColorPicker) solidColorPicker.value = finalColor;
      // Only update text input if it's not the one being typed in (to avoid cursor jumping)
      if (solidHexInput && document.activeElement !== solidHexInput) {
        solidHexInput.value = color;
      }

      saveRecentColor(finalColor);


      // Success feedback (subtle)
      if (document.activeElement === applyHexBtn) {
        // Optional: showNotification('Color Applied', 'success'); 
      }

      // Sync to extension storage for Popup
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ 'solid_bg_color': finalColor });
      }
    }

    if (solidColorPicker) {
      solidColorPicker.value = savedSolidColor;
      solidColorPicker.addEventListener('input', (e) => {
        applyColor(e.target.value);
      });
    }

    if (solidHexInput) {
      solidHexInput.value = savedSolidColor.replace('#', '');

      const handleHexSubmit = () => {
        const color = '#' + solidHexInput.value.trim().replace('#', '');
        applyColor(color);
      };

      // Update as they type too
      solidHexInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (val.length === 6 || (val.startsWith('#') && val.length === 7)) {
          handleHexSubmit();
        }
      });

      applyHexBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        handleHexSubmit();
      });

      solidHexInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleHexSubmit();
        }
      });
    }

    // Initial render
    renderRecentColors();


    // Apply saved solid color on load
    if (savedSolidColor) {
      document.documentElement.style.setProperty('--bg-core', savedSolidColor);
    }

    // ============================================
    // Theme Manager (Auto / Dark / Light)
    // ============================================
    const themeControl = document.getElementById('theme-mode-control');
    const segmentBtns = document.querySelectorAll('.segment-btn');

    const ThemeManager = {
      mode: localStorage.getItem('theme_mode'), // auto, dark, light
      mediaQuery: window.matchMedia('(prefers-color-scheme: dark)'),

      init() {
        // Migration Logic for existing users
        if (!this.mode) {
          const oldAuto = localStorage.getItem('auto_theme_enabled');
          const oldManual = localStorage.getItem('theme_preference');

          if (oldAuto === 'false' && oldManual) {
            this.mode = oldManual; // 'light' or 'dark'
          } else {
            this.mode = 'auto';
          }
          localStorage.setItem('theme_mode', this.mode);
        }

        // Initialize UI and Theme
        this.setMode(this.mode, false);

        // Listen for system changes (only affects 'auto' mode)
        this.mediaQuery.addEventListener('change', (e) => {
          if (this.mode === 'auto') {
            console.log('[Theme] System preference changed:', e.matches ? 'dark' : 'light');
            this.applySystemTheme();
          }
        });

        // UI Listeners
        if (themeControl) {
          segmentBtns.forEach(btn => {
            btn.addEventListener('click', () => {
              const newMode = btn.dataset.value;
              this.setMode(newMode, true);
            });
          });
        }

        // Sync init state (handled by top-level load now, only save if explicitly changed)

      },

      setMode(newMode, save = true) {
        this.mode = newMode;
        console.log('[Theme] Setting mode:', newMode);

        // Update UI buttons
        segmentBtns.forEach(btn => {
          if (btn.dataset.value === newMode) btn.classList.add('active');
          else btn.classList.remove('active');
        });

        // Apply Theme
        if (newMode === 'auto') {
          this.applySystemTheme();
        } else {
          this.applyManualTheme(newMode);
        }

        // Save preference
        if (save) {
          localStorage.setItem('theme_mode', newMode);
          // CRITICAL FIX: Update theme_preference in localStorage too, otherwise index.html 
          // will prioritize the stale 'theme_preference' over 'theme_mode' causing a flash.
          localStorage.setItem('theme_preference', newMode);

          // Sync with extension storage if available
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ 'theme_mode': newMode, 'theme_preference': newMode });
          }
        }
      },

      applySystemTheme() {
        const isDark = this.mediaQuery.matches;
        this.applyVisuals(isDark ? 'dark' : 'light');
      },

      applyManualTheme(mode) {
        this.applyVisuals(mode);
      },

      applyVisuals(theme) {
        if (theme === 'light') {
          document.documentElement.classList.add('light-theme');
        } else {
          document.documentElement.classList.remove('light-theme');
        }

        // Update extension storage for components like the popup
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ 'theme_preference': theme });
        }

        // Notify other components
        document.dispatchEvent(new CustomEvent('themeChanged', { detail: theme }));
        triggerSync(); // Update icons/colors if needed
      }
    };

    ThemeManager.init();





    // Font Selector Logic
    const fontSelect = document.getElementById('font-family-select');
    const savedFont = localStorage.getItem('system_font');
    if (savedFont && fontSelect) {
      fontSelect.value = savedFont;
      document.documentElement.style.setProperty('--font-hud', savedFont);
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ 'system_font': savedFont });
      }
    }

    if (fontSelect) {
      fontSelect.addEventListener('change', (e) => {
        const selectedFont = e.target.value;
        localStorage.setItem('system_font', selectedFont);
        document.documentElement.style.setProperty('--font-hud', selectedFont);
        // Sync to extension storage
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ 'system_font': selectedFont });
        }
      });
    }

    // Accent Color Picker Logic
    const accentPicker = document.getElementById('accent-color-picker');
    const accentHex = document.getElementById('accent-hex-input');
    const savedAccent = localStorage.getItem('accent_color');

    if (accentPicker && accentHex) {
      // Set initial value
      if (savedAccent) {
        accentPicker.value = savedAccent;
        accentHex.value = savedAccent;
      }

      const updateAccent = (color) => {
        // Validate
        if (!color.startsWith('#')) color = '#' + color;

        // Update DOM
        document.documentElement.style.setProperty('--accent-color', color);

        // Update RGB var
        const cleanHex = color.replace('#', '');
        if (cleanHex.length === 6) {
          const r = parseInt(cleanHex.slice(0, 2), 16);
          const g = parseInt(cleanHex.slice(2, 4), 16);
          const b = parseInt(cleanHex.slice(4, 6), 16);
          document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
        }

        // Save
        localStorage.setItem('accent_color', color);
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ 'accent_color': color });
        }
      };

      accentPicker.addEventListener('input', (e) => {
        accentHex.value = e.target.value;
        updateAccent(e.target.value);
      });

      accentHex.addEventListener('input', (e) => {
        const val = e.target.value;
        if (val.length === 7 && val.startsWith('#')) {
          accentPicker.value = val;
          updateAccent(val);
        }
      });

      accentHex.addEventListener('blur', (e) => {
        let val = e.target.value;
        if (!val.startsWith('#')) val = '#' + val;
        if (val.length === 4) { // shorthand
          val = '#' + val[1] + val[1] + val[2] + val[2] + val[3] + val[3];
        }
        if (val.length === 7) {
          accentPicker.value = val;
          accentHex.value = val;
          updateAccent(val);
        } else {
          // Reset to current picker value if invalid
          accentHex.value = accentPicker.value;
        }
      });
    }

    // Upload Notification Toggle
    const notifyCheck = document.getElementById('upload-notify-toggle');
    const savedNotify = localStorage.getItem('upload_notifications_enabled');
    if (notifyCheck) {
      const isEnabled = savedNotify !== 'false'; // Default to true
      notifyCheck.checked = isEnabled;
      notifyCheck.addEventListener('change', (e) => {
        localStorage.setItem('upload_notifications_enabled', e.target.checked);
      });
    }

    // AI Parsing Toggle
    const aiToggle = document.getElementById('ai-parsing-toggle');
    const savedAI = localStorage.getItem('ai_parsing_enabled');
    if (aiToggle) {
      aiToggle.checked = savedAI === 'true';
      aiToggle.addEventListener('change', (e) => {
        localStorage.setItem('ai_parsing_enabled', e.target.checked);
      });
    }

    // 12h Clock Toggle
    const clock12hToggle = document.getElementById('clock-12h-toggle');
    const savedClock12h = localStorage.getItem('clock_12h_enabled');
    if (clock12hToggle) {
      const is12h = savedClock12h !== 'false'; // Default to true
      clock12hToggle.checked = is12h;
      clock12hToggle.addEventListener('change', (e) => {
        localStorage.setItem('clock_12h_enabled', e.target.checked);
      });
    }

    // Clock Swap Toggle
    const clockSwapToggle = document.getElementById('clock-swap-toggle');
    const savedClockSwap = localStorage.getItem('clock_swap_enabled');

    // Apply initially (this runs before body.loaded is added, so no FOUC)
    if (savedClockSwap === 'true') {
      document.body.classList.add('swap-header');
    }

    if (clockSwapToggle) {
      clockSwapToggle.checked = savedClockSwap === 'true';
      clockSwapToggle.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        localStorage.setItem('clock_swap_enabled', isChecked);
        if (isChecked) document.body.classList.add('swap-header');
        else document.body.classList.remove('swap-header');
      });
    }

    // UI Scale Slider
    const scaleSlider = document.getElementById('ui-scale-slider');
    const scaleDisplay = document.getElementById('scale-value-display');
    const resetScaleBtn = document.getElementById('reset-scale-btn');
    const savedScale = localStorage.getItem('ui_scale');
    const defaultScale = 70;

    // Apply saved scale on load
    if (savedScale !== null && scaleSlider) {
      const scaleVal = parseInt(savedScale, 10);
      scaleSlider.value = scaleVal;
      document.body.style.zoom = scaleVal / 100;
      document.documentElement.style.setProperty('--ui-scale-ratio', scaleVal / 100);
      if (scaleDisplay) scaleDisplay.textContent = scaleVal + '%';
    } else {
      // Default scale
      document.body.style.zoom = defaultScale / 100;
      document.documentElement.style.setProperty('--ui-scale-ratio', defaultScale / 100);
      if (scaleDisplay) scaleDisplay.textContent = defaultScale + '%';
    }

    if (scaleSlider) {
      let scaleTimeout;
      scaleSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        document.body.style.zoom = val / 100;
        document.documentElement.style.setProperty('--ui-scale-ratio', val / 100);
        if (scaleDisplay) scaleDisplay.textContent = val + '%';
        // Debounced save
        clearTimeout(scaleTimeout);
        scaleTimeout = setTimeout(() => localStorage.setItem('ui_scale', val), 150);
      });
    }

    if (resetScaleBtn) {
      resetScaleBtn.addEventListener('click', () => {
        document.body.style.zoom = defaultScale / 100;
        document.documentElement.style.setProperty('--ui-scale-ratio', defaultScale / 100);
        localStorage.setItem('ui_scale', defaultScale);
        if (scaleSlider) scaleSlider.value = defaultScale;
        if (scaleDisplay) scaleDisplay.textContent = defaultScale + '%';
      });
    }

    // Gradient Colors
    // ============================================
    // Two-Tone Gradient System
    // ============================================
    const gradientToggle = document.getElementById('gradient-toggle');
    const gradientLayer = document.getElementById('gradient-layer');
    const grad1Picker = document.getElementById('gradient-color-1');
    const grad1Hex = document.getElementById('gradient-hex-1');
    const grad2Picker = document.getElementById('gradient-color-2');
    const grad2Hex = document.getElementById('gradient-hex-2');
    const randomizeGradBtn = document.getElementById('randomize-gradient-btn');

    // Load Saved State
    // Default to enabled for first-time users (null means never set)
    const gradientEnabledRaw = localStorage.getItem('gradient_enabled');
    // FIX: If null (default), explicitly save 'true' so saveAllDashboardSettings() sees it
    if (gradientEnabledRaw === null) {
      localStorage.setItem('gradient_enabled', 'true');
    }
    const savedGradEnabled = gradientEnabledRaw === null ? true : gradientEnabledRaw === 'true';
    const savedGrad1 = localStorage.getItem('gradient_color_1') || '#FF6B00';
    const savedGrad2 = localStorage.getItem('gradient_color_2') || '#FF4500';

    // Apply Initial State
    if (gradientLayer) {
      if (savedGradEnabled) gradientLayer.classList.add('enabled');
      document.documentElement.style.setProperty('--gradient-color-1', savedGrad1);
      document.documentElement.style.setProperty('--gradient-color-2', savedGrad2);

      // If gradient is enabled, ensure it syncs as accent to storage - REMOVED for monochrome
    }

    if (gradientToggle) gradientToggle.checked = savedGradEnabled;
    if (grad1Picker) grad1Picker.value = savedGrad1;
    if (grad1Hex) grad1Hex.value = savedGrad1;
    if (grad2Picker) grad2Picker.value = savedGrad2;
    if (grad2Hex) grad2Hex.value = savedGrad2;

    // Gradient Opacity Slider
    const gradientOpacitySlider = document.getElementById('gradient-opacity-slider');
    const gradientOpacityDisplay = document.getElementById('gradient-opacity-display');
    const savedGradOpacity = localStorage.getItem('gradient_opacity');
    const defaultGradOpacity = 100;

    // Apply saved gradient opacity on load
    if (savedGradOpacity !== null && gradientLayer) {
      const opacityVal = parseInt(savedGradOpacity, 10);
      gradientLayer.style.setProperty('--gradient-opacity', opacityVal / 100);
      if (gradientOpacitySlider) gradientOpacitySlider.value = opacityVal;
      if (gradientOpacityDisplay) gradientOpacityDisplay.textContent = opacityVal + '%';
    } else {
      // Default opacity
      if (gradientLayer) gradientLayer.style.setProperty('--gradient-opacity', defaultGradOpacity / 100);
      if (gradientOpacityDisplay) gradientOpacityDisplay.textContent = defaultGradOpacity + '%';
    }

    if (gradientOpacitySlider) {
      let gradOpacityTimeout;
      gradientOpacitySlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        if (gradientLayer) gradientLayer.style.setProperty('--gradient-opacity', val / 100);
        if (gradientOpacityDisplay) gradientOpacityDisplay.textContent = val + '%';
        // Debounced save
        clearTimeout(gradOpacityTimeout);
        gradOpacityTimeout = setTimeout(() => localStorage.setItem('gradient_opacity', val), 150);
      });
    }

    // Toggle Listener
    if (gradientToggle) {
      gradientToggle.addEventListener('change', (e) => {
        const isEnabled = e.target.checked;
        localStorage.setItem('gradient_enabled', isEnabled);
        if (isEnabled) {
          gradientLayer.classList.add('enabled');
          updateGradient(grad1Picker.value, grad2Picker.value); // Trigger accent sync
        } else {
          gradientLayer.classList.remove('enabled');
        }
      });
    }

    // Color Sync Helpers
    function updateGradient(c1, c2) {
      document.documentElement.style.setProperty('--gradient-color-1', c1);
      document.documentElement.style.setProperty('--gradient-color-2', c2);
      localStorage.setItem('gradient_color_1', c1);
      localStorage.setItem('gradient_color_2', c2);


      // PERSIST SETTINGS (Fixes refresh reset issue)
      if (typeof saveAllDashboardSettings === 'function') {
        saveAllDashboardSettings();
      }
    }

    function setupColorSync(picker, hexInput, isFirst) {
      if (!picker || !hexInput) return;

      const handleUpdate = (val) => {
        // Auto-enable if off
        if (gradientLayer && !gradientLayer.classList.contains('enabled')) {
          gradientLayer.classList.add('enabled');
          if (gradientToggle) gradientToggle.checked = true;
          localStorage.setItem('gradient_enabled', 'true');
        }

        const otherColor = isFirst ? (grad2Picker ? grad2Picker.value : '#FF4500') : (grad1Picker ? grad1Picker.value : '#FF6B00');
        const c1 = isFirst ? val : otherColor;
        const c2 = isFirst ? otherColor : val;
        updateGradient(c1, c2);
      };

      picker.addEventListener('input', (e) => {
        hexInput.value = e.target.value;
        handleUpdate(e.target.value);
      });

      hexInput.addEventListener('input', (e) => {
        let val = e.target.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
          picker.value = val;
          handleUpdate(val);
        }
      });

      hexInput.addEventListener('change', (e) => {
        let val = e.target.value.trim();
        if (!val.startsWith('#') && /^[0-9A-Fa-f]{6}$/.test(val)) {
          val = '#' + val;
          e.target.value = val; // Auto-fix missing # on blur/enter
        }
      });
    }

    setupColorSync(grad1Picker, grad1Hex, true);
    setupColorSync(grad2Picker, grad2Hex, false);

    // Randomize Logic
    if (randomizeGradBtn) {
      const twoTonePresets = [
        { name: 'Neon Cyber', c1: '#7B68EE', c2: '#FF2E63' },
        { name: 'Aurora Borealis', c1: '#00F260', c2: '#0575E6' },
        { name: 'Sunset Drive', c1: '#FF512F', c2: '#DD2476' },
        { name: 'Cosmic Fusion', c1: '#12c2e9', c2: '#c471ed' },
        { name: 'Golden Hour', c1: '#ff9966', c2: '#ff5e62' },
        { name: 'Mint Grape', c1: '#38ef7d', c2: '#11998e' },
        { name: 'Royal Gold', c1: '#FDC830', c2: '#536976' },
        { name: 'Deep Sea', c1: '#2b5876', c2: '#4e4376' },
        { name: 'Cotton Candy', c1: '#FDBB2D', c2: '#22C1C3' },
        { name: 'Electric Velvet', c1: '#8E2DE2', c2: '#4A00E0' },
        { name: 'Fire & Ice', c1: '#EF476F', c2: '#118AB2' },
        { name: 'Toxic Lime', c1: '#96c93d', c2: '#00b09b' },
        { name: 'Night Vibes', c1: '#283c86', c2: '#45a247' },
        { name: 'Warm Horizon', c1: '#FF4E50', c2: '#F9D423' },
        { name: 'Cherry Blossom', c1: '#FF9A9E', c2: '#FECFEF' },
        { name: 'Midnight City', c1: '#232526', c2: '#414345' },
        { name: 'Ocean Blue', c1: '#2E3192', c2: '#1BFFFF' },
        { name: 'Lush Life', c1: '#56ab2f', c2: '#a8e063' },
        { name: 'Disco Club', c1: '#fc466b', c2: '#3f5efb' },
        { name: 'Morning Mist', c1: '#556270', c2: '#FF6B6B' },
        { name: 'Retro Wave', c1: '#bdc3c7', c2: '#2c3e50' },
        { name: 'Summer Breeze', c1: '#2980B9', c2: '#6DD5FA' },
        { name: 'Candy Crush', c1: '#ff0084', c2: '#33001b' },
        { name: 'Deep Space', c1: '#000000', c2: '#434343' },
        { name: 'Kyoto', c1: '#c21500', c2: '#ffc500' },
        { name: 'Amethyst', c1: '#9D50BB', c2: '#6E48AA' },
        { name: 'Tranquil', c1: '#EECDA3', c2: '#EF629F' },
        { name: 'Emerald Water', c1: '#348F50', c2: '#56B4D3' },
        { name: 'Lemon Twist', c1: '#F2994A', c2: '#F2C94C' }
      ];

      randomizeGradBtn.addEventListener('click', () => {
        const random = twoTonePresets[Math.floor(Math.random() * twoTonePresets.length)];

        // Update Inputs
        if (grad1Picker) grad1Picker.value = random.c1;
        if (grad1Hex) grad1Hex.value = random.c1;
        if (grad2Picker) grad2Picker.value = random.c2;
        if (grad2Hex) grad2Hex.value = random.c2;

        // Update CSS & Storage
        updateGradient(random.c1, random.c2);

        // UX Improvement: Auto-enable gradient if it's off so user sees the change
        if (gradientLayer && !gradientLayer.classList.contains('enabled')) {
          gradientLayer.classList.add('enabled');
          if (gradientToggle) gradientToggle.checked = true;
          localStorage.setItem('gradient_enabled', 'true');
          showNotification(`${random.name.toUpperCase()} (ENABLED)`, 'info');
        } else {
          showNotification(`${random.name.toUpperCase()}`, 'info');
        }
      });
    }

    // ============================================
    // Gradient Favorites System
    // ============================================
    const saveGradBtn = document.getElementById('save-gradient-btn');
    const favoritesGrid = document.getElementById('gradient-favorites-grid');

    function getGradientFavorites() {
      const stored = localStorage.getItem('gradient_favorites');
      return stored ? JSON.parse(stored) : [];
    }

    function saveGradientFavorites(favorites) {
      localStorage.setItem('gradient_favorites', JSON.stringify(favorites));
    }

    function renderGradientFavorites() {
      if (!favoritesGrid) return;
      const favorites = getGradientFavorites();
      favoritesGrid.innerHTML = '';

      if (favorites.length === 0) {
        favoritesGrid.innerHTML = '<span class="empty-favorites-hint">No saved gradients</span>';
        return;
      }

      favorites.forEach((fav, index) => {
        const swatch = document.createElement('button');
        swatch.className = 'gradient-favorite-swatch';
        swatch.style.background = `linear-gradient(135deg, ${fav.c1}, ${fav.c2})`;
        swatch.title = `Click to apply, Right-click to delete`;
        swatch.dataset.index = index;

        // Apply on click
        swatch.addEventListener('click', () => {
          if (grad1Picker) grad1Picker.value = fav.c1;
          if (grad1Hex) grad1Hex.value = fav.c1;
          if (grad2Picker) grad2Picker.value = fav.c2;
          if (grad2Hex) grad2Hex.value = fav.c2;
          updateGradient(fav.c1, fav.c2);

          // Auto-enable if off
          if (gradientLayer && !gradientLayer.classList.contains('enabled')) {
            gradientLayer.classList.add('enabled');
            if (gradientToggle) gradientToggle.checked = true;
            localStorage.setItem('gradient_enabled', 'true');
          }
          showNotification('FAVORITE APPLIED', 'success');
        });

        // Delete on right-click
        swatch.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const updatedFavorites = getGradientFavorites();
          updatedFavorites.splice(index, 1);
          saveGradientFavorites(updatedFavorites);
          renderGradientFavorites();
          showNotification('FAVORITE REMOVED', 'info');
        });

        favoritesGrid.appendChild(swatch);
      });
    }

    // Initial Render
    renderGradientFavorites();

    // Save Button Logic
    if (saveGradBtn) {
      saveGradBtn.addEventListener('click', () => {
        const c1 = grad1Picker ? grad1Picker.value : '#7B68EE';
        const c2 = grad2Picker ? grad2Picker.value : '#DA70D6';

        const favorites = getGradientFavorites();

        // Check for duplicates
        const exists = favorites.some(f => f.c1.toLowerCase() === c1.toLowerCase() && f.c2.toLowerCase() === c2.toLowerCase());
        if (exists) {
          showNotification('ALREADY SAVED', 'warning');
          return;
        }

        // Limit to 8 favorites
        if (favorites.length >= 8) {
          showNotification('MAX 8 FAVORITES', 'warning');
          return;
        }

        favorites.push({ c1, c2 });
        saveGradientFavorites(favorites);
        renderGradientFavorites();
        showNotification('GRADIENT SAVED', 'success');
      });
    }

    // Handle Premium Slider Buttons
    document.querySelectorAll('.slider-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = btn.getAttribute('data-target');
        const action = btn.getAttribute('data-action');
        const slider = document.getElementById(targetId);
        if (!slider) return;

        const step = parseFloat(slider.step) || 1;
        let val = parseFloat(slider.value);

        if (action === 'dec') {
          val = Math.max(parseFloat(slider.min || 0), val - step);
        } else {
          val = Math.min(parseFloat(slider.max || 100), val + step);
        }

        slider.value = val;
        // Trigger input event to fire existing listeners
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });

    // AI API Settings Logic
    const aiKeyInput = document.getElementById('ai-api-key');
    const aiProviderSelect = document.getElementById('ai-provider-select');
    const saveAiKeyBtn = document.getElementById('save-ai-key-btn');
    const testAiConnBtn = document.getElementById('test-ai-conn-btn');
    const aiKeyHint = document.getElementById('ai-key-hint');

    // Load saved AI settings
    if (aiKeyInput) aiKeyInput.value = localStorage.getItem('ai_api_key') || '';
    if (aiProviderSelect) {
      aiProviderSelect.value = localStorage.getItem('ai_provider') || 'gemini';
      updateAiHint(aiProviderSelect.value);
    }

    function updateAiHint(provider) {
      if (!aiKeyHint) return;
      if (provider === 'gemini') {
        aiKeyHint.innerHTML = `To use AI, get a free key from <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color: var(--accent-color); font-weight: 600;">Google AI Studio</a>.`;
      } else {
        aiKeyHint.innerHTML = `Get an API key for access to various models at <a href="https://openrouter.ai/keys" target="_blank" style="color: var(--accent-color); font-weight: 600;">OpenRouter.ai</a>.`;
      }
    }

    if (aiProviderSelect) {
      aiProviderSelect.addEventListener('change', (e) => {
        localStorage.setItem('ai_provider', e.target.value);
        updateAiHint(e.target.value);
      });
    }

    if (saveAiKeyBtn) {
      saveAiKeyBtn.addEventListener('click', () => {
        const key = aiKeyInput.value.trim();
        localStorage.setItem('ai_api_key', key);
        showNotification('AI API KEY SAVED', 'success');

        // Flash the button
        saveAiKeyBtn.classList.add('success-flash');
        setTimeout(() => saveAiKeyBtn.classList.remove('success-flash'), 1000);
      });
    }

    if (testAiConnBtn) {
      testAiConnBtn.addEventListener('click', async () => {
        const key = aiKeyInput.value.trim();
        const provider = aiProviderSelect.value;

        if (!key) {
          showNotification('PLEASE PASTE AN API KEY FIRST', 'warning');
          return;
        }

        testAiConnBtn.textContent = 'TESTING...';
        testAiConnBtn.disabled = true;

        try {
          const result = await SmartTaskParser.testConnection(provider, key);
          if (result.success) {
            showNotification('CONNECTION SUCCESSFUL! AI IS READY.', 'success');
            testAiConnBtn.classList.add('connection-success');
          } else {
            showNotification(`CONNECTION FAILED: ${result.error}`, 'error');
            testAiConnBtn.classList.add('connection-error');
          }
        } catch (err) {
          showNotification('CONNECTION FAILED: INVALID REQUEST', 'error');
          testAiConnBtn.classList.add('connection-error');
        } finally {
          testAiConnBtn.textContent = 'CHECK CONNECTION';
          testAiConnBtn.disabled = false;
          setTimeout(() => {
            testAiConnBtn.classList.remove('connection-success', 'connection-error');
          }, 3000);
        }
      });
    }
  }




  /* --- 2. TASKS (EVENT DELEGATION) --- */
  /* --- 2. TASKS (API & RICH UI) --- */





  function initTaskListeners() {

    const addTaskBtn = document.getElementById('add-task-btn');
    const taskListEl = document.getElementById('task-list');
    const completedListEl = document.getElementById('completed-task-list');
    const toggleCompleted = document.getElementById('toggle-completed');
    const completedWrapper = document.getElementById('completed-tasks-container');
    const clearCompletedBtn = document.getElementById('clear-completed-btn');





    if (addTaskBtn) {
      const addTaskCard = document.getElementById('add-task-card');
      const taskModule = addTaskBtn.closest('.module-card');
      const smartTitleInput = document.getElementById('smart-task-title');
      const smartNotesInput = document.getElementById('smart-task-notes');

      // Click still toggles (for manual control)
      addTaskBtn.addEventListener('click', () => {
        if (addTaskCard) {
          addTaskCard.classList.toggle('hidden');
          if (!addTaskCard.classList.contains('hidden')) {
            smartTitleInput?.focus();
          }
        }
      });

      // Hover to open
      addTaskBtn.addEventListener('mouseenter', () => {
        if (addTaskCard && addTaskCard.classList.contains('hidden')) {
          addTaskCard.classList.remove('hidden');
          smartTitleInput?.focus();
        }
      });

      // Close when leaving the task module, but only if inputs are empty
      if (taskModule && addTaskCard) {
        taskModule.addEventListener('mouseleave', () => {
          const hasInput = (smartTitleInput?.value?.trim() || '') !== '' ||
            (smartNotesInput?.value?.trim() || '') !== '';
          if (!hasInput) {
            addTaskCard.classList.add('hidden');
          }
        });
      }

      // Smart Save Handler
      const smartSaveBtn = document.getElementById('smart-save-btn');
      const smartTitle = document.getElementById('smart-task-title');
      const smartNotes = document.getElementById('smart-task-notes');

      const handleSmartSave = async () => {
        const text = smartTitle.value.trim();
        if (!text) return;

        const aiEnabled = document.getElementById('ai-parsing-toggle').checked;
        const manualNotes = smartNotes.value.trim();

        // NEW: Calculate word count of the title input for the > 3 words rule
        const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

        // Combine title + notes for parsing context
        const fullContext = manualNotes ? `${text}\n${manualNotes}` : text;

        let parsed;
        if (aiEnabled) {
          showNotification("AI PARSING...", "info");
          parsed = await SmartTaskParser.parseAI(fullContext);
        } else {
          parsed = SmartTaskParser.parseRegex(fullContext);
        }

        // RULE: "Whatever written more than 3 words should be transferred to additional note exactly how it's written"
        if (wordCount > 3) {
          // Keep it intact, don't touch that.
          const intactOriginal = text;

          // If parser found subtasks or additional details, we can append them, 
          // but the intactOriginal MUST come first or be the main content.
          if (parsed.notes && !parsed.notes.includes(intactOriginal)) {
            parsed.notes = `${intactOriginal}\n\n[Details]:\n${parsed.notes}`;
          } else {
            parsed.notes = intactOriginal;
          }
        }

        // Final merge with manual notes from the textarea if any
        if (manualNotes) {
          if (!parsed.notes) {
            parsed.notes = manualNotes;
          } else if (!parsed.notes.includes(manualNotes)) {
            parsed.notes = `${parsed.notes}\n\n[User Notes]:\n${manualNotes}`;
          }
        }

        // Create Task
        createSmartTask(parsed);

        // Reset & Close
        smartTitle.value = '';
        smartNotes.value = '';
        document.getElementById('add-task-card').classList.add('hidden');
      };

      if (smartSaveBtn) smartSaveBtn.addEventListener('click', handleSmartSave);

      if (smartTitle) {
        smartTitle.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            handleSmartSave();
          }
        });
      }
    }

    if (toggleCompleted) {
      // Restore state: keep expanded if user left it open
      const isExpanded = localStorage.getItem('tasks_completed_expanded') === 'true';
      const tasksModule = document.getElementById('tasks-module');

      if (isExpanded) {
        completedListEl.classList.add('visible');
        if (tasksModule) {
          tasksModule.classList.add('expanded');
        }
      }

      toggleCompleted.addEventListener('click', () => {
        completedListEl.classList.toggle('visible');
        const isVisible = completedListEl.classList.contains('visible');
        localStorage.setItem('tasks_completed_expanded', isVisible);

        if (tasksModule) {
          if (isVisible) {
            tasksModule.classList.add('expanded');
          } else {
            tasksModule.classList.remove('expanded');
          }
        }

        // Update clear button visibility based on expansion state
        const clearBtn = document.getElementById('clear-completed-btn');
        if (clearBtn) {
          const hasCompletedTasks = completedTasks.length > 0;
          if (isVisible && hasCompletedTasks) {
            clearBtn.classList.remove('hidden');
          } else {
            clearBtn.classList.add('hidden');
          }
        }
      });
    }

    // Hover Expand for Completed Tasks - Header always visible, expand on hover
    if (completedWrapper && completedListEl && toggleCompleted) {
      const tasksModule = document.getElementById('tasks-module');
      const updateClearButtonVisibility = () => {
        const clearBtn = document.getElementById('clear-completed-btn');
        if (clearBtn) {
          const isVisible = completedListEl.classList.contains('visible');
          const hasCompletedTasks = completedTasks.length > 0;
          if (isVisible && hasCompletedTasks) {
            clearBtn.classList.remove('hidden');
          } else {
            clearBtn.classList.add('hidden');
          }
        }
      };

      // Hover on header or wrapper to expand
      toggleCompleted.addEventListener('mouseenter', () => {
        if (completedTasks.length > 0) {
          completedListEl.classList.add('visible');
          updateClearButtonVisibility();
        }
      });

      completedWrapper.addEventListener('mouseenter', () => {
        if (completedTasks.length > 0) {
          completedListEl.classList.add('visible');
          updateClearButtonVisibility();
        }
      });

      completedWrapper.addEventListener('mouseleave', () => {
        // Only collapse if not explicitly expanded by click
        const isExplicitlyExpanded = localStorage.getItem('tasks_completed_expanded') === 'true';
        if (!isExplicitlyExpanded) {
          completedListEl.classList.remove('visible');
        }
        updateClearButtonVisibility();
      });
    }

    // Add touch support for mobile devices
    const handleTouchStart = (e) => {
      const card = e.target.closest('.task-card');
      if (!card) return;

      // Don't activate if clicking on interactive elements
      if (e.target.closest('.task-checkbox') ||
        e.target.closest('.action-btn') ||
        e.target.closest('.note-area') ||
        e.target.closest('.save-note-btn')) {
        return;
      }

      // Add touch-active class to show actions
      card.classList.add('touch-active');

      // Remove after a delay or on touch end
      setTimeout(() => {
        card.classList.remove('touch-active');
      }, 3000);
    };

    const handleTouchEnd = (e) => {
      const card = e.target.closest('.task-card');
      if (card && !e.target.closest('.action-btn')) {
        // Keep active if user is interacting with actions
        setTimeout(() => {
          if (!document.activeElement || !document.activeElement.closest('.task-actions')) {
            card.classList.remove('touch-active');
          }
        }, 100);
      }
    };

    // Add touch event listeners for mobile
    [taskListEl, completedListEl].forEach(el => {
      if (!el) return;

      // Touch support
      el.addEventListener('touchstart', handleTouchStart, { passive: true });
      el.addEventListener('touchend', handleTouchEnd, { passive: true });

      // Click outside to close touch-active
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.task-card')) {
          document.querySelectorAll('.task-card.touch-active').forEach(card => {
            card.classList.remove('touch-active');
          });
        }
      });

      el.addEventListener('click', (e) => {
        const card = e.target.closest('.task-card');
        if (!card) return;

        const taskId = card.dataset.id;

        // Checkbox click
        if (e.target.classList.contains('task-checkbox')) {
          e.stopPropagation();
          toggleTaskCompletion(taskId);
          return;
        }

        // Delete click
        if (e.target.classList.contains('delete-task-btn')) {
          e.stopPropagation();
          deleteTask(taskId);
          return;
        }

        // Copy click
        if (e.target.classList.contains('copy-task-btn')) {
          e.stopPropagation();
          const noteArea = card.querySelector('.note-area');
          if (noteArea && noteArea.value) {
            navigator.clipboard.writeText(noteArea.value).then(() => {
              showNotification("COPIED TO CLIPBOARD", "success");
            }).catch(err => {
              console.error('Failed to copy to clipboard:', err);
              showNotification("COPY FAILED", "error");
            });
          } else {
            showNotification("NO NOTES TO COPY", "info");
          }
          return;
        }

        // Save note click
        if (e.target.classList.contains('save-note-btn')) {
          e.stopPropagation();
          const noteArea = card.querySelector('.note-area');
          if (noteArea) {
            updateTaskNote(taskId, noteArea.value);
          }
          return;
        }

        // Expanded view copy button
        if (e.target.closest('.copy-note-btn')) {
          e.stopPropagation();
          const noteArea = card.querySelector('.note-area');
          if (noteArea && noteArea.value) {
            navigator.clipboard.writeText(noteArea.value).then(() => {
              showNotification("COPIED TO CLIPBOARD", "success");
            }).catch(err => {
              console.error('Failed to copy to clipboard:', err);
              showNotification("COPY FAILED", "error");
            });
          } else {
            showNotification("NO NOTES TO COPY", "info");
          }
          return;
        }

        // Expanded view delete button
        if (e.target.closest('.delete-note-btn')) {
          e.stopPropagation();
          deleteTask(taskId);
          return;
        }
      });

      el.addEventListener('dblclick', (e) => {
        const card = e.target.closest('.task-card');
        if (!card) return;

        // Prevent dblclick on controls
        if (e.target.closest('.task-checkbox') || e.target.closest('.action-btn')) return;

        const titleEl = card.querySelector('.task-title');
        const text = titleEl.innerText.trim();

        // Check if it's ONLY a link
        const urlPattern = /^(https?:\/\/)?([\da-z\.-]+)\.([a-z\.]{2,6})([\/\w \.-]*)*\/?$/i;
        if (urlPattern.test(text)) {
          let url = text;
          if (!url.startsWith('http')) {
            url = 'https://' + url;
          }
          window.open(url, '_blank');
          return; // act as hyperlink, don't enter edit mode
        }

        // Toggle Edit Mode
        const isEditing = card.classList.toggle('editing');
        card.classList.toggle('expanded', isEditing); // Also expand notes

        titleEl.contentEditable = isEditing;

        if (isEditing) {
          titleEl.focus();
          // Select all text
          const range = document.createRange();
          range.selectNodeContents(titleEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          // Save changes if toggled off via dblclick (unlikely user flow, but fallback)
          updateTaskTitle(card.dataset.id, titleEl.innerText);
        }
      });

      // Handle Enter/Blur on editable title
      el.addEventListener('keydown', (e) => {
        if (e.target.classList.contains('task-title') && e.key === 'Enter') {
          e.preventDefault();
          e.target.blur(); // Triggers blur which saves
        }
      });

      el.addEventListener('focusout', (e) => {
        if (e.target.classList.contains('task-title')) {
          const card = e.target.closest('.task-card');
          if (card && card.classList.contains('editing')) {
            updateTaskTitle(card.dataset.id, e.target.innerText);
            // Optional: Keep expanded or close? User said "open edit mode", not close.
            // We'll leave it in "edit mode" visual (expanded) but stop title editing
            e.target.contentEditable = false;
            // Remove editing class only from title styling perspective if needed, 
            // but 'editing' class on card controls style. 
            // Let's decide: finish editing title = exit edit mode? 
            // "Double-click card: open edit mode". 
            // Let's keep it simple: Blur = save title. User can minimize manually or click away?
            // Actually, usually blur means "done editing this field".
          }
        }
      });
    });

    // Drag and Drop
    initDragAndDrop();
  }

  async function loadTasks() {
    // Always load from cache first for instant feedback
    const cached = JSON.parse(localStorage.getItem('tasks_cached') || '{"active":[], "completed":[]}');
    if (cached.active.length > 0 || cached.completed.length > 0) {
      activeTasks = cached.active;
      completedTasks = cached.completed;
      renderTasks();
    }

    // Then check auth and sync in background
    chrome.storage.local.get("google_access_token", async (res) => {
      if (res.google_access_token) {
        syncTasksWithGoogle(res.google_access_token);
      }
    });
  }

  async function syncTasksWithGoogle(token) {
    try {
      // 1. FIRST: Push any pending local changes to Google
      await SyncQueue.processQueue(token);

      // 2. THEN: Fetch current state from Google
      const headers = { Authorization: `Bearer ${token}` };
      const res = await googleApiFetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks?showCompleted=true&showHidden=true', { headers });
      const data = await res.json();

      const googleTasks = data.items || [];

      // 3. MERGE: Combine local and Google data
      // Keep local-only tasks (temp- IDs that weren't synced yet)
      const localOnlyActive = activeTasks.filter(t => t.id.startsWith('temp-'));
      const localOnlyCompleted = completedTasks.filter(t => t.id.startsWith('temp-'));

      // Categorize Google tasks
      let googleActive = googleTasks.filter(t => t.status !== 'completed');
      let googleCompleted = googleTasks.filter(t => t.status === 'completed');

      // Add sync metadata
      googleActive = googleActive.map(t => ({ ...t, syncStatus: 'synced', source: 'google' }));
      googleCompleted = googleCompleted.map(t => ({ ...t, syncStatus: 'synced', source: 'google' }));

      // Merge: Google tasks + local-only tasks
      const mergedActive = [...googleActive, ...localOnlyActive];
      const mergedCompleted = [...googleCompleted, ...localOnlyCompleted];

      // Only update if something changed
      const currentActiveStr = JSON.stringify(activeTasks);
      const mergedActiveStr = JSON.stringify(mergedActive);
      const currentCompletedStr = JSON.stringify(completedTasks);
      const mergedCompletedStr = JSON.stringify(mergedCompleted);

      if (currentActiveStr !== mergedActiveStr || currentCompletedStr !== mergedCompletedStr) {
        activeTasks = mergedActive;
        completedTasks = mergedCompleted;
        saveLocalTasks();
        renderTasks();
        console.log('[Sync] Tasks merged. Active:', activeTasks.length, 'Completed:', completedTasks.length);
      }
    } catch (err) {
      console.error("Sync tasks failed", err);
    }
  }

  async function createTask(title) {
    // Validate input
    if (!title || typeof title !== 'string') {
      console.warn('Invalid task title provided');
      return;
    }
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      showNotification("TASK TITLE CANNOT BE EMPTY", "warning");
      return;
    }
    if (trimmedTitle.length > 500) {
      showNotification("TASK TITLE TOO LONG (MAX 500 CHARACTERS)", "warning");
      return;
    }

    // Optimistic UI Update
    const tempId = 'temp-' + Date.now();
    const newTask = { id: tempId, title: trimmedTitle, status: 'needsAction', notes: '', priority: 0, syncStatus: 'pending', source: 'local' };
    activeTasks.unshift(newTask);
    saveLocalTasks();
    renderTasks();

    // Queue and Sync
    SyncQueue.add('create', 'task', newTask);
    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  }

  async function toggleTaskCompletion(taskId) {
    const task = activeTasks.find(t => t.id === taskId) || completedTasks.find(t => t.id === taskId);
    if (!task) return;

    const newStatus = task.status === 'completed' ? 'needsAction' : 'completed';

    // Add visual animation
    const card = document.querySelector(`.task-card[data-id="${taskId}"]`);
    if (card && newStatus === 'completed') {
      card.classList.add('completing');
      await new Promise(r => setTimeout(r, 400));
    }

    // Optimistic UI Update
    task.status = newStatus;
    task.syncStatus = 'pending'; // Mark as pending sync

    if (newStatus === 'completed') {
      activeTasks = activeTasks.filter(t => t.id !== taskId);
      completedTasks.unshift(task);
    } else {
      completedTasks = completedTasks.filter(t => t.id !== taskId);
      activeTasks.unshift(task);
    }
    saveLocalTasks();
    renderTasks();

    // Queue and Sync
    SyncQueue.add('update', 'task', { id: taskId, changes: { status: newStatus } });
    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  }

  async function updateTaskTitle(taskId, newTitle) {
    if (!newTitle || typeof newTitle !== 'string') {
      console.warn('Invalid task title provided');
      return;
    }
    const trimmedTitle = newTitle.trim();
    if (!trimmedTitle) {
      showNotification("TASK TITLE CANNOT BE EMPTY", "warning");
      return;
    }
    if (trimmedTitle.length > 500) {
      showNotification("TASK TITLE TOO LONG (MAX 500 CHARACTERS)", "warning");
      return;
    }

    // Local Update
    const task = activeTasks.find(t => t.id === taskId) || completedTasks.find(t => t.id === taskId);
    if (task) {
      task.title = trimmedTitle;
      task.syncStatus = 'pending';
      saveLocalTasks();
    }

    // Queue and Sync
    SyncQueue.add('update', 'task', { id: taskId, changes: { title: newTitle } });

    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  }

  async function updateTaskNote(taskId, notes) {
    // Local Update
    const task = activeTasks.find(t => t.id === taskId) || completedTasks.find(t => t.id === taskId);
    if (task) {
      task.notes = notes;
      task.syncStatus = 'pending';
      saveLocalTasks();
    }
    showNotification("NOTE SAVED", "success");

    // Queue and Sync
    SyncQueue.add('update', 'task', { id: taskId, changes: { notes } });

    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  }

  async function deleteTask(taskId) {
    // Optimistic UI Update
    activeTasks = activeTasks.filter(t => t.id !== taskId);
    completedTasks = completedTasks.filter(t => t.id !== taskId);
    saveLocalTasks();
    renderTasks();

    // Queue and Sync
    SyncQueue.add('delete', 'task', { id: taskId });

    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  }

  async function clearCompletedTasks() {
    if (completedTasks.length === 0) return;

    // Optional: Confirm dialog
    if (!confirm("Delete all completed tasks potentially?")) return;

    const idsToDelete = completedTasks.map(t => t.id);

    // Optimistic UI Clear
    completedTasks = [];
    saveLocalTasks();
    renderTasks();

    showNotification("Clearing completed tasks...", "info");

    // Background Delete
    chrome.storage.local.get("google_access_token", async (res) => {
      if (res.google_access_token) {
        const token = res.google_access_token;
        let failCount = 0;

        // Process in chunks to respect API limits/performance
        const chunkSize = 8;
        for (let i = 0; i < idsToDelete.length; i += chunkSize) {
          const chunk = idsToDelete.slice(i, i + chunkSize);
          await Promise.all(chunk.map(async (taskId) => {
            // Skip locally generated temp IDs
            if (taskId.startsWith('temp-')) return;
            try {
              await googleApiFetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${taskId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
              });
            } catch (e) {
              console.error(`Failed to delete task ${taskId}`, e);
              failCount++;
            }
          }));
        }

        if (failCount > 0) {
          showNotification(`Cleared specific tasks with ${failCount} errors.`, "warning");
        } else {
          showNotification("All completed tasks deleted.", "success");
        }
        // Final sync to ensure clean state
        syncTasksWithGoogle(token);
      }
    });
  }

  function saveLocalTasks() {
    // Use immediate write for critical task data (user actions)
    localStorage.setItem('tasks_cached', JSON.stringify({ active: activeTasks, completed: completedTasks }));

    // Also sync to chrome.storage with debouncing for non-critical sync
    if (window.PerformanceUtils) {
      window.PerformanceUtils.debouncedStorageWrite('tasks_cached_chrome', {
        active: activeTasks,
        completed: completedTasks
      });
    }
  }

  function renderTasks() {
    const taskListEl = document.getElementById('task-list');
    const completedListEl = document.getElementById('completed-task-list');
    const completedCountEl = document.getElementById('completed-count');
    const tasksModule = document.getElementById('tasks-module');

    if (!taskListEl || !completedListEl) return;

    // Task section expansion is handled by CSS - no JavaScript needed
    if (tasksModule) {
      // FORCE CLEANUP: Remove any inline styles that might conflict with CSS
      tasksModule.style.removeProperty('height');
      tasksModule.style.removeProperty('max-height');
      tasksModule.style.removeProperty('min-height');
    }

    // Use batched DOM updates for better performance
    const utils = window.PerformanceUtils;

    const updateDOM = () => {
      // Clear and prepare
      taskListEl.innerHTML = '';
      completedListEl.innerHTML = '';

      // Batch create active tasks
      if (activeTasks.length === 0) {
        taskListEl.innerHTML = '<div class="empty-state">No active objectives.</div>';
      } else {
        const activeFragment = utils ? utils.createFragment() : document.createDocumentFragment();
        activeTasks.forEach(task => {
          activeFragment.appendChild(createTaskCard(task));
        });
        taskListEl.appendChild(activeFragment);
      }

      // Batch create completed tasks WITH PAGINATION LIMIT
      if (completedTasks.length === 0) {
        completedListEl.innerHTML = '<div class="empty-state">No completed tasks.</div>';
      } else {
        const completedFragment = utils ? utils.createFragment() : document.createDocumentFragment();

        // LIMIT LOGIC: Show only first 20 by default
        // Check if we are already showing all (state could be stored in a closure or checked via DOM, 
        // but for simplicity we'll just check a class or flag. 
        // Actually, let's keep it simple: Default = 20. User clicks "Show All" -> renders all.
        // We need a way to track this state. We can store it on the element or a global variable.
        // Let's use a dataset attribute on the list element for persistence across re-renders
        const showAll = completedListEl.dataset.showAll === 'true';
        const limit = showAll ? completedTasks.length : 20;
        const visibleTasks = completedTasks.slice(0, limit);

        visibleTasks.forEach(task => {
          completedFragment.appendChild(createTaskCard(task, true));
        });

        // Append "Show All" button if there are more tasks and not showing all
        if (!showAll && completedTasks.length > 20) {
          const remainingCount = completedTasks.length - 20;
          const showMoreBtn = document.createElement('button');
          showMoreBtn.className = 'show-more-tasks-btn'; // We'll need to style this
          showMoreBtn.textContent = `Show ${remainingCount} more completed tasks...`;
          showMoreBtn.style.cssText = "width:100%; padding:10px; background:var(--bg-card); border:1px solid var(--border-subtle); color:var(--text-secondary); cursor:pointer; margin-top:8px; border-radius:8px; font-size:0.85rem;";
          showMoreBtn.onclick = () => {
            completedListEl.dataset.showAll = 'true';
            renderTasks(); // Re-render to show all
          };
          completedFragment.appendChild(showMoreBtn);
        } else if (showAll && completedTasks.length > 20) {
          // Optional: "Show Less" button
          const showLessBtn = document.createElement('button');
          showLessBtn.className = 'show-less-tasks-btn';
          showLessBtn.textContent = `Show less`;
          showLessBtn.style.cssText = "width:100%; padding:10px; background:var(--bg-card); border:1px solid var(--border-subtle); color:var(--text-secondary); cursor:pointer; margin-top:8px; border-radius:8px; font-size:0.85rem;";
          showLessBtn.onclick = () => {
            completedListEl.dataset.showAll = 'false';
            renderTasks(); // Re-render to collapse
          };
          completedFragment.appendChild(showLessBtn);
        }

        completedListEl.appendChild(completedFragment);
      }

      if (completedCountEl) completedCountEl.textContent = completedTasks.length;

      // Show/hide existing Clear Button from HTML - only when section is expanded AND has tasks
      const existingClearBtn = document.getElementById('clear-completed-btn');
      if (existingClearBtn) {
        const isExpanded = completedListEl.classList.contains('visible');
        if (completedTasks.length > 0 && isExpanded) {
          existingClearBtn.classList.remove('hidden');
          // Remove old listeners and add new one to prevent duplicates
          const newBtn = existingClearBtn.cloneNode(true);
          existingClearBtn.parentNode.replaceChild(newBtn, existingClearBtn);
          newBtn.addEventListener('click', clearCompletedTasks);
        } else {
          existingClearBtn.classList.add('hidden');
        }
      }

      // Reset all card transforms
      resetAllCardTransforms();
    };

    if (utils) {
      utils.batchDOMUpdate(updateDOM);
    } else {
      updateDOM();
    }
  }

  // Function to reset all task card transforms
  function resetAllCardTransforms() {
    const allCards = document.querySelectorAll('.task-card');
    allCards.forEach(card => {
      if (!card.classList.contains('isDragging') && !card.classList.contains('completing')) {
        card.style.transform = '';
        card.style.opacity = '';
      }
    });
  }

  function createTaskCard(task, isCompleted = false) {
    const card = document.createElement('div');
    card.className = `task-card ${isCompleted ? 'completed' : ''}`;
    card.draggable = true;
    card.dataset.id = task.id;
    // Add priority data attribute for styling
    if (task.priority !== undefined) {
      card.dataset.priority = task.priority;
    }

    // Safe date parsing with validation
    let dueStr = '';
    if (task.due) {
      try {
        const due = new Date(task.due);
        if (!isNaN(due.getTime())) {
          dueStr = due.toLocaleDateString();
        }
      } catch (e) {
        console.warn('Invalid date format for task:', task.id, e);
      }
    }

    // Create task-main container
    const taskMain = document.createElement('div');
    taskMain.className = 'task-main';

    // Create checkbox
    const checkbox = document.createElement('div');
    checkbox.className = `task-checkbox ${isCompleted ? 'checked' : ''}`;
    taskMain.appendChild(checkbox);

    // Create title (safe textContent)
    const title = document.createElement('div');
    title.className = 'task-title';
    title.textContent = task.title || '';
    taskMain.appendChild(title);

    // Create due date if exists
    if (dueStr) {
      const dueEl = document.createElement('div');
      dueEl.className = 'task-due';
      dueEl.textContent = dueStr;
      taskMain.appendChild(dueEl);
    }

    // Create actions container
    const actions = document.createElement('div');
    actions.className = 'task-actions';

    // Create copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn copy-task-btn';
    copyBtn.title = 'Copy Note';
    copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    actions.appendChild(copyBtn);

    // Create delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-task-btn';
    deleteBtn.title = 'Delete Task';
    deleteBtn.textContent = '×';
    actions.appendChild(deleteBtn);

    taskMain.appendChild(actions);
    card.appendChild(taskMain);

    // Create expanded section
    const expanded = document.createElement('div');
    expanded.className = 'task-expanded';

    // Create textarea (safe value assignment)
    const textarea = document.createElement('textarea');
    textarea.className = 'note-area';
    textarea.placeholder = 'Add additional notes...';
    textarea.value = task.notes || '';
    expanded.appendChild(textarea);

    // Create footer container for better organization
    const footer = document.createElement('div');
    footer.className = 'task-expanded-footer';

    // Create actions container
    const expandedActions = document.createElement('div');
    expandedActions.className = 'task-expanded-actions';

    // Create copy note button for expanded view
    const copyNoteBtn = document.createElement('button');
    copyNoteBtn.className = 'task-expanded-action-btn copy-note-btn';
    copyNoteBtn.title = 'Copy Note';
    copyNoteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span>';
    copyNoteBtn.type = 'button';
    expandedActions.appendChild(copyNoteBtn);

    // Create delete button for expanded view
    const deleteExpandedBtn = document.createElement('button');
    deleteExpandedBtn.className = 'task-expanded-action-btn delete-note-btn';
    deleteExpandedBtn.title = 'Delete Task';
    deleteExpandedBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span>Delete</span>';
    deleteExpandedBtn.type = 'button';
    expandedActions.appendChild(deleteExpandedBtn);

    footer.appendChild(expandedActions);

    // Create save button
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-note-btn';
    saveBtn.textContent = 'SAVE';
    saveBtn.type = 'button';
    footer.appendChild(saveBtn);

    expanded.appendChild(footer);
    card.appendChild(expanded);

    // Remove the conflicting mousedown handler - gesture system handles everything
    // The gesture system will handle all drag interactions

    return card;
  }

  /* --- GESTURES & DRAG --- */
  function initGestureListeners() {
    const taskListEl = document.getElementById('task-list');
    const completedListEl = document.getElementById('completed-task-list');
    if (!taskListEl && !completedListEl) return;

    // Shared state
    let startX = 0;
    let startY = 0;
    let activeCard = null;
    let activePointerId = null;
    let axisLocked = null; // 'horizontal' | 'vertical' | null
    let lockedAxisThreshold = 10; // Pixels to move before locking axis
    let originalPriority = null;
    let isDragging = false;
    let currentDeltaX = 0;
    let currentDeltaY = 0;

    const updateVisuals = () => {
      if (!activeCard || !axisLocked) return;

      if (axisLocked === 'horizontal') {
        activeCard.style.transform = `translateX(${currentDeltaX}px)`;
        activeCard.style.opacity = Math.max(0.3, 1 - Math.abs(currentDeltaX) / 400);
      } else if (axisLocked === 'vertical') {
        activeCard.style.transform = `translateY(${currentDeltaY}px)`;
        const priorityChange = Math.round(currentDeltaY / 50);
        if (priorityChange !== 0) {
          activeCard.classList.add('priority-dragging');
          activeCard.dataset.priorityOffset = priorityChange;
        } else {
          activeCard.classList.remove('priority-dragging');
          delete activeCard.dataset.priorityOffset;
        }
      }
    };

    const onPointerDown = (e) => {
      // Only left click for mouse
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      // Ignore clicks on interactive elements
      if (e.target.closest('.task-checkbox') ||
        e.target.closest('.action-btn') ||
        e.target.closest('.task-expanded-action-btn') ||
        e.target.closest('.task-expanded-footer') ||
        e.target.closest('.note-area') ||
        e.target.closest('.task-title[contenteditable="true"]') ||
        e.target.closest('.save-note-btn')) {
        return;
      }

      const card = e.target.closest('.task-card');
      if (!card || card.classList.contains('editing') || card.classList.contains('expanded')) return;

      // Prevent default to stop text selection and other browser behaviors
      e.preventDefault();
      e.stopPropagation();

      // Initialize drag state
      activeCard = card;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      currentDeltaX = 0;
      currentDeltaY = 0;
      axisLocked = null;
      isDragging = false;

      // Store original priority
      const taskId = activeCard.dataset.id;
      const task = activeTasks.find(t => t.id === taskId) || completedTasks.find(t => t.id === taskId);
      originalPriority = task?.priority || 0;

      // Prepare card for dragging
      activeCard.style.transition = 'none';
      activeCard.style.zIndex = '1000';
      activeCard.style.willChange = 'transform';
      activeCard.draggable = false; // Disable native HTML5 drag

      // Capture pointer for better tracking
      try {
        if (e.pointerId !== undefined) {
          activeCard.setPointerCapture(e.pointerId);
        }
      } catch (err) {
        // Pointer capture might fail, continue anyway
      }
    };

    const onPointerMove = (e) => {
      if (!activeCard || activePointerId === null) return;

      // Verify this is our pointer
      if (e.pointerId !== activePointerId && e.pointerId !== undefined) return;

      // Safety check for mouse
      if (e.pointerType === 'mouse' && e.buttons !== 1) {
        onPointerUp(e);
        return;
      }

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const absDeltaX = Math.abs(deltaX);
      const absDeltaY = Math.abs(deltaY);

      // AXIS LOCKING: Lock to primary direction
      if (!axisLocked) {
        if (absDeltaX > lockedAxisThreshold || absDeltaY > lockedAxisThreshold) {
          // Determine which axis has more movement
          if (absDeltaX > absDeltaY) {
            axisLocked = 'horizontal';
            isDragging = true;
          } else {
            axisLocked = 'vertical';
            isDragging = true;
          }
        } else {
          // Not enough movement yet, don't process
          return;
        }
      }

      // Prevent default scrolling/selection once axis is locked
      if (isDragging) {
        e.preventDefault();
        e.stopPropagation();
      }

      // Update deltas based on locked axis
      if (axisLocked === 'horizontal') {
        currentDeltaX = deltaX;
        currentDeltaY = 0; // Lock vertical movement

        // Visual feedback
        if (currentDeltaX > 15) {
          activeCard.classList.add('swiping-delete');
          activeCard.classList.remove('swiping-complete');
        } else if (currentDeltaX < -15) {
          activeCard.classList.add('swiping-complete');
          activeCard.classList.remove('swiping-delete');
        } else {
          activeCard.classList.remove('swiping-delete', 'swiping-complete');
        }
      } else if (axisLocked === 'vertical') {
        currentDeltaY = deltaY;
        currentDeltaX = 0; // Lock horizontal movement
        activeCard.classList.add('priority-dragging');
        const priorityOffset = Math.round(currentDeltaY / 50);
        activeCard.dataset.priorityOffset = priorityOffset;
      }

      // Update visuals immediately
      updateVisuals();

      // Ensure card doesn't overlap with others during drag
      if (activeCard && isDragging) {
        activeCard.classList.add('isDragging');
        activeCard.style.position = 'relative';
        activeCard.style.zIndex = '1000';
        // Prevent layout shift by maintaining space
        activeCard.style.marginBottom = '6px'; // Match gap
      }
    };

    const onPointerUp = (e) => {
      if (!activeCard) return;

      // Verify this is our pointer
      if (activePointerId !== null && e.pointerId !== undefined && e.pointerId !== activePointerId) {
        return;
      }

      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      const taskId = activeCard.dataset.id;

      // Release pointer capture
      try {
        if (activePointerId !== null && activePointerId !== undefined) {
          activeCard.releasePointerCapture(activePointerId);
        }
      } catch (err) {
        // Ignore errors
      }

      // Restore transitions and reset positioning
      activeCard.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
      activeCard.classList.remove('swiping-delete', 'swiping-complete', 'priority-dragging', 'isDragging');
      activeCard.style.zIndex = '';
      activeCard.style.position = 'relative'; // Ensure proper positioning
      activeCard.style.marginBottom = ''; // Reset margin

      // Execute actions based on locked axis
      if (axisLocked === 'horizontal' && isDragging) {
        const threshold = 70;

        if (deltaX > threshold) {
          // RIGHT -> DELETE
          activeCard.style.transform = 'translateX(150%)';
          activeCard.style.opacity = '0';
          setTimeout(() => deleteTask(taskId), 350);
        } else if (deltaX < -threshold) {
          // LEFT -> COMPLETE
          activeCard.style.transform = 'translateX(-150%)';
          activeCard.style.opacity = '0';
          setTimeout(() => toggleTaskCompletion(taskId), 350);
        } else {
          // SNAP BACK
          activeCard.style.transform = '';
          activeCard.style.opacity = '';
        }
      } else if (axisLocked === 'vertical' && isDragging) {
        const priorityChange = Math.round(deltaY / 50);
        const threshold = 30;

        if (Math.abs(deltaY) > threshold && priorityChange !== 0) {
          updateTaskPriority(taskId, originalPriority + priorityChange);
          activeCard.style.transform = 'scale(1.05)';
          setTimeout(() => {
            activeCard.style.transform = '';
          }, 200);
        } else {
          activeCard.style.transform = '';
        }
      } else {
        // No significant drag, just reset
        activeCard.style.transform = '';
        activeCard.style.opacity = '';
      }

      // Cleanup - Ensure all transforms are reset to prevent collisions
      setTimeout(() => {
        if (activeCard) {
          activeCard.draggable = true;
          // Force reset all transform properties
          activeCard.style.transform = 'none';
          activeCard.style.opacity = '';
          activeCard.style.willChange = '';
          activeCard.style.zIndex = '';
          activeCard.style.position = ''; // Reset to default relative
          delete activeCard.dataset.priorityOffset;
          // Remove any lingering classes that might affect positioning
          activeCard.classList.remove('isDragging', 'priority-dragging');
        }
      }, 100);

      // Reset all state
      activeCard = null;
      activePointerId = null;
      axisLocked = null;
      isDragging = false;
      currentDeltaX = 0;
      currentDeltaY = 0;
      originalPriority = null;
    };

    // Add event listeners
    [taskListEl, completedListEl].forEach(listEl => {
      if (!listEl) return;
      listEl.addEventListener('pointerdown', onPointerDown, { passive: false, capture: false });
    });

    // Global listeners for move and up (to track even if pointer leaves element)
    document.addEventListener('pointermove', onPointerMove, { passive: false, capture: false });
    document.addEventListener('pointerup', onPointerUp, { passive: true, capture: false });
    document.addEventListener('pointercancel', onPointerUp, { passive: true, capture: false });
  }

  // Function to update task priority
  async function updateTaskPriority(taskId, newPriority) {
    // Clamp priority between -2 (lowest) and 2 (highest)
    newPriority = Math.max(-2, Math.min(2, Math.round(newPriority)));

    const task = activeTasks.find(t => t.id === taskId) || completedTasks.find(t => t.id === taskId);
    if (!task) return;

    const oldPriority = task.priority || 0;
    if (oldPriority === newPriority) return;

    // Update task
    task.priority = newPriority;
    task.syncStatus = 'pending';
    saveLocalTasks();
    renderTasks();

    // Show feedback
    const priorityLabels = { '-2': 'Very Low', '-1': 'Low', '0': 'Normal', '1': 'High', '2': 'Very High' };
    showNotification(`PRIORITY: ${priorityLabels[newPriority] || 'Normal'}`, "info");

    // Queue and Sync
    SyncQueue.add('update', 'task', { id: taskId, changes: { priority: newPriority } });
    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  }

  function initRotatingTips() {
    const hintEl = document.querySelector('.smart-hint');
    if (!hintEl) return;

    const examples = [
      "Meeting with Team @ 3pm",
      "Grocery: Milk, bread, apples",
      "Finish project report tomorrow",
      "Buy gift for Mom's birthday",
      "Review PR #412",
      "Plan weekend trip to mountains"
    ];

    let currentIndex = 0;

    const updateTip = () => {
      hintEl.classList.add('fade-out');

      setTimeout(() => {
        currentIndex = (currentIndex + 1) % examples.length;
        hintEl.textContent = `Tip: ${examples[currentIndex]}`;
        hintEl.classList.remove('fade-out');
      }, 500); // Matches CSS transition duration
    };

    // Initial set
    hintEl.textContent = `Tip: ${examples[0]}`;

    // Rotate every 6 seconds
    setInterval(updateTip, 6000);
  }

  function initDragAndDrop() {
    const activeListEl = document.getElementById('task-list');
    const completedListEl = document.getElementById('completed-task-list');
    const lists = [activeListEl, completedListEl];

    let startParent = null;

    lists.forEach(list => {
      if (!list) return;

      list.addEventListener('dragstart', e => {
        const card = e.target.closest('.task-card');
        if (card && !card.isDragging) {
          // Only allow native drag if not using gesture system
          card.classList.add('dragging');
          startParent = card.parentElement;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', card.dataset.id);
        } else {
          // Prevent native drag if gesture system is active
          e.preventDefault();
        }
      });

      list.addEventListener('dragend', e => {
        const card = e.target.closest('.task-card');
        if (card) {
          card.classList.remove('dragging');
          updateTaskStateAfterDrop();
        }
      });

      list.addEventListener('dragover', e => {
        e.preventDefault();
        const draggingCard = document.querySelector('.dragging');
        if (!draggingCard) return;

        const targetList = e.currentTarget;
        const afterElement = getDragAfterElement(targetList, e.clientY);

        if (afterElement == null) {
          targetList.appendChild(draggingCard);
        } else {
          targetList.insertBefore(draggingCard, afterElement);
        }
      });
    });

    function getDragAfterElement(container, y) {
      const draggableElements = [...container.querySelectorAll('.task-card:not(.dragging)')];
      return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
          return { offset: offset, element: child };
        } else {
          return closest;
        }
      }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    function updateTaskStateAfterDrop() {
      // 1. Collect all current tasks to look up data
      const allTasksMap = new Map();
      [...activeTasks, ...completedTasks].forEach(t => allTasksMap.set(t.id, t));

      // 2. Rebuild arrays based on new DOM order
      const newActiveTasks = [];
      const newCompletedTasks = [];
      const statusUpdates = [];

      // Process Active List
      if (activeListEl) {
        activeListEl.querySelectorAll('.task-card').forEach(card => {
          const task = allTasksMap.get(card.dataset.id);
          if (task) {
            if (task.status === 'completed') {
              task.status = 'needsAction';
              statusUpdates.push(task);
              // Update visual styles immediately
              card.classList.remove('completed');
              const cb = card.querySelector('.task-checkbox');
              if (cb) cb.classList.remove('checked');
            }
            newActiveTasks.push(task);
          }
        });
      }

      // Process Completed List
      if (completedListEl) {
        completedListEl.querySelectorAll('.task-card').forEach(card => {
          const task = allTasksMap.get(card.dataset.id);
          if (task) {
            if (task.status !== 'completed') {
              task.status = 'completed';
              statusUpdates.push(task);
              // Update visual styles immediately
              card.classList.add('completed');
              const cb = card.querySelector('.task-checkbox');
              if (cb) cb.classList.add('checked');
            }
            newCompletedTasks.push(task);
          }
        });
      }

      // 3. Update Global State
      activeTasks = newActiveTasks;
      completedTasks = newCompletedTasks;
      saveLocalTasks();

      // Update counts
      const completedCountEl = document.getElementById('completed-count');
      if (completedCountEl) completedCountEl.textContent = completedTasks.length;

      // 4. Trigger Sync for status changes
      if (statusUpdates.length > 0) {
        chrome.storage.local.get("google_access_token", async (res) => {
          if (res.google_access_token) {
            const token = res.google_access_token;
            for (const task of statusUpdates) {
              try {
                await fetch(`https://www.googleapis.com/tasks/v1/lists/@default/tasks/${task.id}`, {
                  method: 'PATCH',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({ status: task.status })
                });
              } catch (e) { console.error("Drop sync error", e); }
            }
            // Final sync to be sure
            syncTasksWithGoogle(token);
          }
        });
      }
    }
  }

  /* --- 3. CLOCK --- */
  function initClock() {
    const clockEl = document.getElementById('clock');
    const dateEl = document.getElementById('date-display');

    if (!clockEl || !dateEl) return;

    const tick = () => {
      const now = new Date();
      const is12h = localStorage.getItem('clock_12h_enabled') !== 'false';

      let timeStr = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', hour12: is12h
      });

      if (is12h) {
        timeStr = timeStr.replace(/(AM|PM)/, '<span class="ampm">$1</span>');
        clockEl.innerHTML = timeStr;
      } else {
        clockEl.textContent = timeStr;
      }

      dateEl.textContent = now.toLocaleDateString('en-US', {
        weekday: 'long'
      });
      requestAnimationFrame(tick);
    };
    tick();
  }




  /* --- 5. WORKSPACE SYNC --- */
  async function checkAuthStatus() {
    console.log("[Auth] 🔍 checkAuthStatus() called");
    const loginBtn = document.getElementById('login-btn');

    try {
      // Check if user is marked as logged in AND if there's a stored token
      const storage = await new Promise(resolve => chrome.storage.local.get(["isLoggedIn", "google_user_persistent", "google_access_token"], resolve));
      const isLoggedIn = storage.isLoggedIn;
      const isPersistent = storage.google_user_persistent;
      const storedToken = storage.google_access_token;

      console.log("[Auth] 📦 Storage state:", {
        isLoggedIn,
        isPersistent,
        hasToken: !!storedToken,
        tokenLength: storedToken?.length || 0
      });

      // If user has a stored token OR is marked as logged in, try Worker-based refresh
      // NOTE: chrome.identity.getAuthToken() does NOT work with Web OAuth clients!
      // We must use Worker-based refresh exclusively for Web OAuth client type
      if (storedToken || isLoggedIn || isPersistent) {
        console.log("[Auth] User logged in. Using Worker-based refresh (Web OAuth client)...");

        // SKIP chrome.identity.getAuthToken() - it ONLY works with Chrome App OAuth clients
        // Our client is "Web application" type, so we use Worker exclusively

        // Try Worker-based refresh for token renewal
        if (isPersistent || isLoggedIn) {
          console.log("[Auth] Attempting Worker-based refresh...");
          try {
            const workerToken = await new Promise((resolve) => {
              chrome.runtime.sendMessage({ type: 'REFRESH_VIA_WORKER' }, (response) => {
                if (chrome.runtime.lastError) {
                  console.warn('[Auth] Worker message error:', chrome.runtime.lastError);
                  resolve(null);
                } else {
                  resolve(response?.success ? response.token : null);
                }
              });
            });

            if (workerToken) {
              console.log("[Auth] Worker refresh succeeded! Session restored.");
              await chrome.storage.local.set({
                "google_access_token": workerToken,
                "isLoggedIn": true,
                "google_user_persistent": true
              });
              hideConnectUI();
              await updateProfileInSettings(workerToken);
              syncWorkspace(workerToken);
              return;
            }
            console.log("[Auth] Worker refresh also failed.");
          } catch (workerErr) {
            console.warn("[Auth] Worker fallback error:", workerErr);
          }
        }

        // For persistent users, avoid automatic tab opening
        // Instead, we mark the session as "Needs Refresh" and wait for user interaction
        if (isPersistent || isLoggedIn) {
          console.log("[Auth] Persistent user detected. Marking session as expired for manual reconnect.");
          const profileEmail = document.getElementById('user-email');
          if (profileEmail) profileEmail.textContent = 'SESSION EXPIRED (RECONNECT)';

          // Keep UI in logged-in style to maintain the "Connected" feeling
          await chrome.storage.local.set({
            "isLoggedIn": true,
            "google_user_persistent": true
          });
          hideConnectUI();

          // We will NOT trigger attemptInteractiveRefresh(true) here because it opens a tab.
          // Instead, the user will see the status in the profile or a notification if they try to sync.
          return;
        } else {
          // Non-persistent user - clear state
          console.log("[Auth] Non-persistent user. Clearing logged-in state.");
          await chrome.storage.local.set({
            "isLoggedIn": false,
            "google_access_token": null
          });
          chrome.storage.local.remove(["google_access_token"]);
          showConnectUI();
          return;
        }
      } else {
        // User not logged in and no stored token
        console.log("[Auth] User not logged in.");
        showConnectUI();
        return;
      }
    } catch (err) {
      console.error("[Auth] Status check error:", err);
      showConnectUI();
    }
  }

  // ============================================
  // Authenticated API Request Helper
  // Uses background's ensureToken() for persistent auth
  // ============================================
  async function googleApiRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'AUTHENTICATED_REQUEST',
        url,
        options
      }, response => {
        if (chrome.runtime.lastError) {
          console.error('[API] Request failed:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.success) {
          resolve(response.data);
        } else {
          console.error('[API] Request error:', response?.error);
          reject(new Error(response?.error || 'Request failed'));
        }
      });
    });
  }

  // Get a valid token (uses ensureToken in background)
  async function getValidToken() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_VALID_TOKEN' }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response?.success) {
          resolve(response.token);
        } else {
          reject(new Error(response?.error || 'No token'));
        }
      });
    });
  }

  // Silent refresh - relies on Chrome's Identity API to handle token refresh automatically
  async function attemptSilentRefresh() {
    return new Promise((resolve) => {
      // Use getAuthToken (silent) - Chrome handles token caching/refresh internally
      chrome.identity.getAuthToken({ interactive: false, scopes: SCOPES }, (token) => {
        if (!chrome.runtime.lastError && token) {
          console.log("[Auth] Token obtained silently via native API.");
          resolve(token);
        } else {
          console.warn("[Auth] Silent refresh failed:", chrome.runtime.lastError?.message);
          resolve(null);
        }
      });
    });
  }

  // Interactive refresh: "Connect" button should FORCE a visible login window (users expect this).
  // We prioritize launchWebAuthFlow for the manual "Connect" action to ensure a visible popup/tab.
  async function attemptInteractiveRefresh(forceVisible = false) {
    console.log(`[Auth] Starting interactive auth flow (forceVisible=${forceVisible})...`);

    // If forcing visibility (manual Connect button), GO STRAIGHT TO TAB.
    // This is the most stable "Hybrid Auth" approach and avoids "double login" confusion.
    if (forceVisible) {
      console.log("[Auth] forceVisible=true, Opening Login Tab directly...");
      const clientId = "635413045241-bh93ib54pa4pd15fj9042qsij99290sp.apps.googleusercontent.com";
      const redirectUri = "https://ipmclbopdijpfhlknjhjnijddafggicg.chromiumapp.org/";
      const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');

      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'token');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', SCOPES.join(' '));
      authUrl.searchParams.set('prompt', 'select_account consent');

      chrome.tabs.create({ url: authUrl.toString() });
      console.log("[Auth] Login tab opened. Background snatcher will handle capture.");
      return null; // Return null because background message 'token_captured' will triggers handleNewToken
    }
  }

  async function syncWorkspace(token) {
    syncCalendar(token);
    syncTasksWithGoogle(token);

    if (window.driveModule) {
      // Ensure Drive module is initialized before syncing
      try {
        await window.driveModule.syncDriveFiles(token);
        await window.driveModule.fetchDriveQuota(token);
      } catch (err) {
        console.error('[Sync] Drive sync error:', err);
        // Retry after a short delay in case elements weren't ready
        setTimeout(() => {
          if (window.driveModule) {
            window.driveModule.syncDriveFiles(token).catch(e => console.error('[Sync] Drive retry failed:', e));
            window.driveModule.fetchDriveQuota(token).catch(e => console.error('[Sync] Drive quota retry failed:', e));
          }
        }, 1000);
      }
    } else {
      console.warn('[Sync] Drive module not loaded yet. Will sync when available.');
      // Wait for module to load
      const checkDriveModule = setInterval(() => {
        if (window.driveModule) {
          clearInterval(checkDriveModule);
          window.driveModule.syncDriveFiles(token).catch(e => console.error('[Sync] Drive sync error:', e));
          window.driveModule.fetchDriveQuota(token).catch(e => console.error('[Sync] Drive quota error:', e));
        }
      }, 500);
      // Stop checking after 10 seconds
      setTimeout(() => clearInterval(checkDriveModule), 10000);
    }
  }

  // [Legacy Drive Sync Removed - Moved to drive.js]



  /* ------------------------------- */

  /* --- 9. SMART TASK PARSER --- */
  const SmartTaskParser = {
    // Day name mappings
    WEEKDAYS: {
      'sunday': 0, 'sun': 0,
      'monday': 1, 'mon': 1,
      'tuesday': 2, 'tue': 2, 'tues': 2,
      'wednesday': 3, 'wed': 3,
      'thursday': 4, 'thu': 4, 'thur': 4, 'thurs': 4,
      'friday': 5, 'fri': 5,
      'saturday': 6, 'sat': 6
    },

    // Month name mappings
    MONTHS: {
      'january': 0, 'jan': 0,
      'february': 1, 'feb': 1,
      'march': 2, 'mar': 2,
      'april': 3, 'apr': 3,
      'may': 4,
      'june': 5, 'jun': 5,
      'july': 6, 'jul': 6,
      'august': 7, 'aug': 7,
      'september': 8, 'sep': 8, 'sept': 8,
      'october': 9, 'oct': 9,
      'november': 10, 'nov': 10,
      'december': 11, 'dec': 11
    },

    // Time of day defaults (24h format)
    TIME_OF_DAY: {
      'morning': { hour: 9, minute: 0 },
      'noon': { hour: 12, minute: 0 },
      'afternoon': { hour: 14, minute: 0 },
      'evening': { hour: 18, minute: 0 },
      'night': { hour: 20, minute: 0 },
      'tonight': { hour: 20, minute: 0 },
      'midnight': { hour: 23, minute: 59 },
      'eod': { hour: 17, minute: 0 },
      'end of day': { hour: 17, minute: 0 },
      'cob': { hour: 17, minute: 0 },
      'close of business': { hour: 17, minute: 0 }
    },

    // Enhanced Regex Parser - ROBUST VERSION
    parseRegex: (text) => {
      const result = {
        title: text,
        due: null,
        notes: null,
        priority: 'medium'
      };

      const lower = text.toLowerCase();
      const now = new Date();
      let targetDate = null;
      let hasTime = false;
      let matchedPatterns = [];

      // Helper to initialize targetDate
      const initDate = () => {
        if (!targetDate) targetDate = new Date(now);
      };

      // ===== PATTERN 0: "Day After Tomorrow" =====
      const dayAfterRegex = /\b(the\s+)?day\s+after\s+(tomorrow|tmr|tmrw)\b/gi;
      if (dayAfterRegex.test(text)) {
        initDate();
        targetDate.setDate(targetDate.getDate() + 2);
        matchedPatterns.push(text.match(dayAfterRegex)[0]);
      }

      // ===== PATTERN 1: Explicit time (3pm, 3:30pm, 15:00, 6p, 6a, @ 3pm) =====
      // Supports: 14:00, 2:30pm, 4p, 4a, 4am, 4pm, @4pm
      const explicitTimeRegex = /(?:@|at|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?(?=\s|$|[.,])/gi;
      let timeMatch;
      while ((timeMatch = explicitTimeRegex.exec(text)) !== null) {
        // Avoid matching years like 2026 or pure numbers if not clearly time
        if (!timeMatch[2] && !timeMatch[3] && !text.substring(timeMatch.index - 1, timeMatch.index).match(/@|at|by/i)) continue;

        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        let meridiem = timeMatch[3]?.toLowerCase();
        // Normalize 'a'/'p' to 'am'/'pm'
        if (meridiem === 'a') meridiem = 'am';
        if (meridiem === 'p') meridiem = 'pm';

        // Validate hours (0-23)
        if (hours > 24) continue;
        if (meridiem && hours > 12) continue; // 13pm is invalid

        // Smart inference if no meridiem (e.g. "at 5") -> assume PM if 1-7, else AM (unless 12)
        if (!meridiem) {
          if (hours >= 1 && hours <= 7) hours += 12; // 2 -> 14 (2pm)
        } else {
          if (meridiem === 'pm' && hours < 12) hours += 12;
          if (meridiem === 'am' && hours === 12) hours = 0;
        }

        initDate();
        targetDate.setHours(hours, minutes, 0, 0);
        hasTime = true;
        matchedPatterns.push(timeMatch[0]);
      }

      // ===== PATTERN 1.5: Colloquial Time (half past, quarter to) =====
      const colloquialTimeRegex = /\b(half|quarter)\s+(past|to)\s+(\d{1,2})\b/gi;
      let colloqMatch;
      while ((colloqMatch = colloquialTimeRegex.exec(text)) !== null) {
        const fraction = colloqMatch[1].toLowerCase(); // half, quarter
        const direction = colloqMatch[2].toLowerCase(); // past, to
        let hour = parseInt(colloqMatch[3]);

        if (hour > 12) continue; // usually colloquial uses 12h

        initDate();
        let mins = 0;

        if (fraction === 'half') mins = 30;
        else if (fraction === 'quarter') mins = 15;

        if (direction === 'to') {
          hour -= 1;
          mins = 60 - mins;
        }

        // Infer AM/PM based on current time or standard business hours (9-5)
        // Defaulting to next occurrence
        let hour24 = hour;
        const currentHour = now.getHours();

        // Heuristic: if result is in past for AM, try PM. 
        // Simplified: Assume PM for 1-11, unless explicitly morning context found separately.
        if (hour24 >= 1 && hour24 <= 6) hour24 += 12; // 2 -> 14 (2pm)

        targetDate.setHours(hour24, mins, 0, 0);
        hasTime = true;
        matchedPatterns.push(colloqMatch[0]);
      }

      // ===== PATTERN 2: Relative time (in 30 mins, in 2 hours, in a couple of hours) =====
      const relativeTimeRegex = /in\s+(?:a\s+)?(\d+|couple|few)\s+(?:of\s+)?(min(?:ute)?s?|hr|hour|hours?)/gi;
      let relTimeMatch;
      while ((relTimeMatch = relativeTimeRegex.exec(text)) !== null) {
        let numStr = relTimeMatch[1].toLowerCase();
        let num = 0;
        if (numStr === 'couple') num = 2;
        else if (numStr === 'few') num = 3;
        else num = parseInt(numStr);

        const unit = relTimeMatch[2].toLowerCase();

        initDate();
        if (unit.startsWith('min')) {
          targetDate = new Date(targetDate.getTime() + num * 60 * 1000);
        } else {
          targetDate = new Date(targetDate.getTime() + num * 60 * 60 * 1000);
        }
        hasTime = true;
        matchedPatterns.push(relTimeMatch[0]);
      }

      // ===== PATTERN 3: Today, Tonight, Tomorrow, Next Week, etc. =====
      const relativeDayRegex = /\b(today|tonight|tomorrow|tmr|tmrw|next\s+week|this\s+week)\b/gi;
      let relDayMatch;
      while ((relDayMatch = relativeDayRegex.exec(text)) !== null) {
        // Skip if captured by "day after tomorrow" to avoid double adjust
        if (matchedPatterns.some(p => p.includes(relDayMatch[0]) && p.length > relDayMatch[0].length)) continue;

        const word = relDayMatch[1].toLowerCase();
        initDate();

        if (['tomorrow', 'tmr', 'tmrw'].includes(word)) {
          targetDate.setDate(targetDate.getDate() + 1);
        } else if (word === 'tonight') {
          targetDate.setHours(20, 0, 0, 0);
          hasTime = true;
        } else if (word === 'next week') {
          targetDate.setDate(targetDate.getDate() + 7);
        }
        matchedPatterns.push(relDayMatch[0]);
      }

      // ===== PATTERN 4: Weekdays =====
      const weekdayRegex = /\b(next|this|on)?\s*(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b/gi;
      let weekdayMatch;
      while ((weekdayMatch = weekdayRegex.exec(text)) !== null) {
        const modifier = weekdayMatch[1]?.toLowerCase();
        const dayName = weekdayMatch[2].toLowerCase();
        const targetDayNum = SmartTaskParser.WEEKDAYS[dayName];

        if (targetDayNum === undefined) continue;

        initDate();
        const currentDay = targetDate.getDay();
        let daysToAdd = targetDayNum - currentDay;

        // Logic:
        // "Monday" when today is Tuesday -> Next Monday (6 days)
        // "Monday" when today is Sunday -> Tomorrow (1 day)
        // "Next Monday" -> Monday of next week (always 7+ days usually)

        if (modifier === 'next') {
          daysToAdd += 7;
          // If today is Monday and we say "Next Monday", usually means 7 days later
          if (daysToAdd < 7) daysToAdd += 7;
        } else {
          if (daysToAdd <= 0) daysToAdd += 7; // Future only
        }

        targetDate.setDate(targetDate.getDate() + daysToAdd);
        matchedPatterns.push(weekdayMatch[0]);
      }

      // ===== PATTERN 5: Specific Dates (Jan 15, 15 Jan, 2026 support) =====
      // Matches: Jan 15, Jan 15th, Jan 15 2026, 15th Jan 2026
      const monthFirstRegex = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/gi;
      let mfMatch;
      while ((mfMatch = monthFirstRegex.exec(text)) !== null) {
        const monthStr = mfMatch[1].toLowerCase();
        const day = parseInt(mfMatch[2]);
        const year = mfMatch[3] ? parseInt(mfMatch[3]) : null;
        const month = SmartTaskParser.MONTHS[monthStr];

        if (month !== undefined && day >= 1 && day <= 31) {
          initDate();
          targetDate.setMonth(month, day);
          if (year) {
            targetDate.setFullYear(year);
          } else {
            // Smart year rollover: if date is in past, assume next year
            if (targetDate < now) targetDate.setFullYear(targetDate.getFullYear() + 1);
          }
          matchedPatterns.push(mfMatch[0]);
        }
      }

      const dayFirstRegex = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s*(\d{4}))?\b/gi;
      let dfMatch;
      while ((dfMatch = dayFirstRegex.exec(text)) !== null) {
        const day = parseInt(dfMatch[1]);
        const monthStr = dfMatch[2].toLowerCase();
        const year = dfMatch[3] ? parseInt(dfMatch[3]) : null;
        const month = SmartTaskParser.MONTHS[monthStr];

        if (month !== undefined && day >= 1 && day <= 31) {
          initDate();
          targetDate.setMonth(month, day);
          if (year) {
            targetDate.setFullYear(year);
          } else {
            if (targetDate < now) targetDate.setFullYear(targetDate.getFullYear() + 1);
          }
          matchedPatterns.push(dfMatch[0]);
        }
      }

      // ===== PATTERN 6: Numeric Dates (MM/DD, YYYY-MM-DD, DD.MM.YYYY) =====
      // 1. ISO-ish: YYYY-MM-DD
      const isoDateRegex = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g;
      let isoMatch;
      while ((isoMatch = isoDateRegex.exec(text)) !== null) {
        initDate();
        targetDate.setFullYear(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
        matchedPatterns.push(isoMatch[0]);
      }

      // 2. US/Slash: MM/DD/YYYY or MM/DD (or DD/MM depending on assumption, sticking to MM/DD usually or intelligent check)
      // Regex matches 10/12, 10/12/2025. 
      const slashDateRegex = /\b(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?\b/g;
      let slashMatch;
      while ((slashMatch = slashDateRegex.exec(text)) !== null) {
        // Skip if it looks like ISO (captured above) or time (captured above?)
        if (matchedPatterns.includes(slashMatch[0])) continue;

        const p1 = parseInt(slashMatch[1]);
        const p2 = parseInt(slashMatch[2]);
        const p3 = slashMatch[3] ? parseInt(slashMatch[3]) : null;

        initDate();
        let mon = -1, d = -1, y = p3;

        // Simple heuristic: if p1 > 12, it must be DD/MM
        if (p1 > 12) {
          d = p1; mon = p2 - 1;
        } else {
          // Default to MM/DD
          mon = p1 - 1; d = p2;
        }

        if (mon >= 0 && mon <= 11 && d >= 1 && d <= 31) {
          targetDate.setMonth(mon, d);
          if (y) {
            if (y < 100) y += 2000;
            targetDate.setFullYear(y);
          } else {
            if (targetDate < now) targetDate.setFullYear(targetDate.getFullYear() + 1);
          }
          matchedPatterns.push(slashMatch[0]);
        }
      }

      // ===== PATTERN 7: Time of Day Phases =====
      const todRegex = /\b(morning|noon|afternoon|evening|night|midnight|eod|end of day|cob|close of business)\b/gi;
      let todMatch;
      while ((todMatch = todRegex.exec(text)) !== null) {
        const phrase = todMatch[1].toLowerCase();
        const def = SmartTaskParser.TIME_OF_DAY[phrase];
        initDate();
        targetDate.setHours(def.hour, def.minute, 0, 0);
        hasTime = true;
        matchedPatterns.push(todMatch[0]);
      }

      // ===== PATTERN 8: Relative Future (in 3 days, in a week) =====
      const relFutureRegex = /in\s+(?:a\s+)?(\d+|a|an|couple|few)\s+(day|week|month|year)s?/gi;
      let rfMatch;
      while ((rfMatch = relFutureRegex.exec(text)) !== null) {
        let numStr = rfMatch[1].toLowerCase();
        let num = 1;
        if (numStr === 'couple') num = 2;
        else if (numStr === 'few') num = 3;
        else if (!['a', 'an'].includes(numStr)) num = parseInt(numStr);

        const unit = rfMatch[2].toLowerCase();
        initDate();

        if (unit === 'day') targetDate.setDate(targetDate.getDate() + num);
        if (unit === 'week') targetDate.setDate(targetDate.getDate() + num * 7);
        if (unit === 'month') targetDate.setMonth(targetDate.getMonth() + num);
        if (unit === 'year') targetDate.setFullYear(targetDate.getFullYear() + num);

        matchedPatterns.push(rfMatch[0]);
      }

      // ===== PRIORITY TAGS (Keep existing) =====
      if (lower.match(/(?:^|\s)(#high|!urgent|urgent|asap)(?:\s|$)/)) {
        result.priority = 'high';
        matchedPatterns.push(lower.match(/(?:^|\s)(#high|!urgent|urgent|asap)(?:\s|$)/)[0].trim());
      }
      if (lower.match(/(?:^|\s)(#low|low priority)(?:\s|$)/)) {
        result.priority = 'low';
        matchedPatterns.push(lower.match(/(?:^|\s)(#low|low priority)(?:\s|$)/)[0].trim());
      }

      // ===== FINALIZE DUE DATE =====
      if (targetDate) {
        // If explicit date set but no time, default to 9 AM
        if (!hasTime) targetDate.setHours(9, 0, 0, 0);
        // Safety: If result is still in past (e.g. "at 9am" but it's 10am), bump to tomorrow
        if (hasTime && targetDate < now) {
          // Only bump if it was a time-only match or today match, not a specific date match
          // Heuristic check: was the match just time?
          // For now, simpler: if < now, add 1 day
          targetDate.setDate(targetDate.getDate() + 1);
        }
        result.due = targetDate.toISOString();
      }

      // ===== CLEANUP TITLE =====
      let cleanTitle = text;

      // 1. Remove common task filler prefixes to "generate title better"
      const prefixes = /^(?:remind\s+me\s+to|i\s+need\s+to|task\s+to|please|can\s+you|remember\s+to|don't\s+forget\s+to|check\s+on|look\s+at)\s+/i;
      cleanTitle = cleanTitle.replace(prefixes, '');

      // Sort matched patterns by length descending
      matchedPatterns.sort((a, b) => b.length - a.length);

      // More intelligent removal - only remove clear temporal/priority indicators
      // Keep descriptive words that might be part of the task name
      matchedPatterns.forEach(pat => {
        const lowerPat = pat.toLowerCase();
        // Only remove if it's clearly a date/time/priority indicator, not descriptive text
        const isTemporal = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|am|pm|at|@|by|due|on|next|week|this)\b/i.test(lowerPat);
        const isPriority = /\b(#high|#low|high priority|low priority|urgent|asap|!urgent)\b/i.test(lowerPat);

        if (isTemporal || isPriority) {
          // Escape special regex chars in pattern
          const safePat = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleanTitle = cleanTitle.replace(new RegExp(safePat, 'i'), '');
        }
      });

      // Cleanup stranded prepositions but be more conservative
      cleanTitle = cleanTitle
        .replace(/\b(due|on|by|at|for)\s*$/i, '') // End of string or after keyword
        .replace(/\s+/g, ' ') // Collapse spaces
        .trim();

      // Remove isolated punctuation but preserve meaningful punctuation
      cleanTitle = cleanTitle.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');

      // Apply proper title case capitalization
      cleanTitle = cleanTitle.replace(/\b\w+/g, (word) => {
        const lowerWord = word.toLowerCase();
        const commonWords = ['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can'];
        return commonWords.includes(lowerWord) ? lowerWord : word.charAt(0).toUpperCase() + lowerWord.slice(1);
      });

      // Ensure first word is always capitalized
      if (cleanTitle.length > 0) {
        cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
      }

      // RULE: Force 2-3 word title max
      const titleWords = cleanTitle.split(/\s+/).filter(w => w.length > 0);
      if (titleWords.length > 3) {
        cleanTitle = titleWords.slice(0, 3).join(' ');
      }

      result.title = cleanTitle || text;
      return result;
    },

    // AI Parser (Supports Manual API Keys)
    parseAI: async (text) => {
      const provider = localStorage.getItem('ai_provider') || 'gemini';
      const apiKey = localStorage.getItem('ai_api_key');

      if (!apiKey) {
        console.warn("No AI API Key found, falling back to Regex");
        showNotification("MISSING API KEY", "warning");
        return SmartTaskParser.parseRegex(text);
      }

      try {
        const prompt = `
            You are a world-class Productivity Assistant. Your goal is to convert natural language into structured JSON.
            CRITICAL: The user's input can be in ANY language. Understand the intent regardless of the language.

            Input: "${text}"
            Current Date: ${new Date().toISOString()}

            Instructions:
            - **TITLE (SMART & REFINED)**:
              - Generate a title strictly in the SAME language as the input text.
              - Limit to 2-3 essential words.
              - **ENTITY PRESERVATION**: If a movie, series, book, person, or brand is mentioned, keep the name INTACT.
              - **RESEARCH & REFINEMENT**: If a name or entity is misspelled (e.g., "Incepton"), use your internal knowledge to RESEARCH and output the CORRECT spelling (e.g., "Inception Movie").
              - Focus on "Action + Entity" (e.g., "Watch Interstellar", "Read Atomic Habits").
            - **DATA EXTRACTION**: Extract due date (ISO8601) and priority ("high", "medium", or "low").
            - **SUBTASKS**: List implicit steps in "notes" as Markdown checklist.
            - **NOTES**: Extract additional details.
            
            Output JSON format: { "title": string, "due": string(ISO8601 or null), "notes": string(or null), "priority": "high"|"medium"|"low" }

            Examples:
            Input: "আজকের বাজার কর আর বিলটা দিয়ে দিও কালকের মধ্যে"
            Output: {"title": "বাজার ও বিল", "due": "2026-01-09T09:00:00.000Z", "notes": "- বাজার করা\n- বিল দেওয়া", "priority": "medium"}

            Input: "I want to watch the movie intersteller on friday night"
            Output: {"title": "Watch Interstellar", "due": "2026-01-10T21:00:00.000Z", "notes": "Friday night movie", "priority": "low"}

            Return ONLY raw JSON. Do not include any explanation.
          `;

        let response;
        if (provider === 'gemini') {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          });
        } else {
          response = await fetch(`https://openrouter.ai/api/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'HTTP-Referer': 'https://essentials-dashboard.com',
              'X-Title': 'Essentials Dashboard'
            },
            body: JSON.stringify({
              model: "google/gemini-2.0-flash-exp:free",
              messages: [{ role: "user", content: prompt }]
            })
          });
        }

        if (!response.ok) throw new Error('AI Provider API Error');

        const data = await response.json();
        let rawText = "";

        if (provider === 'gemini') {
          rawText = data.candidates[0].content.parts[0].text;
        } else {
          rawText = data.choices[0].message.content;
        }

        const jsonStr = rawText.replace(/```json|```/g, '').trim();
        const result = JSON.parse(jsonStr);
        return result;
      } catch (e) {
        console.error("AI Parse Failed", e);
        showNotification("AI PARSE FAILED", "error");
        return SmartTaskParser.parseRegex(text);
      }
    },

    // Connection Tester
    testConnection: async (provider, apiKey) => {
      try {
        if (provider === 'gemini') {
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: "Hello, responding with 'OK' if you can see this." }] }] })
          });
          if (res.ok) return { success: true };
          const err = await res.json();
          return { success: false, error: err.error?.message || 'Invalid Key' };
        } else {
          const res = await fetch(`https://openrouter.ai/api/v1/auth/key`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` }
          });
          if (res.ok) return { success: true };
          const err = await res.json();
          return { success: false, error: err.error?.message || 'Invalid Key' };
        }
      } catch (e) {
        return { success: false, error: 'Network Error' };
      }
    }
  };

  async function createSmartTask(parsed) {
    const { title, due, priority, notes } = parsed;

    // Validate title
    if (!title || typeof title !== 'string' || !title.trim()) {
      showNotification("INVALID TASK TITLE", "warning");
      return;
    }

    chrome.storage.local.get("google_access_token", async (res) => {
      let taskCreated = false;

      if (res.google_access_token) {
        const token = res.google_access_token;
        try {
          const body = {
            title: title.trim(),
            status: 'needsAction',
            notes: notes || ''
          };
          if (due) body.due = due;

          const response = await googleApiFetch('https://www.googleapis.com/tasks/v1/lists/@default/tasks', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
          });

          if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
          }

          const task = await response.json();

          // Optimistic UI Update
          activeTasks.unshift({ ...task, syncStatus: 'synced', source: 'google' });
          saveLocalTasks();
          renderTasks();
          showNotification("SMART TASK ADDED", "success");
          taskCreated = true;
        } catch (e) {
          console.error('Failed to create smart task:', e);
          showNotification("FAILED TO CREATE TASK: " + (e.message || "Unknown error"), "error");
          // Fall through to offline mode
        }
      }

      // Offline fallback (also used if API call fails)
      if (!taskCreated) {
        const tempId = 'temp-' + Date.now();
        // Convert priority string to number if needed
        let priorityNum = 0;
        if (priority) {
          if (typeof priority === 'string') {
            priorityNum = priority === 'high' ? 1 : priority === 'low' ? -1 : 0;
          } else if (typeof priority === 'number') {
            priorityNum = priority;
          }
        }

        const newTask = {
          id: tempId,
          title: title.trim() || 'Untitled Task',
          status: 'needsAction',
          notes: notes || '',
          due: due || null,
          priority: priorityNum,
          syncStatus: 'pending',
          source: 'local'
        };
        activeTasks.unshift(newTask);
        saveLocalTasks();
        renderTasks();
        showNotification("TASK ADDED (OFFLINE)", "success");
      }
    });
  }

  /* --- 6. DRIVE HANDLERS --- */







  /* --- 10. DRIVE PERMISSIONS --- */

  /* --- 7. CALENDAR SYNC & INTERACTION --- */

  // Initialize Calendar State on Load
  function initCalendarState() {
    const savedDate = localStorage.getItem('calendar_view_date');
    if (savedDate) {
      currentViewDate = new Date(savedDate);
    } else {
      currentViewDate = new Date();
    }

    // Render immediately with cached events
    // Render immediately with cached events
    // Determine if localEvents has been populated
    const cached = localStorage.getItem('calendar_events_cache');
    if (cached) {
      localEvents = JSON.parse(cached);
    } else {
      localEvents = [];
    }
    renderCalendarMonth(currentViewDate, localEvents, 'stagger'); // 'stagger' = initial load

    // Setup Modal Listeners
    const closeBtn = document.getElementById('close-event-modal');
    const modal = document.getElementById('event-modal');
    if (closeBtn && modal) {
      closeBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
      });
    }

    const saveBtn = document.getElementById('save-event-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', handleSaveEvent);
    }

    // Scroll & Hover Effects for Month/Year Header
    const calBody = document.getElementById('cal-module-body');
    const calHeader = document.getElementById('cal-month-year');
    if (calBody && calHeader) {
      let lastScroll = 0;

      // Initial content wrapping with separate month and year containers
      const initialMonth = currentViewDate.toLocaleDateString('en-US', { month: 'long' });
      const initialYear = currentViewDate.getFullYear().toString();
      calHeader.innerHTML = `
      <span class="cal-flip-container" id="cal-month-container">
        <span class="cal-flip-text" data-value="${initialMonth}">${initialMonth}</span>
      </span>
      <span class="cal-flip-container" id="cal-year-container">
        <span class="cal-flip-text" data-value="${initialYear}">${initialYear}</span>
      </span>
    `;

      // Store reference for revert on mouse leave
      window._calendarRealDate = new Date();
      window._calendarIsHovering = false;

      // IntersectionObserver Setup for "Scroll Storytelling"
      // We observe virtual segments to trigger the cinematic flip
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const monthOffset = parseInt(entry.target.dataset.offset);
            const targetDate = new Date();
            targetDate.setMonth(targetDate.getMonth() + monthOffset);

            if (targetDate.getMonth() !== currentViewDate.getMonth() || targetDate.getFullYear() !== currentViewDate.getFullYear()) {
              currentViewDate = targetDate;
              renderCalendarMonth(currentViewDate, localEvents, 'fade');
              // Fetch events in background
              chrome.storage.local.get("google_access_token", (res) => {
                if (res.google_access_token) syncCalendar(res.google_access_token, true);
              });
            }
          }
        });
      }, { threshold: 0.5, root: calBody });

      // Hover State with revert logic
      calBody.addEventListener('mouseenter', () => {
        calHeader.classList.add('header-active');
        window._calendarIsHovering = true;
      });

      calBody.addEventListener('mouseleave', () => {
        calHeader.classList.remove('header-active');
        window._calendarIsHovering = false;

        // Revert to current month/year with smooth flip
        const realDate = new Date();
        if (currentViewDate.getMonth() !== realDate.getMonth() || currentViewDate.getFullYear() !== realDate.getFullYear()) {
          currentViewDate = realDate;
          renderCalendarMonth(currentViewDate, localEvents, 'fade');
          // Fetch events for current month
          chrome.storage.local.get("google_access_token", (res) => {
            if (res.google_access_token) syncCalendar(res.google_access_token, true);
          });
        }
      });

      calBody.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        calHeader.classList.add('header-active');

        const now = Date.now();
        if (now - lastScroll < 400) return; // Slightly longer delay for smoother transitions
        lastScroll = now;

        // Store scroll direction for film reel animation
        const scrollDirection = e.deltaY > 0 ? 'next' : 'prev';
        window._calendarScrollDirection = scrollDirection;

        // Update date logic
        if (e.deltaY > 0) {
          currentViewDate.setMonth(currentViewDate.getMonth() + 1);
        } else {
          currentViewDate.setMonth(currentViewDate.getMonth() - 1);
        }

        renderCalendarMonth(currentViewDate, localEvents, 'fade');
        chrome.storage.local.get("google_access_token", (res) => {
          if (res.google_access_token) syncCalendar(res.google_access_token, true);
        });
      }, { passive: false });

      // Swipe gesture support for month navigation
      let touchStartX = 0;
      let touchStartY = 0;
      let touchEndX = 0;
      let touchEndY = 0;
      const minSwipeDistance = 50;

      calBody.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
      }, { passive: true });

      calBody.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        touchEndY = e.changedTouches[0].screenY;
        handleSwipe();
      }, { passive: true });

      function handleSwipe() {
        const deltaX = touchEndX - touchStartX;
        const deltaY = touchEndY - touchStartY;
        const absDeltaX = Math.abs(deltaX);
        const absDeltaY = Math.abs(deltaY);

        // Only trigger if horizontal swipe is dominant
        if (absDeltaX > minSwipeDistance && absDeltaX > absDeltaY) {
          const now = Date.now();
          if (now - lastScroll < 400) return;
          lastScroll = now;

          calHeader.classList.add('header-active');

          // Store scroll direction for film reel animation
          let scrollDirection;
          if (deltaX > 0) {
            // Swipe right - previous month
            scrollDirection = 'prev';
            currentViewDate.setMonth(currentViewDate.getMonth() - 1);
          } else {
            // Swipe left - next month
            scrollDirection = 'next';
            currentViewDate.setMonth(currentViewDate.getMonth() + 1);
          }
          window._calendarScrollDirection = scrollDirection;

          renderCalendarMonth(currentViewDate, localEvents, 'fade');
          chrome.storage.local.get("google_access_token", (res) => {
            if (res.google_access_token) syncCalendar(res.google_access_token, true);
          });
        }
      }
    }
  }



  async function syncCalendar(token, noAnim = false) {
    if (isCalendarSyncing) return;
    isCalendarSyncing = true;

    const calBadge = document.getElementById('cal-badge');
    const headers = { Authorization: `Bearer ${token}` };

    try {
      // 1. Process Queue first
      await SyncQueue.processQueue(token);

      // 2. Fetch Google Events
      const year = currentViewDate.getFullYear();
      const month = currentViewDate.getMonth();
      const firstDay = new Date(year, month, 1);
      const lastDay = new Date(year, month + 1, 0);

      const timeMin = firstDay.toISOString();
      const timeMax = lastDay.toISOString();

      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;

      const res = await fetch(url, { headers });
      const data = await res.json();
      const googleItems = data.items || [];

      if (calBadge) calBadge.textContent = googleItems.length.toString();

      // 3. Merge Strategies
      // Keep local items that are pending sync (temp- IDs)
      const localPending = localEvents.filter(e => e.id.toString().startsWith('temp-'));

      // Combine
      localEvents = [...googleItems, ...localPending];

      // Update Cache
      localStorage.setItem('calendar_events_cache', JSON.stringify(localEvents));

      // Re-render
      // Re-render immediately after processing queue to show "synced" status
      renderCalendarMonth(currentViewDate, localEvents, 'none');

    } catch (err) {
      console.error("Calendar Sync Error", err);
    } finally {
      isCalendarSyncing = false;
    }
  }

  function renderCalendarMonth(referenceDate, events = [], animType = 'fade') {
    const calGrid = document.getElementById('cal-grid');
    const calMonthYear = document.getElementById('cal-month-year');

    // Guard: Ensure referenceDate is a valid Date object
    if (!referenceDate || isNaN(referenceDate.getTime())) {
      referenceDate = new Date();
    }

    // Guard: Ensure events is an array
    if (!Array.isArray(events)) {
      console.warn("renderCalendarMonth: events is not an array, defaulting to []");
      events = [];
    }

    if (calMonthYear) {
      const newMonth = referenceDate.toLocaleDateString('en-US', { month: 'long' });
      const newYear = referenceDate.getFullYear().toString();

      const monthContainer = calMonthYear.querySelector('#cal-month-container');
      const yearContainer = calMonthYear.querySelector('#cal-year-container');

      if (monthContainer && yearContainer) {
        const monthText = monthContainer.querySelector('.cal-flip-text');
        const yearText = yearContainer.querySelector('.cal-flip-text');

        const currentMonth = monthText?.dataset.value || '';
        const currentYear = yearText?.dataset.value || '';

        // Only animate if month changed (year always flips with month)
        const monthChanged = currentMonth !== newMonth;

        if (monthChanged) {
          // Helper function to perform flip animation
          const flipElement = (container, oldText, newValue, delay = 0, forceFlip = false) => {
            if (!oldText) return;
            // Skip if value same AND not forcing flip
            if (oldText.dataset.value === newValue && !forceFlip) return;

            setTimeout(() => {
              // Add flip-out to old text
              oldText.classList.add('flip-out');

              // After flip-out completes (150ms for faster animation), swap content and flip-in
              setTimeout(() => {
                oldText.textContent = newValue;
                oldText.dataset.value = newValue;
                oldText.classList.remove('flip-out');
                oldText.classList.add('flip-in');

                // Remove flip-in class after animation
                setTimeout(() => {
                  oldText.classList.remove('flip-in');
                }, 300);
              }, 150);
            }, delay);
          };

          // Sequential flip: month first (0ms), year always flips second (150ms delay)
          if (monthText) {
            flipElement(monthContainer, monthText, newMonth, 0);
          }
          if (yearText) {
            // Force flip year even if value didn't change
            flipElement(yearContainer, yearText, newYear, 150, true);
          }
        }
      } else {
        // Fallback: create structure if not present
        calMonthYear.innerHTML = `
        <span class="cal-flip-container" id="cal-month-container">
          <span class="cal-flip-text" data-value="${newMonth}">${newMonth}</span>
        </span>
        <span class="cal-flip-container" id="cal-year-container">
          <span class="cal-flip-text" data-value="${newYear}">${newYear}</span>
        </span>
      `;
      }
    }
    if (!calGrid) return;

    // Persist View State
    try {
      localStorage.setItem('calendar_view_date', referenceDate.toISOString());
    } catch (e) {
      console.warn("localStorage.setItem failed in renderCalendarMonth", e);
    }

    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth();

    // Get first day of month and last day of month
    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);

    // Starting day of the week (0-6)
    const startingDay = firstDayOfMonth.getDay();
    const totalDays = lastDayOfMonth.getDate();

    // Previous month last few days
    const prevMonthLastDay = new Date(year, month, 0).getDate();

    let html = '';
    let animIndex = 0; // Stagger counter

    // Animation class logic
    let animClass = '';
    if (animType === 'stagger') animClass = 'stagger-load';
    else if (animType === 'fade') animClass = 'fade-load';

    // Padding days from previous month
    for (let i = startingDay - 1; i >= 0; i--) {
      html += `<div class="cal-day other-month ${animClass}" style="--i: ${animIndex++}">${prevMonthLastDay - i}</div>`;
    }

    // Days of current month
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

    // Map events to dates
    const eventMap = {};
    events.forEach(event => {
      let dateKey;

      if (event.start.date) {
        // All-day event: date is in "YYYY-MM-DD" format
        // Extract day directly to avoid timezone conversion issues
        const dateParts = event.start.date.split('-');
        const eventYear = parseInt(dateParts[0]);
        const eventMonth = parseInt(dateParts[1]) - 1; // 0-indexed month
        const eventDay = parseInt(dateParts[2]);

        // Only include if event is in the currently viewed month
        if (eventYear === year && eventMonth === month) {
          dateKey = eventDay;
        } else {
          return; // Skip events not in current month view
        }
      } else if (event.start.dateTime) {
        // Timed event: parse datetime and extract local date
        const eventDate = new Date(event.start.dateTime);
        // Check if event falls within the viewed month
        if (eventDate.getFullYear() === year && eventDate.getMonth() === month) {
          dateKey = eventDate.getDate();
        } else {
          return; // Skip events not in current month view
        }
      } else {
        return; // No valid start date
      }

      if (!eventMap[dateKey]) eventMap[dateKey] = [];
      eventMap[dateKey].push(event);
    });

    for (let i = 1; i <= totalDays; i++) {
      const isToday = isCurrentMonth && today.getDate() === i;
      const dayEvents = eventMap[i] || [];
      const hasEvent = dayEvents.length > 0;

      // Format date specifically for the modal: YYYY-MM-DD
      const modalDate = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;

      let tooltipHtml = '';
      if (hasEvent) {
        tooltipHtml = `<div class="cal-tooltip">`;
        dayEvents.forEach(e => {
          const start = e.start.dateTime || e.start.date;
          const timeStr = e.start.dateTime ? new Date(start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'All Day';
          tooltipHtml += `
          <div class="cal-event-item">
            <span class="cal-event-time">${timeStr}</span>
            <span class="cal-event-summary">${e.summary}</span>
          </div>
        `;
        });
        tooltipHtml += `</div>`;
      }

      html += `
      <div class="cal-day current-month ${isToday ? 'today' : ''} ${hasEvent ? 'has-event' : ''} ${animClass}" 
           data-date="${modalDate}" style="--i: ${animIndex++}">
        ${i}
        ${tooltipHtml}
      </div>
    `;
    }

    // Padding days for next month to fill grid
    const totalCells = startingDay + totalDays;
    const remainingCells = 42 - totalCells; // 6 rows of 7 days
    for (let i = 1; i <= remainingCells; i++) {
      html += `<div class="cal-day other-month ${animClass}" style="--i: ${animIndex++}">${i}</div>`;
    }

    if (!html) {
      console.error("renderCalendarMonth: HTML is empty! Year:", year, "Month:", month, "TotalDays:", totalDays);
      // Fallback if something went catastrophically wrong
      calGrid.innerHTML = '<div style="grid-column: 1/span 7; text-align: center; padding: 20px;">Unable to render calendar dates.</div>';
      return;
    }

    window.PerformanceUtils.batchDOMUpdate(() => {
      calGrid.innerHTML = html;

      // Add smooth transition for month change
      if (animType === 'fade') {
        calGrid.classList.add('transitioning');
        // Remove transitioning class after smooth transition completes
        setTimeout(() => {
          calGrid.classList.remove('transitioning');
          calGrid.style.opacity = '';
        }, 400);
      }

      // Attach click listeners via event delegation (CSP blocks inline onclick)
      calGrid.querySelectorAll('.cal-day.current-month').forEach(day => {
        day.addEventListener('click', (e) => {
          const dateStr = day.dataset.date;
          if (dateStr) {
            // Add click animation
            day.style.transform = 'scale(0.9)';
            setTimeout(() => {
              day.style.transform = '';
            }, 150);
            window.openEventModal(dateStr);
          }
        });

        // Add magnetic hover effect (only when not already in hover state)
        let isHovering = false;
        day.addEventListener('mouseenter', () => {
          isHovering = true;
        });

        day.addEventListener('mousemove', (e) => {
          if (!isHovering) return;
          const rect = day.getBoundingClientRect();
          const x = e.clientX - rect.left - rect.width / 2;
          const y = e.clientY - rect.top - rect.height / 2;
          const distance = Math.sqrt(x * x + y * y);
          const maxDistance = 25;

          if (distance < maxDistance && !day.classList.contains('today')) {
            const moveX = (x / maxDistance) * 4;
            const moveY = (y / maxDistance) * 4;
            day.style.transform = `translate(${moveX}px, ${moveY}px) scale(1.08)`;
          } else if (day.classList.contains('today')) {
            // Special effect for today
            const moveX = (x / maxDistance) * 2;
            const moveY = (y / maxDistance) * 2;
            day.style.transform = `translate(${moveX}px, ${moveY}px) scale(1.08)`;
          }
        });

        day.addEventListener('mouseleave', () => {
          isHovering = false;
          day.style.transform = '';
        });
      });
    });
  }

  // Window scoped function for onclick trigger
  window.openEventModal = function (dateStr) {
    const modal = document.getElementById('event-modal');
    const dateDisplay = document.getElementById('event-date-display');
    const listContainer = document.getElementById('event-list-container');
    const formSection = document.getElementById('event-form-section');
    const eventList = document.getElementById('event-list');
    const showAddBtn = document.getElementById('show-add-event-form');
    const cancelBtn = document.getElementById('cancel-event-form');

    // Reset Form state
    resetEventForm();

    if (modal && dateDisplay) {
      dateDisplay.value = dateStr;
      modal.classList.remove('hidden');

      // Filter events for this date
      const selectedDate = new Date(dateStr);
      const dayEvents = localEvents.filter(e => {
        if (!e.start) return false;
        let eDate;
        if (e.start.date) {
          eDate = e.start.date; // YYYY-MM-DD
        } else if (e.start.dateTime) {
          eDate = e.start.dateTime.split('T')[0];
        }
        return eDate === dateStr;
      });

      // Render List
      renderEventList(dayEvents, dateStr);

      // Initial View Logic
      if (dayEvents.length > 0) {
        listContainer.classList.remove('hidden');
        formSection.classList.add('hidden');
      } else {
        // No events, show form immediately
        listContainer.classList.add('hidden');
        formSection.classList.remove('hidden');
      }

      // Handlers
      if (showAddBtn) {
        showAddBtn.onclick = () => {
          resetEventForm(); // Ensure clean form
          listContainer.classList.add('hidden');
          formSection.classList.remove('hidden');
          const titleInput = document.getElementById('event-title');
          if (titleInput) setTimeout(() => titleInput.focus(), 100);
        };
      }

      if (cancelBtn) {
        cancelBtn.onclick = () => {
          if (dayEvents.length > 0) {
            // Return to list view
            formSection.classList.add('hidden');
            listContainer.classList.remove('hidden');
          } else {
            // If no events, just close modal
            modal.classList.add('hidden');
          }
        };
      }
    }
  };

  function resetEventForm() {
    const titleInput = document.getElementById('event-title');
    const timeInput = document.getElementById('event-time');
    const allDayInput = document.getElementById('event-all-day');
    const eventIdInput = document.getElementById('event-id');
    const saveBtn = document.getElementById('save-event-btn');

    if (titleInput) titleInput.value = '';
    if (timeInput) timeInput.value = '12:00';
    if (allDayInput) allDayInput.checked = false;
    if (eventIdInput) eventIdInput.value = ''; // Clear ID -> Create Mode
    if (saveBtn) saveBtn.textContent = 'SAVE EVENT';
  }

  function renderEventList(events, dateStr) {
    const listEl = document.getElementById('event-list');
    if (!listEl) return;

    listEl.innerHTML = '';

    events.forEach(e => {
      const item = document.createElement('div');
      item.className = 'event-item-card';
      if (e.syncStatus === 'pending') item.classList.add('pending-sync');

      const isAllDay = !!e.start.date;
      const timeStr = isAllDay ? 'All Day' : new Date(e.start.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      item.innerHTML = `
            <div class="event-info">
                <span class="event-time-badge">${timeStr}</span>
                <span class="event-title-text">${e.summary}</span>
            </div>
            <div class="event-actions">
                <button class="icon-btn-small edit-event" title="Edit">✎</button>
                <button class="icon-btn-small delete-event" title="Delete">🗑️</button>
            </div>
        `;

      // Bind Actions
      item.querySelector('.edit-event').onclick = () => handleEditEvent(e, dateStr);
      item.querySelector('.delete-event').onclick = () => handleDeleteEvent(e.id, dateStr);

      listEl.appendChild(item);
    });
  }

  function handleEditEvent(event, dateStr) {
    const listContainer = document.getElementById('event-list-container');
    const formSection = document.getElementById('event-form-section');

    // Populate Form
    document.getElementById('event-id').value = event.id; // Set ID -> Update Mode
    document.getElementById('event-title').value = event.summary;
    document.getElementById('event-date-display').value = dateStr;
    const saveBtn = document.getElementById('save-event-btn');
    if (saveBtn) saveBtn.textContent = 'UPDATE EVENT';

    if (event.start.date) {
      document.getElementById('event-all-day').checked = true;
      document.getElementById('event-time').value = '12:00';
    } else {
      document.getElementById('event-all-day').checked = false;
      // Extract HH:MM
      const dt = new Date(event.start.dateTime);
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      document.getElementById('event-time').value = `${hh}:${mm}`;
    }

    // Switch View
    listContainer.classList.add('hidden');
    formSection.classList.remove('hidden');
  }

  async function handleDeleteEvent(eventId, dateStr) {
    if (!confirm("Delete this event?")) return;

    // 1. Local Optimistic Delete
    localEvents = localEvents.filter(e => e.id !== eventId);
    localStorage.setItem('calendar_events_cache', JSON.stringify(localEvents));

    // 2. Re-render List
    // We need to re-filter because localEvents changed
    const dayEvents = localEvents.filter(e => {
      if (!e.start) return false;
      let eDate;
      if (e.start.date) {
        eDate = e.start.date;
      } else if (e.start.dateTime) {
        eDate = e.start.dateTime.split('T')[0];
      }
      return eDate === dateStr;
    });
    renderEventList(dayEvents, dateStr);
    renderCalendarMonth(currentViewDate, localEvents, 'none'); // Update main calendar view too

    // 3. Queue & Sync
    SyncQueue.add('delete', 'event', { id: eventId });
    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });

    showNotification("EVENT DELETED", "info");
  }




  async function handleSaveEvent() {
    const dateStr = document.getElementById('event-date-display').value;
    const title = document.getElementById('event-title').value;
    const time = document.getElementById('event-time').value;
    const isAllDay = document.getElementById('event-all-day').checked;
    const eventId = document.getElementById('event-id').value; // Empty if create

    if (!title || !dateStr) return;

    // Construct resource
    const resource = {
      summary: title,
    };

    if (isAllDay) {
      resource.start = { date: dateStr };
      const d = new Date(dateStr);
      d.setDate(d.getDate() + 1);
      resource.end = { date: d.toISOString().split('T')[0] };
    } else {
      // Force local date interpretation
      const startDateTime = new Date(`${dateStr}T${time}:00`);
      const endDateTime = new Date(startDateTime.getTime() + 60 * 60 * 1000); // 1 hour default
      resource.start = { dateTime: startDateTime.toISOString() };
      resource.end = { dateTime: endDateTime.toISOString() };
    }

    // 1. Local Update (Optimistic)
    if (eventId) {
      // UPDATE
      const idx = localEvents.findIndex(e => e.id === eventId);
      if (idx !== -1) {
        localEvents[idx] = { ...localEvents[idx], ...resource, syncStatus: 'pending' };
      }
      SyncQueue.add('update', 'event', { id: eventId, resource });
      showNotification("EVENT UPDATED", "success");
    } else {
      // CREATE
      const tempId = 'temp-' + Date.now();
      const newEvent = {
        id: tempId,
        ...resource,
        syncStatus: 'pending',
        source: 'local'
      };
      localEvents.push(newEvent);
      SyncQueue.add('create', 'event', { id: tempId, resource: { ...resource, id: tempId } }); // Include ID in resource for tracking
      showNotification("EVENT CREATED", "success");
    }

    localStorage.setItem('calendar_events_cache', JSON.stringify(localEvents));

    // 2. Render UI
    const modal = document.getElementById('event-modal');
    // Re-filter events for the list logic
    const dayEvents = localEvents.filter(e => {
      if (!e.start) return false;
      let eDate;
      if (e.start.date) eDate = e.start.date;
      else if (e.start.dateTime) eDate = e.start.dateTime.split('T')[0];
      return eDate === dateStr;
    });

    // Return to list view
    const listContainer = document.getElementById('event-list-container');
    const formSection = document.getElementById('event-form-section');
    listContainer.classList.remove('hidden');
    formSection.classList.add('hidden');
    renderEventList(dayEvents, dateStr);
    renderCalendarMonth(currentViewDate, localEvents, 'none');

    // 3. Trigger Sync
    chrome.storage.local.get("google_access_token", (res) => {
      if (res.google_access_token) {
        SyncQueue.processQueue(res.google_access_token);
      }
    });
  }



  function openLightbox(src) {
    const modal = document.getElementById('lightbox-modal');
    const img = document.getElementById('lightbox-img');
    const closeBtn = document.getElementById('close-lightbox');

    if (modal && img) {
      img.src = src;
      modal.classList.remove('hidden');

      // Close handlers
      const close = () => {
        modal.classList.add('hidden');
        img.src = '';
      };

      if (closeBtn) closeBtn.onclick = close;
      modal.onclick = (e) => {
        if (e.target === modal) close();
      };
    }
  }

  // ===================================
  // SITE TIME TRACKING MODULE
  // ===================================

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


  function initSiteTracker() {
    const listEl = document.getElementById('site-list');
    const resetBtn = document.getElementById('reset-stats-btn');
    if (!listEl) return;

    // Check and perform midnight reset
    checkMidnightReset();

    function renderSites() {
      chrome.tabs.query({}, (tabs) => {
        const activeDomains = new Set();
        tabs.forEach(tab => {
          const domain = getDomainFromUrl(tab.url);
          if (domain) activeDomains.add(domain);
        });

        chrome.storage.local.get(["site_stats", "session_history", "blocked_domains"], (data) => {
          const stats = data.site_stats || {};
          const blockedDomains = data.blocked_domains || {};
          const activeStatsArr = [];
          const todayHistoryArr = [];

          // Convert to array and split into active/history
          for (const [domain, info] of Object.entries(stats)) {
            if (info.time > 1000) { // Minimum 1 second
              // Safeguard: Cap time at 24 hours (86400000ms) to prevent display of inflated numbers
              const maxDailyTime = 86400000; // 24 hours in milliseconds
              const cappedTime = Math.min(info.time, maxDailyTime);

              if (activeDomains.has(domain)) {
                activeStatsArr.push({ domain, time: cappedTime });
              } else {
                todayHistoryArr.push({ domain, time: cappedTime });
              }
            }
          }

          // Sort both by time descending
          activeStatsArr.sort((a, b) => b.time - a.time);
          todayHistoryArr.sort((a, b) => b.time - a.time);

          // Clear list
          listEl.innerHTML = '';

          // Render active sites directly (like active tasks) - always visible
          if (activeStatsArr.length === 0) {
            listEl.innerHTML = '<div class="empty-state">No active focus sessions.</div>';
          } else {
            activeStatsArr.forEach(site => {
              const item = createActiveSiteItem(site, blockedDomains);
              listEl.appendChild(item);
            });
          }

          // Render History Section below (separate container, like completed tasks)
          renderHistorySection(listEl, data.session_history || [], todayHistoryArr, blockedDomains);
        });
      });
    }

    function renderHistorySection(container, history, todayHistory, blockedDomains) {
      // Remove existing history section
      const existing = container.querySelector('.session-history-container');
      if (existing) existing.remove();

      // Create wrapper container (like completed-tasks-container)
      const wrapper = document.createElement('div');
      wrapper.className = 'session-history-container';
      wrapper.style.width = '100%';

      // History header with toggle (like completed-tasks-header)
      const header = document.createElement('div');
      header.className = 'session-history-header';
      header.id = 'toggle-history';
      // Only count today's history entries
      const historyCount = todayHistory.length;
      header.innerHTML = `
      <span class="session-history-title">HISTORY</span>
      <span class="session-history-count" id="history-count">${historyCount}</span>
    `;

      // History list container (like completed-task-list)
      const historyList = document.createElement('div');
      historyList.className = 'session-history-list';
      historyList.id = 'session-history-list';

      // Restore state: keep expanded if user left it open
      const isExpanded = localStorage.getItem('session_history_expanded') === 'true';
      const hasHistory = todayHistory.length > 0;

      if (isExpanded && hasHistory) {
        sessionHistoryVisible = true;
        historyList.classList.add('visible');
      }

      // Render content - Only today's history
      if (!hasHistory) {
        historyList.innerHTML = '<div class="empty-state" style="padding:10px; opacity:0.6; font-size:0.75rem;">No recorded sessions today.</div>';
      } else {
        // Today's history only
        const todayGroup = document.createElement('div');
        todayGroup.className = 'history-group';
        todayGroup.innerHTML = '<div class="history-group-title">TODAY</div>';

        todayHistory.forEach(site => {
          const item = createHistoryItem(site, blockedDomains, true);
          todayGroup.appendChild(item);
        });

        historyList.appendChild(todayGroup);
      }

      // Toggle on header click (like completed tasks toggle)
      header.addEventListener('click', () => {
        sessionHistoryVisible = !sessionHistoryVisible;
        historyList.classList.toggle('visible', sessionHistoryVisible);
        // Store state
        localStorage.setItem('session_history_expanded', sessionHistoryVisible);
      });

      // Hover to expand (like completed tasks)
      wrapper.addEventListener('mouseenter', () => {
        if (hasHistory) {
          historyList.classList.add('visible');
          sessionHistoryVisible = true;
        }
      });

      wrapper.addEventListener('mouseleave', () => {
        // Only collapse if not explicitly expanded by click
        const isExplicitlyExpanded = localStorage.getItem('session_history_expanded') === 'true';
        if (!isExplicitlyExpanded && hasHistory) {
          historyList.classList.remove('visible');
          sessionHistoryVisible = false;
        }
      });

      // Assemble: Header -> History List (like completed-tasks-container structure)
      wrapper.appendChild(header);
      wrapper.appendChild(historyList);
      container.appendChild(wrapper);
    }

    // Helper: Create active site item
    function createActiveSiteItem(site, blockedDomains) {
      const item = document.createElement('div');
      item.className = 'site-item active-site-item';
      item.style.cursor = 'pointer';
      item.title = 'Double-click to block/unblock domain';

      const minutes = site.time / 60000;
      const baseHour = Math.max(60, Math.ceil(minutes / 60) * 60);
      const widthPercent = Math.min((minutes / baseHour) * 100, 100);
      const isBlocked = !!blockedDomains[site.domain];
      const displayDomain = formatDomainForDisplay(site.domain, 20);

      item.innerHTML = `
      <span class="site-time">${formatDuration(site.time)}</span>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${widthPercent}%"></div>
      </div>
      <span class="site-domain ${isBlocked ? 'blocked' : ''}" title="${site.domain}">${displayDomain}</span>
    `;

      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const newStatus = !blockedDomains[site.domain];
        blockedDomains[site.domain] = newStatus;

        if (window.PerformanceUtils) {
          window.PerformanceUtils.debouncedStorageWrite("blocked_domains", blockedDomains);
        } else {
          chrome.storage.local.set({ "blocked_domains": blockedDomains });
        }

        if (!newStatus) {
          chrome.runtime.sendMessage({ type: 'domain-unblocked', domain: site.domain });
        }
        renderSites();
      });

      return item;
    }

    // Helper: Create history item
    function createHistoryItem(site, blockedDomains, isToday) {
      const item = document.createElement('div');
      item.className = 'site-item history-item';
      item.style.opacity = isToday ? '0.7' : '0.6';
      item.style.cursor = 'pointer';
      item.title = 'Double-click to block/unblock domain';

      const minutes = site.time / 60000;
      const baseHour = Math.max(60, Math.ceil(minutes / 60) * 60);
      const widthPercent = Math.min((minutes / baseHour) * 100, 100);
      const isBlocked = !!blockedDomains[site.domain];
      const displayDomain = formatDomainForDisplay(site.domain, 20);

      item.innerHTML = `
      <span class="site-time">${formatDuration(site.time)}</span>
      <div class="progress-track" style="height: 1px; opacity: 0.3;">
        <div class="progress-fill" style="width: ${widthPercent}%"></div>
      </div>
      <span class="site-domain ${isBlocked ? 'blocked' : ''}" title="${site.domain}">${displayDomain}</span>
    `;

      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const newStatus = !blockedDomains[site.domain];
        blockedDomains[site.domain] = newStatus;
        chrome.storage.local.set({ "blocked_domains": blockedDomains }, () => {
          if (!newStatus) {
            chrome.runtime.sendMessage({ type: 'domain-unblocked', domain: site.domain });
          }
          renderSites();
        });
      });

      return item;
    }

    function formatDuration(ms) {
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}S`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}M`;
      const h = Math.floor(m / 60);
      const remainingM = m % 60;
      return remainingM > 0 ? `${h}H ${remainingM}M` : `${h}H`;
    }

    // Smart domain formatting function
    // Intelligently formats domain names for better readability
    function formatDomainForDisplay(domain, maxLength = 20) {
      if (!domain) return '';

      // Remove www. prefix if present
      let cleaned = domain.replace(/^www\./i, '');

      // If domain fits, return as is
      if (cleaned.length <= maxLength) {
        return cleaned;
      }

      // Split domain into parts
      const parts = cleaned.split('.');

      // If it's a simple domain (2 parts: name.tld), just truncate
      if (parts.length === 2) {
        return cleaned.length > maxLength
          ? cleaned.substring(0, maxLength - 3) + '...'
          : cleaned;
      }

      // For multi-part domains (subdomain.domain.tld), prioritize showing:
      // 1. Main domain + TLD (last 2 parts)
      // 2. Subdomain prefix if space allows

      const mainDomain = parts.slice(-2).join('.'); // e.g., "google.com"
      const subdomains = parts.slice(0, -2); // e.g., ["console", "cloud"]

      // If main domain alone fits, show it
      if (mainDomain.length <= maxLength) {
        // Try to show subdomain prefix if there's space
        if (subdomains.length > 0 && mainDomain.length + 4 <= maxLength) {
          const subdomain = subdomains[subdomains.length - 1]; // Last subdomain
          const combined = `${subdomain}.${mainDomain}`;
          if (combined.length <= maxLength) {
            return combined;
          }
        }
        return mainDomain;
      }

      // Main domain is too long, use smart truncation
      // Show first part + "..." + last part
      if (mainDomain.length > maxLength) {
        const domainName = parts[parts.length - 2]; // e.g., "google"
        const tld = parts[parts.length - 1]; // e.g., "com"
        const availableForName = maxLength - tld.length - 4; // 4 for "..." + "."

        if (availableForName > 0) {
          return domainName.substring(0, availableForName) + '...' + tld;
        } else {
          // Even TLD is too long, just show what fits
          return mainDomain.substring(0, maxLength - 3) + '...';
        }
      }

      // Fallback: truncate from end
      return cleaned.substring(0, maxLength - 3) + '...';
    }

    // Render every 5 seconds for near-real-time updates
    renderSites();
    siteStatsInterval = setInterval(renderSites, 5000);

    // Reset button (also updates timestamp)
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (confirm('Reset all session stats?')) {
          saveCurrentSessionToHistory(() => {
            chrome.storage.local.set({
              "site_stats": {},
              "lastResetTimestamp": Date.now()
            }, renderSites);
          });
        }
      });
    }
  }

  function checkMidnightReset() {
    chrome.storage.local.get(["lastResetTimestamp", "site_stats", "session_history"], (data) => {
      const lastReset = data.lastResetTimestamp || 0;
      const now = new Date();
      const lastResetDate = new Date(lastReset);

      // Check if we've crossed midnight since last reset
      const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

      if (lastReset < todayMidnight) {
        // Save current session to history before resetting
        const stats = data.site_stats || {};
        const statsArr = [];
        for (const [domain, info] of Object.entries(stats)) {
          if (info.time > 1000) {
            statsArr.push({ domain, time: info.time });
          }
        }

        if (statsArr.length > 0) {
          const history = data.session_history || [];
          history.push({
            date: lastResetDate.toISOString(),
            stats: statsArr
          });

          // Keep only last 30 days
          if (history.length > 30) history.shift();

          chrome.storage.local.set({
            "session_history": history,
            "site_stats": {},
            "lastResetTimestamp": todayMidnight
          });
        } else {
          // Reset even if no stats to save
          chrome.storage.local.set({
            "site_stats": {},
            "lastResetTimestamp": todayMidnight
          });
        }
      } else {
        // First run or valid
        if (!data.lastResetTimestamp) {
          chrome.storage.local.set({ "lastResetTimestamp": todayMidnight });
        }
      }
    });
  }

  // Call reset check
  checkMidnightReset();
  setInterval(checkMidnightReset, 60000);


  function saveCurrentSessionToHistory(callback) {
    chrome.storage.local.get(["site_stats", "session_history"], (data) => {
      const stats = data.site_stats || {};
      const statsArr = [];
      for (const [domain, info] of Object.entries(stats)) {
        if (info.time > 1000) {
          statsArr.push({ domain, time: info.time });
        }
      }

      if (statsArr.length > 0) {
        const history = data.session_history || [];
        history.push({
          date: Date.now(),
          sites: statsArr
        });
        // Keep only last 30 sessions
        const trimmedHistory = history.slice(-30);
        chrome.storage.local.set({ "session_history": trimmedHistory }, callback);
      } else if (callback) {
        callback();
      }
    });
  }

  function initCalendarScrollEffects() {
    const container = document.getElementById('calendar-module');
    if (!container) return;

    const showScrollIndicator = () => {
      container.classList.add('scroll-highlight');
    };

    const hideScrollIndicator = () => {
      container.classList.remove('scroll-highlight');
    };

    container.addEventListener('mouseenter', showScrollIndicator);
    container.addEventListener('mouseleave', hideScrollIndicator);
  }

  function initModuleResizing() {
    // User requested AUTO-EXPANSION based on content.
    // Fixed positioning and CSS max-height: calc(100vh - 80px) handle the boundary.
    return;

    // Load saved height
    const savedHeight = localStorage.getItem('task_module_height');
    if (savedHeight) {
      taskModule.style.setProperty('--task-expanded-height', savedHeight + 'px');
    }

    let startY, startHeight;

    const onMouseMove = (e) => {
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = clientY - startY;

      // Allow dragging without typical viewport limits per user request
      const nextHeight = Math.max(200, startHeight + dy);

      // Use !important to override any CSS height: auto and remove max-height limit
      taskModule.style.setProperty('--task-expanded-height', nextHeight + 'px');
      taskModule.style.setProperty('height', nextHeight + 'px', 'important');
      taskModule.style.setProperty('min-height', nextHeight + 'px', 'important');
      taskModule.style.setProperty('max-height', 'none', 'important');

      taskModule.classList.add('resizing');
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onMouseMove);
      document.removeEventListener('touchend', onMouseUp);
      taskModule.classList.remove('resizing');

      // Save to localStorage
      const finalHeight = parseInt(taskModule.style.height);
      if (!isNaN(finalHeight)) {
        localStorage.setItem('task_module_height', finalHeight);
        taskModule.style.setProperty('--task-expanded-height', finalHeight + 'px');
      }
    };

    const onMouseDown = (e) => {
      // Only left click
      if (e.type === 'mousedown' && e.button !== 0) return;

      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startHeight = taskModule.offsetHeight;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('touchmove', onMouseMove, { passive: false });
      document.addEventListener('touchend', onMouseUp);

      if (e.cancelable) e.preventDefault();
    };

    handle.addEventListener('mousedown', onMouseDown);
    handle.addEventListener('touchstart', onMouseDown, { passive: false });
  }

  function initTaskHoverExpansion() {
    // User requested AUTO-EXPANSION based on content.
    // CSS ensures it grows naturally and stops at the boundary.
    return;
  }

});
