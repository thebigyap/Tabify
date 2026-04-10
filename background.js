let runningCheck = false;
var tabsMap = new Map();

/**
 * BOLT OPTIMIZATION: Settings Cache
 * Synchronous access to extension settings to avoid repeated asynchronous chrome.storage lookups.
 */
let settingsCache = {
	ignoredWebsites: new Set(),
	ignoreQueryStrings: false,
	ignoreAnchorTags: false,
	switchToOriginalTab: false,
	extensionEnabled: false
};

function normalizeIgnoredWebsites(values) {
	const next = new Set();
	for (const value of Array.isArray(values) ? values : []) {
		if (typeof value !== "string") continue;
		const canonical = canonicalize(value);
		next.add(canonical || value);
	}
	return Array.from(next);
}

// Update cache when storage changes
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "sync") return;
	for (let key in changes) {
		if (Object.prototype.hasOwnProperty.call(settingsCache, key)) {
			if (key === "ignoredWebsites") {
				settingsCache.ignoredWebsites = new Set(normalizeIgnoredWebsites(changes[key].newValue));
			} else {
				settingsCache[key] = changes[key].newValue;
			}
			console.log(`[CACHE]: Updated ${key}`);

			if (key === "extensionEnabled") {
				const iconPath = settingsCache.extensionEnabled
					? "assets/images/blue_happy_128.png"
					: "assets/images/disabled_sad_128.png";

				chrome.action.setIcon({ path: iconPath }, () => {
					console.log(`[ICON]: Updated to ${iconPath}`);
				});
			}
		}
	}
});

async function loadSettings() {
	return new Promise(resolve => {
		chrome.storage.sync.get([
			"ignoredWebsites",
			"ignoreQueryStrings",
			"ignoreAnchorTags",
			"switchToOriginalTab",
			"extensionEnabled"
		], async result => {
			const normalizedIgnored = normalizeIgnoredWebsites(result.ignoredWebsites);
			settingsCache.ignoredWebsites = new Set(normalizedIgnored);
			settingsCache.ignoreQueryStrings = !!result.ignoreQueryStrings;
			settingsCache.ignoreAnchorTags = !!result.ignoreAnchorTags;
			settingsCache.switchToOriginalTab = !!result.switchToOriginalTab;
			settingsCache.extensionEnabled = !!result.extensionEnabled;
			const originalIgnored = Array.isArray(result.ignoredWebsites) ? result.ignoredWebsites : [];
			const needsMigration = originalIgnored.length !== normalizedIgnored.length
				|| originalIgnored.some((url, index) => normalizedIgnored[index] !== url);
			if (needsMigration) {
				await new Promise(saveResolve => chrome.storage.sync.set({ ignoredWebsites: normalizedIgnored }, saveResolve));
			}
			resolve();
		});
	});
}

var tabCheck = function () {
	console.log("Running tabCheck: checking all duplicates...");
	checkAllDuplicates();
};

var tabsIgnored = function () {
	console.log("Ignored Websites:", settingsCache.ignoredWebsites);
}

/**
 * BOLT OPTIMIZATION: O(n) Duplicate Check
 * Instead of O(n^2) by calling checkForDuplicate for each tab, we do a single pass.
 */
async function checkAllDuplicates() {
	if (runningCheck) return;
	runningCheck = true;
	console.log("Running batch duplicate check...");

	try {
		await ensureTabsMapInitialized();
		const tabsToRemove = [];
		const seenUrls = new Map();
		const seenBaseUrlsQS = new Map();
		const seenBaseUrlsAnchor = new Map();
		let firstOriginalTabId = null;

		// To match current behavior of "closing the new one and selecting the old one",
		// we keep the first one we encounter and mark subsequent ones as duplicates.

		for (const tab of tabsMap.values()) {
			if (!tab.url) continue;

			// Skip NTP tabs
			if (tab.url.includes("://newtab")) continue;

			// Skip Bing search tabs
			if (tab.url.includes("search?") && tab.url.includes("bing.com")) continue;

			// Check if tab is ignored
			const canonicalUrl = canonicalize(tab.url);
			if (settingsCache.ignoredWebsites.has(tab.url) || (canonicalUrl && settingsCache.ignoredWebsites.has(canonicalUrl))) continue;

			let isDuplicate = false;
			let originalTabId = null;

			// Exact match
			if (seenUrls.has(tab.url)) {
				isDuplicate = true;
				originalTabId = seenUrls.get(tab.url);
			} else {
				// Query-stripped match
				if (settingsCache.ignoreQueryStrings) {
					const baseUrl = tab.url.split("?")[0];
					if (seenBaseUrlsQS.has(baseUrl)) {
						isDuplicate = true;
						originalTabId = seenBaseUrlsQS.get(baseUrl);
					}
				}

				// Anchor-stripped match
				if (!isDuplicate && settingsCache.ignoreAnchorTags) {
					const baseUrl = tab.url.split("#")[0];
					if (seenBaseUrlsAnchor.has(baseUrl)) {
						isDuplicate = true;
						originalTabId = seenBaseUrlsAnchor.get(baseUrl);
					}
				}
			}

			if (isDuplicate) {
				tabsToRemove.push(tab.id);
				if (settingsCache.switchToOriginalTab && firstOriginalTabId === null && typeof originalTabId === "number") {
					firstOriginalTabId = originalTabId;
				}
			} else {
				seenUrls.set(tab.url, tab.id);
				if (settingsCache.ignoreQueryStrings) seenBaseUrlsQS.set(tab.url.split("?")[0], tab.id);
				if (settingsCache.ignoreAnchorTags) seenBaseUrlsAnchor.set(tab.url.split("#")[0], tab.id);
			}
		}

		if (tabsToRemove.length > 0) {
			console.log(`Removing ${tabsToRemove.length} duplicate tabs...`);
			chrome.tabs.remove(tabsToRemove);
			if (settingsCache.switchToOriginalTab && firstOriginalTabId !== null) {
				chrome.tabs.update(firstOriginalTabId, { active: true }, () => void chrome.runtime.lastError);
			}
		}
	} catch (error) {
		console.error("Error in checkAllDuplicates:", error);
	} finally {
		runningCheck = false;
	}
}

// LISTENER FOR COMMUNICATION WITH `popup.js`
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
	const act = request.action;
	if (act === "checkAllDuplicates") {
		checkAllDuplicates();
	}
	// Note: updateCache message is now handled by chrome.storage.onChanged
});

async function initializeExtension() {
	// Load settings into cache first
	await loadSettings();

	// Make sure we use the large icon
	const iconPath = settingsCache.extensionEnabled
		? "assets/images/blue_happy_128.png"
		: "assets/images/disabled_sad_128.png";

	chrome.action.setIcon({ path: iconPath }, () => {
		console.log(`[ICON]: Updated to ${iconPath}`);
	});

	// Add existing tabs to tabsMap
	chrome.tabs.query({}, function (existingTabs) {
		tabsMap.clear();
		for (const tab of existingTabs) {
			tabsMap.set(tab.id, tab);
		}
		console.log("Initialized tabsMap with", tabsMap.size, "tabs");
	});

	setTimeout(function () {
		// Check for duplicate tabs in tabsMap
		if (settingsCache.extensionEnabled) {
			checkAllDuplicates();
		}
	}, 10000); // Wait a couple seconds to allow the browser to start up and load pages before activating the plugin

	console.log("Extension Loaded.\ntabsMap: ", tabsMap);
	return;
}

/**
 * BOLT OPTIMIZATION: Synchronous Check with Cache
 * We now use settingsCache instead of asynchronous storage lookups.
 */
async function checkForDuplicate(tab, preventSwitch = false) {
	if (runningCheck || !tab.url) return;
	runningCheck = true;
	console.log("Checking for duplicate tab:", tab.id, tab.url);

	try {
		await ensureTabsMapInitialized();
		// Skip NTP tabs
		if (tab.url.includes("://newtab")) {
			console.log(tab, "Cannot remove NTP tab.");
			return;
		}

		// Skip Bing search tabs
		if (tab.url.includes("search?") && tab.url.includes("bing.com")) {
			console.log(tab, "Ignoring bing search tab.");
			return;
		}

		// Check if tab is ignored (using cache)
		const canonicalUrl = canonicalize(tab.url);
		if (settingsCache.ignoredWebsites.has(tab.url) || (canonicalUrl && settingsCache.ignoredWebsites.has(canonicalUrl))) {
			console.log(tab.url, "is ignored, not checking for duplicates.");
			return;
		}

		// Check for duplicates
		let isDuplicate = false;
		let originalTab = null;

		for (const t of tabsMap.values()) {
			if (t.id === tab.id) continue;

			// Exact match
			if (t.url === tab.url) {
				isDuplicate = true;
				originalTab = t;
				break;
			}

			// Query-stripped match
			if (settingsCache.ignoreQueryStrings) {
				const baseUrl = tab.url.split("?")[0];
				if (t.url && t.url.split("?")[0] === baseUrl) {
					isDuplicate = true;
					originalTab = t;
					break;
				}
			}

			// Anchor-stripped match
			if (settingsCache.ignoreAnchorTags) {
				const baseUrl = tab.url.split("#")[0];
				if (t.url && t.url.split("#")[0] === baseUrl) {
					isDuplicate = true;
					originalTab = t;
					break;
				}
			}

			// Pending URL match
			if (tab.pendingUrl !== undefined && t.url === tab.pendingUrl) {
				isDuplicate = true;
				originalTab = t;
				break;
			}
		}

		if (isDuplicate) {
			chrome.tabs.remove(tab.id, function () {
				if (!originalTab || preventSwitch) return;

				if (settingsCache.switchToOriginalTab) {
					chrome.tabs.update(originalTab.id, { active: true }, function (updatedTab) {
						console.log("Setting Active Tab:", updatedTab.id, updatedTab);
					});
				}

				console.log("Closed duplicate tab:", tab.id, tab.url, "Dup of:", originalTab?.id, originalTab?.url);
			});
		}
	} finally {
		runningCheck = false;
	}
}

const MENU_ID = "tabify-toggle-ignore";

function ensureContextMenu() {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({
			id: MENU_ID,
			title: "Ignore this site in Tabify",
			contexts: ["page"]
		}, () => void chrome.runtime.lastError);
	});
}

chrome.runtime.onInstalled.addListener((reason) => {
	// Create welcome page
	if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
		chrome.tabs.create({
			url: "welcome.html"
		});
	}

	ensureContextMenu();
	initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
	ensureContextMenu();
	initializeExtension();
});

// CREATE TAB LISTENER
chrome.tabs.onCreated.addListener(function (newTab) {
	tabsMap.set(newTab.id, newTab);
	console.log("New tab", newTab.id);
});

// UPDATE TAB LISTENER
chrome.tabs.onUpdated.addListener(async function (tabID, changeInfo, updatedTab) {
	const isEnabled = settingsCache.extensionEnabled;

	// Ignore favIcon, title changes, and loading tabs
	if (changeInfo.favIconUrl
		|| changeInfo.title
		|| (changeInfo.status && changeInfo.status === "loading"))
		return;

	console.log("changeInfo:", changeInfo);

	if (changeInfo.status === "complete") {
		tabsMap.set(tabID, updatedTab);
		if (isEnabled) {
			checkForDuplicate(updatedTab);
		}
	}
});

// REMOVE TAB LISTENER
chrome.tabs.onRemoved.addListener(function (tabID) {
	try {
		// Remove the tab from the map
		if (tabsMap.delete(tabID)) {
			console.log("Removed tab", tabID);
		}
	}
	catch (error) {
		console.log("ERROR:", error);
	}
});

// Canonicalize a page URL I.E. https://www.example.com/
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

function ensureTabsMapInitialized() {
	if (tabsMap.size > 0) return Promise.resolve();
	return new Promise(resolve => {
		chrome.tabs.query({}, function (existingTabs) {
			tabsMap.clear();
			for (const tab of existingTabs) {
				tabsMap.set(tab.id, tab);
			}
			resolve();
		});
	});
}

function getIgnored() {
	return new Promise(resolve => {
		chrome.storage.sync.get(["ignoredWebsites"], res =>
			resolve(normalizeIgnoredWebsites(res.ignoredWebsites))
		);
	});
}

function setIgnored(next) {
	return new Promise(resolve => {
		const normalized = normalizeIgnoredWebsites(next);
		chrome.storage.sync.set({ ignoredWebsites: normalized }, () => {
			// Optional broadcast, but silences "Receiving end does not exist"
			try {
				chrome.runtime.sendMessage(
					{ action: "updateCache", setting: "ignoreWebsite", value: normalized },
					() => void chrome.runtime.lastError // read lastError to suppress warning
				);
			} catch (_) { /* ignore */ }
			resolve();
		});
	});
}

// Refresh the menu title for a given URL
async function refreshMenuTitleForUrl(rawUrl) {
	const site = canonicalize(rawUrl);
	if (!site) {
		try {
			chrome.contextMenus.update(MENU_ID, { title: "Ignore this site in Tabify" });
			try { chrome.contextMenus.refresh(); } catch { } // Edge may not have refresh
		} catch (error) {
			console.warn("Failed to update context menu:", error);
		}
		return;
	}

	const list = await getIgnored();
	const isIgnored = list.includes(site);

	try {
		chrome.contextMenus.update(MENU_ID, {
			title: isIgnored ? "Unignore this site in Tabify" : "Ignore this site in Tabify"
		});
		try { chrome.contextMenus.refresh(); } catch { } // Edge may not have refresh
	} catch (error) {
		console.warn("Failed to update context menu:", error);
	}
}

// Prefer onShown when available; otherwise fall back to tab events
if (chrome.contextMenus && chrome.contextMenus.onShown) {
	chrome.contextMenus.onShown.addListener((info, tab) => {
		const url = info.pageUrl || tab?.url || "";
		refreshMenuTitleForUrl(url);
	});
} else {
	// Edge fallback
	chrome.tabs.onActivated.addListener(async ({ tabId }) => {
		try {
			const tab = await chrome.tabs.get(tabId);
			refreshMenuTitleForUrl(tab.url || "");
		} catch { }
	});
	chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		if (changeInfo.status === "complete" || changeInfo.url) {
			refreshMenuTitleForUrl((tab && (tab.url || changeInfo.url)) || "");
		}
	});
}

// Toggle on click
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId !== MENU_ID) return;

	const url = info.pageUrl || tab?.url || "";
	const site = canonicalize(url);
	if (!site) return;

	const list = await getIgnored();
	const exists = list.includes(site);
	const next = exists ? list.filter(u => u !== site) : Array.from(new Set([...list, site]));
	await setIgnored(next);
	refreshMenuTitleForUrl(url);
});
