const URL_BASE = "https://www.pornhub.com";

const PLATFORM_CLAIMTYPE = 3;

const PLATFORM = "PornHub";

var config = {};
var state = {
	token: "",
	sessionCookie: "",
	// Auth state populated by the login flow / isLoggedIn().
	isAuthenticated: false,
	username: "",
	userId: ""
};
var pluginSettings = {
	syncRemoteHistory: true
};

// headers (including cookie by default, since it's used for each session later)
var headers = {
	"Cookie": "platform=pc; accessAgeDisclaimerPH=2",
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
	"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.5",
	"Cache-Control": "no-cache",
	"Upgrade-Insecure-Requests": "1"
};

// Auth cookies that indicate a successfully logged-in pornhub session. `il`
// is set as part of the persistent login token, `phn` is the persistent
// username hash. Presence of either is treated as logged-in; the session is
// re-verified against /front_page to fetch the actual username.
const AUTH_COOKIE_NAMES = ["il", "phn"];

/**
 * Build a query
 * @param {{[key: string]: any}} params Query params
 * @returns {String} Query string
 */
function buildQuery(params) {
	let query = "";
	let first = true;
	for (const [key, value] of Object.entries(params)) {
		if (value) {
			if (first) {
				first = false;
			} else {
				query += "&";
			}

			query += `${key}=${value}`;
		}
	}

	return (query && query.length > 0) ? `?${query}` : ""; 
}


//Source Methods
source.enable = function (conf, settings, savedStateStr) {
	config = conf ?? {};

	if (settings && typeof settings.syncRemoteHistory !== "undefined") {
		const v = settings.syncRemoteHistory;
		pluginSettings.syncRemoteHistory = (v === true) || (typeof v === "string" && v.toLowerCase() === "true");
	}

	if (savedStateStr) {
		try {
			const s = JSON.parse(savedStateStr);
			state.token = s.token || "";
			state.sessionCookie = s.sessionCookie || "";
			state.isAuthenticated = !!s.isAuthenticated;
			state.username = s.username || "";
			state.userId = s.userId || "";
			log("State loaded: token=" + (state.token ? "present" : "empty") + " auth=" + state.isAuthenticated);
		} catch (e) {
			log("Failed to parse saved state: " + e);
		}
	}

	// If Grayjay tells us the user is logged in (via its built-in bridge), trust it.
	try {
		if (typeof bridge !== "undefined" && bridge && typeof bridge.isLoggedIn === "function" && bridge.isLoggedIn()) {
			state.isAuthenticated = true;
		}
	} catch (e) { /* ignore */ }
};

source.disable = function () {
	state.isAuthenticated = false;
	state.username = "";
	state.userId = "";
};

source.setSettings = function (newsettings) {
	if (!newsettings) return;
	if (typeof newsettings.syncRemoteHistory !== "undefined") {
		const v = newsettings.syncRemoteHistory;
		pluginSettings.syncRemoteHistory = (v === true) || (typeof v === "string" && v.toLowerCase() === "true");
	}
};

source.saveState = function() {
	return JSON.stringify({
		token: state.token,
		sessionCookie: state.sessionCookie,
		isAuthenticated: state.isAuthenticated,
		username: state.username,
		userId: state.userId
	});
};

source.getCapabilities = function () {
	// Kept for completeness; Grayjay detects history sync support purely by
	// the presence of source.getUserHistory below.
	return {
		hasSyncRemoteWatchHistory: pluginSettings.syncRemoteHistory
	};
};

source.getHome = function () {
	return getVideoPager('/video', {}, 1);
};



source.searchSuggestions = function(query) {
	if(query.length < 1) return [];

	try {
		// Build autocomplete API URL
		var apiUrl = URL_BASE + "/api/v1/video/search_autocomplete?pornstars=true&token=" + state.token + "&orientation=straight&q=" + encodeURIComponent(query) + "&alt=0";
		log("Fetching autocomplete: " + apiUrl);

		// Use httpGET with options object
		var json = httpGET(apiUrl, {
			headers: {
				"Cookie": headers["Cookie"],
				"User-Agent": headers["User-Agent"],
				"Accept": "*/*",
				"Accept-Language": "en-US,en;q=0.5",
				"Referer": URL_BASE + "/",
				"X-Requested-With": "XMLHttpRequest",
				"Content-Type": "application/x-www-form-urlencoded"
			},
			requireToken: true,
			parseJson: true,
			retries: 3
		});

		if (!json || json.length === 0) {
			log("Empty autocomplete JSON");
			return [];
		}

		var suggestions = [];

		// Add query suggestions
		if (json.queries && Array.isArray(json.queries)) {
			suggestions = suggestions.concat(json.queries);
		}

		// Add model names (prefixed with @)
		if (json.models && Array.isArray(json.models)) {
			json.models.forEach(function(model) {
				suggestions.push("@" + model.name);
			});
		}

		// Add pornstar names (prefixed with @)
		if (json.pornstars && Array.isArray(json.pornstars)) {
			json.pornstars.forEach(function(pornstar) {
				suggestions.push("@" + pornstar.name);
			});
		}

		// Add channel names (prefixed with #)
		if (json.channels && Array.isArray(json.channels)) {
			json.channels.forEach(function(channel) {
				suggestions.push("#" + channel.name);
			});
		}

		log("Autocomplete returned " + suggestions.length + " total suggestions");
		return suggestions;
	} catch(e) {
		log("Search suggestions failed: " + e);
		return [];
	}
};

// ---------- search constants ----------

const SORT_OPTIONS = ["Relevance", "Most Recent", "Most Viewed", "Top Rated", "Longest"];
const SORT_MAP = {
	"Relevance":    "",
	"Most Recent":  "mr",
	"Most Viewed":  "mv",
	"Top Rated":    "tr",
	"Longest":      "lg"
};
// `period=` filter values used by pornhub's /video/search endpoint.
const DATE_MAP = {
	"today":  "t",
	"week":   "w",
	"month":  "m",
	"year":   "y",
	"all":    "a"
};
// Duration filter: `min_duration` / `max_duration` in minutes.
const DURATION_MAP = {
	"short":  { min_duration: 0,  max_duration: 10 },
	"medium": { min_duration: 10, max_duration: 20 },
	"long":   { min_duration: 20, max_duration: 30 },
	"vlong":  { min_duration: 30 }
};
// Production filter -> `p=` query parameter
const PRODUCTION_MAP = {
	"professional": "professional",
	"homemade":     "homemade"
};

// Popular pornhub category IDs (used by `cat=` query parameter on /video/search).
// Mirrors the way HV-GJ exposes a multi-select "Category" filter.
const CATEGORY_FILTERS = [
	{ name: "Any",           value: ""   },
	{ name: "Amateur",       value: "3"  },
	{ name: "Anal",          value: "35" },
	{ name: "Asian",         value: "1"  },
	{ name: "Babe",          value: "4"  },
	{ name: "Big Ass",       value: "6"  },
	{ name: "Big Tits",      value: "7"  },
	{ name: "Blonde",        value: "9"  },
	{ name: "Blowjob",       value: "13" },
	{ name: "Brunette",      value: "10" },
	{ name: "Cartoon",       value: "57" },
	{ name: "Cosplay",       value: "115"},
	{ name: "Creampie",      value: "15" },
	{ name: "Cumshot",       value: "16" },
	{ name: "Ebony",         value: "2"  },
	{ name: "Fetish",        value: "20" },
	{ name: "Gangbang",      value: "55" },
	{ name: "Hardcore",      value: "27" },
	{ name: "Hentai",        value: "60" },
	{ name: "Interracial",   value: "29" },
	{ name: "Japanese",      value: "111"},
	{ name: "Latina",        value: "30" },
	{ name: "Lesbian",       value: "31" },
	{ name: "MILF",          value: "33" },
	{ name: "Pornstar",      value: "37" },
	{ name: "POV",           value: "41" },
	{ name: "Public",        value: "42" },
	{ name: "Reality",       value: "5"  },
	{ name: "Red Head",      value: "21" },
	{ name: "Rough Sex",     value: "94" },
	{ name: "Squirt",        value: "67" },
	{ name: "Teen (18+)",    value: "14" },
	{ name: "Threesome",     value: "53" },
	{ name: "Toys",          value: "23" },
	{ name: "Verified Amateurs", value: "139" },
	{ name: "Vintage",       value: "61" },
	{ name: "Webcam",        value: "26" }
];

source.getSearchCapabilities = () => {
	return {
		// Only video feed types here so Grayjay shows the filter/sort UI on the
		// Videos tab. Channels/Playlists searches happen via dedicated entry
		// points (searchChannels / searchPlaylists).
		types: [Type.Feed.Mixed, Type.Feed.Videos],
		sorts: SORT_OPTIONS,
		filters: [
			{
				id: "date",
				name: "Date",
				isMultiSelect: false,
				filters: [
					{ name: "Any time",     value: ""      },
					{ name: "Today",        value: "today" },
					{ name: "This week",    value: "week"  },
					{ name: "This month",   value: "month" },
					{ name: "This year",    value: "year"  }
				]
			},
			{
				id: "duration",
				name: "Duration",
				isMultiSelect: false,
				filters: [
					{ name: "Any",          value: ""        },
					{ name: "0-10 min",     value: "short"   },
					{ name: "10-20 min",    value: "medium"  },
					{ name: "20-30 min",    value: "long"    },
					{ name: "30+ min",      value: "vlong"   }
				]
			},
			{
				id: "quality",
				name: "Quality",
				isMultiSelect: false,
				filters: [
					{ name: "Any",          value: ""   },
					{ name: "HD",           value: "hd" }
				]
			},
			{
				id: "production",
				name: "Production",
				isMultiSelect: false,
				filters: [
					{ name: "Any",          value: ""             },
					{ name: "Professional", value: "professional" },
					{ name: "Homemade",     value: "homemade"     }
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

function _pickFilter(filters, id) {
	if (!filters) return null;
	const v = filters[id];
	if (Array.isArray(v)) return v.length ? v[0] : null;
	return v || null;
}

function buildSearchFilterParams(order, filters) {
	const out = {};
	if (order && SORT_MAP[order] !== undefined && SORT_MAP[order] !== "") {
		out.o = SORT_MAP[order];
	}
	if (filters && typeof filters === "object") {
		const date = _pickFilter(filters, "date");
		if (date && DATE_MAP[date]) out.period = DATE_MAP[date];
		const dur = _pickFilter(filters, "duration");
		if (dur && DURATION_MAP[dur]) Object.assign(out, DURATION_MAP[dur]);
		const q = _pickFilter(filters, "quality");
		if (q === "hd") out.hd = 1;
		const prod = _pickFilter(filters, "production");
		if (prod && PRODUCTION_MAP[prod]) out.p = PRODUCTION_MAP[prod];
		const cat = _pickFilter(filters, "category");
		if (cat) out.cat = cat;
	}
	return out;
}

source.search = function (query, type, order, filters) {
	// Route by feed type. Channels & Playlists have dedicated entry points.
	if (type === Type.Feed.Channels) return source.searchChannels(query);
	if (type === Type.Feed.Playlists) return source.searchPlaylists(query);

	const extra = buildSearchFilterParams(order, filters);
	const params = Object.assign({ search: query }, extra);
	return getVideoPager("/video/search", params, 1);
};

source.getSearchChannelContentsCapabilities = function () {
	return {
		types: [Type.Feed.Mixed],
		sorts: [Type.Order.Chronological],
		filters: []
	};
};

source.searchChannelContents = function (channelUrl, query, type, order, filters) {
	throw new ScriptException("This is a sample");
};

source.searchChannels = function (query) {
	return getAutocompleteChannelPager(query);
};


source.isChannelUrl = function (url) {
	return url.includes(".pornhub.com/model/") || url.includes(".pornhub.com/channels/") || url.includes(".pornhub.com/pornstar/");
};

source.getChannel = function (url) {
	if (!url.startsWith("htt")) {
		url = URL_BASE + url;
	}

	// Normalize the URL to remove country-specific subdomains
	url = normalizePornhubUrl(url);

	var channelUrlName = url.split("/")[4]

	var info;
	if(url.includes("/channels/")) {
		info = getChannelInfo(url);
	} else {
		info = getPornstarInfo(url);
	}

    return new PlatformChannel({
        id: new PlatformID(PLATFORM, channelUrlName, config.id, PLATFORM_CLAIMTYPE),
        name: info.channelName,
        thumbnail: info.channelThumbnail,
        banner: info.channelBanner,
        subscribers: info.channelSubscribers,
        description: info.channelDescription,
        url: info.channelUrl,
        links: info.channelLinks
    })
}



source.getChannelContents = function (url, type, order, filters) {
	// Normalize the URL to remove country-specific subdomains
	url = normalizePornhubUrl(url);

	// channels have different format than model/pornstar
	if(url.includes("/channels/")) {
		return getChannelVideosPager(url + "/videos", {}, 1);
	} else if(url.includes("/model/")){
		return getModelVideosPager(url + "/videos", {}, 1);
	} else {
		return getPornstarVideosPager(url + "/videos/upload", {}, 1);
	}
};


source.isContentDetailsUrl = function(url) {
	return url.includes(".pornhub.com/view_video.php?viewkey=") || url.includes("/view_video.php?viewkey=");
};

const supportedResolutions = {
	'1080': { width: 1920, height: 1080 },
	'720': { width: 1280, height: 720 },
	'480': { width: 854, height: 480 },
	'360': { width: 640, height: 360 },
	'240': { width: 352, height: 240 },
	'144': { width: 256, height: 144 }
};



source.getContentDetails = function (url) {
	var html = httpGET(url, {});

	let flashvarsMatch = html.match(/var\s+flashvars_\d+\s*=\s*({.+?});/);

	let flashvars = {};
	if (flashvarsMatch) {
		flashvars = JSON.parse(flashvarsMatch[1]);
	}

	var mediaDefinitions = flashvars["mediaDefinitions"];
	var sources = [];

	for (const mediaDefinition of mediaDefinitions) {
		if (typeof mediaDefinition.defaultQuality !== "boolean") continue;
		if (typeof mediaDefinition.quality === "object") continue;
		var resolution = supportedResolutions[mediaDefinition.quality];
		if (!resolution) continue;
		sources.push(new HLSSource({
			name: `${resolution.width}x${resolution.height}`,
			url: mediaDefinition.videoUrl,
			duration: flashvars.video_duration ?? 0,
			priority: true,
			requestModifier: { headers: { "Referer": URL_BASE + "/" } }
		}));
	}

	var dom = domParser.parseFromString(html);

	var ldJson = JSON.parse(dom.querySelector('script[type="application/ld+json"]').text)

	var description = ldJson.description;

	var userAvatar = dom.getElementsByClassName("userAvatar")[0].querySelector("img").getAttribute("src")

	var userInfoNode = dom.getElementsByClassName("userInfo")[0];

	var channelUrlId = userInfoNode.querySelector("div.usernameWrap a").getAttribute("href").split('/').pop();

	var subscribersStr = "0";
	var infoSpans = userInfoNode.querySelectorAll("span");
	for (var i = 0; i < infoSpans.length; i++) {
		var spanText = infoSpans[i].textContent.trim();
		if (spanText.includes("Subscriber")) {
			subscribersStr = spanText;
			break;
		}
	}
	var subscribers = parseStringWithKorMSuffixes(subscribersStr);
	var displayName = userInfoNode.querySelector("a").text;
	var channelUrl = URL_BASE + userInfoNode.querySelector("a").getAttribute("href");


	var views = parseInt(ldJson.interactionStatistic[0].userInteractionCount.replace(/,/g, ""))

	var videoId = flashvars.playbackTracking.video_id.toString();

	// note: subtitles are in https://www.pornhub.com/video/caption?id={videoId}&language_id=1&caption_type=0 if present

	const details = new PlatformVideoDetails({
		id: new PlatformID(PLATFORM, videoId, config.id),
		name: flashvars.video_title,
		thumbnails: new Thumbnails([new Thumbnail(flashvars.image_url, 0)]),
		author: new PlatformAuthorLink(new PlatformID(PLATFORM, channelUrlId, config.id),
			displayName,
			channelUrl,
			userAvatar ?? "",
			subscribers ?? 0),
		datetime: Math.round((new Date(ldJson.uploadDate)).getTime() / 1000),
		duration: flashvars.video_duration,
		viewCount: views,
		url: flashvars.link_url,
		isLive: false,
		description: description,
		video: new VideoSourceDescriptor(sources),
		//subtitles: subtitles
	});

	details.getContentRecommendations = function () {
		return source.getContentRecommendations(url);
	};

	return details;
};

// Get content recommendations based on a video URL
source.getContentRecommendations = function(url) {
	var html = httpGET(url, {});
	var dom = domParser.parseFromString(html);

	// Find all li.pcVideoListItem in the page (these are related videos)
	var liElements = dom.querySelectorAll("li.pcVideoListItem");

	if (liElements.length === 0) {
		log("No recommendations found");
		return new ContentPager([], false);
	}

	var resultArray = [];

	liElements.forEach(function (li) {
		const videoId = li.getAttribute("data-video-id");
		if (videoId && !isNaN(videoId)) {
			const aElement = li.querySelector('a.thumbnailTitle, a[href*="view_video"]');
			if (aElement) {
				const videoUrl = aElement.getAttribute('href');
				const imgElement = li.querySelector('img');
				if (imgElement && videoUrl) {
					const thumbnailUrl = imgElement.getAttribute('src') || imgElement.getAttribute('data-src') || imgElement.getAttribute('data-thumb_url');
					const title = aElement.getAttribute("title") || aElement.textContent.trim() || imgElement.getAttribute("alt");
					const durationVar = li.querySelector(".duration, var.duration");
					const durationStr = durationVar ? durationVar.textContent.trim() : "0:00";
					const duration = parseDuration(durationStr);
					const viewsSpan = li.querySelector(".views var, .views");
					const viewsStr = viewsSpan ? viewsSpan.textContent.trim() : "0";
					const views = viewsStr && viewsStr.includes("K") || viewsStr.includes("M") ? parseNumberSuffix(viewsStr) : 0;

					const authorLink = li.querySelector(".usernameWrap a, a[href*='/model/'], a[href*='/pornstar/'], a[href*='/channels/']");
					let authorInfo = {
						channel: "",
						authorName: ""
					};
					if (authorLink) {
						authorInfo.channel = URL_BASE + authorLink.getAttribute("href");
						authorInfo.authorName = authorLink.textContent.trim();
					}

					resultArray.push(new PlatformVideo({
						id: new PlatformID(PLATFORM, videoId, config.id),
						name: title ?? "",
						thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
						author: new PlatformAuthorLink(new PlatformID(PLATFORM, authorInfo.authorName, config.id),
							authorInfo.authorName,
							authorInfo.channel,
							""),
						datetime: undefined,
						duration: duration,
						viewCount: views,
						url: videoUrl.startsWith("http") ? videoUrl : URL_BASE + videoUrl,
						isLive: false
					}));
				}
			}
		}
	});

	log(`Found ${resultArray.length} recommendations`);
	return new ContentPager(resultArray, false);
};

// Get shorts from the /shorties/ page
source.getShorts = function(context) {
	// Parse context
	var from = 1;
	var count = 12;

	if (typeof context === 'string') {
		try {
			const parsed = JSON.parse(context);
			from = parsed.from ?? 1;
			count = parsed.count ?? 12;
		} catch (e) {
			// Use defaults
		}
	} else if (context) {
		from = context.from ?? 1;
		count = context.count ?? 12;
	}

	return getShortsPager(from, count);
};

function getShortsPager(from, count) {
	log(`getShortsPager from=${from} count=${count}`);

	// PornHub's /shorties page returns random shorts on each visit
	// Not paginated - each fetch gets a fresh random set
	const url = URL_BASE + "/shorties";

	var html = httpGET(url, {});

	// Extract JSON_SHORTIES from the JavaScript in the HTML
	// Pattern can be either:
	// 1. JSON_SHORTIES = insertAfterNthPosition([...]);
	// 2. if (SHOW_SHORTIES_ADS) { JSON_SHORTIES = insertAfterNthPosition([...]); }

	// Find the line that assigns JSON_SHORTIES
	var startIdx = html.indexOf('JSON_SHORTIES = insertAfterNthPosition([');
	if (startIdx === -1) {
		log("No JSON_SHORTIES assignment found in page");
		return new PornhubVideoPager([], false, "/shorties", {}, 1);
	}

	// Extract the JSON array - find the matching closing bracket and semicolon
	var arrayStart = html.indexOf('[', startIdx);
	var bracketCount = 0;
	var arrayEnd = -1;
	var inString = false;
	var escapeNext = false;

	for (var i = arrayStart; i < html.length; i++) {
		var char = html[i];

		if (escapeNext) {
			escapeNext = false;
			continue;
		}

		if (char === '\\') {
			escapeNext = true;
			continue;
		}

		if (char === '"' && !escapeNext) {
			inString = !inString;
			continue;
		}

		if (inString) continue;

		if (char === '[') {
			bracketCount++;
		} else if (char === ']') {
			bracketCount--;
			if (bracketCount === 0) {
				arrayEnd = i + 1;
				break;
			}
		}
	}

	if (arrayEnd === -1) {
		log("Could not find end of JSON_SHORTIES array");
		return new PornhubVideoPager([], false, "/shorties", {}, 1);
	}

	var jsonString = html.substring(arrayStart, arrayEnd);
	if (!jsonString) {
		log("No JSON_SHORTIES data extracted");
		return new PornhubVideoPager([], false, "/shorties", {}, 1);
	}

	var shortsData;
	try {
		shortsData = JSON.parse(jsonString);
	} catch (e) {
		log("Failed to parse JSON_SHORTIES: " + e);
		return new PornhubVideoPager([], false, "/shorties", {}, 1);
	}

	if (!shortsData || shortsData.length === 0) {
		log("No shorts data found");
		return new PornhubVideoPager([], false, "/shorties", {}, 1);
	}

	var resultArray = [];

	shortsData.forEach(function (short) {
		if (!short.videoId) return;

		const videoId = short.videoId.toString();
		const title = short.videoTitle || "";
		const thumbnailUrl = short.imageUrl || "";
		const videoUrl = short.linkUrl || "";
		const authorName = short.name || "";
		const authorUrl = short.profileUrl || "";

		// Calculate duration from mediaDefinitions if available
		var duration = 0;
		if (short.trackingTimeWatched && short.trackingTimeWatched.video_duration) {
			duration = short.trackingTimeWatched.video_duration;
		}

		// Parse likes as views (shorties don't have view count)
		var views = 0;
		if (short.likeInfo) {
			const likeStr = short.likeInfo.toString();
			if (likeStr.includes("K") || likeStr.includes("M")) {
				views = parseNumberSuffix(likeStr);
			} else {
				views = parseInt(likeStr) || 0;
			}
		}

		// Extract video sources from mediaDefinitions
		var sources = [];
		if (short.mediaDefinitions && Array.isArray(short.mediaDefinitions)) {
			short.mediaDefinitions.forEach(function (mediaDefinition) {
				if (mediaDefinition.format === "hls" && mediaDefinition.videoUrl) {
					var quality = mediaDefinition.quality;
					var resolution = supportedResolutions[quality];
					if (resolution) {
						sources.push(new HLSSource({
							name: quality + "p",
							url: mediaDefinition.videoUrl,
							duration: duration,
							priority: mediaDefinition.defaultQuality === true,
							requestModifier: { headers: { "Referer": URL_BASE + "/" } }
						}));
					}
				}
			});
		}

		// If we have sources, return PlatformVideoDetails (playable)
		// If no sources, return PlatformVideo (metadata only)
		if (sources.length > 0) {
			resultArray.push(new PlatformVideoDetails({
				id: new PlatformID(PLATFORM, videoId, config.id),
				name: title ?? "",
				thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
				author: new PlatformAuthorLink(new PlatformID(PLATFORM, authorName, config.id),
					authorName,
					authorUrl,
					""),
				datetime: undefined,
				duration: duration,
				viewCount: views,
				url: videoUrl.startsWith("http") ? videoUrl : URL_BASE + videoUrl,
				isLive: false,
				isShort: true,
				description: "",
				video: new VideoSourceDescriptor(sources),
				rating: new RatingLikes(parseInt(short.likeNumber) || 0)
			}));
		} else {
			// No sources available, return metadata only
			resultArray.push(new PlatformVideo({
				id: new PlatformID(PLATFORM, videoId, config.id),
				name: title ?? "",
				thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
				author: new PlatformAuthorLink(new PlatformID(PLATFORM, authorName, config.id),
					authorName,
					authorUrl,
					""),
				datetime: undefined,
				duration: duration,
				viewCount: views,
				url: videoUrl.startsWith("http") ? videoUrl : URL_BASE + videoUrl,
				isLive: false,
				isShort: true
			}));
		}
	});

	log(`Found ${resultArray.length} shorts`);

	// Always hasMore=true since each fetch returns new random shorts
	var hasMore = resultArray.length > 0;

	return new PornhubVideoPager(resultArray, hasMore, "/shorties", {}, 1);
}



/**
 * Detect if the HTML response is a bot detection challenge page
 * @param {string} html - The HTML response body
 * @returns {boolean} - True if it's a challenge page
 */
function isBotChallenge(html) {
	return html.includes("function leastFactor(n)") && html.includes("document.cookie=\"KEY=");
}

/**
 * Solve PornHub's bot detection challenge using eval()
 * @param {string} html - The challenge page HTML
 * @returns {string|null} - The KEY cookie value, or null if solving failed
 */
function solveBotChallenge(html) {
	try {
		log("Solving bot detection challenge...");

		// Extract the JavaScript challenge code
		var scriptStart = html.indexOf("<script type=\"text/javascript\">");
		var scriptEnd = html.indexOf("</script>", scriptStart);
		if (scriptStart === -1 || scriptEnd === -1) {
			log("Could not find script tags in challenge");
			return null;
		}

		var scriptContent = html.substring(scriptStart + 31, scriptEnd);

		// Remove HTML comments (<!-- and -->)
		scriptContent = scriptContent.replace(/<!--/g, "").replace(/-->/g, "");

		// Replace document.cookie assignment with a return statement
		// Original: document.cookie="KEY="+n+"*"+p/n+":"+s+":2234595840:1;path=/;";
		// We want to capture: n+"*"+p/n+":"+s+":2234595840:1"
		scriptContent = scriptContent.replace(
			/document\.cookie\s*=\s*"KEY="\s*\+\s*([^;]+);/,
			'return $1;'
		);

		// Remove document.location.reload
		scriptContent = scriptContent.replace(/document\.location\.reload\([^)]*\);?/g, "");

		// Wrap in a function that calls go() and returns the result
		var solverCode = scriptContent + "\nreturn go();";

		log("Executing challenge code...");

		// Execute the challenge using eval
		var keyCookieValue = eval("(function() { " + solverCode + " })()");

		if (keyCookieValue) {
			log("Challenge solved: KEY=" + keyCookieValue.substring(0, 20) + "...");
			return keyCookieValue;
		} else {
			log("Challenge execution returned no value");
			return null;
		}
	} catch (e) {
		log("Failed to solve bot challenge: " + e);
		return null;
	}
}

// the only things you need for a valid session are as follows:
// 1.) token
// 2.) cookies: __l, __s, and ss
// this will allow you to get search suggestions!!
function refreshSession() {
	const resp = http.GET(URL_BASE, headers);
	if (!resp.isOk)
		throw new ScriptException("Failed request [" + URL_BASE + "] (" + resp.code + ")");
	else {
		var dom = domParser.parseFromString(resp.body);

		// Extract token from search input
		const searchInput = dom.querySelector("#searchInput");
		if (searchInput) {
			state.token = searchInput.getAttribute("data-token");
			log("Token extracted: " + (state.token ? state.token.substring(0, 20) + "..." : "null"));
		} else {
			log("Warning: #searchInput not found, token extraction failed");
		}

		// Extract session ID from meta tag
		var sessionId = "";
		const metaTag = dom.querySelector("meta[name=\"adsbytrafficjunkycontext\"]");
		if (metaTag) {
			const adContextInfo = metaTag.getAttribute("data-info");
			sessionId = JSON.parse(adContextInfo)["session_id"];
			state.sessionCookie = sessionId;
			log("Session ID extracted: ss=" + sessionId.substring(0, 10) + "...");
		} else {
			log("Warning: meta tag not found, session ID extraction failed");
		}

		// Extract cookies from response headers
		// The __l and __s cookies are essential for autocomplete to work
		var cookiesFromHeaders = [];
		log("Response headers available: " + (resp.headers ? "yes" : "no"));
		if (resp.headers) {
			log("Headers keys: " + Object.keys(resp.headers).join(", "));
			if (resp.headers["set-cookie"]) {
				var setCookieHeaders = resp.headers["set-cookie"];
				log("set-cookie header found, type: " + typeof setCookieHeaders);
				if (typeof setCookieHeaders === 'string') {
					setCookieHeaders = [setCookieHeaders];
				}

				for (var i = 0; i < setCookieHeaders.length; i++) {
					var cookieHeader = setCookieHeaders[i];
					// Extract cookie name and value (format: "name=value; path=/; ...")
					var cookieParts = cookieHeader.split(';')[0].trim();
					cookiesFromHeaders.push(cookieParts);
					log("Extracted cookie: " + cookieParts);
				}
			} else {
				log("No set-cookie header found");
			}
		}

		// Build the complete cookie string
		// Start with required cookies
		var cookieString = "platform=pc; accessAgeDisclaimerPH=2";

		// Preserve any auth cookies that were captured by Grayjay's
		// login web view (il, phn, etc) -- without these, the user
		// appears logged-out after a session refresh.
		try {
			var prev = headers["Cookie"] || "";
			prev.split(";").forEach(function (p) {
				var part = p.trim();
				if (!part) return;
				var name = part.split("=")[0];
				if (AUTH_COOKIE_NAMES.indexOf(name) >= 0) {
					cookieString += "; " + part;
				}
			});
		} catch (e) { /* ignore */ }

		// Add cookies from response headers (__l, __s, etc.)
		for (var i = 0; i < cookiesFromHeaders.length; i++) {
			cookieString += "; " + cookiesFromHeaders[i];
		}

		// Add session ID if we got one from meta tag
		if (sessionId) {
			cookieString += "; ss=" + sessionId;
		}

		headers["Cookie"] = cookieString;
		log("Session refreshed - token: " + (state.token ? "present" : "empty") + ", cookies set: " + cookiesFromHeaders.length);
	}
}

function getVideoId(dom) {
	var videoId =  dom.querySelector("div#player").getAttribute("data-video-id");
	return videoId
}

source.getComments = function (url) {
	var html = httpGET(url, {});
	var dom = domParser.parseFromString(html);
	var videoId = getVideoId(dom);

	return getCommentPager(`/comment/show?id=${videoId}&popular=0&what=video&token=${state.token}`, {}, 1);
}

source.getSubComments = function (comment) {
	throw new ScriptException("This is a sample");
}

function parseStringWithKorMSuffixes(subscriberString) {
    const numericPart = parseFloat(subscriberString);

    if (subscriberString.includes("K")) {
        return Math.floor(numericPart * 1000);
    } else if (subscriberString.includes("M")) {
        return Math.floor(numericPart * 1000000);
    } else {
        return Math.floor(numericPart);
    }
}




function getCommentPager(path, params, page) {
	log(`getCommentPager page=${page}`, params)

	const count = 10;
	const page_end = (page ?? 1) * count;
	params = { ... params, page }

	const url = URL_BASE + path;
	const urlWithParams = `${url}${buildQuery(params)}`;

	// Comment API requires a valid token in the URL path
	var html = httpGET(urlWithParams, { requireToken: true });

	var comments = getComments(html);
	// if no comments, return empty page
	if (comments.total === 0) return new PornhubCommentPager();
	
	return new PornhubCommentPager(comments.comments.map(c => {
		return new Comment({
			author: new PlatformAuthorLink(new PlatformID(PLATFORM, c.username, config.id), 
				c.username, 
				"", 
				c.avatar,
				"",),
			message: c.message,
			rating: new RatingLikesDislikes(c.voteUp, c.voteDown),
			date: Math.round(c.date.getTime() / 1000),
			replyCount: c.totalReplies,
			context: { id: c.id }
		});
	}), comments.total > page_end, path, params, page);
}




function getComments(html) {

	var dom = domParser.parseFromString(html);

	var comments = []

	const total = parseInt(dom.querySelector("div#cmtWrapper div.cmtHeader h2 span").textContent.trim().replace("(", "").replace(")", ""));
	if (total > 0) {
		// Loop through each comment block
		// todo nested blocks
		dom.querySelectorAll('div#cmtContent div.commentBlock').forEach(commentBlock => {
			const id = commentBlock.getAttribute("class").match(/commentTag(\d+)/)[1];

			const avatar = commentBlock.querySelector("img").getAttribute("src");
			const username = commentBlock.querySelector('.usernameLink').textContent.trim();
			const date = parseRelativeDate(commentBlock.querySelector('div.date').textContent.trim());
			const message = commentBlock.querySelector('.commentMessage span').textContent.trim();
			const voteUp = parseInt(commentBlock.querySelector('span.voteTotal').textContent.trim());
			var isVoteDownPresent = commentBlock.querySelectorAll('div.actionButtonsBlock span') !== null;

			var voteDown = 0;
			if (isVoteDownPresent) {
				voteDown = parseInt(commentBlock.querySelectorAll('div.actionButtonsBlock span')[1].textContent.trim());
			}

			// Push comment details to the comments array
			comments.push({
				id,
				avatar,
				username,
				date,
				message,
				voteUp,
				voteDown
			});
		});


		return {
			total: total,
			comments: comments
		};

	} else {

		return {
			total: 0,
			comments: 0
		};
	}

}


/**
 * Normalize PornHub URL by removing country-specific subdomains
 * @param {string} url - The URL to normalize
 * @returns {string} - Normalized URL with www.pornhub.com
 */
function normalizePornhubUrl(url) {
	if (!url) return url;

	// Replace any country-specific subdomain (rt.pornhub.com, de.pornhub.com, etc.) with www.pornhub.com
	// Also handles urls without subdomain (pornhub.com -> www.pornhub.com)
	return url.replace(/https?:\/\/([a-z]{2}\.)?pornhub\.com/, "https://www.pornhub.com");
}

/**
 * Extract platform name from URL
 * @param {string} url - The URL to extract platform from
 * @param {string} label - Optional label from the page
 * @returns {string} - Platform name or "Website"
 */
function extractPlatformName(url, label) {
	try {
		// If label is provided and meaningful, use it
		if (label && label !== "") {
			return label;
		}

		// Extract domain from URL
		var domain = url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();

		// Map of domain patterns to friendly names
		var platformMap = {
			'twitter.com': 'Twitter',
			'x.com': 'Twitter',
			'instagram.com': 'Instagram',
			'tiktok.com': 'TikTok',
			'youtube.com': 'YouTube'
		};

		// Check if domain matches any known platform
		for (var pattern in platformMap) {
			if (domain.includes(pattern)) {
				return platformMap[pattern];
			}
		}

		// For unknown domains, capitalize the first part of the domain
		var domainParts = domain.split('.');
		if (domainParts.length > 0) {
			var name = domainParts[0];
			return name.charAt(0).toUpperCase() + name.slice(1);
		}

		return "Website";
	} catch (e) {
		return "Website";
	}
}

function parseRelativeDate(relativeDate) {
    const now = new Date();
    const lowerCaseRelativeDate = relativeDate.toLowerCase();

    if (lowerCaseRelativeDate.includes('1 second ago')) {
        return new Date(now - 1000);
    } else if (lowerCaseRelativeDate.includes('1 minute ago')) {
        return new Date(now - 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('1 hour ago')) {
        return new Date(now - 60 * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('1 day ago')) {
        return new Date(now - 24 * 60 * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('yesterday')) {
        return new Date(now - 24 * 60 * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('1 week ago')) {
        return new Date(now - 7 * 24 * 60 * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('1 month ago')) {
        const oneMonthAgo = new Date(now);
        oneMonthAgo.setMonth(now.getMonth() - 1);
        return oneMonthAgo;
    } else if (lowerCaseRelativeDate.includes('1 year ago')) {
        const oneYearAgo = new Date(now);
        oneYearAgo.setFullYear(now.getFullYear() - 1);
        return oneYearAgo;
    } else if (lowerCaseRelativeDate.includes('seconds ago')) {
        const secondsAgo = parseInt(lowerCaseRelativeDate);
        return new Date(now - secondsAgo * 1000);
    } else if (lowerCaseRelativeDate.includes('minutes ago')) {
        const minutesAgo = parseInt(lowerCaseRelativeDate);
        return new Date(now - minutesAgo * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('hours ago')) {
        const hoursAgo = parseInt(lowerCaseRelativeDate);
        return new Date(now - hoursAgo * 60 * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('days ago')) {
        const daysAgo = parseInt(lowerCaseRelativeDate);
        return new Date(now - daysAgo * 24 * 60 * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('weeks ago')) {
        const weeksAgo = parseInt(lowerCaseRelativeDate);
        return new Date(now - weeksAgo * 7 * 24 * 60 * 60 * 1000);
    } else if (lowerCaseRelativeDate.includes('months ago')) {
        const monthsAgo = parseInt(lowerCaseRelativeDate);
        const oneMonthAgo = new Date(now);
        oneMonthAgo.setMonth(now.getMonth() - monthsAgo);
        return oneMonthAgo;
    } else if (lowerCaseRelativeDate.includes('years ago')) {
        const yearsAgo = parseInt(lowerCaseRelativeDate);
        const oneYearAgo = new Date(now);
        oneYearAgo.setFullYear(now.getFullYear() - yearsAgo);
        return oneYearAgo;
    }

	// Handle additional cases or return null if the format is not recognized
    return 0;
}


function getChannelInfo(url) {
	var html = httpGET(url, {});
	let dom = domParser.parseFromString(html);

	const avatarElement = dom.getElementById("getAvatar");
	var channelThumbnail = avatarElement ? avatarElement.getAttribute("src") : "";

	const bannerElement = dom.getElementById("coverPictureDefault");
	var channelBanner = bannerElement ? bannerElement.getAttribute("src") : "";

	const nameElement = dom.querySelector("h1");
	var channelName = nameElement ? nameElement.textContent.trim() : "";

	var statsNode = dom.getElementById("stats");

	var channelSubscribers = (statsNode && statsNode.childNodes[1]) ? parseInt(statsNode.childNodes[1].textContent.trim().replace(/,/g, '')) : 0;
	var channelViews = (statsNode && statsNode.childNodes[0]) ? parseInt(statsNode.childNodes[0].textContent.trim().replace(/,/g, '')) : 0;
	var channelVideos = (statsNode && statsNode.childNodes[2]) ? parseInt(statsNode.childNodes[2].textContent.trim().split(" ")[0].replace(/,/g, '')) : 0;

	const descElement = dom.querySelector(".cdescriptions");
	var channelDescription = (descElement && descElement.childNodes[0]) ? descElement.childNodes[0].textContent.trim() : "";

	// Add channel stats to description
	if (channelViews > 0 || channelVideos > 0 || channelSubscribers > 0) {
		channelDescription += "\n\n📊 Channel Stats:";
		if (channelVideos > 0) {
			channelDescription += "\n• Total Videos: " + channelVideos.toLocaleString();
		}
		if (channelViews > 0) {
			channelDescription += "\n• Total Views: " + channelViews.toLocaleString();
		}
		if (channelSubscribers > 0) {
			channelDescription += "\n• Subscribers: " + channelSubscribers.toLocaleString();
		}
	}

	// Extract social media links
	var channelLinks = {};
	var socialLinksSection = dom.querySelector(".socialLinksSection, section.socialLinksSection");
	if (socialLinksSection) {
		var socialLinks = socialLinksSection.querySelectorAll("ul.socialList li a");
		socialLinks.forEach(function(link) {
			var href = link.getAttribute("href");
			if (href && !href.includes("pornhub.com")) {
				var linkText = link.querySelector(".socialText");
				var label = linkText ? linkText.textContent.trim() : "";

				// Extract platform name from URL domain
				var platformName = extractPlatformName(href, label);

				// Use the label if available, otherwise use the extracted platform name
				var linkLabel = label || platformName;

				if (linkLabel) {
					channelLinks[linkLabel] = href;
				}
			}
		});
	}

	return {
		channelName: channelName,
		channelThumbnail: channelThumbnail,
		channelBanner: channelBanner,
		channelSubscribers: channelSubscribers,
		channelDescription: channelDescription,
		channelUrl: normalizePornhubUrl(url),
		channelLinks: channelLinks
	}
}



function getPornstarInfo(url) {
	var html = httpGET(url, {});
	let dom = domParser.parseFromString(html);

	const avatarElement = dom.getElementById("getAvatar");
	const channelThumbnail = avatarElement ? avatarElement.getAttribute("src") : "";

	const bannerElement = dom.getElementById("coverPictureDefault");
	const channelBanner = bannerElement ? bannerElement.getAttribute("src") : "";

	const nameElement = dom.querySelector("div.name > h1");
	const channelName = nameElement ? nameElement.textContent.trim() : "";

	var channelDescription = "";
	const aboutSection = dom.querySelector("section.aboutMeSection");
	if (aboutSection) {
		var divs = aboutSection.querySelectorAll("div");
		for (var i = 0; i < divs.length; i++) {
			if (!divs[i].getAttribute("class")) {
				channelDescription = divs[i].textContent;
				break;
			}
		}
	}

	const statsNode = dom.querySelector("div.infoBoxes");
	const channelSubscribers = statsNode ? parseNumberSuffix(statsNode.querySelector("div[data-title^=Subscribers] > span.big").textContent.trim()) : 0;
	const channelViews = statsNode ? parseNumberSuffix(statsNode.querySelector("div[data-title^=Video] > span.big").textContent.trim()) : 0;

	// Try to get video count from the stats node
	var channelVideos = 0;
	const videoCountElement = dom.querySelector("div.pornstarVideosCounter span.big, div.videosCounter span");
	if (videoCountElement) {
		const videoCountText = videoCountElement.textContent.trim();
		channelVideos = videoCountText.includes("K") || videoCountText.includes("M") ? parseNumberSuffix(videoCountText) : parseInt(videoCountText.replace(/,/g, '')) || 0;
	}

	// Add channel stats to description
	if (channelViews > 0 || channelVideos > 0 || channelSubscribers > 0) {
		channelDescription += "\n\n📊 Channel Stats:";
		if (channelVideos > 0) {
			channelDescription += "\n• Total Videos: " + channelVideos.toLocaleString();
		}
		if (channelViews > 0) {
			channelDescription += "\n• Total Views: " + channelViews.toLocaleString();
		}
		if (channelSubscribers > 0) {
			channelDescription += "\n• Subscribers: " + channelSubscribers.toLocaleString();
		}
	}

	// Extract social media links
	var channelLinks = {};
	var socialLinksSection = dom.querySelector(".socialLinksSection, section.socialLinksSection");
	if (socialLinksSection) {
		var socialLinks = socialLinksSection.querySelectorAll("ul.socialList li a");
		socialLinks.forEach(function(link) {
			var href = link.getAttribute("href");
			if (href && !href.includes("pornhub.com")) {
				var linkText = link.querySelector(".socialText");
				var label = linkText ? linkText.textContent.trim() : "";

				// Extract platform name from URL domain
				var platformName = extractPlatformName(href, label);

				// Use the label if available, otherwise use the extracted platform name
				var linkLabel = label || platformName;

				if (linkLabel) {
					channelLinks[linkLabel] = href;
				}
			}
		});
	}

	return {
		channelName: channelName,
		channelThumbnail: channelThumbnail,
		channelBanner: channelBanner,
		channelSubscribers: channelSubscribers,
		channelDescription: channelDescription,
		channelUrl: normalizePornhubUrl(url),
		channelLinks: channelLinks
	}
}




class PornhubVideoPager extends VideoPager {
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params,  page});
	}

	nextPage() {
		// For shorts, call getShortsPager to get fresh random shorts
		if (this.context.path === "/shorties") {
			return getShortsPager(0, 12);
		}
		return getVideoPager(this.context.path, this.context.params, (this.context.page ?? 1) + 1);
	}
}


class PornhubChannelVideosPager extends VideoPager {
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params,  page});
	}

	nextPage() {
		if(this.context.path.includes("/channels/")) {
			return getChannelVideosPager(this.context.path, this.context.params, (this.context.page ?? 1) + 1);
		} else if(this.context.path.includes("/model/")) {
			return getModelVideosPager(this.context.path, this.context.params, (this.context.page ?? 1) + 1);
		}
		else {
			return getPornstarVideosPager(this.context.path, this.context.params, (this.context.page ?? 1) + 1);
		}
	}
}



class PornhubChannelPager extends ChannelPager {
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params, page });
	}
	
	nextPage() {
		return getChannelPager(this.context.path, this.context.params, (this.context.page ?? 1) + 1);
	}
}


class PornhubCommentPager extends CommentPager {
	constructor(results, hasMore, path, params, page) {
		super(results, hasMore, { path, params, page });
	}

	nextPage() {
		return getCommentPager(this.context.path, this.context.params, (this.context.page ?? 1) + 1);
	}
}

// Multi-channel pager for combined pornstars/models/channels search
class PornhubMultiChannelPager extends ChannelPager {
	constructor(results, hasMore, query, page) {
		super(results, hasMore, { query, page });
	}

	nextPage() {
		return getMultiChannelPager(this.context.query, (this.context.page ?? 1) + 1);
	}
}

// Use autocomplete API for channel search (no bot detection, no pagination issues!)
function getAutocompleteChannelPager(query) {
	try {
		// Build autocomplete API URL
		var apiUrl = URL_BASE + "/api/v1/video/search_autocomplete?pornstars=true&token=" + state.token + "&orientation=straight&q=" + encodeURIComponent(query) + "&alt=0";
		log("Fetching channel search from autocomplete: " + apiUrl);

		// Use httpGET with options object
		var json = httpGET(apiUrl, {
			headers: {
				"Cookie": headers["Cookie"],
				"User-Agent": headers["User-Agent"],
				"Accept": "*/*",
				"Accept-Language": "en-US,en;q=0.5",
				"Referer": URL_BASE + "/",
				"X-Requested-With": "XMLHttpRequest",
				"Content-Type": "application/x-www-form-urlencoded"
			},
			requireToken: true,
			parseJson: true,
			retries: 3
		});

		var allChannels = [];

		// Add models
		if (json.models && Array.isArray(json.models)) {
			json.models.forEach(function(model) {
				allChannels.push(new PlatformAuthorLink(
					new PlatformID(PLATFORM, model.slug, config.id),
					model.name,
					URL_BASE + "/model/" + model.slug,
					"", // No avatar in autocomplete API
					0   // No subscribers in autocomplete API
				));
			});
			log(`Found ${json.models.length} models`);
		}

		// Add pornstars
		if (json.pornstars && Array.isArray(json.pornstars)) {
			json.pornstars.forEach(function(pornstar) {
				allChannels.push(new PlatformAuthorLink(
					new PlatformID(PLATFORM, pornstar.slug, config.id),
					pornstar.name,
					URL_BASE + "/pornstar/" + pornstar.slug,
					"", // No avatar in autocomplete API
					0   // No subscribers in autocomplete API
				));
			});
			log(`Found ${json.pornstars.length} pornstars`);
		}

		// Add channels
		if (json.channels && Array.isArray(json.channels)) {
			json.channels.forEach(function(channel) {
				allChannels.push(new PlatformAuthorLink(
					new PlatformID(PLATFORM, channel.slug, config.id),
					channel.name,
					URL_BASE + "/channels/" + channel.slug,
					"", // No avatar in autocomplete API
					0   // No subscribers in autocomplete API
				));
			});
			log(`Found ${json.channels.length} channels`);
		}

		log(`Found ${allChannels.length} total creators from autocomplete`);

		// Autocomplete doesn't support pagination, so hasMore is always false
		return new PornhubMultiChannelPager(allChannels, false, query, 1);
	} catch(e) {
		log("Channel search failed: " + e);
		return new PornhubMultiChannelPager([], false, query, 1);
	}
}

// Search both pornstars and channels (OLD METHOD - using HTML scraping with bot detection)
function getMultiChannelPager(query, page) {
	log(`getMultiChannelPager query=${query} page=${page}`);

	var allChannels = [];
	var hasMore = false;

	// Search pornstars
	try {
		var pornstarHtml = httpGET(URL_BASE + "/pornstars/search?search=" + encodeURIComponent(query) + "&page=" + page, {});
		var pornstars = getPornstarsFromSearch(pornstarHtml);
		allChannels = allChannels.concat(pornstars.channels);
		hasMore = hasMore || pornstars.hasNextPage;
		log(`Found ${pornstars.channels.length} pornstars`);
	} catch(e) {
		log("Failed to search pornstars: " + e);
	}

	// Search channels
	try {
		var channelHtml = httpGET(URL_BASE + "/channels/search?channelSearch=" + encodeURIComponent(query) + "&page=" + page, {});
		var channels = getChannels(channelHtml);
		allChannels = allChannels.concat(channels.channels);
		hasMore = hasMore || channels.hasNextPage;
		log(`Found ${channels.channels.length} channels`);
	} catch(e) {
		log("Failed to search channels: " + e);
	}

	log(`Found ${allChannels.length} total creators`);

	return new PornhubMultiChannelPager(allChannels.map(c => {
		return new PlatformAuthorLink(new PlatformID(PLATFORM, c.name, config.id),
			c.displayName,
			URL_BASE + c.url,
			c.avatar ?? "",
			c.subscribers);
	}), hasMore, query, page);
}

// Parse pornstars from search results
function getPornstarsFromSearch(html) {
	var dom = domParser.parseFromString(html);
	var resultArray = [];

	// Try multiple possible selectors for pornstar search results
	var pornstarElements = dom.querySelectorAll("div.pornstarsSearchResult li, ul.pornstars-list li, li.pornstar-item, div.performerCard");

	if (pornstarElements.length === 0) {
		log("No pornstar elements found with standard selectors");
		return { hasNextPage: false, channels: [] };
	}

	pornstarElements.forEach(function(li) {
		var linkElement = li.querySelector("a");
		if (!linkElement) return;

		var url = linkElement.getAttribute("href");
		if (!url || !url.includes("/pornstar/")) return;

		var imgElement = li.querySelector("img");
		var avatar = imgElement ? (imgElement.getAttribute("data-src") || imgElement.getAttribute("src") || "") : "";

		// Try different selectors for name
		var nameElement = li.querySelector(".pornStarName, .performerCardName, .title");
		var displayName = nameElement ? nameElement.textContent.trim() : "";
		if (!displayName && linkElement.getAttribute("title")) {
			displayName = linkElement.getAttribute("title");
		}

		// Try different selectors for subscriber count
		var rankElement = li.querySelector(".rank_number, .subscribers, .subscribersText");
		var subscribers = 0;
		if (rankElement) {
			var subsText = rankElement.textContent.trim();
			subscribers = subsText.includes("K") || subsText.includes("M") ? parseNumberSuffix(subsText) : parseInt(subsText) || 0;
		}

		var name = url ? url.split("/").filter(s => s).pop() : displayName;

		if (url && displayName) {
			resultArray.push({
				subscribers: subscribers,
				name: name,
				url: url,
				displayName: displayName,
				avatar: avatar
			});
		}
	});

	var hasNextPage = false;
	var pageNextNode = dom.querySelector("li.page_next a, a.page-next, .pagination a.next");
	if (pageNextNode && pageNextNode.getAttribute("href") && pageNextNode.getAttribute("href") !== "") {
		hasNextPage = true;
	}

	log(`getPornstarsFromSearch: Found ${resultArray.length} pornstars`);

	return {
		hasNextPage: hasNextPage,
		channels: resultArray
	};
}


function getChannelPager(path, params, page) {

	log(`getChannelPager page=${page}`, params)

	const count = 40;
	const page_end = (page ?? 1) * count;
	params = { ... params, page }

	const url = URL_BASE + path;
	const urlWithParams = `${url}${buildQuery(params)}`;

	var html = httpGET(urlWithParams, {});

	var channels = getChannels(html, "searchChannelsSection");


	return new PornhubChannelPager(channels.channels.map(c => {
			return new PlatformAuthorLink(new PlatformID(PLATFORM, c.name, config.id), 
				c.displayName, 
				URL_BASE + c.url, 
				c.avatar ?? "",
				c.subscribers);
		}), channels.hasNextPage, path, params, page);
}

function getChannels(html) {

	var dom = domParser.parseFromString(html);

	var resultArray = []

	dom.getElementById("searchChannelsSection").childNodes.forEach((li) => {

			var avatar = li.querySelector("div.avatar a.usernameLink img").getAttribute("src");
			var displayName = li.querySelector("div.descriptionContainer li a.usernameLink").textContent.trim()
			var url = li.querySelector("div.descriptionContainer li a.usernameLink").getAttribute("href");
			var subscribers = parseInt(li.querySelector("div.descriptionContainer li span").textContent.trim().replace(/\,/, ""));
			var name = url.split("/")[1];

			resultArray.push({
				subscribers: subscribers,
				name: name,
				url: url,
				displayName: displayName,
				avatar: avatar,
			});
	});
	

	var hasNextPage = false; 
	var pageNextNode = dom.getElementsByClassName("page_next");
	if (pageNextNode.length > 0) {
		hasNextPage = pageNextNode[0].firstChild.getAttribute("href") == "" ? false : true;
	}

	return {
		hasNextPage: hasNextPage,
		channels: resultArray
	};
}

// todo: maybe improve?
function getChannelVideosPager(path, params, page) {
	log(`getChannelVideosPager page=${page}`, params)

	const count = 36;
	const page_end = (page ?? 1) * count;
	params = { ... params, page }

	const url = path;
	const urlWithParams = `${url}${buildQuery(params)}`;

	var html = httpGET(urlWithParams, {});

	// Use getVideos() with class selector since channel pages use the same structure as regular video pages
	var dom = domParser.parseFromString(html);

	// Try specific IDs first (these are guaranteed to have videos)
	var ulElement = dom.getElementById("mostRecentVideosSection") || dom.getElementById("moreData");

	// If no ID found, try querySelectorAll and find first non-empty ul
	if (!ulElement) {
		var ulElements = dom.querySelectorAll("ul.full-row-thumbs.videos, ul.videos.full-row-thumbs");
		for (var i = 0; i < ulElements.length; i++) {
			var testUl = ulElements[i];
			if (testUl.querySelectorAll("li.pcVideoListItem").length > 0) {
				ulElement = testUl;
				break;
			}
		}
	}

	if (!ulElement) {
		log("Warning: Could not find ul.full-row-thumbs.videos, trying old getChannelContents method");
		var vids = getChannelContents(html);
		return _buildPornhubChannelVideosPager(vids, vids.totalElemsPages > page_end, path, params, page);
	}

	// Parse videos using the same logic as getVideos but adapted for channel pages
	var resultArray = [];
	var authorName = path.split("/")[4]; // Extract channel name from path
	var authorInfo = {
		authorName: authorName,
		avatar: ""
	};

	ulElement.querySelectorAll("li.pcVideoListItem").forEach(function (li) {
		const videoId = li.getAttribute("data-video-id");
		if (videoId && !isNaN(videoId)) {
			const aElement = li.querySelector('a.js-linkVideoThumb');
			if (aElement) {
				const videoUrl = aElement.getAttribute('href');
				const imgElement = aElement.querySelector('img');
				if (imgElement && videoUrl) {
					const thumbnailUrl = imgElement.getAttribute('src');
					const title = imgElement.getAttribute("alt") || imgElement.getAttribute("data-title") || aElement.getAttribute("data-title");
					const durationVar = aElement.querySelector(".duration");
					const durationStr = durationVar ? durationVar.textContent.trim() : "0:00";
					const duration = parseDuration(durationStr);
					const viewsSpan = li.querySelector(".views var");
					const viewsStr = viewsSpan ? viewsSpan.textContent.trim() : "0";
					const views = parseNumberSuffix(viewsStr);

					resultArray.push({
						id: videoId,
						videoUrl: videoUrl,
						title: title,
						thumbnailUrl: thumbnailUrl,
						duration: duration,
						authorInfo: authorInfo,
						views: views,
					});
				}
			}
		}
	});

	var vids = {
		videos: resultArray,
		totalElemsPages: resultArray.length
	};
	return _buildPornhubChannelVideosPager(vids, resultArray.length >= count, path, params, page);
}

function getModelVideosPager(path, params, page) {
	log(`getModelVideosPager page=${page}`, params)
	params = { ... params, page }

	const url = path;
	const urlWithParams = `${url}${buildQuery(params)}`;

	var html = httpGET(urlWithParams, {});

	// Try new structure first (same as regular video pages)
	var dom = domParser.parseFromString(html);

	// Try specific IDs first (these are guaranteed to have videos)
	var ulElement = dom.getElementById("mostRecentVideosSection") || dom.getElementById("moreData");

	// If no ID found, try querySelectorAll and find first non-empty ul
	if (!ulElement) {
		var ulElements = dom.querySelectorAll("ul.full-row-thumbs.videos, ul.videos.full-row-thumbs");
		for (var i = 0; i < ulElements.length; i++) {
			var testUl = ulElements[i];
			if (testUl.querySelectorAll("li.pcVideoListItem").length > 0) {
				ulElement = testUl;
				break;
			}
		}
	}

	if (ulElement) {
		log("Using new ul.full-row-thumbs.videos structure for model page");
		var resultArray = [];
		var authorName = path.split("/")[4]; // Extract model name from path
		var authorInfo = {
			authorName: authorName,
			avatar: ""
		};

		const count = 40;
		ulElement.querySelectorAll("li.pcVideoListItem").forEach(function (li) {
			const videoId = li.getAttribute("data-video-id");
			if (videoId && !isNaN(videoId)) {
				const aElement = li.querySelector('a.js-linkVideoThumb');
				if (aElement) {
					const videoUrl = aElement.getAttribute('href');
					const imgElement = aElement.querySelector('img');
					if (imgElement && videoUrl) {
						const thumbnailUrl = imgElement.getAttribute('src');
						const title = imgElement.getAttribute("alt") || imgElement.getAttribute("data-title") || aElement.getAttribute("data-title");
						const durationVar = aElement.querySelector(".duration");
						const durationStr = durationVar ? durationVar.textContent.trim() : "0:00";
						const duration = parseDuration(durationStr);
						const viewsSpan = li.querySelector(".views var");
						const viewsStr = viewsSpan ? viewsSpan.textContent.trim() : "0";
						const views = parseNumberSuffix(viewsStr);

						resultArray.push({
							id: videoId,
							videoUrl: videoUrl,
							title: title,
							thumbnailUrl: thumbnailUrl,
							duration: duration,
							authorInfo: authorInfo,
							views: views,
						});
					}
				}
			}
		});

		var vids = {
			videos: resultArray,
			hasNextPage: resultArray.length >= count
		};
		return _buildPornhubChannelVideosPager(vids, vids.hasNextPage, path, params, page);
	}

	// Fallback to old structure
	log("Using old getModelContents structure for model page");
	var vids = getModelContents(html);
	return _buildPornhubChannelVideosPager(vids, vids.hasNextPage, path, params, page)
}

function getPornstarVideosPager(path, params, page) {
	log(`getPornstarVideosPager page=${page}`, params)

	const count = 40;
	const page_end = (page ?? 1) * count;
	params = { ... params, page }

	const url = path;
	const urlWithParams = `${url}${buildQuery(params)}`;

	var html = httpGET(urlWithParams, {});

	// Try new structure first (same as regular video pages)
	var dom = domParser.parseFromString(html);

	// Try specific IDs first (these are guaranteed to have videos)
	var ulElement = dom.getElementById("mostRecentVideosSection") || dom.getElementById("moreData");

	// If no ID found, try querySelectorAll and find first non-empty ul
	if (!ulElement) {
		var ulElements = dom.querySelectorAll("ul.full-row-thumbs.videos, ul.videos.full-row-thumbs");
		for (var i = 0; i < ulElements.length; i++) {
			var testUl = ulElements[i];
			if (testUl.querySelectorAll("li.pcVideoListItem").length > 0) {
				ulElement = testUl;
				break;
			}
		}
	}

	if (ulElement) {
		log("Using new ul.full-row-thumbs.videos structure for pornstar page");
		var resultArray = [];
		var authorName = path.split("/")[4]; // Extract pornstar name from path
		var authorInfo = {
			authorName: authorName,
			avatar: ""
		};

		ulElement.querySelectorAll("li.pcVideoListItem").forEach(function (li) {
			const videoId = li.getAttribute("data-video-id");
			if (videoId && !isNaN(videoId)) {
				const aElement = li.querySelector('a.js-linkVideoThumb');
				if (aElement) {
					const videoUrl = aElement.getAttribute('href');
					const imgElement = aElement.querySelector('img');
					if (imgElement && videoUrl) {
						const thumbnailUrl = imgElement.getAttribute('src');
						const title = imgElement.getAttribute("alt") || imgElement.getAttribute("data-title") || aElement.getAttribute("data-title");
						const durationVar = aElement.querySelector(".duration");
						const durationStr = durationVar ? durationVar.textContent.trim() : "0:00";
						const duration = parseDuration(durationStr);
						const viewsSpan = li.querySelector(".views var");
						const viewsStr = viewsSpan ? viewsSpan.textContent.trim() : "0";
						const views = parseNumberSuffix(viewsStr);

						resultArray.push({
							id: videoId,
							videoUrl: videoUrl,
							title: title,
							thumbnailUrl: thumbnailUrl,
							duration: duration,
							authorInfo: authorInfo,
							views: views,
						});
					}
				}
			}
		});

		var vids = {
			videos: resultArray,
			totalElemsPages: resultArray.length
		};
		return _buildPornhubChannelVideosPager(vids, resultArray.length >= count, path, params, page);
	}

	// Fallback to old structure
	log("Using old getPornstarContents structure for pornstar page");
	var vids = getPornstarContents(html);
	return _buildPornhubChannelVideosPager(vids, vids.totalElemsPages > page_end, path, params, page)
}

function _buildPornhubChannelVideosPager(vids, hasNextPage, path, params, page) {
	// Extract the channel URL from the path (remove /videos or /videos/upload suffix)
	var channelUrl = path.replace(/\/videos.*$/, '');

	return new PornhubChannelVideosPager(vids.videos.map(v => {
		return new PlatformVideo({
			id: new PlatformID(PLATFORM, v.id, config.id),
			name: v.title ?? "",
			thumbnails: new Thumbnails([new Thumbnail(v.thumbnailUrl, 0)]),
			author: new PlatformAuthorLink(new PlatformID(PLATFORM, v.authorInfo.authorName, config.id),
				v.authorInfo.authorName,
				channelUrl,
				v.authorInfo.avatar),
			datetime: undefined,
			duration: v.duration,
			viewCount: v.views,
			url: URL_BASE + v.videoUrl,
			isLive: false
		});

	}), hasNextPage, path, params, page);
}


function getChannelContents(html) {
	var dom = domParser.parseFromString(html);

	var statsNodes = dom.querySelectorAll("div#stats div.info.floatRight");

	var total = (statsNodes && statsNodes[2]) ? parseInt(statsNodes[2].textContent.split(" VIDEOS")[0]) : 0;

	var resultArray = []

	const nameElement = dom.querySelector("div.title h1");
	const avatarElement = dom.querySelector("img#getAvatar");

	var authorInfo = {
		authorName: nameElement ? nameElement.textContent.trim() : "",
		avatar: avatarElement ? avatarElement.getAttribute("href") : ""
	}

	const videosContainer = dom.getElementById("showAllChanelVideos");
	if (!videosContainer) return { totalElemsPages: total, videos: resultArray };

	videosContainer.childNodes.forEach((li) => {
		if (!li) return;

		const titleElement = li.querySelector("span.title a");
		if (!titleElement) return;

		var title = titleElement.textContent.trim();
		var videoUrl = titleElement.getAttribute("href");
		if (!videoUrl) return;

		const imgElement = li.querySelector("img");
		var thumbnailUrl = imgElement ? imgElement.getAttribute("src") : "";

		var videoId = li.getAttribute("data-video-id");
		if (!videoId) return;

		const durationElement = li.querySelector("var.duration");
		var duration = durationElement ? parseDuration(durationElement.textContent.trim()) : 0;

		const viewsElement = li.querySelector("div.videoDetailsBlock span.views var");
		var views = viewsElement ? parseStringWithKorMSuffixes(viewsElement.textContent.trim()) : 0;

		resultArray.push({
			id: videoId,
			videoUrl: videoUrl,
			title: title,
			thumbnailUrl: thumbnailUrl,
			duration: duration,
			authorInfo: authorInfo,
			views: views,
		});

	});

	return {
		totalElemsPages: total,
		videos: resultArray
	};
}

function getPornstarContents(html) {
	var dom = domParser.parseFromString(html);

	// "Showing 1-40 of 52"
	const showingInfoElement = dom.querySelector("div.showingInfo");
	var total = 0;
	if (showingInfoElement) {
		var showingInfo = showingInfoElement.textContent.trim();
		if (showingInfo.length > 0 && showingInfo.includes(" of ")) {
			// "52"
			total = parseInt(showingInfo.split(" of ").slice(-1), 10);
		}
	}

	var resultArray = []

	const nameElement = dom.querySelector("h1[itemprop=name]");
	const avatarElement = dom.querySelector("img#getAvatar");

	var authorInfo = {
		authorName: nameElement ? nameElement.textContent.trim() : "",
		avatar: avatarElement ? avatarElement.getAttribute("src") : ""
	}

	const videoListContainer = dom.querySelector("div.videoUList > ul");
	if (!videoListContainer) return { totalElemsPages: total, videos: resultArray };

	videoListContainer.childNodes.forEach((li) => {
		if (!li) return;

		const titleElement = li.querySelector("span.title a");
		if (!titleElement) return;

		var title = titleElement.textContent.trim();
		var videoUrl = titleElement.getAttribute("href");
		if (!videoUrl) return;

		const imgElement = li.querySelector("img");
		var thumbnailUrl = imgElement ? imgElement.getAttribute("src") : "";

		var videoId = li.getAttribute("data-video-id");
		if (!videoId) return;

		const durationElement = li.querySelector("var.duration");
		var duration = durationElement ? parseDuration(durationElement.textContent.trim()) : 0;

		const viewsElement = li.querySelector("div.videoDetailsBlock span.views var");
		var views = viewsElement ? parseStringWithKorMSuffixes(viewsElement.textContent.trim()) : 0;

		resultArray.push({
			id: videoId,
			videoUrl: videoUrl,
			title: title,
			thumbnailUrl: thumbnailUrl,
			duration: duration,
			authorInfo: authorInfo,
			views: views,
		});

	});

	return {
		totalElemsPages: total,
		videos: resultArray
	};
}

function getModelContents(html) {
	var dom = domParser.parseFromString(html);
	var hasNextPage;

	const pageNext = dom.querySelector("li.page_next > a");
	if (pageNext) {
		hasNextPage = pageNext.getAttribute("href") !== "";
	} else {
		hasNextPage = false;
	}

	var resultArray = []

	const nameElement = dom.querySelector("h1[itemprop=name]");
	const avatarElement = dom.querySelector("img#getAvatar");

	var authorInfo = {
		authorName: nameElement ? nameElement.textContent.trim() : "",
		avatar: avatarElement ? avatarElement.getAttribute("src") : ""
	}

	const videoListContainer = dom.querySelector("div.videoUList > ul");
	if (!videoListContainer) return { hasNextPage: hasNextPage, videos: resultArray };

	videoListContainer.childNodes.forEach((li) => {
		if (!li) return;

		const titleElement = li.querySelector("span.title a");
		if (!titleElement) return;

		var title = titleElement.textContent.trim();
		var videoUrl = titleElement.getAttribute("href");
		if (!videoUrl) return;

		const imgElement = li.querySelector("img");
		var thumbnailUrl = imgElement ? imgElement.getAttribute("src") : "";

		var videoId = li.getAttribute("data-video-id");
		if (!videoId) return;

		const durationElement = li.querySelector("var.duration");
		var duration = durationElement ? parseDuration(durationElement.textContent.trim()) : 0;

		const viewsElement = li.querySelector("div.videoDetailsBlock span.views var");
		var views = viewsElement ? parseStringWithKorMSuffixes(viewsElement.textContent.trim()) : 0;

		resultArray.push({
			id: videoId,
			videoUrl: videoUrl,
			title: title,
			thumbnailUrl: thumbnailUrl,
			duration: duration,
			authorInfo: authorInfo,
			views: views,
		});

	});

	return {
		hasNextPage: hasNextPage,
		videos: resultArray
	};
}

function getVideoPager(path, params, page) {
	log(`getVideoPager page=${page}`, params)
	params = { ... params, page }

	const url = URL_BASE + path;
	const urlWithParams = `${url}${buildQuery(params)}`;

	var html = httpGET(urlWithParams, {});

	// Use different container IDs based on the path
	// Search pages use "videoSearchResult", home/category pages use "videoCategory"
	var containerId = path.includes("/search") ? "videoSearchResult" : "videoCategory";
	var vids = getVideos(html, containerId);
	
	return new PornhubVideoPager(vids.videos.map(v => {
		return new PlatformVideo({
			id: new PlatformID(PLATFORM, v.id, config.id),
			name: v.title ?? "",
			thumbnails: new Thumbnails([new Thumbnail(v.thumbnailUrl, 0)]),
			author: new PlatformAuthorLink(new PlatformID(PLATFORM, v.authorInfo.authorName, config.id),
				v.authorInfo.authorName,
				v.authorInfo.channel),
			datetime: undefined,
			duration: v.duration,
			viewCount: v.views,
			url: v.videoUrl,
			isLive: false
		});

	}), true, path, params, page);
}


function getVideos(html, ulId) {

	let node = domParser.parseFromString(html, "text/html");
	
	// Find the ul element with id ulId
	var ulElement = node.getElementById(ulId);

	var total = 1;

	var pagingIndicationElement = node.getElementsByClassName("showingCounter")[0];
	if (pagingIndicationElement !== undefined && pagingIndicationElement !== null) {
		var pagingIndication = pagingIndicationElement.textContent.trim();
		if (pagingIndication && typeof pagingIndication === 'string') {
			var indexOfTotalStr = pagingIndication.indexOf("of "); // "showing XX-ZZ of TOTAL"
			if (indexOfTotalStr !== -1) {
				total = parseInt(pagingIndication.substring(indexOfTotalStr + 3), 10);
				log(`getVideos total: ${total}`);
			}
		}
	}

	var resultArray = []

    if (ulElement) {
        // Get all li elements inside the ul with class "pcVideoListItem" (new class)
        const liElements = ulElement.querySelectorAll("li.pcVideoListItem");

        log(`getVideos found ${liElements.length} li elements`);

        // Iterate through each li element
        liElements.forEach(function (li) {
            // Get the data-video-id attribute of the li element for the videoId
            const videoId = li.getAttribute("data-video-id");

            // Ensure a valid videoId is found and it's not the ad element (which might have no data-video-id or a non-numeric id)
            if (videoId && !isNaN(videoId)) {
                // Find the first <a> tag inside the li which is the video link
                const aElement = li.querySelector('a.js-linkVideoThumb');

                if (aElement) {
                    // Get the "href" attribute as "videoUrl"
                    const videoUrl = URL_BASE + aElement.getAttribute('href');

                    // Find the <img> tag inside the <a>
                    const imgElement = aElement.querySelector('img');

                    if (imgElement) {
                        // Get the "src" attribute as "thumbnailUrl"
                        const thumbnailUrl = imgElement.getAttribute('src');

                        // Title can be from the img's alt or data-title, or the a tag's data-title, or the .thumbnailTitle span
                        const title = imgElement.getAttribute("alt") || imgElement.getAttribute("data-title") || aElement.getAttribute("data-title");

                        // Get the duration string from the <var> tag with class "duration"
                        const durationVar = aElement.querySelector(".duration");
                        const durationStr = durationVar ? durationVar.textContent.trim() : "0:00";
                        const duration = parseDuration(durationStr);

                        // Get the views string from the <var> tag inside the span with class "views"
                        const viewsSpan = li.querySelector(".views var");
                        const viewsStr = viewsSpan ? viewsSpan.textContent.trim() : "0";
                        const views = parseNumberSuffix(viewsStr);

                        // Get author information
                        const authorLink = li.querySelector(".usernameWrap a");
                        let authorInfo = {
                            channel: "",
                            authorName: ""
                        };
                        if (authorLink) {
                            authorInfo.channel = URL_BASE + authorLink.getAttribute("href");
                            authorInfo.authorName = authorLink.textContent.trim();
                        }

                        // Create an object with the desired properties and push it to the result array
                        resultArray.push({
                            id: videoId,
                            videoUrl: videoUrl,
                            title: title,
                            thumbnailUrl: thumbnailUrl,
                            duration: duration,
                            authorInfo: authorInfo,
                            views: views,
                        });
                    }
                }
            }
        });
    }

	log(resultArray.length + " videos found");

	return {
		totalElemsPages: undefined,
		videos: resultArray
	};

}


/**
 * HTTP GET wrapper that manages session lifecycle, bot detection bypass, and retries
 * Similar to Kick's callUrl function but adapted for PornHub's specific challenges
 * @param {string} url - The URL to fetch
 * @param {Object} options - Request options
 * @param {Object} options.headers - Optional custom headers to use instead of default headers
 * @param {boolean} options.requireToken - Whether this request requires a valid session token (default: false)
 * @param {boolean} options.parseJson - Whether to parse response as JSON (default: false)
 * @param {number} options.retries - Number of retry attempts on failure (default: 3)
 * @returns {string | Object} - Response body as string or parsed JSON
 * @throws {ScriptException}
 */
function httpGET(url, options = {}) {
	// Extract options with defaults
	var customHeaders = options.headers || null;
	var requireToken = options.requireToken || false;
	var parseJson = options.parseJson || false;
	var retries = options.retries !== undefined ? options.retries : 3;

	let lastError = null;
	let attempts = retries + 1; // +1 for the initial attempt

	// Use custom headers if provided, otherwise use default headers
	var requestHeaders = customHeaders || headers;

	while (attempts > 0) {
		try {
			// Step 1: Ensure we have a valid session
			if (headers["Cookie"].length === 0) {
				log("Session empty, refreshing...");
				refreshSession();
				// Update request headers with new cookies if using default headers
				if (!customHeaders) {
					requestHeaders = headers;
				} else {
					// Update cookie in custom headers
					customHeaders["Cookie"] = headers["Cookie"];
					requestHeaders = customHeaders;
				}
			} else if (requireToken && state.token === "") {
				log("Token required but empty, refreshing session...");
				refreshSession();
				// Update request headers after session refresh
				if (!customHeaders) {
					requestHeaders = headers;
				} else {
					customHeaders["Cookie"] = headers["Cookie"];
					requestHeaders = customHeaders;
				}
			}

			// Step 2: Make the HTTP request
			log("httpGET: Fetching " + url + " (attempt " + (retries - attempts + 2) + "/" + (retries + 1) + ")");
			const resp = http.GET(url, requestHeaders);

			// Step 3: Check response status
			if (!resp.isOk) {
				throw new ScriptException("Request [" + url + "] failed with code [" + resp.code + "]");
			}

			var body = resp.body;

			// Step 4: Check for bot detection challenge
			if (isBotChallenge(body)) {
				log("Bot challenge detected on attempt " + (retries - attempts + 2));

				// Solve the challenge
				var keyCookieValue = solveBotChallenge(body);

				if (!keyCookieValue) {
					throw new ScriptException("Failed to solve bot challenge");
				}

				// Update headers with KEY cookie
				headers["Cookie"] += "; KEY=" + keyCookieValue;

				// Update request headers
				if (!customHeaders) {
					requestHeaders = headers;
				} else {
					customHeaders["Cookie"] = headers["Cookie"];
					requestHeaders = customHeaders;
				}

				log("KEY cookie added, retrying request...");

				// Retry the request with the KEY cookie
				const retryResp = http.GET(url, requestHeaders);

				if (!retryResp.isOk) {
					throw new ScriptException("Retry request [" + url + "] failed with code [" + retryResp.code + "]");
				}

				body = retryResp.body;

				// Verify challenge was bypassed
				if (isBotChallenge(body)) {
					throw new ScriptException("Bot challenge persists after solving");
				}

				log("Bot challenge bypassed successfully");
			}

			// Step 5: Parse response if requested
			if (parseJson) {
				try {
					var json = JSON.parse(body);

					// Check for API errors
					if (json.error) {
						throw new ScriptException("API error: " + json.error);
					}

					return json;
				} catch (parseError) {
					log("Failed to parse JSON: " + parseError);
					throw new ScriptException("JSON parse error: " + parseError);
				}
			}

			// Step 6: Return successful response
			return body;

		} catch (error) {
			lastError = error;
			attempts--;

			log("Request failed: " + error + " (attempts remaining: " + attempts + ")");

			// If we have more attempts and the error is recoverable, try refreshing session
			if (attempts > 0) {
				if (error.toString().includes("401") || error.toString().includes("403") ||
				    error.toString().includes("session") || error.toString().includes("token")) {
					log("Attempting session refresh before retry...");
					try {
						refreshSession();
						// Update request headers after refresh
						if (!customHeaders) {
							requestHeaders = headers;
						} else {
							customHeaders["Cookie"] = headers["Cookie"];
							requestHeaders = customHeaders;
						}
					} catch (refreshError) {
						log("Session refresh failed: " + refreshError);
					}
				}

				// Small delay before retry to avoid rate limiting
				log("Waiting 1 second before retry...");
				bridge.sleep(1000);
				continue;
			}

			// All retry attempts exhausted
			log("Request failed after " + (retries + 1) + " attempts");
			throw lastError;
		}
	}

	// Should never reach here, but just in case
	throw lastError || new ScriptException("Request failed for unknown reason");
}

function parseNumberSuffix(numStr) {

	var mul = 1;
	if (numStr.includes("K")) {
		mul = 1000;
	}
	if (numStr.includes("M")) {
		mul = 1000000;
	}

	var out = parseFloat(numStr.slice(0, -1)) * mul;
	return out;
}

function parseDuration(durationStr) {
	if (!durationStr) return 0;
	var splitted = String(durationStr).trim().split(":");
	if (splitted.length === 2) {
		var mins = parseInt(splitted[0]) || 0;
		var secs = parseInt(splitted[1]) || 0;
		return 60 * mins + secs;
	}
	if (splitted.length === 3) {
		var hrs = parseInt(splitted[0]) || 0;
		var mns = parseInt(splitted[1]) || 0;
		var scs = parseInt(splitted[2]) || 0;
		return 3600 * hrs + 60 * mns + scs;
	}
	return parseInt(durationStr) || 0;
}

// ====================================================================
// Authentication (login / logout / session detection)
// ====================================================================

function hasValidAuthCookie(cookies) {
	if (!cookies) return false;
	if (typeof cookies === "string") {
		if (!cookies.length) return false;
		for (var i = 0; i < AUTH_COOKIE_NAMES.length; i++) {
			if (cookies.indexOf(AUTH_COOKIE_NAMES[i] + "=") >= 0) return true;
		}
		return false;
	}
	if (Array.isArray(cookies)) {
		for (var j = 0; j < cookies.length; j++) {
			var c = cookies[j];
			if (c && c.name && AUTH_COOKIE_NAMES.indexOf(c.name) >= 0) return true;
		}
		return false;
	}
	if (typeof cookies === "object") {
		for (var k in cookies) {
			if (cookies[k] && AUTH_COOKIE_NAMES.indexOf(k) >= 0) return true;
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
		var out = [];
		for (var k in cookies) { if (cookies[k]) out.push(k + "=" + cookies[k]); }
		return out.join("; ");
	}
	return "";
}

// Loads whatever cookies Grayjay captured for pornhub.com after the login
// flow, and merges any auth cookies into the shared `headers["Cookie"]` so
// subsequent http.GET calls (which use those headers) are authenticated.
function loadAuthCookies() {
	var captured = "";
	try {
		if (typeof http.getCookies === "function") {
			var ck = http.getCookies(URL_BASE);
			if (hasValidAuthCookie(ck)) captured = cookiesToString(ck);
		}
		if (!captured && typeof bridge !== "undefined" && bridge) {
			if (typeof bridge.getCookieString === "function") {
				var s = bridge.getCookieString(URL_BASE);
				if (hasValidAuthCookie(s)) captured = s;
			}
			if (!captured && typeof bridge.getCookies === "function") {
				try {
					var c2 = bridge.getCookies("pornhub.com");
					if (hasValidAuthCookie(c2)) captured = cookiesToString(c2);
				} catch (e) { /* ignore */ }
			}
		}
	} catch (e) { log("loadAuthCookies error: " + e); }
	if (captured) {
		// Merge captured auth cookies into the default request headers cookie
		// string. We keep the existing platform=pc / accessAgeDisclaimerPH=2
		// cookies (needed by many endpoints) and append anything new.
		try {
			var existing = headers["Cookie"] || "";
			var existingNames = {};
			existing.split(";").forEach(function(p) {
				var kv = p.trim().split("=");
				if (kv[0]) existingNames[kv[0]] = true;
			});
			captured.split(";").forEach(function(p) {
				var part = p.trim();
				if (!part) return;
				var name = part.split("=")[0];
				if (!existingNames[name]) {
					existing += (existing ? "; " : "") + part;
					existingNames[name] = true;
				}
			});
			headers["Cookie"] = existing;
		} catch (e) { log("loadAuthCookies merge error: " + e); }
		return true;
	}
	return false;
}

// Parse the logged-in username from a fetched pornhub HTML page. Pornhub
// exposes the current user via the top-bar dropdown (`a.username`) and via a
// meta tag (`name="USR"`) on most pages.
function parseUsernameFromHtml(html) {
	try {
		var dom = domParser.parseFromString(html);
		var meta = dom.querySelector("meta[name='USR']") || dom.querySelector("meta[name='userId']");
		if (meta && meta.getAttribute("content")) {
			var v = meta.getAttribute("content").trim();
			if (v && v.toLowerCase() !== "guest" && v !== "0") {
				return v;
			}
		}
		var a = dom.querySelector("a.username, a#headerUsername, li#headerUsername a");
		if (a) {
			var name = a.textContent.trim();
			if (name && name.toLowerCase() !== "log in" && name.toLowerCase() !== "sign in") {
				return name;
			}
		}
		// fallback: look for /users/<name>/ link in header
		var profileLink = dom.querySelector("a[href*='/users/'][href*='/account']");
		if (profileLink) {
			var href = profileLink.getAttribute("href") || "";
			var m = href.match(/\/users\/([^\/\?#]+)/);
			if (m) return m[1];
		}
	} catch (e) { /* ignore */ }
	return "";
}

// Authoritative session probe: fetch the home page (which renders different
// HTML depending on auth) and extract the logged-in username. Populates
// state.username when successful.
function validateSession() {
	try {
		var resp = http.GET(URL_BASE + "/front", headers, true);
		if (!resp || !resp.isOk) {
			resp = http.GET(URL_BASE + "/", headers, true);
		}
		if (!resp || !resp.isOk) return false;
		var u = parseUsernameFromHtml(resp.body);
		if (u) {
			state.username = u;
			return true;
		}
	} catch (e) { log("validateSession error: " + e); }
	return false;
}

function bridgeIsLoggedIn() {
	try {
		if (typeof bridge !== "undefined" && bridge && typeof bridge.isLoggedIn === "function") {
			return !!bridge.isLoggedIn();
		}
	} catch (e) { /* ignore */ }
	return false;
}

source.isLoggedIn = function () {
	try {
		if (bridgeIsLoggedIn()) {
			loadAuthCookies();
			state.isAuthenticated = true;
			if (!state.username) validateSession();
			return true;
		}
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

source.getLoggedInUser = function () {
	try {
		if (!source.isLoggedIn()) return null;
		if (!state.username) validateSession();
		return state.username || "Logged In";
	} catch (e) { return null; }
};

// Mirrors HV-GJ: return true unconditionally so Grayjay never displays
// "Login cancelled". isLoggedIn() will resolve the real state on next call.
source.login = function () {
	try {
		loadAuthCookies();
		state.isAuthenticated = true;
		try { validateSession(); } catch (e) { /* ignore */ }
		log("login(): accepted - cookies captured by Grayjay");
		return true;
	} catch (e) {
		log("login error: " + e);
		return true;
	}
};

source.prepareLogin = function () {
	try {
		state.isAuthenticated = false;
		state.username = "";
		state.userId = "";
		// Reset cookie string to the public defaults so the next login is fresh.
		headers["Cookie"] = "platform=pc; accessAgeDisclaimerPH=2";
		try {
			if (typeof http.clearCookies === "function") {
				http.clearCookies("pornhub.com");
				http.clearCookies("www.pornhub.com");
			}
			if (typeof bridge !== "undefined" && bridge && bridge.clearCookies) {
				bridge.clearCookies("pornhub.com");
				bridge.clearCookies("www.pornhub.com");
			}
		} catch (e) { /* ignore */ }
		return true;
	} catch (e) {
		log("prepareLogin error: " + e);
		return true;
	}
};

source.logout = function () {
	state.isAuthenticated = false;
	state.username = "";
	state.userId = "";
	headers["Cookie"] = "platform=pc; accessAgeDisclaimerPH=2";
	try {
		if (typeof http.clearCookies === "function") {
			http.clearCookies("pornhub.com");
			http.clearCookies("www.pornhub.com");
		}
		if (typeof bridge !== "undefined" && bridge && bridge.clearCookies) {
			bridge.clearCookies("pornhub.com");
			bridge.clearCookies("www.pornhub.com");
		}
	} catch (e) { /* ignore */ }
};

// ====================================================================
// Playlist search & details
// ====================================================================

source.isPlaylistUrl = function (url) {
	if (!url) return false;
	if (isVirtualPlaylistUrl(url)) return true;
	return /^https?:\/\/(?:[a-z]{2}\.)?(?:www\.)?pornhub\.com\/playlist\/\d+/.test(url);
};

source.searchPlaylists = function (query) {
	return new PornhubPlaylistsPager(query, 1);
};

function _extractPlaylistIdFromUrl(url) {
	if (!url) return null;
	var m = url.match(/\/playlist\/(\d+)/);
	return m ? m[1] : null;
}

function _playlistUrlFromId(id) {
	return URL_BASE + "/playlist/" + id;
}

function _parsePlaylistListItems(html) {
	// Parses a search result page or "all playlists" page for playlists. Each
	// playlist tile carries the data-id attribute and a thumbnail/title link.
	var dom = domParser.parseFromString(html);
	var out = [];
	var nodes = dom.querySelectorAll("li.pcVideoListItem, li.playlistLink, ul.user-playlist li, li.playlistsItem");
	for (var i = 0; i < nodes.length; i++) {
		var li = nodes[i];
		var id = li.getAttribute("data-id") || li.getAttribute("data-playlist-id");
		var titleA = li.querySelector("a.title, span.title a, a.linkPlaylist, a.playlistTitle");
		var href = titleA ? titleA.getAttribute("href") : "";
		if (!id && href) {
			var mm = href.match(/\/playlist\/(\d+)/);
			if (mm) id = mm[1];
		}
		if (!id) continue;
		var name = titleA ? titleA.textContent.trim() : "";
		if (!name) {
			var alt = li.querySelector("img");
			name = alt ? (alt.getAttribute("alt") || "") : "";
		}
		var img = li.querySelector("img");
		var thumb = img ? (img.getAttribute("data-thumb_url") || img.getAttribute("data-src") || img.getAttribute("src") || "") : "";
		var ownerA = li.querySelector(".usernameWrap a, a.usernameLink, a[href*='/users/'], a[href*='/model/'], a[href*='/pornstar/'], a[href*='/channels/']");
		var ownerName = ownerA ? ownerA.textContent.trim() : "";
		var ownerUrl = ownerA ? (URL_BASE + ownerA.getAttribute("href")) : "";
		var countEl = li.querySelector(".videoCount, .videos, .videosNumber");
		var videoCount = 0;
		if (countEl) {
			var n = parseInt((countEl.textContent || "").replace(/[^0-9]/g, ""));
			if (!isNaN(n)) videoCount = n;
		}
		out.push({
			id: id,
			name: name || ("Playlist " + id),
			thumbnail: thumb,
			ownerName: ownerName,
			ownerUrl: ownerUrl,
			videoCount: videoCount
		});
	}
	return out;
}

function _parsePlaylistVideos(html) {
	// Same DOM shape as the regular video lists.
	var dom = domParser.parseFromString(html);
	var out = [];
	var lis = dom.querySelectorAll("li.pcVideoListItem");
	for (var i = 0; i < lis.length; i++) {
		var li = lis[i];
		var videoId = li.getAttribute("data-video-id");
		if (!videoId || isNaN(videoId)) continue;
		var a = li.querySelector("a.js-linkVideoThumb, a.thumbnailTitle, a[href*='view_video']");
		if (!a) continue;
		var videoUrl = a.getAttribute("href");
		if (!videoUrl) continue;
		if (!videoUrl.startsWith("http")) videoUrl = URL_BASE + videoUrl;
		var img = li.querySelector("img");
		var thumb = img ? (img.getAttribute("data-thumb_url") || img.getAttribute("data-src") || img.getAttribute("src") || "") : "";
		var title = (img && (img.getAttribute("alt") || img.getAttribute("data-title"))) || a.getAttribute("data-title") || a.getAttribute("title") || "";
		var dEl = li.querySelector("var.duration, .duration");
		var dur = dEl ? parseDuration(dEl.textContent.trim()) : 0;
		var vEl = li.querySelector(".views var, .views");
		var views = vEl ? parseNumberSuffix(vEl.textContent.trim()) : 0;
		var authorA = li.querySelector(".usernameWrap a, a[href*='/model/'], a[href*='/pornstar/'], a[href*='/channels/'], a[href*='/users/']");
		var authorName = authorA ? authorA.textContent.trim() : "";
		var authorUrl = authorA ? (URL_BASE + authorA.getAttribute("href")) : "";
		out.push({
			id: videoId,
			name: title,
			thumb: thumb,
			duration: dur,
			views: views,
			videoUrl: videoUrl,
			authorName: authorName,
			authorUrl: authorUrl
		});
	}
	// Has next page?
	var pageNext = dom.querySelector("li.page_next a, a.page_next, .pagination a[rel='next']");
	var hasNext = false;
	if (pageNext) {
		var h = pageNext.getAttribute("href") || "";
		if (h && h !== "#") hasNext = true;
	}
	return { videos: out, hasNext: hasNext };
}

source.getPlaylist = function (url) {
	if (isVirtualPlaylistUrl(url)) {
		return getVirtualPlaylistDetails(url);
	}
	var id = _extractPlaylistIdFromUrl(url);
	if (!id) throw new ScriptException("Invalid playlist URL: " + url);

	var html;
	try {
		html = httpGET(URL_BASE + "/playlist/" + id, {});
	} catch (e) {
		throw new ScriptException("Playlist fetch failed: " + e);
	}
	var dom = domParser.parseFromString(html);

	// Title
	var titleEl = dom.querySelector("h1.playlistTitle, h1.title, div.playlist-info h1, h1");
	var name = titleEl ? titleEl.textContent.trim() : ("Playlist " + id);

	// Owner
	var ownerA = dom.querySelector(".playlistMeta a.usernameLink, .playlistBy a, a[href*='/users/'][class*='username']");
	var ownerName = ownerA ? ownerA.textContent.trim() : "";
	var ownerUrl = ownerA ? (URL_BASE + ownerA.getAttribute("href")) : "";
	var ownerImg = dom.querySelector(".playlistMeta img, .playlist-info img");
	var ownerAvatar = ownerImg ? (ownerImg.getAttribute("src") || "") : "";

	// Videos in this playlist page.
	var parsed = _parsePlaylistVideos(html);

	var author = ownerName
		? new PlatformAuthorLink(new PlatformID(PLATFORM, ownerName, config.id), ownerName, ownerUrl, ownerAvatar)
		: new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");

	var pvids = parsed.videos.map(_videoToPlatformVideo);

	return new PlatformPlaylistDetails({
		id: new PlatformID(PLATFORM, id, config.id),
		name: name,
		thumbnail: (parsed.videos[0] && parsed.videos[0].thumb) || "",
		author: author,
		datetime: Math.floor(Date.now() / 1000),
		url: url,
		videoCount: pvids.length,
		contents: new VideoPager(pvids, false)
	});
};

function _videoToPlatformVideo(v) {
	return new PlatformVideo({
		id: new PlatformID(PLATFORM, v.id, config.id),
		name: v.name || "",
		thumbnails: new Thumbnails([new Thumbnail(v.thumb || "", 0)]),
		author: new PlatformAuthorLink(new PlatformID(PLATFORM, v.authorName || "", config.id),
			v.authorName || "",
			v.authorUrl || "",
			""),
		datetime: v.datetime || undefined,
		duration: v.duration || 0,
		viewCount: v.views || 0,
		url: v.videoUrl,
		isLive: false
	});
}

class PornhubPlaylistsPager extends PlaylistPager {
	constructor(query, page) {
		super([], true);
		this.query = query;
		this.page = page || 1;
		this._load();
	}
	_load() {
		try {
			var url = URL_BASE + "/playlist/search" + buildQuery({ search: this.query, page: this.page });
			var html = httpGET(url, {});
			var items = _parsePlaylistListItems(html);
			var out = items.map(p => new PlatformPlaylist({
				id: new PlatformID(PLATFORM, p.id, config.id),
				name: p.name,
				thumbnail: p.thumbnail || "",
				author: p.ownerName
					? new PlatformAuthorLink(new PlatformID(PLATFORM, p.ownerName, config.id), p.ownerName, p.ownerUrl, "")
					: new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", ""),
				datetime: Math.floor(Date.now() / 1000),
				url: _playlistUrlFromId(p.id),
				videoCount: p.videoCount || 0
			}));
			this.results = out;
			// Detect more pages.
			var dom = domParser.parseFromString(html);
			var pageNext = dom.querySelector("li.page_next a, a.page_next, .pagination a[rel='next']");
			this.hasMore = !!(pageNext && pageNext.getAttribute("href") && pageNext.getAttribute("href") !== "#");
			if (!this.hasMore && out.length >= 20) this.hasMore = true;
		} catch (e) {
			log("PornhubPlaylistsPager._load error: " + e);
			this.results = [];
			this.hasMore = false;
		}
	}
	nextPage() {
		this.page++;
		this._load();
		return this;
	}
}

// ====================================================================
// Virtual playlists (Favorites, Watch Later) -- session scoped
// ====================================================================

const VPL_FAVORITES   = URL_BASE + "/__pornhub__/favorites";
const VPL_WATCH_LATER = URL_BASE + "/__pornhub__/watch-later";

function isVirtualPlaylistUrl(url) {
	return url === VPL_FAVORITES || url === VPL_WATCH_LATER;
}

function _fetchVirtualPlaylistVideos(kind) {
	// kind: "favorites" | "watch-later"
	// Pornhub exposes per-user lists at:
	//   Favorites:   /users/<username>/videos/favourites?page=N
	//                (alternate alias: /my/favorites/videos)
	//   Watch Later: /playlist/watch-later (a special server-side playlist)
	if (!state.username) validateSession();
	var basePath;
	if (kind === "favorites") {
		basePath = state.username
			? ("/users/" + encodeURIComponent(state.username) + "/videos/favourites")
			: "/my/favorites/videos";
	} else {
		basePath = state.username
			? ("/users/" + encodeURIComponent(state.username) + "/videos/watch-later")
			: "/playlist/watch-later";
	}
	var out = [];
	for (var page = 1; page <= 50; page++) {
		var url = URL_BASE + basePath + buildQuery({ page: page });
		var html;
		try { html = httpGET(url, {}); } catch (e) { log("virtualPL " + kind + " p" + page + " err: " + e); break; }
		var parsed = _parsePlaylistVideos(html);
		if (!parsed.videos.length) break;
		for (var i = 0; i < parsed.videos.length; i++) out.push(parsed.videos[i]);
		if (!parsed.hasNext) break;
	}
	return out;
}

function getVirtualPlaylistDetails(url) {
	if (!source.isLoggedIn()) throw new ScriptException("Login required for " + url);
	var kind = (url === VPL_FAVORITES) ? "favorites" : "watch-later";
	var videos = _fetchVirtualPlaylistVideos(kind);
	var name = (kind === "favorites") ? "Favorites" : "Watch Later";
	var author = state.username
		? new PlatformAuthorLink(new PlatformID(PLATFORM, state.username, config.id),
			state.username, URL_BASE + "/users/" + encodeURIComponent(state.username), "")
		: new PlatformAuthorLink(new PlatformID(PLATFORM, "", config.id), "", "", "");
	var pvids = videos.map(_videoToPlatformVideo);
	return new PlatformPlaylistDetails({
		id: new PlatformID(PLATFORM, kind, config.id),
		name: name,
		thumbnail: (videos[0] && videos[0].thumb) || "",
		author: author,
		datetime: Math.floor(Date.now() / 1000),
		url: url,
		videoCount: pvids.length,
		contents: new VideoPager(pvids, false)
	});
}

// ====================================================================
// Subscription & playlist migration
// ====================================================================

source.getUserSubscriptions = function () {
	try {
		if (!source.isLoggedIn()) {
			log("getUserSubscriptions: not logged in");
			return [];
		}
		if (!state.username) validateSession();
		var seen = {};
		var out = [];
		// Pornhub paginates subscriptions at /users/<name>/subscriptions?page=N
		var paths = state.username
			? [
				"/users/" + encodeURIComponent(state.username) + "/subscriptions",
				"/my/subscriptions"
			]
			: ["/my/subscriptions"];
		for (var pi = 0; pi < paths.length && out.length === 0; pi++) {
			var basePath = paths[pi];
			for (var page = 1; page <= 50; page++) {
				var url = URL_BASE + basePath + buildQuery({ page: page });
				var html;
				try { html = httpGET(url, {}); } catch (e) { log("getUserSubscriptions " + basePath + " p" + page + ": " + e); break; }
				var dom = domParser.parseFromString(html);
				// Match channel/model/pornstar links inside subscription tiles.
				var anchors = dom.querySelectorAll("a[href^='/model/'], a[href^='/pornstar/'], a[href^='/channels/']");
				var pageFound = 0;
				for (var i = 0; i < anchors.length; i++) {
					var href = anchors[i].getAttribute("href") || "";
					// Only consume the canonical profile root, not sub-pages.
					var m = href.match(/^\/(model|pornstar|channels)\/([^\/\?#]+)\/?$/);
					if (!m) continue;
					var key = m[1] + "/" + m[2];
					if (seen[key]) continue;
					seen[key] = true;
					out.push(URL_BASE + "/" + key);
					pageFound++;
				}
				if (pageFound === 0) break;
				var pageNext = dom.querySelector("li.page_next a, a.page_next");
				if (!pageNext) break;
				var h = pageNext.getAttribute("href") || "";
				if (!h || h === "#") break;
			}
		}
		log("getUserSubscriptions: returning " + out.length + " channel(s)");
		return out;
	} catch (e) {
		log("getUserSubscriptions error: " + e);
		return [];
	}
};

source.getUserPlaylists = function () {
	try {
		if (!source.isLoggedIn()) {
			log("getUserPlaylists: not logged in");
			return [];
		}
		if (!state.username) validateSession();
		var seen = {};
		var out = [];
		// User-owned playlists at /users/<name>/playlists?page=N
		var paths = state.username
			? [
				"/users/" + encodeURIComponent(state.username) + "/playlists",
				"/my/playlists"
			]
			: ["/my/playlists"];
		for (var pi = 0; pi < paths.length && out.length === 0; pi++) {
			var basePath = paths[pi];
			for (var page = 1; page <= 20; page++) {
				var url = URL_BASE + basePath + buildQuery({ page: page });
				var html;
				try { html = httpGET(url, {}); } catch (e) { log("getUserPlaylists " + basePath + " p" + page + ": " + e); break; }
				var items = _parsePlaylistListItems(html);
				if (!items.length) {
					// Also try harvesting via direct anchor scan, in case the DOM
					// shape on /users/<name>/playlists is different.
					var dom2 = domParser.parseFromString(html);
					var as = dom2.querySelectorAll("a[href*='/playlist/']");
					for (var j = 0; j < as.length; j++) {
						var href = as[j].getAttribute("href") || "";
						var mm = href.match(/\/playlist\/(\d+)/);
						if (!mm) continue;
						if (seen[mm[1]]) continue;
						seen[mm[1]] = true;
						out.push(_playlistUrlFromId(mm[1]));
					}
					if (out.length === 0) break;
					continue;
				}
				var added = 0;
				for (var i = 0; i < items.length; i++) {
					var p = items[i];
					if (!p.id || seen[p.id]) continue;
					seen[p.id] = true;
					out.push(_playlistUrlFromId(p.id));
					added++;
				}
				if (!added) break;
			}
		}
		// Append virtual lists (always available when logged in).
		out.push(VPL_FAVORITES);
		out.push(VPL_WATCH_LATER);
		log("getUserPlaylists: returning " + out.length + " playlist(s) (incl. Favorites + Watch Later)");
		return out;
	} catch (e) {
		log("getUserPlaylists error: " + e);
		return [];
	}
};

// ====================================================================
// Remote watch history (Pornhub -> Grayjay)
// ====================================================================

// Build a PlatformVideo for watch-history import. CRITICAL (per Grayjay):
//   - playbackDate must be > 0 AND must be passed IN the constructor.
//   - playbackTime must be > 0 AND must be passed IN the constructor, else
//     Grayjay silently drops the entry from sync.
function _createHistoryPlatformVideo(v, watchedSecondsOrder) {
	var playbackDate = (watchedSecondsOrder && watchedSecondsOrder.watchedAt > 0)
		? watchedSecondsOrder.watchedAt
		: Math.floor(Date.now() / 1000) - (watchedSecondsOrder ? watchedSecondsOrder.order * 60 : 0);
	var playbackTime = Math.max(60, Math.floor((v.duration || 300) * 0.5));
	return new PlatformVideo({
		id: new PlatformID(PLATFORM, v.id, config.id),
		name: v.name || "",
		thumbnails: new Thumbnails([new Thumbnail(v.thumb || "", 0)]),
		author: new PlatformAuthorLink(new PlatformID(PLATFORM, v.authorName || "", config.id),
			v.authorName || "",
			v.authorUrl || "",
			""),
		datetime: v.datetime || playbackDate,
		duration: v.duration || 0,
		viewCount: v.views || 0,
		url: v.videoUrl,
		isLive: false,
		playbackDate: playbackDate,
		playbackTime: playbackTime
	});
}

// Grayjay detects "Sync Remote History" support by the presence of
// source.getUserHistory. When enabled, this is called on startup.
source.getUserHistory = function () {
	return source.syncRemoteWatchHistory(null);
};

source.syncRemoteWatchHistory = function (continuationToken) {
	try {
		log("===== syncRemoteWatchHistory START =====");
		if (!source.isLoggedIn()) {
			log("syncRemoteWatchHistory: not logged in, skipping");
			return new VideoPager([], false, { token: null });
		}
		if (!state.username) validateSession();

		// Pornhub keeps "Recently watched" / "Watch history" at:
		//   /my/recently-watched           (modern)
		//   /users/<name>/videos/recent    (alternate / older URL)
		var historyPaths = state.username
			? [
				"/users/" + encodeURIComponent(state.username) + "/videos/recent",
				"/my/recently-watched"
			]
			: ["/my/recently-watched"];
		var allItems = [];
		for (var pi = 0; pi < historyPaths.length && allItems.length === 0; pi++) {
			var basePath = historyPaths[pi];
			for (var page = 1; page <= 50; page++) {
				var url = URL_BASE + basePath + buildQuery({ page: page });
				var html;
				try { html = httpGET(url, {}); } catch (e) {
					log("syncRemoteWatchHistory " + basePath + " p" + page + ": " + e);
					break;
				}
				var parsed = _parsePlaylistVideos(html);
				if (!parsed.videos.length) break;
				for (var i = 0; i < parsed.videos.length; i++) allItems.push(parsed.videos[i]);
				if (!parsed.hasNext) break;
			}
		}
		if (!allItems.length) {
			log("syncRemoteWatchHistory: no history found");
			return new VideoPager([], false, { token: null });
		}
		var out = [];
		for (var k = 0; k < allItems.length; k++) {
			out.push(_createHistoryPlatformVideo(allItems[k], { watchedAt: 0, order: k }));
		}
		log("syncRemoteWatchHistory: returning " + out.length + " items");
		log("===== syncRemoteWatchHistory END =====");
		return new VideoPager(out, false, { token: null });
	} catch (e) {
		log("syncRemoteWatchHistory error: " + e);
		return new VideoPager([], false, { token: null });
	}
};

log("LOADED");
