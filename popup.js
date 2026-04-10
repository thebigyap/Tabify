function updateCache(setting, newValue) {
	// Send a message to update the cache in background.js
	chrome.runtime.sendMessage({
		action: "updateCache",
		setting: setting,
		value: newValue
	});
}

function checkAllDuplicates() {
	// Send a message to update the cache in background.js
	chrome.runtime.sendMessage({
		action: "checkAllDuplicates"
	});
}

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

function normalizeIgnoredWebsites(values) {
	const next = new Set();
	for (const value of Array.isArray(values) ? values : []) {
		if (typeof value !== "string") continue;
		const canonical = canonicalize(value);
		next.add(canonical || value);
	}
	return Array.from(next);
}

document.addEventListener("DOMContentLoaded", function () {
	const extensionEnableCheckbox = document.getElementById("extensionEnableCheckbox");
	const stripCheckbox = document.getElementById("stripCheckbox");
	const anchorsCheckbox = document.getElementById("anchorsCheckbox");
	const switchToOriginalTabCheckbox = document.getElementById("switchToOriginalTabCheckbox");
	const ignoreWebsiteButton = document.getElementById("ignoreWebsiteButton");
	const clearWebsitesButton = document.getElementById("clearWebsitesButton");
	const manageWebsitesButton = document.getElementById("manageWebsitesButton");

	chrome.storage.sync.get(["extensionEnabled", "ignoreQueryStrings", "ignoreAnchorTags", "switchToOriginalTab", "ignoredWebsites"], function (result) {
		extensionEnableCheckbox.checked = !!result.extensionEnabled;
		stripCheckbox.checked = !!result.ignoreQueryStrings;
		anchorsCheckbox.checked = !!result.ignoreAnchorTags;
		switchToOriginalTabCheckbox.checked = !!result.switchToOriginalTab;
		chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
			const currentUrl = tabs[0] && tabs[0].url ? tabs[0].url : "";
			const site = canonicalize(currentUrl);
			const ignoredWebsites = normalizeIgnoredWebsites(result.ignoredWebsites);
			const index = site ? ignoredWebsites.indexOf(site) : -1;

			if (index === -1) {
				ignoreWebsiteButton.innerText = "Ignore Website";
			} else {
				ignoreWebsiteButton.innerText = "Unignore Website";
				ignoreWebsiteButton.style.backgroundColor = "#ed3f54";
			}
		});
	});

	// Add `change` event handlers
	extensionEnableCheckbox.addEventListener("change", function () {
		const newValue = this.checked;
		chrome.storage.sync.set({ "extensionEnabled": newValue }, function () {
			updateCache("extensionEnabled", newValue);
			console.log("[SETTING]: extensionEnabled ->", newValue);
			if (newValue === true)
				checkAllDuplicates();
		});
	});
	stripCheckbox.addEventListener("change", function () {
		const newValue = this.checked;
		chrome.storage.sync.set({ "ignoreQueryStrings": newValue }, function () {
			updateCache("ignoreQueryStrings", newValue);
			console.log("[SETTING]: ignoreQueryStrings ->", newValue);
			if (newValue === true)
				checkAllDuplicates();
		});
	});
	anchorsCheckbox.addEventListener("change", function () {
		const newValue = this.checked;
		chrome.storage.sync.set({ "ignoreAnchorTags": newValue }, function () {
			updateCache("ignoreAnchorTags", newValue);
			console.log("[SETTING]: ignoreAnchorTags ->", newValue);
			if (newValue === true)
				checkAllDuplicates();
		});
	});
	switchToOriginalTabCheckbox.addEventListener("change", function () {
		const newValue = this.checked;
		chrome.storage.sync.set({ "switchToOriginalTab": newValue }, function () {
			updateCache("switchToOriginalTab", newValue);
			console.log("[SETTING]: switchToOriginalTab ->", newValue);
		});
	});
	ignoreWebsiteButton.addEventListener("click", function () {
		const button = this;
		chrome.storage.sync.get(["ignoredWebsites"], function (result) {
			let ignoredWebsites = normalizeIgnoredWebsites(result.ignoredWebsites);
			chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
				const currentUrl = tabs[0] && tabs[0].url ? tabs[0].url : "";
				const site = canonicalize(currentUrl);
				if (!site) return;
				const index = ignoredWebsites.indexOf(site);
				if (index === -1) {
					ignoredWebsites.push(site);
					button.innerText = "Unignore Website";
					button.style.backgroundColor = "#ed3f54";
				} else {
					ignoredWebsites.splice(index, 1);
					button.innerText = "Ignore Website";
					button.style.backgroundColor = "";
				}
				const next = Array.from(new Set(ignoredWebsites));
				chrome.storage.sync.set({ "ignoredWebsites": next }, function () {
					updateCache("ignoreWebsite", next);
					console.log("ignoredWebsites ->\n", next.join(",\n"));
				});
			});
		});
	});
	clearWebsitesButton.addEventListener("click", function () {
		chrome.storage.sync.set({ "ignoredWebsites": [] }, function () {
			updateCache("ignoreWebsite", []);
			console.log("ignoredWebsites ->\n", []);
		});
		ignoreWebsiteButton.innerText = "Ignore Website";
		ignoreWebsiteButton.style.backgroundColor = "";
		clearWebsitesButton.innerText = "Cleared!";
		clearWebsitesButton.style.backgroundColor = "#ed3f54";
		setTimeout(function () {
			clearWebsitesButton.innerText = "Clear Excluded Websites";
			clearWebsitesButton.style.backgroundColor = "";
		}, 2000);
	});
	manageWebsitesButton.addEventListener("click", function () {
		chrome.tabs.create({ url: chrome.runtime.getURL("manage.html") });
	});
});
