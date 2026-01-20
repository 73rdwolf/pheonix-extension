document.addEventListener('DOMContentLoaded', () => {
    // Utility for applying accent colors
    const applyAccent = (hex) => {
        // Use default if hex is undefined or null
        const color = hex || '#FF6B00';
        console.log('[POPUP] Applying accent color:', color);
        document.documentElement.style.setProperty('--accent-color', color);
        const cleanHex = color.replace('#', '');
        const r = parseInt(cleanHex.slice(0, 2), 16);
        const g = parseInt(cleanHex.slice(2, 4), 16);
        const b = parseInt(cleanHex.slice(4, 6), 16);
        document.documentElement.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
    };

    // Helper function to resolve theme (handles 'auto' mode)
    const resolveTheme = (themeMode, themePreference) => {
        if (themeMode === 'auto') {
            // Resolve auto mode based on system preference
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            return prefersDark ? 'dark' : 'light';
        }
        // Use theme_mode if available, otherwise fall back to theme_preference
        return themeMode || themePreference || 'dark';
    };

    // Helper function to apply theme
    const applyTheme = (theme) => {
        if (theme === 'light') {
            document.documentElement.classList.add('light-theme');
        } else {
            document.documentElement.classList.remove('light-theme');
        }
    };

    // Sync theme, accent, bg, and font with main dashboard (Shared Storage)
    chrome.storage.local.get(['theme_mode', 'theme_preference', 'accent_color', 'solid_bg_color', 'system_font'], (res) => {
        console.log('[POPUP] Initial load from storage:', res);

        // Handle Theme - check theme_mode first, then theme_preference
        const themeMode = res.theme_mode || res.theme_preference;
        const resolvedTheme = resolveTheme(themeMode, res.theme_preference);
        console.log('[POPUP] Resolved theme:', resolvedTheme, 'from mode:', themeMode);
        applyTheme(resolvedTheme);

        // Handle Accent - Use Budarina theme colors by default, or custom if set
        let accent = res.accent_color;
        if (!accent) {
            // Use Budarina theme default: black for light, white for dark
            accent = resolvedTheme === 'light' ? '#000000' : '#FFFFFF';
        }
        applyAccent(accent);

        // Handle Background Color
        if (res.solid_bg_color) {
            document.documentElement.style.setProperty('--bg-core', res.solid_bg_color);
            document.body.style.backgroundColor = res.solid_bg_color;
        }

        // Handle Font
        if (res.system_font) {
            document.documentElement.style.setProperty('--font-hud', res.system_font);
        }
    });

    // Listen for system theme changes (for auto mode)
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = () => {
        chrome.storage.local.get(['theme_mode', 'theme_preference'], (res) => {
            const themeMode = res.theme_mode || res.theme_preference;
            if (themeMode === 'auto') {
                const resolvedTheme = resolveTheme('auto', res.theme_preference);
                console.log('[POPUP] System theme changed, resolved to:', resolvedTheme);
                applyTheme(resolvedTheme);
            }
        });
    };
    mediaQuery.addEventListener('change', handleSystemThemeChange);

    // Listen for live updates from Dashboard settings
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
            console.log('[POPUP] Storage changed:', changes);

            // Live Theme Update - handle both theme_mode and theme_preference
            if (changes.theme_mode || changes.theme_preference) {
                chrome.storage.local.get(['theme_mode', 'theme_preference', 'accent_color'], (res) => {
                    const themeMode = res.theme_mode || res.theme_preference;
                    const resolvedTheme = resolveTheme(themeMode, res.theme_preference);
                    console.log('[POPUP] Theme changed, resolved to:', resolvedTheme, 'from mode:', themeMode);
                    applyTheme(resolvedTheme);
                    // Update accent color to match theme if no custom accent is set
                    if (!res.accent_color) {
                        const accent = resolvedTheme === 'light' ? '#000000' : '#FFFFFF';
                        applyAccent(accent);
                    }
                });
            }

            // Live Accent Update
            if (changes.accent_color) {
                console.log('[POPUP] Accent color changed to:', changes.accent_color.newValue);
                // Get current theme to determine default if accent is cleared
                chrome.storage.local.get(['theme_mode', 'theme_preference'], (themeRes) => {
                    const themeMode = themeRes.theme_mode || themeRes.theme_preference;
                    const resolvedTheme = resolveTheme(themeMode, themeRes.theme_preference);
                    let accent = changes.accent_color.newValue;
                    if (!accent) {
                        // Use Budarina theme default: black for light, white for dark
                        accent = resolvedTheme === 'light' ? '#000000' : '#FFFFFF';
                    }
                    applyAccent(accent);
                });
            }

            // Live Background Update
            if (changes.solid_bg_color) {
                document.documentElement.style.setProperty('--bg-core', changes.solid_bg_color.newValue);
                document.body.style.backgroundColor = changes.solid_bg_color.newValue;
            }

            // Live Font Update
            if (changes.system_font) {
                document.documentElement.style.setProperty('--font-hud', changes.system_font.newValue);
            }
        }
    });

    // Refresh button logic
    const refreshBtn = document.getElementById('refresh-gmail-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            refreshBtn.classList.add('rotate-180');
            setTimeout(() => refreshBtn.classList.remove('rotate-180'), 600);
            refreshList();
        });
    }

    checkAuthStatus();
    initEmailModalListeners();
});

let currentEmailId = null;

function checkAuthStatus() {
    chrome.storage.local.get(["google_access_token", "gmail_cached_snippet"], (res) => {
        const token = res.google_access_token;
        if (res.gmail_cached_snippet) {
            const gmailList = document.getElementById('gmail-list');
            if (gmailList) gmailList.innerHTML = res.gmail_cached_snippet;
        }

        if (token) {
            syncGmail(token);
        } else {
            document.getElementById('gmail-list').innerHTML = `
                <div class="empty-state">
                  <p>Please connect Google to see your emails.</p>
                  <button id="connect-google-btn" class="primary-btn" style="margin-top:20px; width:100%;">CONNECT GOOGLE</button>
                </div>
            `;
            document.getElementById('connect-google-btn')?.addEventListener('click', () => {
                // Use chrome.identity.getAuthToken for consistency with script.js
                // This allows silent token refresh to work properly
                chrome.identity.getAuthToken({ interactive: true }, (token) => {
                    if (chrome.runtime.lastError || !token) {
                        console.error("Popup Auth Error:", chrome.runtime.lastError?.message);
                        return;
                    }
                    chrome.storage.local.set({ "google_access_token": token }, () => {
                        checkAuthStatus();
                    });
                });
            });
        }
    });
}

async function syncGmail(token) {
    const headers = { Authorization: `Bearer ${token}` };
    const gmailList = document.getElementById('gmail-list');
    const gmailBadge = document.getElementById('gmail-badge');

    try {
        const gRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=10', { headers });
        const gData = await gRes.json();

        if (gmailBadge) gmailBadge.textContent = gData.resultSizeEstimate || '0';

        if (gData.messages && gData.messages.length > 0) {
            const promises = gData.messages.map(async (msg) => {
                const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers });
                return await detailRes.json();
            });

            const messages = await Promise.all(promises);
            renderEmails(messages.filter(m => m));
        } else {
            gmailList.innerHTML = '<div class="empty-state">No unread mail.</div>';
        }
    } catch (err) {
        console.error(err);
        gmailList.innerHTML = '<div class="empty-state" style="color: #ff4444">Sync Error</div>';
    }
}

function renderEmails(messages) {
    const gmailList = document.getElementById('gmail-list');
    if (!gmailList) return;

    gmailList.innerHTML = messages.map(m => {
        const subjectHeader = m.payload.headers.find(h => h.name === 'Subject');
        const fromHeader = m.payload.headers.find(h => h.name === 'From');
        const subject = subjectHeader ? subjectHeader.value : '(No Subject)';
        const from = fromHeader ? fromHeader.value.replace(/<.*>/, '').trim().replace(/"/g, '') : 'Unknown';
        const snippet = m.snippet;
        const date = new Date(parseInt(m.internalDate));
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        return `
            <div class="email-item" data-email-id="${m.id}">
                <div class="email-header">
                    <span class="email-from" title="${from}">${from}</span>
                    <span class="email-time">${timeStr}</span>
                </div>
                <div class="email-subject" title="${subject}">${subject}</div>
                <div class="email-snippet">${snippet}</div>
            </div>
        `;
    }).join('');

    gmailList.querySelectorAll('.email-item').forEach(item => {
        item.addEventListener('click', () => openEmail(item.dataset.emailId));
    });

    chrome.storage.local.set({ "gmail_cached_snippet": gmailList.innerHTML });
}

function initEmailModalListeners() {
    const modal = document.getElementById('email-view-modal');
    const closeBtn = document.getElementById('close-email-modal');
    const replyBtn = document.getElementById('email-reply-btn');
    const markReadBtn = document.getElementById('email-mark-read-btn');
    const deleteBtn = document.getElementById('email-delete-btn');
    const replyArea = document.getElementById('email-reply-area');
    const sendReplyBtn = document.getElementById('email-send-reply-btn');
    const cancelReplyBtn = document.getElementById('email-cancel-reply-btn');
    const bodyContent = document.getElementById('email-body-content');
    const modalHeader = document.querySelector('.modal-header-clean');
    const actionsToolbar = document.querySelector('.email-actions-toolbar');

    if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

    if (replyBtn) {
        replyBtn.addEventListener('click', () => {
            replyArea.classList.toggle('hidden');
            if (!replyArea.classList.contains('hidden')) {
                document.body.classList.add('reply-mode');
                document.getElementById('email-reply-text').focus();
            } else {
                document.body.classList.remove('reply-mode');
            }
        });
    }

    // Smart Scroll Logic with performance optimization
    if (bodyContent) {
        let lastScrollTop = 0;
        let ticking = false;

        bodyContent.addEventListener('scroll', () => {
            if (!ticking) {
                requestAnimationFrame(() => {
                    const st = bodyContent.scrollTop;

                    // Header Compression
                    if (st > 40) {
                        modalHeader?.classList.add('compressed');
                    } else {
                        modalHeader?.classList.remove('compressed');
                    }

                    // Toolbar Visibility (Floating Unit)
                    if (st > lastScrollTop && st > 100) {
                        actionsToolbar?.classList.add('scrolling-down');
                    } else {
                        actionsToolbar?.classList.remove('scrolling-down');
                    }
                    lastScrollTop = st <= 0 ? 0 : st;
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });
    }

    if (cancelReplyBtn) {
        cancelReplyBtn.addEventListener('click', () => {
            replyArea.classList.add('hidden');
            document.body.classList.remove('reply-mode');
            document.getElementById('email-reply-text').value = '';
        });
    }

    if (sendReplyBtn) {
        sendReplyBtn.addEventListener('click', async () => {
            const text = document.getElementById('email-reply-text').value;
            if (!text.trim()) return;
            sendReplyBtn.textContent = '...';
            sendReplyBtn.disabled = true;
            await sendReply(currentEmailId, text);
            sendReplyBtn.textContent = 'SEND';
            sendReplyBtn.disabled = false;
            replyArea.classList.add('hidden');
            document.body.classList.remove('reply-mode');
            document.getElementById('email-reply-text').value = '';
            modal.classList.add('hidden');
            refreshList();
        });
    }

    if (markReadBtn) {
        markReadBtn.addEventListener('click', async () => {
            markReadBtn.textContent = '...';
            markReadBtn.disabled = true;
            await markAsRead(currentEmailId);
            markReadBtn.textContent = 'Mark Read';
            markReadBtn.disabled = false;
            modal.classList.add('hidden');
            refreshList();
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            const originalHTML = deleteBtn.innerHTML;
            deleteBtn.innerHTML = '...';
            deleteBtn.disabled = true;
            await trashEmail(currentEmailId);
            deleteBtn.innerHTML = originalHTML;
            deleteBtn.disabled = false;
            modal.classList.add('hidden');
            refreshList();
        });
    }
}

async function openEmail(id) {
    currentEmailId = id;
    const modal = document.getElementById('email-view-modal');
    const subjectEl = document.getElementById('email-view-subject');
    const fromEl = document.getElementById('email-view-from');
    const timeEl = document.getElementById('email-view-time');
    const bodyEl = document.getElementById('email-body-content');
    const modalHeader = document.querySelector('.modal-header-clean');
    const actionsToolbar = document.querySelector('.email-actions-toolbar');

    modal.classList.remove('hidden');
    modalHeader?.classList.remove('compressed');
    actionsToolbar?.classList.remove('scrolling-down');
    bodyEl.scrollTop = 0;
    // Optimized skeleton loaders
    subjectEl.textContent = "";
    fromEl.textContent = "";
    timeEl.textContent = "";
    subjectEl.innerHTML = `<div class="skeleton-line" style="width: 80%; height: 18px;"></div>`;
    fromEl.innerHTML = `<div class="skeleton-line" style="width: 50%; height: 14px;"></div>`;
    timeEl.innerHTML = `<div class="skeleton-line" style="width: 30%; height: 14px;"></div>`;
    bodyEl.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:12px; opacity:0.1">
            <div class="skeleton-line" style="width:80%; height:14px;"></div>
            <div class="skeleton-line" style="width:100%; height:14px;"></div>
            <div class="skeleton-line" style="width:90%; height:14px;"></div>
            <div class="skeleton-line" style="width:70%; height:14px;"></div>
            <div class="skeleton-line" style="width:95%; height:14px;"></div>
        </div>
    `;
    document.getElementById('email-reply-area').classList.add('hidden');
    document.body.classList.remove('reply-mode');

    chrome.storage.local.get("google_access_token", async (res) => {
        const token = res.google_access_token;
        if (!token) return;

        try {
            const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json();
            const headers = data.payload.headers;

            const subject = headers.find(h => h.name === 'Subject')?.value || '(No Subject)';
            const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
            const fromName = from.replace(/<.*>/, '').trim().replace(/"/g, '') || from;
            const dateObj = new Date(parseInt(data.internalDate));
            const dateStr = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

            subjectEl.textContent = subject;
            fromEl.textContent = fromName;
            fromEl.title = from;
            timeEl.textContent = dateStr;

            let bodyHtml = "";
            if (data.payload.parts) {
                const parts = data.payload.parts;
                const htmlPart = findPart(parts, 'text/html');
                if (htmlPart && htmlPart.body.data) {
                    bodyHtml = decodeBase64URL(htmlPart.body.data);
                } else {
                    const plainPart = findPart(parts, 'text/plain');
                    if (plainPart && plainPart.body.data) {
                        const text = decodeBase64URL(plainPart.body.data);
                        bodyHtml = `<pre>${text}</pre>`;
                    }
                }
            } else if (data.payload.body && data.payload.body.data) {
                const decoded = decodeBase64URL(data.payload.body.data);
                if (data.payload.mimeType === 'text/html' || decoded.trim().startsWith('<')) {
                    bodyHtml = decoded;
                } else {
                    bodyHtml = `<pre>${decoded}</pre>`;
                }
            }

            bodyEl.innerHTML = bodyHtml || "<p>No content.</p>";
            bodyEl.querySelectorAll('a').forEach(link => {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.style.color = 'var(--accent-color)';
            });
        } catch (e) {
            console.error(e);
            bodyEl.innerHTML = '<p style="color: #ff6b6b">Error loading content.</p>';
        }
    });
}

function findPart(parts, mimeType) {
    for (const part of parts) {
        if (part.mimeType === mimeType) return part;
        if (part.parts) {
            const result = findPart(part.parts, mimeType);
            if (result) return result;
        }
    }
    return null;
}

function decodeBase64URL(str) {
    return decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/'))));
}

async function sendReply(messageId, text) {
    return new Promise(resolve => {
        chrome.storage.local.get("google_access_token", async (res) => {
            const token = res.google_access_token;
            try {
                const originalRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=From`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                const originalData = await originalRes.json();
                const headers = originalData.payload.headers;

                const originalSubject = headers.find(h => h.name === 'Subject')?.value;
                const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
                const messageIdHeader = headers.find(h => h.name === 'Message-ID')?.value;
                const fromHeader = headers.find(h => h.name === 'From')?.value;
                const toEmail = fromHeader.includes('<') ? fromHeader.match(/<([^>]+)>/)[1] : fromHeader;

                const emailLines = [
                    `To: ${toEmail}`,
                    `Subject: ${subject}`,
                    messageIdHeader ? `In-Reply-To: ${messageIdHeader}` : '',
                    messageIdHeader ? `References: ${messageIdHeader}` : '',
                    'Content-Type: text/plain; charset="UTF-8"',
                    '',
                    text
                ].filter(line => line !== '');

                const email = emailLines.join('\r\n');
                const base64EncodedEmail = btoa(unescape(encodeURIComponent(email))).replace(/\+/g, '-').replace(/\//g, '_');

                await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ raw: base64EncodedEmail })
                });
                resolve();
            } catch (e) {
                console.error(e);
                resolve();
            }
        });
    });
}

async function markAsRead(messageId) {
    return new Promise(resolve => {
        chrome.storage.local.get("google_access_token", async (res) => {
            const token = res.google_access_token;
            try {
                await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
                });
                resolve();
            } catch (e) {
                console.error(e);
                resolve();
            }
        });
    });
}

async function trashEmail(messageId) {
    return new Promise(resolve => {
        chrome.storage.local.get("google_access_token", async (res) => {
            const token = res.google_access_token;
            try {
                await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}` }
                });
                resolve();
            } catch (e) {
                console.error(e);
                resolve();
            }
        });
    });
}

function refreshList() {
    chrome.storage.local.get("google_access_token", (res) => {
        if (res.google_access_token) syncGmail(res.google_access_token);
    });
}
