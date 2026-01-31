/**
 * early_init.js
 * Contains critical scripts that must run before anything else to prevent FOUC (Flash of Unstyled Content).
 * Merged from inline scripts in index.html to comply with CSP.
 */

// SCRIPT 1: Critical CSS/Theme injector
(function () {
    'use strict';
    // CRITICAL: Default to LIGHT GRAY to prevent white flash
    // HTML tag already has #F2F2F2, so we maintain that unless dark theme
    var bgColor = '#F2F2F2'; // Default light - prevents white flash
    var isLight = true; // Default to light to prevent white flash

    // Try to read theme, but don't block if it fails
    try {
        var pref = localStorage.getItem('theme_preference');
        var mode = localStorage.getItem('theme_mode');
        var theme = pref || mode || 'auto';

        if (theme === 'light') {
            isLight = true;
            bgColor = '#F2F2F2';
        } else if (theme === 'dark') {
            isLight = false;
            bgColor = '#0A0A0B';
        } else if (theme === 'auto') {
            try {
                isLight = !window.matchMedia('(prefers-color-scheme: dark)').matches;
                bgColor = isLight ? '#F2F2F2' : '#0A0A0B';
            } catch (e) {
                // Fallback to light to prevent white flash
                isLight = true;
                bgColor = '#F2F2F2';
            }
        }

        var solidColor = localStorage.getItem('solid_bg_color');
        if (solidColor && solidColor.trim()) {
            bgColor = solidColor;
            // If custom color is set, try to determine if it's light or dark
            try {
                var rgb = solidColor.match(/\d+/g);
                if (rgb && rgb.length >= 3) {
                    var r = parseInt(rgb[0]);
                    var g = parseInt(rgb[1]);
                    var b = parseInt(rgb[2]);
                    // If average is > 128, it's likely a light color
                    isLight = ((r + g + b) / 3) > 128;
                }
            } catch (e) { }
        }
    } catch (e) {
        // If localStorage fails, default to light to prevent white flash
        isLight = true;
        bgColor = '#F2F2F2';
    }

    // CRITICAL: Set background IMMEDIATELY
    var html = document.documentElement;
    html.style.setProperty('background-color', bgColor, 'important');
    html.style.setProperty('background', bgColor, 'important');

    // Apply theme class immediately
    if (isLight) {
        html.classList.add('light-theme');
    } else {
        html.classList.remove('light-theme');
    }

    // CRITICAL: Inject CSS into head IMMEDIATELY as backup
    var style = document.createElement('style');
    style.id = 'critical-bg-inline';
    style.setAttribute('data-bg', bgColor);
    style.textContent =
        'html{background-color:' + bgColor + '!important;background:' + bgColor + '!important;}' +
        'html:not(.light-theme){background-color:#0A0A0B!important;background:#0A0A0B!important;}' +
        'html.light-theme{background-color:#F2F2F2!important;background:#F2F2F2!important;}' +
        'body{background-color:inherit!important;background:inherit!important;margin:0!important;padding:0!important;}';

    var head = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
    head.insertBefore(style, head.firstChild);

    // Update meta theme-color if it exists
    try {
        var metaTheme = document.getElementById('theme-color-meta');
        if (metaTheme) {
            metaTheme.content = bgColor;
        }
    } catch (e) { }

    var setBodyBg = function () {
        try {
            if (document.body) {
                document.body.style.setProperty('background-color', bgColor, 'important');
                document.body.style.setProperty('background', bgColor, 'important');
                return true;
            }
        } catch (e) { }
        return false;
    };

    if (!setBodyBg()) {
        try {
            var observer = new MutationObserver(function () {
                if (setBodyBg()) {
                    observer.disconnect();
                }
            });
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: false
            });
            setTimeout(setBodyBg, 0);
        } catch (e) {
            var interval = setInterval(function () {
                if (setBodyBg()) {
                    clearInterval(interval);
                }
            }, 1);
            setTimeout(function () { clearInterval(interval); }, 100);
        }
    }
})();

// SCRIPT 2: Synchronous background color setter
(function () {
    'use strict';
    try {
        const pref = localStorage.getItem('theme_preference');
        const mode = localStorage.getItem('theme_mode');
        const theme = pref || mode || 'auto';

        let isLight = false;
        if (theme === 'light') {
            isLight = true;
        } else if (theme === 'auto') {
            try {
                isLight = !window.matchMedia('(prefers-color-scheme: dark)').matches;
            } catch (e) {
                isLight = false;
            }
        }

        const solidColor = localStorage.getItem('solid_bg_color');
        const finalBg = solidColor || (isLight ? '#F2F2F2' : '#0A0A0B');

        const html = document.documentElement;
        html.style.setProperty('--bg-core', finalBg);
        html.style.setProperty('--bg-core-inline', finalBg);
        html.style.backgroundColor = finalBg;
        html.style.background = finalBg;

        const metaTheme = document.getElementById('theme-color-meta');
        if (metaTheme) {
            metaTheme.content = finalBg;
        }

        if (isLight) {
            html.classList.add('light-theme');
        } else {
            html.classList.remove('light-theme');
        }

        const setBodyBg = function () {
            if (document.body) {
                document.body.style.setProperty('--bg-core-inline', finalBg);
                document.body.style.backgroundColor = finalBg;
                document.body.style.background = finalBg;
                return true;
            }
            return false;
        };

        if (!setBodyBg()) {
            const observer = new MutationObserver(function () {
                if (setBodyBg()) {
                    observer.disconnect();
                }
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(setBodyBg, 0);
        }
    } catch (e) {
        document.documentElement.style.backgroundColor = '#0A0A0B';
        document.documentElement.style.background = '#0A0A0B';
    }
})();

// SCRIPT 3: Theme/Settings applier
(function () {
    const doc = document.documentElement;
    const pref = localStorage.getItem('theme_preference');
    const mode = localStorage.getItem('theme_mode');
    const theme = pref || mode || 'auto';

    let isLight = false;
    if (theme === 'light') isLight = true;
    else if (theme === 'auto') {
        isLight = !window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    const solidColor = localStorage.getItem('solid_bg_color');
    const finalBg = solidColor || (isLight ? '#F2F2F2' : '#0A0A0B');

    doc.style.setProperty('--bg-core', finalBg);
    doc.style.setProperty('--bg-core-inline', finalBg);
    doc.style.setProperty('background-color', finalBg, 'important');
    doc.style.setProperty('background', finalBg, 'important');

    var criticalStyle = document.getElementById('critical-bg-inline');
    if (criticalStyle) {
        criticalStyle.setAttribute('data-bg', finalBg);
        criticalStyle.textContent =
            'html{background-color:' + finalBg + '!important;background:' + finalBg + '!important;}' +
            'html.light-theme{background-color:' + (isLight ? '#F2F2F2' : '#0A0A0B') + '!important;background:' + (isLight ? '#F2F2F2' : '#0A0A0B') + '!important;}' +
            'body{background-color:inherit!important;background:inherit!important;margin:0!important;padding:0!important;}';
    }

    if (document.body) {
        document.body.style.setProperty('--bg-core-inline', finalBg);
        document.body.style.setProperty('background-color', finalBg, 'important');
        document.body.style.setProperty('background', finalBg, 'important');
    }

    let metaTheme = document.getElementById('theme-color-meta') || document.querySelector('meta[name="theme-color"]');
    if (!metaTheme) {
        metaTheme = document.createElement('meta');
        metaTheme.id = 'theme-color-meta';
        metaTheme.name = "theme-color";
        document.head.appendChild(metaTheme);
    }
    metaTheme.content = finalBg;

    if (localStorage.getItem('gradient_enabled') === 'true') {
        const g1 = localStorage.getItem('gradient_color_1');
        const g2 = localStorage.getItem('gradient_color_2');
        if (g1) doc.style.setProperty('--gradient-color-1', g1);
        if (g2) doc.style.setProperty('--gradient-color-2', g2);
        doc.classList.add('has-gradient');
    } else {
        doc.classList.remove('has-gradient');
    }

    const font = localStorage.getItem('font_hud_preference');
    if (font) doc.style.setProperty('--font-hud', font);

    if (pref || mode) doc.classList.add('pre-loaded');
})();
