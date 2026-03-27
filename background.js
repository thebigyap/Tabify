let runningCheck = false;
var tabArr = [];

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

// Update cache when storage changes
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "sync") return;
	for (let key in changes) {
		if (Object.prototype.hasOwnProperty.call(settingsCache, key)) {
			if (key === "ignoredWebsites") {
				settingsCache.ignoredWebsites = new Set(Array.isArray(changes[key].newValue) ? changes[key].newValue : []);
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
		], result => {
			settingsCache.ignoredWebsites = new Set(Array.isArray(result.ignoredWebsites) ? result.ignoredWebsites : []);
			settingsCache.ignoreQueryStrings = !!result.ignoreQueryStrings;
			settingsCache.ignoreAnchorTags = !!result.ignoreAnchorTags;
			settingsCache.switchToOriginalTab = !!result.switchToOriginalTab;
			settingsCache.extensionEnabled = !!result.extensionEnabled;
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
		const tabsToRemove = [];
		const seenUrls = new Set();
		const seenBaseUrlsQS = new Set();
		const seenBaseUrlsAnchor = new Set();

		// We iterate in reverse to keep the "oldest" tab (usually the one with lower index)
		// actually tabs are added to tabArr in order of creation/detection.
		// To match current behavior of "closing the new one and selecting the old one",
		// we should probably keep the first one we encounter and mark subsequent ones as duplicates.

		for (const tab of tabArr) {
			if (!tab.url) continue;

			// Skip NTP tabs
			if (tab.url.includes("://newtab")) continue;

			// Skip Bing search tabs
			if (tab.url.includes("search?") && tab.url.includes("bing.com")) continue;

			// Check if tab is ignored
			if (settingsCache.ignoredWebsites.has(tab.url)) continue;

			let isDuplicate = false;

			// Exact match
			if (seenUrls.has(tab.url)) {
				isDuplicate = true;
			} else {
				// Query-stripped match
				if (settingsCache.ignoreQueryStrings) {
					const baseUrl = tab.url.split("?")[0];
					if (seenBaseUrlsQS.has(baseUrl)) {
						isDuplicate = true;
					}
				}

				// Anchor-stripped match
				if (!isDuplicate && settingsCache.ignoreAnchorTags) {
					const baseUrl = tab.url.split("#")[0];
					if (seenBaseUrlsAnchor.has(baseUrl)) {
						isDuplicate = true;
					}
				}
			}

			if (isDuplicate) {
				tabsToRemove.push(tab.id);
			} else {
				seenUrls.add(tab.url);
				if (settingsCache.ignoreQueryStrings) seenBaseUrlsQS.add(tab.url.split("?")[0]);
				if (settingsCache.ignoreAnchorTags) seenBaseUrlsAnchor.add(tab.url.split("#")[0]);
			}
		}

		if (tabsToRemove.length > 0) {
			console.log(`Removing ${tabsToRemove.length} duplicate tabs...`);
			chrome.tabs.remove(tabsToRemove);
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

	// Add existing tabs to tabArr
	chrome.tabs.query({}, function (existingTabs) {
		tabArr = existingTabs; // Initialize tabArr with current tabs
		console.log("Initialized tabArr with", tabArr.length, "tabs");
	});

	setTimeout(function () {
		// Check for duplicate tabs in tabArr
		if (settingsCache.extensionEnabled) {
			checkAllDuplicates();
		}
	}, 10000); // Wait a couple seconds to allow the browser to start up and load pages before activating the plugin

	console.log("Extension Loaded.\ntabArr: ", tabArr);
	return;
}

/**
 * BOLT OPTIMIZATION: Synchronous Check with Cache
 * We now use settingsCache instead of asynchronous storage lookups.
 */
function checkForDuplicate(tab, preventSwitch = false) {
	if (runningCheck || !tab.url) return;
	runningCheck = true;
	console.log("Checking for duplicate tab:", tab.id, tab.url);

	try {
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
		if (settingsCache.ignoredWebsites.has(tab.url)) {
			console.log(tab.url, "is ignored, not checking for duplicates.");
			return;
		}

		// Check for exact URL duplicates
		let isDuplicate = tabArr.some(t => t.url === tab.url && t.id !== tab.id);
		console.log("Exact match isDuplicate:", isDuplicate);

		// Check for query-stripped duplicates
		if (!isDuplicate && settingsCache.ignoreQueryStrings) {
			const baseUrl = tab.url.split("?")[0];
			isDuplicate = tabArr.some(t => t && t.url && t.url.split("?")[0] === baseUrl && t.id !== tab.id);
			console.log("Query-stripped isDuplicate:", baseUrl, isDuplicate);
		}

		// Check for anchor-stripped duplicates
		if (!isDuplicate && settingsCache.ignoreAnchorTags) {
			const baseUrl = tab.url.split("#")[0];
			isDuplicate = tabArr.some(t => t && t.url && t.url.split("#")[0] === baseUrl && t.id !== tab.id);
			console.log("Anchor-stripped isDuplicate:", baseUrl, isDuplicate);
		}

		// Check for pending URL duplicates
		const pendingURL = tab.pendingUrl !== undefined
			? tabArr.some(t => t.url === tab.pendingUrl && t.id !== tab.id)
			: false;

		if (isDuplicate || pendingURL) {
			chrome.tabs.remove(tab.id, function () {
				const originalTab = tabArr.find(t => t.url === tab.url && t.id !== tab.id);

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

chrome.runtime.onInstalled.addListener((reason) => {
	// Create welcome page
	if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
		chrome.tabs.create({
			url: "welcome.html"
		});
	}

	chrome.contextMenus.create({
		id: MENU_ID,
		title: "Ignore this site in Tabify",
		contexts: ["page"]
	});

	initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
	initializeExtension();
});

// CREATE TAB LISTENER
chrome.tabs.onCreated.addListener(function (newTab) {
	tabArr.push(newTab);
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

	const tab = tabArr.findIndex(tab => tab.id === tabID);
	if (changeInfo.status === "complete" && tab !== -1) {
		tabArr[tab] = updatedTab;
		if (isEnabled)
			checkForDuplicate(tabArr[tab]);
	}
});

// REMOVE TAB LISTENER
chrome.tabs.onRemoved.addListener(function (tabID) {
	try {
		// Find the index of the tab in the array
		const index = tabArr.findIndex(tab => tab.id === tabID);
		// Remove the tab from the array
		if (index !== -1) {
			tabArr.splice(index, 1);
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

function getIgnored() {
	return new Promise(resolve => {
		chrome.storage.sync.get(["ignoredWebsites"], res =>
			resolve(Array.isArray(res.ignoredWebsites) ? res.ignoredWebsites : [])
		);
	});
}

function setIgnored(next) {
	return new Promise(resolve => {
		chrome.storage.sync.set({ ignoredWebsites: next }, () => {
			// Optional broadcast, but silences "Receiving end does not exist"
			try {
				chrome.runtime.sendMessage(
					{ action: "updateCache", setting: "ignoreWebsite", value: next },
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
