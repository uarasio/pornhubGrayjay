// PMVHaven plugin for Grayjay
// Provides: video listing, search, channels/profiles, recommendations, comments,
// playlist search/details, login, history sync, subscription/playlist migration.

const PLATFORM = "PMVHaven";
const BASE_URL = "https://pmvhaven.com";
const PLATFORM_CLAIMTYPE = 3;

const API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9"
};

var config = {};
var pluginSettings = {
    // Default ON so Grayjay shows its built-in "Sync" tab and the
    // "Sync Remote History from this platform on startup" toggle as soon
    // as the user logs in. Mirrors SB-GJ exactly.
    syncRemoteHistory: true
};
var state = {
    isAuthenticated: false,
    username: "",
    userId: "",
    authCookies: ""
};

// ---------- helpers ----------

function jsonGET(url) {
    const res = http.GET(url, API_HEADERS, false);
    if (!res.isOk) {
        throw new ScriptException("Request failed " + res.code + " for " + url);
    }
    try { return JSON.parse(res.body); }
    catch (e) { throw new ScriptException("Invalid JSON from " + url); }
}

function jsonGETNoThrow(url, useAuth) {
    try {
        const res = http.GET(url, API_HEADERS, useAuth === true);
        if (!res.isOk) return null;
        return JSON.parse(res.body);
    } catch (e) {
        log("jsonGETNoThrow failed for " + url + ": " + e);
        return null;
    }
}

function jsonRequest(method, url, body, useAuth) {
    try {
        const headers = Object.assign({ "Content-Type": "application/json" }, API_HEADERS);
        const payload = body ? JSON.stringify(body) : "";
        let res;
        if (method === "POST")      res = http.POST(url, payload, headers, useAuth === true);
        else if (method === "PUT")  res = (http.PUT ? http.PUT(url, payload, headers, useAuth === true)
                                                    : http.request("PUT", url, payload, headers, useAuth === true));
        else if (method === "DELETE") res = (http.DELETE ? http.DELETE(url, headers, useAuth === true)
                                                          : http.request("DELETE", url, "", headers, useAuth === true));
        else                        res = http.POST(url, payload, headers, useAuth === true);
        if (!res || !res.isOk) return null;
        if (!res.body) return { success: true };
        try { return JSON.parse(res.body); } catch (e) { return { success: true, raw: res.body }; }
    } catch (e) {
        log("jsonRequest " + method + " " + url + " failed: " + e);
        return null;
    }
}

function buildQuery(params) {
    const parts = [];
    for (const k in params) {
        if (params[k] === undefined || params[k] === null) continue;
        parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
    }
    return parts.length ? "?" + parts.join("&") : "";
}

function parseDuration(duration) {
    if (typeof duration === "number") return duration;
    if (typeof duration === "string") {
        const parts = duration.split(":").map(a => parseInt(a, 10));
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
}

function parseDateSeconds(iso) {
    if (!iso) return 0;
    try {
        const t = Date.parse(iso);
        if (!isFinite(t)) return 0;
        return Math.floor(t / 1000);
    } catch (e) { return 0; }
}

function slugifyTitle(title) {
    return (title || "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function videoUrlFromIdTitle(id, title) {
    const slug = slugifyTitle(title);
    return BASE_URL + "/video/" + (slug ? slug + "_" : "") + id;
}

function channelUrlFromUsername(username) {
    return BASE_URL + "/profile/" + username;
}

function playlistUrlFromId(id) {
    return BASE_URL + "/playlists/" + id;
}

function extractVideoIdFromUrl(url) {
    if (!url) return null;
    // matches /video/<slug>_<id> or /video/<id>
    const m = url.match(/\/video\/(?:[^_\/?#]+_)?([a-f0-9]{24})/i);
    if (m) return m[1];
    // standalone id
    const m2 = url.match(/([a-f0-9]{24})/i);
    return m2 ? m2[1] : null;
}

function extractUsernameFromProfileUrl(url) {
    const m = url.match(/\/profile\/([^\/\?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
}

function extractPlaylistIdFromUrl(url) {
    const m = url.match(/\/playlists?\/([a-f0-9]{24})/i);
    return m ? m[1] : null;
}

function isObjectId(s) {
    return typeof s === "string" && /^[a-f0-9]{24}$/i.test(s);
}

// Resolve a profile token (which may be a username OR a 24-char user id, since
// pmvhaven.com profile URLs use the user's _id) into the full user document.
function fetchUserByToken(token) {
    if (!token) return null;
    if (isObjectId(token)) {
        const byId = jsonGETNoThrow(BASE_URL + "/api/users/" + token);
        if (byId && byId.data) return byId.data;
    }
    const byName = jsonGETNoThrow(BASE_URL + "/api/users/by-username/" + encodeURIComponent(token));
    if (byName && byName.data) return byName.data;
    return null;
}

// ---------- builders ----------

function createAuthor(uploaderName, uploaderUsername, uploaderAvatarUrl) {
    const name = uploaderUsername || uploaderName || "";
    if (!name) {
        return new PlatformAuthorLink(
            new PlatformID(PLATFORM, "", config.id),
            "", "", ""
        );
    }
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, name, config.id),
        name,
        channelUrlFromUsername(name),
        uploaderAvatarUrl || ""
    );
}

function toPlatformVideo(v) {
    const id = v._id || v.id || "";
    const vidurl = videoUrlFromIdTitle(id, v.title || "");
    const thumbUrl = v.thumbnailUrl || (v.thumbnailSizes && (v.thumbnailSizes.lg || v.thumbnailSizes.md)) || "";
    const durationSec = (typeof v.durationSeconds === "number" && v.durationSeconds > 0)
        ? v.durationSeconds
        : parseDuration(v.duration);

    const pv = new PlatformVideo({
        id: new PlatformID(PLATFORM, id, config.id),
        name: v.title || "Untitled",
        thumbnails: thumbUrl ? new Thumbnails([new Thumbnail(thumbUrl, 720)]) : new Thumbnails([]),
        author: createAuthor(v.uploader, v.uploaderUsername, v.uploaderAvatarUrl),
        datetime: parseDateSeconds(v.uploadDate || v.createdAt),
        duration: durationSec,
        viewCount: v.views || 0,
        url: vidurl,
        isLive: false
    });
    // Resume-point hydration when the server has returned the logged-in user's
    // watch progress on the video document.
    if (typeof v.watchProgress === "number" && v.watchProgress > 0) {
        try { pv.playbackTime = Math.floor(v.watchProgress); } catch (e) { /* ignore */ }
    }
    if (v.lastWatchedAt) {
        try { pv.playbackDate = parseDateSeconds(v.lastWatchedAt); } catch (e) { /* ignore */ }
    }
    return pv;
}

// Build a PlatformVideo for watch-history import. CRITICAL: Grayjay only imports
// history items whose `playbackDate` is non-null AND `playbackTime > 0`, and it
// ONLY reads these when they are passed INTO the PlatformVideo constructor — values
// assigned after construction (pv.playbackTime = ...) are ignored. See
// StateHistory.syncRemoteHistory (grayjay-android): `if(video.playbackTime > 0)`.
function createHistoryPlatformVideo(v, watchedSeconds, fallbackOrder) {
    const id = v._id || v.id || "";
    const vidurl = videoUrlFromIdTitle(id, v.title || "");
    const thumbUrl = v.thumbnailUrl || (v.thumbnailSizes && (v.thumbnailSizes.lg || v.thumbnailSizes.md)) || "";
    const durationSec = (typeof v.durationSeconds === "number" && v.durationSeconds > 0)
        ? v.durationSeconds
        : parseDuration(v.duration);

    // playbackDate = when it was watched (unix seconds). Must be > 0.
    let playbackDate = watchedSeconds && watchedSeconds > 0 ? watchedSeconds : 0;
    if (!playbackDate) {
        // Preserve descending order even without a server timestamp.
        playbackDate = Math.floor(Date.now() / 1000) - (fallbackOrder || 0) * 60;
    }

    // playbackTime = resume position (seconds). MUST be > 0 or Grayjay drops it.
    let playbackTime;
    if (typeof v.watchProgress === "number" && v.watchProgress > 0) {
        playbackTime = Math.floor(v.watchProgress);
    } else {
        // Completed/unknown items: use half the duration (>=60s) so they still import.
        playbackTime = Math.max(60, Math.floor((durationSec || 300) * 0.5));
    }

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, id, config.id),
        name: v.title || "Untitled",
        thumbnails: thumbUrl ? new Thumbnails([new Thumbnail(thumbUrl, 720)]) : new Thumbnails([]),
        author: createAuthor(v.uploader, v.uploaderUsername, v.uploaderAvatarUrl),
        datetime: parseDateSeconds(v.uploadDate || v.createdAt) || playbackDate,
        duration: durationSec,
        viewCount: v.views || 0,
        url: vidurl,
        isLive: false,
        // MUST be in the constructor for Grayjay to import the history item.
        playbackDate: playbackDate,
        playbackTime: playbackTime
    });
}

function toPlatformChannel(user, subscriberCount) {
    const username = user.username || "";
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, username, config.id, PLATFORM_CLAIMTYPE),
        name: username,
        thumbnail: user.avatarUrl || "",
        banner: user.bannerUrl || "",
        subscribers: subscriberCount || 0,
        description: user.bio || "",
        url: channelUrlFromUsername(username),
        urlAlternatives: [channelUrlFromUsername(username)],
        links: user.socialLinks ? cleanSocialLinks(user.socialLinks) : {}
    });
}

function cleanSocialLinks(links) {
    const out = {};
    const map = { website: "Website", twitter: "Twitter", discord: "Discord", telegram: "Telegram" };
    for (const k in map) {
        const v = links[k];
        if (v && typeof v === "string" && v.length > 0) out[map[k]] = v;
    }
    return out;
}

function toPlatformPlaylist(p) {
    const ownerName = p.ownerUsername || p.owner || "";
    const author = ownerName
        ? new PlatformAuthorLink(
            new PlatformID(PLATFORM, ownerName, config.id),
            ownerName,
            channelUrlFromUsername(ownerName),
            p.ownerAvatarUrl || ""
          )
        : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");
    const count = (typeof p.validVideoCount === "number") ? p.validVideoCount
        : (typeof p.videoCount === "number") ? p.videoCount
        : (Array.isArray(p.videos) ? p.videos.length : 0);
    return new PlatformPlaylist({
        id: new PlatformID(PLATFORM, p._id, config.id),
        name: p.name || "Playlist",
        thumbnail: p.thumbnailUrl || p.thumbnail || "",
        author: author,
        datetime: parseDateSeconds(p.createdAt),
        url: playlistUrlFromId(p._id),
        videoCount: count
    });
}

// ---------- source plugin ----------

source.enable = function(conf, settings, savedState) {
    config = conf || {};
    if (settings && typeof settings.syncRemoteHistory !== "undefined") {
        const v = settings.syncRemoteHistory;
        pluginSettings.syncRemoteHistory = (v === true) || (typeof v === "string" && v.toLowerCase() === "true");
    }
    if (savedState) {
        try {
            const s = JSON.parse(savedState);
            state.username = s.username || "";
            state.userId = s.userId || "";
            state.isAuthenticated = !!s.isAuthenticated;
        } catch (e) { /* ignore */ }
    }
    // If Grayjay tells us the user is logged in (via its built-in bridge), trust it.
    try {
        if (typeof bridge !== "undefined" && bridge && typeof bridge.isLoggedIn === "function" && bridge.isLoggedIn()) {
            state.isAuthenticated = true;
        }
    } catch (e) { /* ignore */ }
    log("PMVHaven plugin enabled. syncRemoteHistory=" + pluginSettings.syncRemoteHistory +
        " auth=" + state.isAuthenticated);
};

source.disable = function() {
    state.isAuthenticated = false;
    state.username = "";
    state.userId = "";
};

source.setSettings = function(newsettings) {
    if (!newsettings) return;
    if (typeof newsettings.syncRemoteHistory !== "undefined") {
        const v = newsettings.syncRemoteHistory;
        pluginSettings.syncRemoteHistory = (v === true) || (typeof v === "string" && v.toLowerCase() === "true");
    }
};

source.saveState = function() {
    return JSON.stringify({
        isAuthenticated: state.isAuthenticated,
        username: state.username,
        userId: state.userId
    });
};

source.getCapabilities = function() {
    // Kept for completeness, but note: Grayjay does NOT read this to decide
    // whether to show the Sync tab. It detects history support purely by the
    // presence of `source.getUserHistory` (JSClient.kt: `!!source.getUserHistory`).
    // The actual gate is therefore `source.getUserHistory` being defined below.
    return {
        hasSyncRemoteWatchHistory: pluginSettings.syncRemoteHistory
    };
};

// ---------- auth ----------

// All possible better-auth session cookie names PMVHaven may set. Production
// (HTTPS) uses the "__Secure-" prefixed variants; large tokens get chunked
// into ".0", ".1", ... We treat any of these as a valid session marker.
const AUTH_COOKIE_NAMES = [
    "__Secure-better-auth.session_token",
    "better-auth.session_token"
];

function hasValidAuthCookie(cookies) {
    if (!cookies) return false;
    // string form: "name=value; name2=value2"
    if (typeof cookies === "string") {
        if (cookies.length === 0) return false;
        for (let i = 0; i < AUTH_COOKIE_NAMES.length; i++) {
            const n = AUTH_COOKIE_NAMES[i];
            if (cookies.indexOf(n + "=") >= 0 || cookies.indexOf(n + ".0=") >= 0) return true;
        }
        return false;
    }
    // array of {name,value}
    if (Array.isArray(cookies)) {
        for (let i = 0; i < cookies.length; i++) {
            const c = cookies[i];
            if (c && c.name && c.value) {
                for (let j = 0; j < AUTH_COOKIE_NAMES.length; j++) {
                    const n = AUTH_COOKIE_NAMES[j];
                    if (c.name === n || c.name.indexOf(n + ".") === 0) return true;
                }
            }
        }
        return false;
    }
    // object map
    if (typeof cookies === "object") {
        for (const k in cookies) {
            if (!cookies[k]) continue;
            for (let j = 0; j < AUTH_COOKIE_NAMES.length; j++) {
                const n = AUTH_COOKIE_NAMES[j];
                if (k === n || k.indexOf(n + ".") === 0) return true;
            }
        }
        return false;
    }
    return false;
}

function cookiesToString(cookies) {
    if (!cookies) return "";
    if (typeof cookies === "string") return cookies;
    if (Array.isArray(cookies)) {
        return cookies.filter(c => c && c.name && c.value)
            .map(c => c.name + "=" + c.value).join("; ");
    }
    if (typeof cookies === "object") {
        const out = [];
        for (const k in cookies) { if (cookies[k]) out.push(k + "=" + cookies[k]); }
        return out.join("; ");
    }
    return "";
}

// Read whatever cookies Grayjay captured for pmvhaven.com after the login web
// view. Mirrors SB-GJ: try http.getCookies first, then the bridge variants.
function loadAuthCookies() {
    try {
        if (typeof http.getCookies === "function") {
            const cookies = http.getCookies(BASE_URL);
            if (hasValidAuthCookie(cookies)) { state.authCookies = cookiesToString(cookies); return true; }
        }
        if (typeof bridge !== "undefined" && bridge) {
            if (typeof bridge.getCookieString === "function") {
                const s = bridge.getCookieString(BASE_URL);
                if (hasValidAuthCookie(s)) { state.authCookies = s; return true; }
            }
            if (typeof bridge.getCookies === "function") {
                try {
                    const c = bridge.getCookies("pmvhaven.com");
                    if (hasValidAuthCookie(c)) { state.authCookies = cookiesToString(c); return true; }
                } catch (e) { /* ignore */ }
            }
        }
    } catch (e) { log("loadAuthCookies error: " + e); }
    return false;
}

function tryParseSession(res) {
    if (!res || !res.isOk) return false;
    const body = (res.body || "").trim();
    if (!body || body === "null") return false;
    try {
        const json = JSON.parse(body);
        const user = json.user || (json.session && json.session.user) || json.data;
        if (!user) return false;
        // PMVHaven's API uses `customUserId` (24-char hex) for /api/users/...
        // endpoints (subscriptions, playlists?owner=...). The better-auth
        // `id` field is a separate internal id that those endpoints reject.
        // Prefer customUserId; fall back to other variants only if missing.
        const uid = user.customUserId || user._id || user.userId || user.id;
        if (!uid) return false;
        state.userId = uid;
        state.username = user.username || user.name || state.username || "";
        return true;
    } catch (e) { /* ignore */ }
    return false;
}

function fetchUserInfo() {
    // Pull username/userId from /api/auth/get-session using current cookies.
    // Tries Grayjay's auth context first (useAuth=true), then falls back to
    // sending the captured cookies as an explicit Cookie header. The fallback
    // is what lets us recognise the login when the user signed in via the
    // generic "video -> more -> page" web view, instead of the dedicated
    // Authentication login flow (cookies are still in Grayjay's cookie jar
    // but may not be flagged as plugin-auth).
    try {
        const res1 = http.GET(BASE_URL + "/api/auth/get-session", API_HEADERS, true);
        if (tryParseSession(res1)) return true;
    } catch (e) { log("fetchUserInfo(useAuth) error: " + e); }

    try {
        if (state.authCookies && state.authCookies.length > 0) {
            const hdrs = Object.assign({}, API_HEADERS, { "Cookie": state.authCookies });
            const res2 = http.GET(BASE_URL + "/api/auth/get-session", hdrs, false);
            if (tryParseSession(res2)) return true;
        }
    } catch (e) { log("fetchUserInfo(manual cookie) error: " + e); }

    return false;
}

// Authoritative server-side check: ask /api/auth/get-session with the captured
// cookies. Returns true and populates username/userId when a session exists.
function validateSession() {
    return fetchUserInfo();
}

function bridgeIsLoggedIn() {
    try {
        if (typeof bridge !== "undefined" && bridge && typeof bridge.isLoggedIn === "function") {
            return !!bridge.isLoggedIn();
        }
    } catch (e) { /* ignore */ }
    return false;
}

source.isLoggedIn = function() {
    try {
        // 1) Trust Grayjay's bridge signal first — once it has captured the
        //    required cookies via its login web view, this is the authoritative
        //    indicator that the user finished the flow.
        if (bridgeIsLoggedIn()) {
            loadAuthCookies();
            state.isAuthenticated = true;
            if (!state.username) fetchUserInfo();
            return true;
        }
        // 2) Make sure we have whatever auth cookies were captured, then ask
        //    the server with them. This is how the session is recognised after
        //    the user finishes logging in inside the web view.
        loadAuthCookies();
        if (validateSession()) {
            state.isAuthenticated = true;
            return true;
        }
        state.isAuthenticated = false;
        return false;
    } catch (e) {
        log("isLoggedIn error: " + e);
        return false;
    }
};

source.getLoggedInUser = function() {
    try {
        if (!source.isLoggedIn()) return null;
        if (!state.username) fetchUserInfo();
        return state.username || "Logged In";
    } catch (e) { return null; }
};

// IMPORTANT: Grayjay shows "Login cancelled" whenever this returns false (or
// throws). SB-GJ never returns false here — it trusts that Grayjay's web view
// captured the cookies and returns true unconditionally. We do the same:
// the actual session check is deferred to isLoggedIn()/getLoggedInUser() so
// the user can re-validate later from settings without aborting the flow.
source.login = function() {
    try {
        loadAuthCookies();
        state.isAuthenticated = true;
        // Best-effort: try to populate the username right away.
        try { fetchUserInfo(); } catch (e) { /* ignore */ }
        log("login(): accepted - cookies captured by Grayjay");
        return true;
    } catch (e) {
        log("login error: " + e);
        // Still return true so Grayjay does not display "Login cancelled".
        // isLoggedIn() will resolve the real state on the next call.
        return true;
    }
};

// Called by Grayjay just before opening the login web view. Mirroring SB-GJ:
// wipe any stale auth state and clear residual cookies so the user always
// starts the login flow fresh (avoids stuck/expired session cookies blocking
// the cookiesToFind trigger from firing).
source.prepareLogin = function() {
    try {
        state.isAuthenticated = false;
        state.username = "";
        state.userId = "";
        state.authCookies = "";
        try {
            if (typeof http.clearCookies === "function") {
                http.clearCookies("pmvhaven.com");
                http.clearCookies("www.pmvhaven.com");
            }
            if (typeof bridge !== "undefined" && bridge && bridge.clearCookies) {
                bridge.clearCookies("pmvhaven.com");
                bridge.clearCookies("www.pmvhaven.com");
            }
        } catch (e) { /* ignore */ }
        log("prepareLogin: cleared stale auth state");
        return true;
    } catch (e) {
        log("prepareLogin error: " + e);
        return true;
    }
};

source.logout = function() {
    state.isAuthenticated = false;
    state.username = "";
    state.userId = "";
    state.authCookies = "";
    try {
        if (typeof http.clearCookies === "function") {
            http.clearCookies("pmvhaven.com");
            http.clearCookies("www.pmvhaven.com");
        }
        if (typeof bridge !== "undefined" && bridge && bridge.clearCookies) {
            bridge.clearCookies("pmvhaven.com");
            bridge.clearCookies("www.pmvhaven.com");
        }
    } catch (e) { /* ignore */ }
};

// ---------- home ----------

source.getHome = function() {
    // The /api/videos/trending endpoint is NOT paginated: it returns the same
    // fixed set on every page, which made Grayjay's home feed repeat forever.
    // Use the browse endpoint (/api/videos) which paginates correctly.
    return new VideosApiPager("browse", { sort: "-uploadDate" });
};

// ---------- search ----------

source.searchSuggestions = function(query) { return []; };

// Search filter constants (must match values used in search())
const SORT_OPTIONS = ["Relevance", "Newest", "Oldest", "Most Viewed", "Most Liked", "Top Rated"];
const SORT_MAP = {
    "Relevance":    "",
    "Newest":       "-uploadDate",
    "Oldest":       "uploadDate",
    "Most Viewed":  "-views",
    "Most Liked":   "-likes",
    "Top Rated":    "-bayesianRating"
};
const DATE_DAYS = { "today": 1, "7days": 7, "30days": 30, "365days": 365 };
const DURATION_MAP = {
    "0-5":   { durationMax: 5 * 60 },
    "5-20":  { durationMin: 5 * 60, durationMax: 20 * 60 },
    "20+":   { durationMin: 20 * 60 }
};
// Quality buckets via video height. These params are honoured ONLY by the
// browse endpoint (/api/videos), so search() routes to browse when set.
const QUALITY_MAP = {
    "2160": { minHeight: 2160 },
    "1440": { minHeight: 1440, maxHeight: 2159 },
    "1080": { minHeight: 1080, maxHeight: 1439 },
    "720":  { minHeight: 720,  maxHeight: 1079 }
};
// Popular PMVHaven tags used to build the "Category" filter (multi-select).
const CATEGORY_FILTERS = [
    { name: "Any",            value: "" },
    { name: "Amateur",        value: "amateur" },
    { name: "Anal",           value: "anal" },
    { name: "Asian",          value: "asian" },
    { name: "Big Ass",        value: "big ass" },
    { name: "Big Tits",       value: "big tits" },
    { name: "Blonde",         value: "blonde" },
    { name: "Blowjob",        value: "blowjob" },
    { name: "Brunette",       value: "brunette" },
    { name: "Cosplay",        value: "cosplay" },
    { name: "Cowgirl",        value: "cowgirl" },
    { name: "Creampie",       value: "creampie" },
    { name: "Cum",            value: "cum" },
    { name: "Cumshot",        value: "cumshot" },
    { name: "Cute",           value: "cute" },
    { name: "Dancing",        value: "dancing" },
    { name: "Deepthroat",     value: "deepthroat" },
    { name: "Doggystyle",     value: "doggystyle" },
    { name: "Facial",         value: "facial" },
    { name: "Gangbang",       value: "gangbang" },
    { name: "Goon",           value: "goon" },
    { name: "Hardcore",       value: "hardcore" },
    { name: "Hentai",         value: "hentai" },
    { name: "HMV",            value: "hmv" },
    { name: "Hypno",          value: "hypno" },
    { name: "Interracial",    value: "interracial" },
    { name: "Japanese",       value: "japanese" },
    { name: "JAV",            value: "jav" },
    { name: "MILF",           value: "milf" },
    { name: "POV",            value: "pov" },
    { name: "PAWG",           value: "pawg" },
    { name: "Riding",         value: "riding" },
    { name: "Sissy",          value: "sissy" },
    { name: "Splitscreen",    value: "splitscreen" },
    { name: "Teasing",        value: "teasing" },
    { name: "Teen",           value: "teen" },
    { name: "TikTok",         value: "tiktok" },
    { name: "Twerking",       value: "twerking" },
    { name: "3D",             value: "3d" }
];

source.getSearchCapabilities = function() {
    return {
        // Only video feed types here. Including Channels/Playlists in the
        // search types makes Grayjay hide the filter/sort UI (official plugins
        // like PeerTube/Rumble only declare video types alongside filters).
        types: [Type.Feed.Mixed, Type.Feed.Videos],
        sorts: SORT_OPTIONS,
        filters: [
            {
                id: "date",
                name: "Date",
                isMultiSelect: false,
                filters: [
                    { name: "Any time",     value: "" },
                    { name: "Today",        value: "today" },
                    { name: "Last 7 days",  value: "7days" },
                    { name: "Last 30 days", value: "30days" },
                    { name: "Last year",    value: "365days" }
                ]
            },
            {
                id: "duration",
                name: "Duration",
                isMultiSelect: false,
                filters: [
                    { name: "Any",       value: "" },
                    { name: "0-5 min",   value: "0-5" },
                    { name: "5-20 min",  value: "5-20" },
                    { name: "20+ min",   value: "20+" }
                ]
            },
            {
                id: "quality",
                name: "Quality",
                isMultiSelect: false,
                filters: [
                    { name: "Any",        value: "" },
                    { name: "2160p (4K)", value: "2160" },
                    { name: "1440p",      value: "1440" },
                    { name: "1080p",      value: "1080" },
                    { name: "720p",       value: "720" }
                ]
            },
            {
                id: "category",
                name: "Category",
                isMultiSelect: false,
                filters: CATEGORY_FILTERS
            }
        ]
    };
};

function buildSearchFilterParams(order, filters) {
    const out = {};
    if (order && SORT_MAP[order] !== undefined && SORT_MAP[order] !== "") {
        out.sort = SORT_MAP[order];
    }
    if (filters && typeof filters === "object") {
        const date = pickFilter(filters, "date");
        if (date && DATE_DAYS[date]) {
            const from = new Date(Date.now() - DATE_DAYS[date] * 24 * 3600 * 1000);
            out.uploadDateFrom = from.toISOString();
        }
        const dur = pickFilter(filters, "duration");
        if (dur && DURATION_MAP[dur]) Object.assign(out, DURATION_MAP[dur]);
        const q = pickFilter(filters, "quality");
        if (q && QUALITY_MAP[q]) Object.assign(out, QUALITY_MAP[q]);
        const tags = pickFilterAll(filters, "category").filter(t => t && t.length > 0);
        if (tags.length) out.tags = tags.join(",");
    }
    return out;
}

function pickFilter(filters, id) {
    if (!filters) return null;
    const v = filters[id];
    if (Array.isArray(v)) return v.length ? v[0] : null;
    return v || null;
}

function pickFilterAll(filters, id) {
    if (!filters) return [];
    const v = filters[id];
    if (Array.isArray(v)) return v.slice();
    return v ? [v] : [];
}

source.search = function(query, type, order, filters) {
    // Pasting a pmvhaven.com link into search resolves it to the exact item
    // (playlist, profile or video) instead of a fuzzy text match.
    const direct = trySearchDirectUrl(query);
    if (direct) return direct;
    if (type === Type.Feed.Channels) return source.searchChannels(query);
    if (type === Type.Feed.Playlists) return source.searchPlaylists(query);
    const extra = buildSearchFilterParams(order, filters);
    // The text-search endpoint (/api/videos/search) ignores minHeight/maxHeight,
    // so when a Quality filter is active we use the browse endpoint
    // (/api/videos) which honours every filter. Browse has no free-text param,
    // so the typed query is folded into the tag list (matches pmvhaven.com's
    // own tag-based /search page).
    if (extra.minHeight || extra.maxHeight) {
        const tagList = [];
        if (extra.tags) tagList.push(extra.tags);
        if (query && query.trim()) tagList.push(query.trim().toLowerCase());
        if (tagList.length) extra.tags = tagList.join(",");
        return new VideosApiPager("browse", extra);
    }
    return new VideosApiPager("search", Object.assign({ q: query }, extra));
};

source.searchChannels = function(query) {
    try {
        const data = jsonGETNoThrow(BASE_URL + "/api/users/search" + buildQuery({ q: query }));
        const users = (data && data.users) || [];
        const channels = users.map(u => new PlatformChannel({
            id: new PlatformID(PLATFORM, u.username, config.id, PLATFORM_CLAIMTYPE),
            name: u.displayName || u.username,
            thumbnail: u.avatarUrl || "",
            banner: "",
            subscribers: 0,
            description: "",
            url: channelUrlFromUsername(u.username),
            links: {}
        }));
        return new ChannelPager(channels, false);
    } catch (e) {
        log("searchChannels error: " + e);
        return new ChannelPager([], false);
    }
};

source.searchPlaylists = function(query) {
    return new PlaylistsApiPager(query);
};

// When the search box contains a pmvhaven.com URL, return the exact entity it
// points at as a single-result feed. Handles playlist, profile and video links
// (with or without the leading https://). Returns null for normal text queries.
function normalizePmvUrl(q) {
    q = (q || "").trim();
    if (/^https?:\/\//i.test(q)) return q;
    const i = q.toLowerCase().indexOf("pmvhaven.com");
    if (i < 0) return q;
    return "https://" + q.slice(i);
}

function trySearchDirectUrl(query) {
    if (!query || typeof query !== "string") return null;
    if (query.toLowerCase().indexOf("pmvhaven.com") < 0) return null;
    const url = normalizePmvUrl(query);
    try {
        // Playlist link -> the playlist card.
        if (/\/playlists?\//i.test(url)) {
            const plId = extractPlaylistIdFromUrl(url);
            if (plId) {
                const resp = jsonGETNoThrow(BASE_URL + "/api/playlists/" + plId);
                if (resp && resp.data) return new ContentPager([toPlatformPlaylist(resp.data)], false);
            }
        }
        // Video link -> the video card.
        if (source.isContentDetailsUrl(url)) {
            const vid = extractVideoIdFromUrl(url);
            if (vid) {
                const r = jsonGETNoThrow(BASE_URL + "/api/videos/" + vid);
                if (r && r.data) return new ContentPager([toPlatformVideo(r.data)], false);
            }
        }
        // Profile link -> the channel card.
        if (source.isChannelUrl(url)) {
            try { return new ContentPager([source.getChannel(url)], false); }
            catch (e) { /* fall through */ }
        }
    } catch (e) {
        log("trySearchDirectUrl error: " + e);
    }
    return null;
}

// ---------- channel ----------

source.isChannelUrl = function(url) {
    return /^https?:\/\/(?:www\.)?pmvhaven\.com\/profile\/[^\/\?#]+/.test(url);
};

source.getChannel = function(url) {
    const token = extractUsernameFromProfileUrl(url);
    if (!token) throw new ScriptException("Invalid channel URL: " + url);

    const userData = fetchUserByToken(token);
    if (!userData) {
        throw new ScriptException("Profile not found for " + token);
    }
    const userId = userData._id;

    let subCount = 0;
    try {
        const sc = jsonGETNoThrow(BASE_URL + "/api/users/" + userId + "/subscriber-count");
        if (sc && typeof sc.count === "number") subCount = sc.count;
    } catch (e) { /* ignore */ }

    return toPlatformChannel(userData, subCount);
};

source.getChannelCapabilities = function() {
    return {
        types: [Type.Feed.Videos],
        sorts: [Type.Order.Chronological],
        filters: []
    };
};

source.getChannelContents = function(url) {
    const token = extractUsernameFromProfileUrl(url);
    if (!token) return new ContentPager([], false);
    // Channel video listing keys off the username; resolve id-based profile
    // URLs (pmvhaven uses the user _id in profile links) to the username first.
    let username = token;
    if (isObjectId(token)) {
        const u = fetchUserByToken(token);
        username = u && u.username;
    }
    if (!username) return new ContentPager([], false);
    return new ChannelVideosPager(username);
};

source.getChannelVideos = function(url) {
    return source.getChannelContents(url);
};

// Grayjay shows a "Playlists" tab on the channel page when this optional hook
// is present. Lists every public playlist created by the profile's owner.
source.getChannelPlaylists = function(url) {
    const token = extractUsernameFromProfileUrl(url);
    if (!token) return new PlaylistPager([], false);
    return new ChannelPlaylistsPager(token);
};

// ---------- video ----------

source.isContentDetailsUrl = function(url) {
    return /^https?:\/\/(?:www\.)?pmvhaven\.com\/video\//.test(url);
};

source.getContentDetails = function(url) {
    const id = extractVideoIdFromUrl(url);
    if (!id) throw new ScriptException("Could not extract video id from " + url);

    const resp = jsonGETNoThrow(BASE_URL + "/api/videos/" + id);
    if (!resp || !resp.data) throw new ScriptException("Video not found: " + id);
    const v = resp.data;

    const sources = [];
    if (v.hlsEnabled && v.hlsMasterPlaylistUrl) {
        sources.push(new HLSSource({
            name: "HLS",
            duration: v.durationSeconds || parseDuration(v.duration),
            url: v.hlsMasterPlaylistUrl
        }));
    }
    if (v.videoUrl) {
        sources.push(new VideoUrlSource({
            container: v.contentType || "video/mp4",
            name: (v.width && v.height) ? (v.height + "p") : "mp4",
            width: v.width || 0,
            height: v.height || 0,
            url: v.videoUrl,
            duration: v.durationSeconds || parseDuration(v.duration)
        }));
    }

    const details = new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, id, config.id),
        name: v.title || "Untitled",
        thumbnails: v.thumbnailUrl ? new Thumbnails([new Thumbnail(v.thumbnailUrl, 720)]) : new Thumbnails([]),
        author: createAuthor(v.uploader, v.uploaderUsername, v.uploaderAvatarUrl),
        datetime: parseDateSeconds(v.uploadDate || v.createdAt),
        duration: v.durationSeconds || parseDuration(v.duration),
        viewCount: v.views || 0,
        url: url,
        isLive: false,
        description: v.description || "",
        video: new VideoSourceDescriptor(sources),
        rating: new RatingLikesDislikes(v.likes || 0, v.dislikes || 0)
    });
    if (typeof v.watchProgress === "number" && v.watchProgress > 0) {
        try { details.playbackTime = Math.floor(v.watchProgress); } catch (e) { /* ignore */ }
    }
    // Grayjay reads recommended videos from a method on the details object
    // itself (see uarasio/SB-GJ for the same pattern). Without this hook the
    // "More videos" rail under a video stays empty even if
    // source.getContentRecommendations is defined.
    details.getContentRecommendations = function() {
        return source.getContentRecommendations(url, details);
    };
    return details;
};

// ---------- actions (subscribe / like / dislike / watch-progress push) ----------

source.actionSubscribe = function(channelUrl, subscribe) {
    try {
        const token = extractUsernameFromProfileUrl(channelUrl);
        if (!token) return false;
        const userData = fetchUserByToken(token);
        const userId = userData && userData._id;
        if (!userId) return false;
        const r = jsonRequest("PUT", BASE_URL + "/api/users/" + userId + "/subscribe",
            { action: subscribe === false ? "unsubscribe" : "subscribe" }, true);
        return !!r;
    } catch (e) { log("actionSubscribe error: " + e); return false; }
};

source.actionLike = function(videoUrl, like) {
    const id = extractVideoIdFromUrl(videoUrl);
    if (!id) return false;
    const r = jsonRequest("PUT", BASE_URL + "/api/videos/" + id + "/like",
        { action: like === false ? "unlike" : "like" }, true);
    return !!r;
};

source.actionDislike = function(videoUrl, dislike) {
    const id = extractVideoIdFromUrl(videoUrl);
    if (!id) return false;
    const r = jsonRequest("PUT", BASE_URL + "/api/videos/" + id + "/dislike",
        { action: dislike === false ? "undislike" : "dislike" }, true);
    return !!r;
};

// Push local playback progress back to the server (called by Grayjay when the
// user pauses / leaves a video, if Grayjay reflects the hook).
source.savePlaybackState = function(url, watchTimeSeconds) {
    try {
        if (!source.isLoggedIn()) return false;
        const id = extractVideoIdFromUrl(url);
        if (!id) return false;
        const progress = Math.max(0, Math.round(Number(watchTimeSeconds) || 0));
        const r = jsonRequest("PUT", BASE_URL + "/api/users/watch-progress",
            { videoId: id, progress: progress }, true);
        return !!r;
    } catch (e) { log("savePlaybackState error: " + e); return false; }
};
// Alias for compatibility with possible Grayjay hook names.
source.actionWatchProgress = source.savePlaybackState;

source.getContentRecommendations = function(url, initialData) {
    const id = extractVideoIdFromUrl(url);
    if (!id) return new ContentPager([], false);
    try {
        const data = jsonGETNoThrow(BASE_URL + "/api/videos/" + id + "/recommendations-es?limit=20");
        const list = (data && (data.videos || data.data)) || [];
        const vids = list.map(toPlatformVideo);
        return new ContentPager(vids, false);
    } catch (e) {
        log("recommendations error: " + e);
        return new ContentPager([], false);
    }
};

// ---------- comments ----------

source.getComments = function(url) {
    const id = extractVideoIdFromUrl(url);
    if (!id) return new CommentPager([], false);
    return new VideoCommentPager(url, id, 1);
};

source.getSubComments = function(comment) {
    if (!comment || !comment.context) return new CommentPager([], false);
    const replies = comment.context.replies || [];
    return new CommentPager(
        replies.map(r => buildComment(r, comment.context.videoUrl, comment.context.videoId, null)),
        false
    );
};

function buildComment(c, videoUrl, videoId, parentForReplies) {
    const author = c.username
        ? new PlatformAuthorLink(
            new PlatformID(PLATFORM, c.username, config.id),
            c.username,
            channelUrlFromUsername(c.username),
            c.avatarUrl || ""
          )
        : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");
    const replyCount = Array.isArray(c.replies) ? c.replies.length : 0;
    return new Comment({
        contextUrl: videoUrl,
        author: author,
        message: c.text || "",
        rating: new RatingLikesDislikes(c.likes || 0, c.dislikes || 0),
        date: parseDateSeconds(c.createdAt),
        replyCount: replyCount,
        context: {
            videoUrl: videoUrl,
            videoId: videoId,
            replies: c.replies || []
        }
    });
}

// ---------- playlist ----------

// Virtual playlist URLs for the logged-in user's personal lists. They map
// 1:1 to dedicated API endpoints (favorites / watch-later) and are exposed
// alongside real playlists so Grayjay's "Import Playlists" picks them up.
const VPL_FAVORITES   = BASE_URL + "/user/favorites";
const VPL_WATCH_LATER = BASE_URL + "/user/watch-later";

function isVirtualPlaylistUrl(url) {
    return url === VPL_FAVORITES || url === VPL_WATCH_LATER;
}

function fetchVirtualPlaylist(kind) {
    // kind: "favorites" | "watch-later"
    // Pages through the full list and returns a {name, videos[]} payload.
    const out = [];
    let page = 1;
    const limit = 50;
    while (page <= 20) { // safety cap (1000 videos max per virtual list)
        const endpoint = (kind === "favorites")
            ? "/api/user/favorites" + buildQuery({ page: page, limit: limit, sortBy: "added", sortOrder: "desc" })
            : "/api/user/watch-later" + buildQuery({ page: page, limit: limit });
        const resp = jsonGETNoThrow(BASE_URL + endpoint, true);
        if (!resp) break;
        const items = resp.favorites || resp.videos || resp.data || [];
        if (!Array.isArray(items) || items.length === 0) break;
        for (let i = 0; i < items.length; i++) out.push(items[i]);
        const pag = resp.pagination || {};
        if (items.length < limit) break;
        if (typeof pag.totalPages === "number" && page >= pag.totalPages) break;
        page++;
    }
    return {
        name: (kind === "favorites") ? "Favorites" : "Watch Later",
        videos: out
    };
}

source.isPlaylistUrl = function(url) {
    if (isVirtualPlaylistUrl(url)) return true;
    return /^https?:\/\/(?:www\.)?pmvhaven\.com\/playlists\/[a-f0-9]{24}/i.test(url);
};

source.getPlaylist = function(url) {
    // Virtual playlists (favorites / watch-later) are session-scoped lists
    // populated from dedicated endpoints.
    if (isVirtualPlaylistUrl(url)) {
        if (!source.isLoggedIn()) throw new ScriptException("Login required for " + url);
        const kind = (url === VPL_FAVORITES) ? "favorites" : "watch-later";
        const pl = fetchVirtualPlaylist(kind);
        const author = state.username
            ? new PlatformAuthorLink(
                new PlatformID(PLATFORM, state.username, config.id),
                state.username,
                channelUrlFromUsername(state.username),
                ""
              )
            : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");
        const videos = pl.videos.map(toPlatformVideo);
        return new PlatformPlaylistDetails({
            id: new PlatformID(PLATFORM, kind, config.id),
            name: pl.name,
            thumbnail: videos.length && videos[0] ? "" : "",
            author: author,
            datetime: Math.floor(Date.now() / 1000),
            url: url,
            videoCount: videos.length,
            contents: new VideoPager(videos, false)
        });
    }

    const id = extractPlaylistIdFromUrl(url);
    if (!id) throw new ScriptException("Invalid playlist URL: " + url);
    const resp = jsonGETNoThrow(BASE_URL + "/api/playlists/" + id);
    if (!resp || !resp.data) throw new ScriptException("Playlist not found: " + id);
    const p = resp.data;
    const ownerName = p.ownerUsername || p.owner || "";
    const author = ownerName
        ? new PlatformAuthorLink(
            new PlatformID(PLATFORM, ownerName, config.id),
            ownerName,
            channelUrlFromUsername(ownerName),
            p.ownerAvatarUrl || ""
          )
        : new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");

    const details = (p.videoDetails || []).map(toPlatformVideo);

    return new PlatformPlaylistDetails({
        id: new PlatformID(PLATFORM, id, config.id),
        name: p.name || "Playlist",
        thumbnail: p.thumbnail || (details.length ? "" : ""),
        author: author,
        datetime: parseDateSeconds(p.createdAt),
        url: url,
        videoCount: details.length,
        contents: new VideoPager(details, false)
    });
};

// ---------- subscription/playlist migration ----------

source.getUserSubscriptions = function() {
    // Returns list of channel URLs the logged-in user is subscribed to.
    // PMVHaven returns at most `limit` per page; iterate until exhausted so
    // big subscription lists migrate fully into Grayjay.
    try {
        if (!source.isLoggedIn()) {
            log("getUserSubscriptions: not logged in");
            return [];
        }
        if (!state.userId) { fetchUserInfo(); }
        if (!state.userId) return [];

        const seen = {};
        const out = [];
        let page = 1;
        const limit = 100;
        while (page <= 50) { // safety cap
            const resp = jsonGETNoThrow(
                BASE_URL + "/api/users/" + state.userId + "/subscriptions" +
                buildQuery({ page: page, limit: limit }), true);
            if (!resp || resp.success === false) break;
            const list = resp.data || [];
            if (!Array.isArray(list) || list.length === 0) break;
            for (let i = 0; i < list.length; i++) {
                const u = list[i];
                if (!u || !u.username || seen[u.username]) continue;
                seen[u.username] = true;
                out.push(channelUrlFromUsername(u.username));
            }
            const pag = resp.pagination || {};
            if (list.length < limit) break;
            if (pag.hasMore === false) break;
            if (typeof pag.totalPages === "number" && page >= pag.totalPages) break;
            page++;
        }
        log("getUserSubscriptions: returning " + out.length + " channel(s)");
        return out;
    } catch (e) {
        log("getUserSubscriptions error: " + e);
        return [];
    }
};

source.getUserPlaylists = function() {
    // Returns list of playlist URLs owned by the logged-in user, plus the
    // virtual Favorites and Watch Later playlists so Grayjay's "Import
    // Playlists" picks all three up in one go.
    try {
        if (!source.isLoggedIn()) {
            log("getUserPlaylists: not logged in");
            return [];
        }
        if (!state.userId) { fetchUserInfo(); }

        const out = [];

        // Real, user-created playlists (paginate to be safe).
        if (state.userId) {
            const seen = {};
            let page = 1;
            const limit = 100;
            while (page <= 20) {
                const resp = jsonGETNoThrow(BASE_URL + "/api/playlists" + buildQuery({
                    owner: state.userId,
                    page: page,
                    limit: limit,
                    sort: "-createdAt"
                }), true);
                if (!resp || resp.success === false) break;
                const list = resp.data || [];
                if (!Array.isArray(list) || list.length === 0) break;
                for (let i = 0; i < list.length; i++) {
                    const pl = list[i];
                    if (!pl || !pl._id || seen[pl._id]) continue;
                    seen[pl._id] = true;
                    out.push(playlistUrlFromId(pl._id));
                }
                const meta = resp.meta || {};
                if (list.length < limit) break;
                if (meta.hasMore === false) break;
                if (typeof meta.totalPages === "number" && page >= meta.totalPages) break;
                page++;
            }
        }

        // Virtual session-scoped lists (always available when logged in).
        out.push(VPL_FAVORITES);
        out.push(VPL_WATCH_LATER);

        log("getUserPlaylists: returning " + out.length + " playlist(s) (incl. Favorites + Watch Later)");
        return out;
    } catch (e) {
        log("getUserPlaylists error: " + e);
        return [];
    }
};

// ---------- remote watch history ----------

// Grayjay (Android & Desktop) detects "Sync Remote History" support ONLY by the
// presence of `source.getUserHistory` (JSClient.kt -> `!!source.getUserHistory`).
// When the user enables the built-in "Sync > Sync Remote History" toggle, Grayjay
// calls `source.getUserHistory()` on startup (StateHistory.syncRemoteHistory).
// `source.syncRemoteWatchHistory` and `source.getCapabilities` are NOT used for
// this, so defining getUserHistory is what makes the Sync tab appear AND import.
source.getUserHistory = function() {
    return source.syncRemoteWatchHistory(null);
};

source.syncRemoteWatchHistory = function(continuationToken) {
    // IMPORTANT: Grayjay's startup sync only consumes the first page returned
    // by this function (its pager loop has a hard cap). To import the entire
    // history we paginate through PMVHaven internally and return everything
    // in a single VideoPager with hasMore=false. Same approach as SB-GJ.
    try {
        log("===== syncRemoteWatchHistory START =====");
        if (!source.isLoggedIn()) {
            log("syncRemoteWatchHistory: not logged in, skipping");
            return new VideoPager([], false, { token: null });
        }

        const MAX_PAGES = 100;
        const PAGE_LIMIT = 48;
        let allItems = [];
        let usedPrimary = true;

        // Primary endpoint: /api/user/history returns hydrated video objects
        // with watchedAt + watchProgress in one shot.
        for (let page = 1; page <= MAX_PAGES; page++) {
            const resp = jsonGETNoThrow(BASE_URL + "/api/user/history" + buildQuery({
                page: page, limit: PAGE_LIMIT, filter: "all", _t: Date.now()
            }), true);

            if (!resp) {
                if (page === 1) { usedPrimary = false; break; }
                log("syncRemoteWatchHistory: /history page " + page + " failed, stopping pagination");
                break;
            }
            if (resp.success === false || !Array.isArray(resp.history)) {
                if (page === 1) { usedPrimary = false; break; }
                break;
            }
            const items = resp.history;
            log("syncRemoteWatchHistory: /history page " + page + " -> " + items.length + " items");
            if (items.length === 0) break;
            allItems = allItems.concat(items);

            const pag = resp.pagination || {};
            if (typeof pag.totalPages === "number" && page >= pag.totalPages) break;
            if (items.length < PAGE_LIMIT) break;
        }

        // Fallback: /api/user/watched-video-ids -> hydrate per id.
        if (!usedPrimary) {
            log("syncRemoteWatchHistory: /history unavailable, falling back to /watched-video-ids");
            for (let page = 1; page <= MAX_PAGES; page++) {
                const resp = jsonGETNoThrow(BASE_URL + "/api/user/watched-video-ids" + buildQuery({
                    page: page, limit: PAGE_LIMIT
                }), true);
                if (!resp) break;
                let entries = resp.data || resp.videoIds || resp.watched || [];
                if (!Array.isArray(entries) || entries.length === 0) break;
                for (let i = 0; i < entries.length; i++) {
                    const e = entries[i];
                    const videoId = typeof e === "string" ? e : (e && (e.videoId || e._id || e.id));
                    if (!videoId) continue;
                    const watchedAt = (e && e.watchedAt) || null;
                    const vd = jsonGETNoThrow(BASE_URL + "/api/videos/" + videoId);
                    if (!vd || !vd.data) continue;
                    const v = vd.data;
                    if (watchedAt && !v.watchedAt) v.watchedAt = watchedAt;
                    allItems.push(v);
                }
                if (entries.length < PAGE_LIMIT) break;
            }
        }

        if (allItems.length === 0) {
            log("syncRemoteWatchHistory: no history found");
            return new VideoPager([], false, { token: null });
        }

        // Build PlatformVideo objects with playbackDate / playbackTime set IN the
        // constructor (Grayjay ignores them otherwise — see createHistoryPlatformVideo).
        const out = [];
        for (let i = 0; i < allItems.length; i++) {
            const v = allItems[i];
            if (!v || !v._id) continue;
            const watchedSeconds = parseDateSeconds(v.watchedAt || v.lastWatchedAt);
            out.push(createHistoryPlatformVideo(v, watchedSeconds, i));
        }

        log("syncRemoteWatchHistory: returning " + out.length + " total history items");
        log("===== syncRemoteWatchHistory END =====");
        return new VideoPager(out, false, { token: null });
    } catch (e) {
        log("syncRemoteWatchHistory: exception " + e);
        return new VideoPager([], false, { token: null });
    }
};

// ---------- pagers ----------

class VideosApiPager extends ContentPager {
    constructor(kind, payload) {
        super([], true);
        this.kind = kind; // "browse", "search" or "trending"
        this.payload = payload || {};
        this.page = 0;
        this.seen = {};
        this.nextPage();
    }
    nextPage() {
        this.page++;
        // PMVHaven's API paginates with `page` (the previous `index` param was
        // silently ignored, which is why feeds repeated the same results). The
        // browse feed lives at /api/videos, search/trending have sub-paths.
        const path = (this.kind === "browse") ? "/api/videos" : ("/api/videos/" + this.kind);
        const url = BASE_URL + path + buildQuery(
            Object.assign({}, this.payload, { page: this.page, limit: 50 })
        );
        const data = jsonGETNoThrow(url);
        if (!data || data.success === false) { this.hasMore = false; this.results = []; return this; }
        const list = data.videos || data.data || [];
        // De-duplicate across pages so already-seen videos never reappear.
        const fresh = [];
        for (let i = 0; i < list.length; i++) {
            const v = list[i];
            const id = v && (v._id || v.id);
            if (!id || this.seen[id]) continue;
            this.seen[id] = true;
            fresh.push(toPlatformVideo(v));
        }
        this.results = fresh;
        const pag = data.pagination || {};
        if (typeof pag.hasNext === "boolean") this.hasMore = pag.hasNext;
        else this.hasMore = list.length >= 50;
        return this;
    }
}

class ChannelVideosPager extends ContentPager {
    constructor(username) {
        super([], true);
        this.username = username;
        this.page = 0;
        this.nextPage();
    }
    nextPage() {
        this.page++;
        const url = BASE_URL + "/api/videos" + buildQuery({
            uploader: this.username,
            page: this.page,
            limit: 50
        });
        const data = jsonGETNoThrow(url);
        if (!data) { this.hasMore = false; this.results = []; return this; }
        const list = data.videos || data.data || [];
        this.results = list.map(toPlatformVideo);
        const pagination = data.pagination || {};
        this.hasMore = pagination.hasNext === true || this.results.length >= 50;
        return this;
    }
}

class PlaylistsApiPager extends PlaylistPager {
    constructor(query) {
        super([], true);
        this.query = query;
        this.page = 0;
        this.seen = {};
        this.nextPage();
    }
    nextPage() {
        this.page++;
        // Use `page` (not the ignored `index`) so playlist search actually
        // advances instead of returning page 1 over and over.
        const url = BASE_URL + "/api/playlists/search" + buildQuery({
            q: this.query, page: this.page, limit: 20
        });
        const data = jsonGETNoThrow(url);
        const list = (data && data.data) || [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || !p._id || this.seen[p._id]) continue;
            this.seen[p._id] = true;
            out.push(toPlatformPlaylist(p));
        }
        this.results = out;
        const meta = (data && data.meta) || {};
        if (typeof meta.hasMore === "boolean") this.hasMore = meta.hasMore;
        else this.hasMore = list.length >= 20;
        return this;
    }
}

// Lists the playlists created by a single profile owner. `owner` may be a
// username or a 24-char user id — pmvhaven's /api/playlists?owner= accepts both.
class ChannelPlaylistsPager extends PlaylistPager {
    constructor(owner) {
        super([], true);
        this.owner = owner;
        this.page = 0;
        this.seen = {};
        this.nextPage();
    }
    nextPage() {
        this.page++;
        const url = BASE_URL + "/api/playlists" + buildQuery({
            owner: this.owner, page: this.page, limit: 30, sort: "-createdAt"
        });
        const data = jsonGETNoThrow(url);
        const list = (data && data.data) || [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            if (!p || !p._id || this.seen[p._id]) continue;
            // The unauthenticated owner endpoint also returns private playlists;
            // only surface public ones on a profile's Playlists tab.
            if (p.isPublic === false) continue;
            this.seen[p._id] = true;
            out.push(toPlatformPlaylist(p));
        }
        this.results = out;
        const meta = (data && data.meta) || {};
        if (typeof meta.hasMore === "boolean") this.hasMore = meta.hasMore;
        else this.hasMore = list.length >= 30;
        return this;
    }
}

class VideoCommentPager extends CommentPager {
    constructor(videoUrl, videoId, page) {
        super([], true);
        this.videoUrl = videoUrl;
        this.videoId = videoId;
        this.page = page || 1;
        this._loadPage();
    }
    _loadPage() {
        const url = BASE_URL + "/api/videos/" + this.videoId + "/comments" + buildQuery({
            index: this.page, limit: 50
        });
        const data = jsonGETNoThrow(url);
        const list = (data && data.data) || [];
        const filtered = list.filter(c => !c.shadowBanned);
        this.results = filtered.map(c => buildComment(c, this.videoUrl, this.videoId, null));
        // Honour real pagination metadata when the API returns it
        const p = data && data.pagination;
        if (p && typeof p.hasNext === "boolean") this.hasMore = p.hasNext;
        else if (p && typeof p.totalPages === "number") this.hasMore = this.page < p.totalPages;
        else this.hasMore = filtered.length >= 50;
    }
    nextPage() {
        this.page++;
        this._loadPage();
        return this;
    }
}

log("PMVHaven plugin loaded");
