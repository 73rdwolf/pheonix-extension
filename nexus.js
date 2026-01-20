
/* --- 10. NEXUS CONSOLE --- */
/*
 * 6x2 GRID:
 * - Top Row: 5 most visited from site_stats + Add button
 * - Bottom Row: Next 6 frequently used from site_stats
 * - Star intersections between icons
 */

/**
 * Saves onboarding settings safely.
 * @param {Object} settings - { theme: 'light'|'dark', pinnedSites: string[], onboarding_completed: boolean }
 */
async function saveOnboardingSettings(settings) {
    if (!settings) return;

    try {
        const current = await chrome.storage.local.get(['user_preferences', 'nexus_pinned']);

        // 1. Update User Preferences (merge with existing)
        const userPrefs = current.user_preferences || {};
        if (settings.theme) userPrefs.theme = settings.theme;
        if (settings.onboarding_completed !== undefined) userPrefs.onboarding_completed = settings.onboarding_completed;

        // 2. Update Pinned Sites (if provided)
        let nexusPinned = current.nexus_pinned || [];
        if (Array.isArray(settings.pinnedSites)) {
            nexusPinned = settings.pinnedSites;
        }

        // 3. Save to storage
        await chrome.storage.local.set({
            'user_preferences': userPrefs,
            'nexus_pinned': nexusPinned
        });

        console.log('[Nexus] Onboarding settings saved:', settings);

    } catch (e) {
        console.error('[Nexus] Failed to save onboarding settings:', e);
    }
}

function initNexus() {
    console.log('[Nexus] initNexus called');
    const container = document.getElementById('nexus-console');
    const row0 = document.getElementById('nexus-row-0');
    const row1 = document.getElementById('nexus-row-1');
    const quoteText = document.getElementById('nexus-quote-text');
    const quoteAuthor = document.getElementById('nexus-quote-author');
    const tooltip = document.getElementById('nexus-tooltip');

    if (!row0 || !row1 || !container) {
        console.error('[Nexus] Critical elements missing:', {
            container: !!container,
            row0: !!row0,
            row1: !!row1
        });
        return;
    }

    // Theme Logic: Centrally managed in script.js. Removing redundant nexus-specific theme applier to prevent conflicts.


    // Tooltip helper functions
    const showTooltip = (text) => {
        if (tooltip) {
            tooltip.textContent = text;
            tooltip.classList.add('visible');
        }
    };

    const hideTooltip = () => {
        if (tooltip) {
            tooltip.classList.remove('visible');
        }
    };

    // Star SVG template
    const starSvg = `<svg width="21" height="21" viewBox="0 0 21 21" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M10.5 0C10.5 4.94975 10.5001 7.42455 12.0378 8.96223C13.3832 10.3077 15.4462 10.4761 19.2568 10.4971L21 10.5C16.0503 10.5 13.5755 10.5001 12.0378 12.0378C10.5001 13.5755 10.5 16.0503 10.5 21C10.5 16.0503 10.4999 13.5755 8.96223 12.0378C7.42455 10.5001 4.94975 10.5 0 10.5C4.94975 10.5 7.42455 10.4999 8.96223 8.96223C10.3077 7.61676 10.4761 5.55383 10.4971 1.74316L10.5 0Z"></path>
    </svg>`;

    // Quotes
    const quotes = [
        { text: "You have power over your mind, not outside events.", author: "MARCUS AURELIUS" },
        { text: "The obstacle is the way.", author: "MARCUS AURELIUS" },
        { text: "Waste no more time arguing about what a good man should be. Be one.", author: "MARCUS AURELIUS" },
        { text: "He who has a why to live can bear almost any how.", author: "FRIEDRICH NIETZSCHE" },
        { text: "It is not that we have a short time to live, but that we waste a lot of it.", author: "SENECA" }
    ];

    let currentSiteOrder = null; // To track changes and prevent redundant renders

    // Load and render
    const loadNexus = async () => {
        try {
            console.log('[Nexus] Loading data...');
            const storage = await chrome.storage.local.get(['site_stats', 'nexus_pinned']);
            const stats = storage.site_stats || {};
            let pinnedSites = storage.nexus_pinned || [];

            // Helper to get "root" signature for deduplication
            const getSiteSignature = (domain) => {
                const clean = domain.replace(/^www\./, '').toLowerCase();
                if (clean.includes('google.') || clean === 'google') return 'google';
                if (clean.includes('yahoo.')) return 'yahoo';
                if (clean.includes('bing.')) return 'bing';
                if (clean.includes('amazon.')) return 'amazon';
                if (clean.includes('reddit.')) return 'reddit';
                if (clean.includes('wikipedia.')) return 'wikipedia';
                return clean;
            };

            // 1. Process all stats into a flat sorted list
            const allSites = [];
            for (const [domain, data] of Object.entries(stats)) {
                if (!data.time || data.time <= 0) continue;
                allSites.push({
                    domain: domain,
                    cleanDomain: domain.toLowerCase().trim(),
                    title: data.customName || domain.replace(/^www\./, '').split('.')[0].toUpperCase(),
                    url: domain.startsWith('http') ? domain : 'https://' + domain,
                    icon: data.icon || null,
                    time: data.time,
                    signature: getSiteSignature(domain)
                });
            }
            allSites.sort((a, b) => b.time - a.time);

            // 2. Extract Unique Signatures (Primary List)
            const seenSigs = new Set();
            const distinctSites = [];
            for (const site of allSites) {
                if (!seenSigs.has(site.signature)) {
                    distinctSites.push(site);
                    seenSigs.add(site.signature);
                }
            }

            // 3. Clean Pinned List (Deduplicate signatures)
            const validPinnedDomains = [];
            const seenPinnedSigs = new Set();
            for (const domain of pinnedSites) {
                const sig = getSiteSignature(domain);
                if (!seenPinnedSigs.has(sig)) {
                    seenPinnedSigs.add(sig);
                    validPinnedDomains.push(domain);
                }
            }
            if (validPinnedDomains.length !== pinnedSites.length) {
                pinnedSites = validPinnedDomains;
                await chrome.storage.local.set({ 'nexus_pinned': pinnedSites });
            }

            // 4. Auto-Fill Pinned (Up to 5)
            if (pinnedSites.length < 5) {
                let changed = false;
                const currentPinnedSigs = new Set(pinnedSites.map(d => getSiteSignature(d)));
                const currentPinnedDomains = new Set(pinnedSites);

                // Pass 1: Fill with Unique Signatures
                for (const site of distinctSites) {
                    if (pinnedSites.length >= 5) break;
                    if (!currentPinnedSigs.has(site.signature)) {
                        pinnedSites.push(site.domain);
                        currentPinnedSigs.add(site.signature);
                        currentPinnedDomains.add(site.domain);
                        changed = true;
                    }
                }

                // Pass 2: Fallback to ANY valid site if still empty
                if (pinnedSites.length < 5) {
                    for (const site of allSites) {
                        if (pinnedSites.length >= 5) break;
                        if (!currentPinnedDomains.has(site.domain)) {
                            pinnedSites.push(site.domain);
                            currentPinnedDomains.add(site.domain);
                            changed = true;
                        }
                    }
                }

                if (changed) {
                    await chrome.storage.local.set({ 'nexus_pinned': pinnedSites });
                }
            }

            // 5. Build Top Row Object List
            const topSites = [];
            for (const domain of pinnedSites) {
                let site = allSites.find(s => s.domain === domain);
                if (!site) {
                    // Fallback: match by signature if exact domain usage is low/gone
                    const sig = getSiteSignature(domain);
                    site = allSites.find(s => s.signature === sig);
                }

                if (site) {
                    topSites.push(site);
                } else {
                    // Fallback: create site object, checking stats for customName
                    const siteData = stats[domain] || {};
                    topSites.push({
                        domain: domain,
                        title: siteData.customName || domain.replace(/^www\./, '').split('.')[0].toUpperCase(),
                        url: domain.startsWith('http') ? domain : 'https://' + domain,
                        icon: siteData.icon || null,
                        time: siteData.time || 0
                    });
                }
            }

            // 6. Build Bottom Row (Next 6)
            const bottomSites = [];
            const pinnedSigsSet = new Set(pinnedSites.map(d => getSiteSignature(d)));

            // Pass 1: Unique Signatures NOT in pinned (Aggressive Dedupe)
            for (const site of distinctSites) {
                if (bottomSites.length >= 6) break;
                if (!pinnedSigsSet.has(site.signature)) {
                    bottomSites.push(site);
                }
            }

            // Pass 2: Fallback to ANY site NOT in pinned & NOT in bottom (Relaxed)
            if (bottomSites.length < 6) {
                const existingDomains = new Set([...pinnedSites, ...bottomSites.map(s => s.domain)]);
                for (const site of allSites) {
                    if (bottomSites.length >= 6) break;
                    if (!existingDomains.has(site.domain)) {
                        bottomSites.push(site);
                        existingDomains.add(site.domain);
                    }
                }
            }

            // Calculate a signature for the current view
            const signature = [...topSites, ...bottomSites].map(s => s.domain).join('|');

            if (signature === currentSiteOrder) {
                console.log('[Nexus] Site order unchanged, skipping render');
                return;
            }
            currentSiteOrder = signature;

            console.log('[Nexus] Rendering sites:', { top: topSites.length, bottom: bottomSites.length });
            render(topSites, bottomSites);
            addStarIntersections();
        } catch (e) {
            console.error('[Nexus] Error in loadNexus:', e);
        }
    };

    // Initial Load
    const initialLoad = async () => {
        // --- HISTORY IMPORT LOGIC (First Run Only) ---
        const storage = await chrome.storage.local.get(['site_stats', 'history_imported']);
        const stats = storage.site_stats || {};
        const alreadyImported = storage.history_imported === true;

        if (!alreadyImported && Object.keys(stats).length < 5) {
            console.log('[Nexus] Importing history for initial population...');
            try {
                // Fetch up to 5k recent history items
                const historyHelper = await chrome.history.search({
                    text: '',
                    startTime: 0,
                    maxResults: 5000
                });

                if (historyHelper && historyHelper.length > 0) {
                    const domainMap = {};

                    historyHelper.forEach(item => {
                        if (!item.url || !item.url.startsWith('http')) return;

                        try {
                            const urlObj = new URL(item.url);
                            const domain = urlObj.hostname.replace(/^www\./, '');

                            // Skip common garbage/utility domains
                            if (domain.includes('google.com') && item.url.includes('/search')) return;
                            if (domain === 'localhost' || domain.includes('127.0.0.1')) return;

                            if (!domainMap[domain]) {
                                domainMap[domain] = {
                                    visitCount: 0,
                                    lastVisit: 0,
                                    title: item.title || domain
                                };
                            }

                            // Weight: visitCount is explicitly provided by API
                            domainMap[domain].visitCount += (item.visitCount || 1);
                            domainMap[domain].lastVisit = Math.max(domainMap[domain].lastVisit, item.lastVisitTime || 0);

                            // Prefer shorter titles if multiple
                            if (item.title && item.title.length < domainMap[domain].title.length) {
                                domainMap[domain].title = item.title;
                            }
                        } catch (e) {
                            // ignore invalid URLs
                        }
                    });

                    // Convert map to site_stats format
                    // We map visitCount to "time" (milliseconds spent) loosely to fit existing ranking logic
                    // Formula: visitCount * 5 minutes per visit
                    Object.keys(domainMap).forEach(domain => {
                        const data = domainMap[domain];
                        // Only add if not already present
                        if (!stats[domain]) {
                            stats[domain] = {
                                time: data.visitCount * 300000, // 5 mins per visit approx
                                lastSeen: data.lastVisit,
                                icon: null, // will be auto-fetched on render
                                customName: null // let auto-fetch handle title for now
                            };
                        }
                    });

                    // Save imported stats
                    await chrome.storage.local.set({
                        'site_stats': stats,
                        'history_imported': true
                    });
                    console.log('[Nexus] History import complete. Stats count:', Object.keys(stats).length);
                }
            } catch (err) {
                console.error('[Nexus] History import failed:', err);
                // Mark as done anyway to prevent infinite retry loops on error
                await chrome.storage.local.set({ 'history_imported': true });
            }
        }

        await loadNexus();
        renderQuote(); // Only call once at the start
    };

    // Render rows
    const render = (topSites, bottomSites) => {
        row0.innerHTML = '';
        row1.innerHTML = '';

        // TOP ROW: 5 pinned sites + 1 cell (6 cells total)
        for (let i = 0; i < 6; i++) {
            const site = topSites[i];
            if (site) {
                row0.appendChild(createItem(site, true, true)); // isPinned = true
            } else {
                row0.appendChild(createEmptySlotWithAdd(true)); // isTopRow = true
            }
        }

        // BOTTOM ROW: 6 dynamic sites (6 cells)
        for (let i = 0; i < 6; i++) {
            const site = bottomSites[i];
            if (site) {
                row1.appendChild(createItem(site, false, false)); // isPinned = false
            } else {
                row1.appendChild(createEmptySlotWithAdd(false)); // isTopRow = false
            }
        }
    };

    // Add star intersections at the center of every 4 cards
    const addStarIntersections = () => {
        const wrapper = document.getElementById('nexus-grid-wrapper');
        if (!wrapper) return;

        // Remove old stars
        wrapper.querySelectorAll('.star-intersection').forEach(el => el.remove());

        // Grid: 6 columns × 62px each, NO gap.
        // Positioning stars relative to the wrapper, so no padding offsets needed.
        const cardSize = 62;
        const starSize = 17;

        // Stars at the exact junction of 4 cards
        for (let col = 0; col < 5; col++) {
            // Horizontal junction is exactly at (col + 1) * 62
            const x = (col + 1) * cardSize - (starSize / 2);

            // Vertical junction is exactly at one card height (62px)
            const y = cardSize - (starSize / 2);

            const star = document.createElement('div');
            star.className = 'star-intersection';
            star.style.left = `${x}px`;
            star.style.top = `${y}px`;
            star.innerHTML = starSvg;
            wrapper.appendChild(star);
        }
    };

    // Helper to cache remote icon to base64 permanently
    // Uses canvas method - images load fine via <img>, we just try to cache them
    // If CORS blocks canvas conversion, that's okay - image still displays
    const cacheIcon = (domain, imgElement) => {
        if (!imgElement || !domain) return;
        // Skip if already cached
        if (imgElement.src && imgElement.src.startsWith('data:')) return;
        
        // Store original onload if it exists
        const originalOnload = imgElement.onload;
        
        // Wait for image to load, then try to convert to base64 via canvas
        imgElement.onload = async function() {
            // Call original onload if it exists
            if (originalOnload) originalOnload.call(this);
            
            // Only try to cache if image loaded successfully
            if (!this.complete || this.naturalWidth === 0) return;
            
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = this.naturalWidth || 128;
                canvas.height = this.naturalHeight || 128;
                
                // Try to draw image to canvas
                // This will fail with "tainted canvas" if CORS blocks it, but that's okay
                ctx.drawImage(this, 0, 0);
                
                // Convert to base64 (will throw if canvas is tainted)
                const base64 = canvas.toDataURL('image/png');
                
                // Save to storage
                const storage = await chrome.storage.local.get(['site_stats']);
                const stats = storage.site_stats || {};
                if (stats[domain] && (!stats[domain].icon || !stats[domain].icon.startsWith('data:'))) {
                    stats[domain].icon = base64;
                    await chrome.storage.local.set({ 'site_stats': stats });
                }
            } catch (e) {
                // Silently fail - CORS errors when converting to canvas are expected
                // The image still displays fine, we just can't cache it
                // This is normal and not a problem
            }
        };
    };

    // Create item
    const createItem = (site, showEdit, isPinned) => {
        const a = document.createElement('a');
        a.className = 'console-item';
        a.href = site.url;
        a.dataset.title = site.title;
        a.dataset.domain = site.domain;
        if (isPinned) a.dataset.pinned = 'true';

        const iconWrap = document.createElement('div');
        iconWrap.className = 'console-icon-wrap';

        const img = document.createElement('img');
        // Don't set crossOrigin - let images load normally (they display fine without it)
        // We'll try to cache via canvas, but if CORS blocks it, that's okay - image still displays

        // 1. Check if we have a CACHED icon (Base64)
        if (site.icon && site.icon.startsWith('data:')) {
            img.src = site.icon;
        } else {
            // 2. Not cached - use providers (images load fine via <img>, just can't fetch() them)
            // Icon Fallback Chain
            const providers = [
                site.icon, // Primary cached icon if exists
                `https://icons.duckduckgo.com/ip3/${site.domain}.ico`, // DDG (images work, fetch() has CORS)
                `https://logo.clearbit.com/${site.domain}`, // Clearbit (usually works)
                `https://www.google.com/s2/favicons?domain=${site.domain}&sz=128` // Google (as fallback)
            ].filter(Boolean);

            let iconIndex = 0;
            img.src = providers[0] || `https://icons.duckduckgo.com/ip3/${site.domain}.ico`;

            // Try to cache the icon when it loads (using canvas method, no fetch() needed)
            // This will silently fail if CORS blocks canvas conversion, but image still displays
            cacheIcon(site.domain, img);

            img.onerror = () => {
                iconIndex++;
                if (iconIndex < providers.length) {
                    img.src = providers[iconIndex];
                    // Try to cache this provider too
                    cacheIcon(site.domain, img);
                } else {
                    // If everything fails, use a generic placeholder
                    img.style.opacity = 0.3;
                    img.alt = 'Icon unavailable';
                }
            };
        }

        img.alt = site.title;

        // Cache successful non-primary icons? 
        // For now, let's keep it dynamic to ensure freshness.

        iconWrap.appendChild(img);
        a.appendChild(iconWrap);

        // Delete
        const del = document.createElement('div');
        del.className = 'delete-trigger';
        del.textContent = '×';
        del.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isPinned) {
                handleUnpin(site.domain);
            } else {
                handleDelete(site.domain);
            }
        });
        a.appendChild(del);

        // Edit (top row only)
        if (showEdit) {
            const edit = document.createElement('div');
            edit.className = 'edit-trigger';
            edit.textContent = '✎';
            edit.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                handleEdit(site);
            });
            a.appendChild(edit);
        }

        // Tooltip on hover
        a.addEventListener('mouseenter', () => {
            showTooltip(site.title);
        });
        a.addEventListener('mouseleave', () => {
            hideTooltip();
        });

        return a;
    };

    // Empty slot with add button
    const createEmptySlotWithAdd = (isTopRow) => {
        const div = document.createElement('div');
        div.className = 'console-item empty-slot';
        const btn = document.createElement('button');
        btn.className = 'add-console-btn';
        btn.title = 'Add Bookmark';
        btn.textContent = '+';
        btn.addEventListener('click', () => handleAdd(isTopRow));
        div.appendChild(btn);
        return div;
    };

    // ============================================
    // BOOKMARK MODAL CONTROLLER
    // ============================================
    const modal = document.getElementById('nexus-bookmark-modal');
    const modalTitle = document.getElementById('nexus-modal-title');
    const urlInput = document.getElementById('nexus-bookmark-url');
    const nameInput = document.getElementById('nexus-bookmark-name');
    const nameStatus = document.getElementById('nexus-name-status');
    const pasteBtn = document.getElementById('nexus-paste-btn');
    const saveBtn = document.getElementById('nexus-save-bookmark-btn');
    const closeBtn = document.getElementById('close-nexus-modal');

    let editingDomain = null; // null = adding new, string = editing existing
    let shouldPinOnSave = false;

    // Open modal for adding
    const handleAdd = (shouldPin = false) => {
        if (!modal || !urlInput || !nameInput || !saveBtn) {
            console.error('[Nexus] Bookmark modal elements missing');
            if (typeof showNotification === 'function') {
                showNotification('Error: Bookmark modal missing', 'error');
            }
            return;
        }

        editingDomain = null;
        shouldPinOnSave = shouldPin;
        if (modalTitle) modalTitle.textContent = 'ADD BOOKMARK';
        urlInput.value = '';
        nameInput.value = '';
        if (nameStatus) {
            nameStatus.className = 'input-status';
            nameStatus.textContent = '';
        }
        saveBtn.textContent = 'ADD BOOKMARK';
        openModal();
        urlInput.focus();
    };

    // Open modal for editing
    const handleEdit = (site) => {
        if (!modal || !urlInput || !nameInput || !saveBtn) {
            console.error('[Nexus] Bookmark modal elements missing during edit');
            if (typeof showNotification === 'function') {
                showNotification('Error: Bookmark modal missing', 'error');
            }
            return;
        }

        editingDomain = site.domain;
        shouldPinOnSave = false;
        if (modalTitle) modalTitle.textContent = 'EDIT BOOKMARK';
        urlInput.value = site.url;
        nameInput.value = site.title || site.domain.replace(/^www\./, '').split('.')[0].toUpperCase();
        if (nameStatus) {
            nameStatus.className = 'input-status';
            nameStatus.textContent = '';
        }
        saveBtn.textContent = 'SAVE CHANGES';
        openModal();
        nameInput.focus();
    };

    const openModal = () => {
        if (modal) modal.classList.remove('hidden');
    };

    const closeModal = () => {
        if (modal) modal.classList.add('hidden');
        editingDomain = null;
        shouldPinOnSave = false;
    };

    // Paste button handler
    if (pasteBtn) {
        pasteBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    urlInput.value = text.trim();
                    urlInput.dispatchEvent(new Event('input')); // Trigger auto-fetch
                }
            } catch (e) {
                console.error('[Nexus] Clipboard paste failed:', e);
                if (typeof showNotification === 'function') {
                    showNotification('Unable to access clipboard', 'error');
                }
            }
        });
    }

    // Auto-fetch site name when URL changes
    let fetchDebounce = null;
    if (urlInput) {
        urlInput.addEventListener('input', () => {
            clearTimeout(fetchDebounce);
            const url = urlInput.value.trim();

            if (!url || !url.startsWith('http')) {
                nameStatus.className = 'input-status';
                return;
            }

            fetchDebounce = setTimeout(() => {
                autoFetchSiteName(url);
            }, 500); // Debounce 500ms
        });
    }

    // Auto-fetch site name logic
    const autoFetchSiteName = async (url) => {
        let domain;
        try {
            domain = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return;
        }

        nameStatus.className = 'input-status loading';
        nameStatus.textContent = '...';

        // 1. Try browser history first
        try {
            const historyItems = await chrome.history.search({
                text: domain,
                startTime: Date.now() - (30 * 24 * 60 * 60 * 1000), // Last 30 days
                maxResults: 10
            });

            const match = historyItems.find(item => {
                try {
                    const itemDomain = new URL(item.url).hostname.replace(/^www\./, '');
                    return itemDomain === domain && item.title && item.title.trim().length > 0;
                } catch {
                    return false;
                }
            });

            if (match && match.title) {
                // Extract clean title (often titles have " - Site Name" pattern)
                let title = match.title.split(' - ')[0].split(' | ')[0].trim();
                if (title.length > 30) title = title.substring(0, 30) + '...';

                nameInput.value = title;
                nameStatus.className = 'input-status success';
                nameStatus.textContent = '✓';
                setTimeout(() => { nameStatus.className = 'input-status'; }, 1500);
                return;
            }
        } catch (e) {
            console.log('[Nexus] History lookup failed:', e);
        }

        // 2. Fallback: fetch page title from URL
        try {
            const response = await fetch(url, {
                method: 'GET',
                mode: 'no-cors' // This limits us but avoids CORS issues
            });

            // Due to no-cors, we can't read the response. Use domain fallback.
            const domainName = domain.split('.')[0];
            nameInput.value = domainName.charAt(0).toUpperCase() + domainName.slice(1);
            nameStatus.className = 'input-status success';
            nameStatus.textContent = '✓';
            setTimeout(() => { nameStatus.className = 'input-status'; }, 1500);
        } catch (e) {
            // Final fallback: just use domain
            const domainName = domain.split('.')[0];
            nameInput.value = domainName.charAt(0).toUpperCase() + domainName.slice(1);
            nameStatus.className = 'input-status';
        }
    };

    // Close modal handler
    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    // Save bookmark handler
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            const customName = nameInput.value.trim();

            if (!url || !url.startsWith('http')) {
                if (typeof showNotification === 'function') {
                    showNotification('Please enter a valid URL', 'warning');
                }
                return;
            }

            let domain;
            try {
                domain = new URL(url).hostname;
            } catch {
                domain = url.replace(/https?:\/\//, '').split('/')[0];
            }

            const cleanDomain = domain.toLowerCase().trim().replace(/^www\./, '');

            const storage = await chrome.storage.local.get(['site_stats', 'nexus_pinned']);
            const stats = storage.site_stats || {};
            const pinned = storage.nexus_pinned || [];

            // Helper for signature
            const getSiteSignature = (d) => {
                const clean = d.replace(/^www\./, '').toLowerCase();
                if (clean.includes('google.') || clean === 'google') return 'google';
                if (clean.includes('yahoo.')) return 'yahoo';
                if (clean.includes('bing.')) return 'bing';
                if (clean.includes('amazon.')) return 'amazon';
                if (clean.includes('reddit.')) return 'reddit';
                if (clean.includes('wikipedia.')) return 'wikipedia';
                return clean;
            };

            // Adding new bookmark
            if (!editingDomain) {
                const newSignature = getSiteSignature(cleanDomain);
                const normalizedStats = Object.keys(stats).map(d => d.toLowerCase().replace(/^www\./, ''));

                if (normalizedStats.includes(cleanDomain)) {
                    if (typeof showNotification === 'function') {
                        showNotification('This domain already exists', 'warning');
                    }
                    return;
                }

                const existingSignatures = Object.keys(stats).map(d => getSiteSignature(d));
                if (existingSignatures.includes(newSignature)) {
                    if (typeof showNotification === 'function') {
                        showNotification('A similar domain already exists', 'warning');
                    }
                    return;
                }

                const maxTime = Math.max(...Object.values(stats).map(s => s.time || 0), 0);

                stats[cleanDomain] = {
                    time: maxTime + 7200000,
                    icon: `https://www.google.com/s2/favicons?domain=${cleanDomain}&sz=128`,
                    lastSeen: Date.now(),
                    customName: customName || null
                };

                if (shouldPinOnSave && !pinned.includes(cleanDomain)) {
                    pinned.push(cleanDomain);
                    const uniquePinned = [...new Set(pinned)];
                    await chrome.storage.local.set({ 'site_stats': stats, 'nexus_pinned': uniquePinned });
                } else {
                    await chrome.storage.local.set({ 'site_stats': stats });
                }

                if (typeof showNotification === 'function') {
                    showNotification('Bookmark added', 'success');
                }
            } else {
                // Editing existing bookmark
                if (stats[editingDomain]) {
                    stats[editingDomain].customName = customName || null;
                    await chrome.storage.local.set({ 'site_stats': stats });

                    if (typeof showNotification === 'function') {
                        showNotification('Bookmark updated', 'success');
                    }
                }
            }

            closeModal();
            loadNexus();
        });
    }

    // Delete handler
    const handleDelete = async (domain) => {
        const storage = await chrome.storage.local.get(['site_stats']);
        const stats = storage.site_stats || {};
        if (stats[domain]) {
            delete stats[domain];
            await chrome.storage.local.set({ 'site_stats': stats });
            loadNexus();
        }
    };

    // Unpin handler (remove from pinned list)
    const handleUnpin = async (domain) => {
        const storage = await chrome.storage.local.get(['nexus_pinned']);
        const pinned = storage.nexus_pinned || [];
        const updated = pinned.filter(d => d !== domain);
        await chrome.storage.local.set({ 'nexus_pinned': updated });
        loadNexus();
    };

    // Quote
    const renderQuote = () => {
        if (!quoteText || !quoteAuthor) return;
        const q = quotes[Math.floor(Math.random() * quotes.length)];
        quoteText.textContent = `"${q.text}"`;
        quoteAuthor.textContent = q.author;
    };

    // Init
    console.log('[Nexus] Initializing...');
    try {
        initialLoad().then(() => {
            console.log('[Nexus] Initial load complete');
        }).catch(err => {
            console.error('[Nexus] Initial load failed:', err);
        });
    } catch (e) {
        console.error('[Nexus] Critical error during init:', e);
    }

    // Listen for changes
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.site_stats) {
            console.log('[Nexus] Detected stats change, reloading...');
            loadNexus().catch(e => console.error('[Nexus] Reload failed:', e)); // Only reload the sites, not the quote
        }
    });
}
