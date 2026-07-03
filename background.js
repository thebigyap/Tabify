/**
 * Tabify — background service worker
 *
 * Keeps a single tab per page by detecting duplicates and closing the newest one
 * (optionally jumping to the original). Designed for Manifest V3, where the
 * service worker is torn down and restarted on demand, so all state is rebuilt
 * lazily and every event waits for settings to be ready before acting.
 */

const STORAGE_KEYS = [
	"ignoredWebsites",
	"ignoreQueryStrings",
	"ignoreAnchorTags",
	"switchToOriginalTab",
	"extensionEnabled",
];

const ICON_ENABLED = "assets/images/blue_happy_128.png";
const ICON_DISABLED = "assets/images/disabled_sad_128.png";

const MENU_IGNORE = "tabify-toggle-ignore";
const MENU_CLOSE_DUPES = "tabify-close-duplicates";

/** In-memory mirror of every open tab, keyed by tab id. Rebuilt on demand. */
const tabsMap = new Map();

/** Live, synchronous view of settings. ignoredWebsites is a Set of origins. */
const settings = {
	ignoredWebsites: new Set(),
	ignoreQueryStrings: false,
	ignoreAnchorTags: false,
	switchToOriginalTab: false,
	extensionEnabled: false,
};

/* --------------------------------------------------------------------------
 * Settings
 *
 * In MV3 the worker can be killed at any time and restarted by an event. The
 * old code only loaded settings on install/startup, so an event-driven restart
 * left `extensionEnabled` stuck at its default (false) and silently disabled
 * the extension. We kick off a load at top level (runs on every wake) and have
 * every handler await it before reading `settings`.
 * ------------------------------------------------------------------------ */

function normalizeIgnoredWebsites(values) {
	const next = new Set();
	for (const value of Array.isArray(values) ? values : []) {
		if (typeof value !== "string") continue;
		const canonical = canonicalize(value);
		next.add(canonical || value);
	}
	return Array.from(next);
}

async function loadSettings() {
	const result = await chrome.storage.sync.get(STORAGE_KEYS);

	const normalizedIgnored = normalizeIgnoredWebsites(result.ignoredWebsites);
	settings.ignoredWebsites = new Set(normalizedIgnored);
	settings.ignoreQueryStrings = !!result.ignoreQueryStrings;
	settings.ignoreAnchorTags = !!result.ignoreAnchorTags;
	settings.switchToOriginalTab = !!result.switchToOriginalTab;
	settings.extensionEnabled = !!result.extensionEnabled;

	// One-time migration: rewrite any legacy/loose entries as canonical origins.
	const original = Array.isArray(result.ignoredWebsites) ? result.ignoredWebsites : [];
	const changed = original.length !== normalizedIgnored.length
		|| original.some((url, i) => normalizedIgnored[i] !== url);
	if (changed) {
		await chrome.storage.sync.set({ ignoredWebsites: normalizedIgnored });
	}

	updateIcon();
}

// Runs on every service-worker wake, not just install/startup.
let settingsReady = loadSettings();

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "sync") return;

	let touchedMatching = false;
	for (const key in changes) {
		if (key === "ignoredWebsites") {
			settings.ignoredWebsites = new Set(normalizeIgnoredWebsites(changes[key].newValue));
			touchedMatching = true;
		} else if (key === "extensionEnabled") {
			settings.extensionEnabled = !!changes[key].newValue;
			updateIcon();
			touchedMatching = true;
		} else if (key === "ignoreQueryStrings" || key === "ignoreAnchorTags") {
			settings[key] = !!changes[key].newValue;
			touchedMatching = true;
		} else if (key === "switchToOriginalTab") {
			settings.switchToOriginalTab = !!changes[key].newValue;
		}
	}

	// Any change that affects what counts as a duplicate should re-scan
	// immediately so the popup's promise of "applies right away" holds true.
	if (touchedMatching && settings.extensionEnabled) scheduleScan();
});

function updateIcon() {
	const path = settings.extensionEnabled ? ICON_ENABLED : ICON_DISABLED;
	chrome.action.setIcon({ path }, () => void chrome.runtime.lastError);
}

/* --------------------------------------------------------------------------
 * URL helpers
 * ------------------------------------------------------------------------ */

// Canonicalize a page URL to its origin, e.g. https://www.example.com/
function canonicalize(raw) {
	if (!raw) return null;
	try {
		const u = new URL(raw);
		if (u.protocol !== "http:" && u.protocol !== "https:") return null;

		const isLocal = h => h === "localhost" || h.endsWith(".localhost");
		const isIp = h => /^[0-9.]+$/.test(h) || h.includes(":");

		let host = u.hostname.toLowerCase();
		if (!host.includes(".") && !isLocal(host) && !isIp(host)) host += ".com";

		const dotCount = (host.match(/\./g) || []).length;
		if (!host.startsWith("www.") && dotCount === 1 && !isLocal(host) && !isIp(host)) host = "www." + host;

		const scheme = (isLocal(host) || isIp(host)) ? "http" : "https";
		return `${scheme}://${host}/`;
	} catch {
		return null;
	}
}

const stripQuery = url => url.split("?")[0];
const stripAnchor = url => url.split("#")[0];

// Pages we never touch: new-tab pages and Bing's search results (which reuse
// one URL shape across many distinct searches).
function isSkippable(url) {
	if (!url) return true;
	if (url.includes("://newtab")) return true;
	if (url.includes("bing.com") && url.includes("search?")) return true;
	return false;
}

function isIgnored(url) {
	if (settings.ignoredWebsites.has(url)) return true;
	const canonical = canonicalize(url);
	return !!canonical && settings.ignoredWebsites.has(canonical);
}

function urlsMatch(a, b) {
	if (a === b) return true;
	if (settings.ignoreQueryStrings && stripQuery(a) === stripQuery(b)) return true;
	if (settings.ignoreAnchorTags && stripAnchor(a) === stripAnchor(b)) return true;
	return false;
}

/* --------------------------------------------------------------------------
 * Tab map
 * ------------------------------------------------------------------------ */

async function ensureTabsMapInitialized() {
	if (tabsMap.size > 0) return;
	const existing = await chrome.tabs.query({});
	tabsMap.clear();
	for (const tab of existing) tabsMap.set(tab.id, tab);
}

function removeTabs(idOrIds) {
	return new Promise(resolve => {
		chrome.tabs.remove(idOrIds, () => {
			void chrome.runtime.lastError;
			resolve();
		});
	});
}

function activateTab(id) {
	return new Promise(resolve => {
		chrome.tabs.update(id, { active: true }, () => {
			void chrome.runtime.lastError;
			resolve();
		});
	});
}

/* --------------------------------------------------------------------------
 * Duplicate detection
 *
 * Every check runs through a single promise chain so two checks never overlap.
 * Without this, two tabs that are duplicates of each other could each see the
 * other and both get closed. Tabs we decide to close are removed from the map
 * synchronously so a queued check won't treat them as live originals.
 * ------------------------------------------------------------------------ */

let checkChain = Promise.resolve();
let scanTimer = null;

function enqueue(task) {
	checkChain = checkChain.then(task).catch(err => console.error("[Tabify]", err));
	return checkChain;
}

// Coalesce bursts of events (e.g. session restore) into one full scan.
function scheduleScan(delay = 150) {
	if (scanTimer) clearTimeout(scanTimer);
	scanTimer = setTimeout(() => {
		scanTimer = null;
		enqueue(() => checkAllDuplicates());
	}, delay);
}

// Check a single freshly-loaded tab against everything else. Closes THIS tab
// (the newer one) when it matches an existing tab, matching Tabify's contract
// of "keep the tab you already had open".
async function checkForDuplicate(tab) {
	await settingsReady;
	await ensureTabsMapInitialized();

	if (!settings.extensionEnabled || !tab || !tab.url) return;
	if (isSkippable(tab.url) || isIgnored(tab.url)) return;

	let originalId = null;
	for (const other of tabsMap.values()) {
		if (other.id === tab.id || !other.url) continue;
		if (urlsMatch(tab.url, other.url) || (tab.pendingUrl && other.url === tab.pendingUrl)) {
			originalId = other.id;
			break;
		}
	}

	if (originalId === null) return;

	tabsMap.delete(tab.id);
	await removeTabs(tab.id);
	if (settings.switchToOriginalTab) await activateTab(originalId);
}

// Single O(n) pass over all tabs, keeping the first occurrence of each URL and
// closing later duplicates. `force` lets the "Close duplicates now" menu item
// work even while the extension is toggled off.
async function checkAllDuplicates(force = false) {
	await settingsReady;
	await ensureTabsMapInitialized();

	if (!settings.extensionEnabled && !force) return;

	const seenExact = new Map();
	const seenQuery = new Map();
	const seenAnchor = new Map();
	const toRemove = [];
	let switchTo = null;

	for (const tab of tabsMap.values()) {
		if (!tab.url || isSkippable(tab.url) || isIgnored(tab.url)) continue;

		let originalId = null;
		if (seenExact.has(tab.url)) {
			originalId = seenExact.get(tab.url);
		} else if (settings.ignoreQueryStrings && seenQuery.has(stripQuery(tab.url))) {
			originalId = seenQuery.get(stripQuery(tab.url));
		} else if (settings.ignoreAnchorTags && seenAnchor.has(stripAnchor(tab.url))) {
			originalId = seenAnchor.get(stripAnchor(tab.url));
		}

		if (originalId !== null) {
			toRemove.push(tab.id);
			if (settings.switchToOriginalTab && switchTo === null) switchTo = originalId;
		} else {
			seenExact.set(tab.url, tab.id);
			if (settings.ignoreQueryStrings) seenQuery.set(stripQuery(tab.url), tab.id);
			if (settings.ignoreAnchorTags) seenAnchor.set(stripAnchor(tab.url), tab.id);
		}
	}

	if (toRemove.length === 0) return;

	for (const id of toRemove) tabsMap.delete(id);
	await removeTabs(toRemove);
	if (settings.switchToOriginalTab && switchTo !== null) await activateTab(switchTo);
}

/* --------------------------------------------------------------------------
 * Tab lifecycle listeners
 * ------------------------------------------------------------------------ */

chrome.tabs.onCreated.addListener(tab => {
	tabsMap.set(tab.id, tab);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	// Ignore noise: favicon/title updates and the "loading" phase.
	if (changeInfo.favIconUrl || changeInfo.title) return;
	if (changeInfo.status !== "complete") return;

	tabsMap.set(tabId, tab);
	// Always enqueue; checkForDuplicate awaits settingsReady and no-ops when the
	// extension is off. Gating here would miss events fired before settings load
	// on a fresh service-worker wake.
	enqueue(() => checkForDuplicate(tab));
});

chrome.tabs.onRemoved.addListener(tabId => {
	tabsMap.delete(tabId);
});

/* --------------------------------------------------------------------------
 * Context menu
 * ------------------------------------------------------------------------ */

function ensureContextMenu() {
	chrome.contextMenus.removeAll(() => {
		void chrome.runtime.lastError;
		chrome.contextMenus.create({
			id: MENU_IGNORE,
			title: "Ignore this site in Tabify",
			contexts: ["page"],
		}, () => void chrome.runtime.lastError);
		chrome.contextMenus.create({
			id: MENU_CLOSE_DUPES,
			title: "Close duplicate tabs now",
			contexts: ["page", "action"],
		}, () => void chrome.runtime.lastError);
	});
}

function getIgnored() {
	return chrome.storage.sync.get(["ignoredWebsites"])
		.then(res => normalizeIgnoredWebsites(res.ignoredWebsites));
}

async function setIgnored(next) {
	await chrome.storage.sync.set({ ignoredWebsites: normalizeIgnoredWebsites(next) });
}

// Reflect whether the current site is ignored in the menu label.
async function refreshMenuTitleForUrl(rawUrl) {
	const site = canonicalize(rawUrl);
	let title = "Ignore this site in Tabify";
	if (site) {
		const list = await getIgnored();
		if (list.includes(site)) title = "Unignore this site in Tabify";
	}
	try {
		chrome.contextMenus.update(MENU_IGNORE, { title });
		chrome.contextMenus.refresh?.();
	} catch { /* menu may not exist yet */ }
}

if (chrome.contextMenus.onShown) {
	chrome.contextMenus.onShown.addListener((info, tab) => {
		refreshMenuTitleForUrl(info.pageUrl || tab?.url || "");
	});
} else {
	// Edge fallback: keep the label fresh as the active tab changes.
	chrome.tabs.onActivated.addListener(async ({ tabId }) => {
		try {
			const tab = await chrome.tabs.get(tabId);
			refreshMenuTitleForUrl(tab.url || "");
		} catch { /* tab gone */ }
	});
	chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		if (changeInfo.status === "complete" || changeInfo.url) {
			refreshMenuTitleForUrl(tab?.url || changeInfo.url || "");
		}
	});
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === MENU_CLOSE_DUPES) {
		enqueue(() => checkAllDuplicates(true));
		return;
	}

	if (info.menuItemId === MENU_IGNORE) {
		const site = canonicalize(info.pageUrl || tab?.url || "");
		if (!site) return;
		const list = await getIgnored();
		const next = list.includes(site)
			? list.filter(u => u !== site)
			: [...list, site];
		await setIgnored(next);
		refreshMenuTitleForUrl(info.pageUrl || tab?.url || "");
	}
});

/* --------------------------------------------------------------------------
 * Install / startup
 * ------------------------------------------------------------------------ */

async function applyInstallDefaults() {
	// Tabify should work the moment it's installed, so default it on. Only fill
	// in keys that aren't set yet — never clobber an existing user's choices.
	const current = await chrome.storage.sync.get(STORAGE_KEYS);
	const defaults = {
		extensionEnabled: true,
		ignoreQueryStrings: false,
		ignoreAnchorTags: false,
		switchToOriginalTab: true,
		ignoredWebsites: [],
	};
	const toSet = {};
	for (const key of STORAGE_KEYS) {
		if (current[key] === undefined) toSet[key] = defaults[key];
	}
	if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
}

chrome.runtime.onInstalled.addListener(async details => {
	ensureContextMenu();

	if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
		await applyInstallDefaults();
		settingsReady = loadSettings();
		await settingsReady;
		chrome.tabs.create({ url: "welcome.html" });
	}

	await settingsReady;
	scheduleScan(1000);
});

chrome.runtime.onStartup.addListener(() => {
	ensureContextMenu();
	settingsReady = loadSettings();
	// Give the browser a moment to restore the session before the first scan.
	scheduleScan(10000);
});
