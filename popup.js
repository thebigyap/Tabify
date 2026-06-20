/* Tabify popup — a thin settings editor.
   It only reads/writes chrome.storage; the background worker reacts to those
   changes (updating the icon and re-scanning tabs), so no messaging is needed. */

const SETTING_KEYS = ["extensionEnabled", "ignoreQueryStrings", "ignoreAnchorTags", "switchToOriginalTab", "ignoredWebsites"];

let els = {};
let currentSite = null; // canonical origin of the active tab, or null if N/A
let globeIcon = "";     // default globe markup, kept so we can restore it

function getSettings(keys) { return chrome.storage.sync.get(keys); }
function setSettings(obj) { return chrome.storage.sync.set(obj); }

// Origin-level canonicalization — must mirror background.js / manage.js.
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

function normalizeIgnored(values) {
	const next = new Set();
	for (const value of Array.isArray(values) ? values : []) {
		if (typeof value !== "string") continue;
		next.add(canonicalize(value) || value);
	}
	return Array.from(next);
}

function hostLabel(canonical) {
	try { return new URL(canonical).hostname.replace(/^www\./, ""); }
	catch { return canonical; }
}

/* --- Rendering ----------------------------------------------------------- */

function siteSubtitle(ignored) {
	if (ignored) return "Always allowed here";
	return els.master.checked ? "Closing duplicates here" : "Tabify is off";
}

function applyEnabledUI(enabled) {
	els.masterStatus.textContent = enabled ? "On · watching for duplicates" : "Off · duplicates are allowed";
	els.masterIcon.style.background = enabled ? "var(--green)" : "#8e8e93";
	els.matchBlock.classList.toggle("is-disabled", !enabled);
	els.behaviorBlock.classList.toggle("is-disabled", !enabled);
	els.strip.disabled = !enabled;
	els.anchors.disabled = !enabled;
	els.switchOriginal.disabled = !enabled;
	if (currentSite) els.siteStatus.textContent = siteSubtitle(els.ignoreSite.checked);
}

function setExcludedCount(n) {
	els.excludedCount.textContent = String(n);
	els.excludedSubtitle.textContent = n === 0 ? "Nothing excluded yet" : "Sites Tabify leaves alone";
}

function setFavicon(url) {
	const img = document.createElement("img");
	img.className = "site-favicon";
	img.alt = "";
	img.referrerPolicy = "no-referrer";
	img.onerror = () => {
		els.siteIcon.style.background = "var(--accent)";
		els.siteIcon.innerHTML = globeIcon;
	};
	img.src = url;
	els.siteIcon.style.background = "transparent";
	els.siteIcon.replaceChildren(img);
}

function renderSiteState(ignored) {
	els.ignoreSite.checked = ignored;
	els.siteStatus.textContent = siteSubtitle(ignored);
}

/* --- Init ---------------------------------------------------------------- */

async function initCurrentSite(ignoredList) {
	let tab;
	try {
		[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	} catch { /* ignore */ }

	const url = tab && tab.url ? tab.url : "";
	currentSite = canonicalize(url);

	if (!currentSite) {
		els.siteHost.textContent = "This page";
		els.siteStatus.textContent = "Tabify doesn’t run here";
		els.ignoreSite.checked = false;
		els.ignoreSite.disabled = true;
		els.siteGroup.style.opacity = "0.55";
		els.siteIcon.style.background = "#8e8e93";
		return;
	}

	els.siteHost.textContent = hostLabel(currentSite);
	if (tab.favIconUrl && /^https?:/.test(tab.favIconUrl)) setFavicon(tab.favIconUrl);
	renderSiteState(ignoredList.includes(currentSite));
}

async function init() {
	els = {
		master: document.getElementById("extensionEnableCheckbox"),
		masterIcon: document.getElementById("masterIcon"),
		masterStatus: document.getElementById("masterStatus"),
		strip: document.getElementById("stripCheckbox"),
		anchors: document.getElementById("anchorsCheckbox"),
		switchOriginal: document.getElementById("switchToOriginalTabCheckbox"),
		ignoreSite: document.getElementById("ignoreSiteToggle"),
		siteGroup: document.getElementById("siteGroup"),
		siteHost: document.getElementById("siteHost"),
		siteStatus: document.getElementById("siteStatus"),
		siteIcon: document.getElementById("siteIcon"),
		matchBlock: document.getElementById("matchBlock"),
		behaviorBlock: document.getElementById("behaviorBlock"),
		manageBtn: document.getElementById("manageWebsitesButton"),
		excludedCount: document.getElementById("excludedCount"),
		excludedSubtitle: document.getElementById("excludedSubtitle"),
		version: document.getElementById("versionLabel"),
	};
	globeIcon = els.siteIcon.innerHTML;

	els.version.textContent = "v" + chrome.runtime.getManifest().version;

	const data = await getSettings(SETTING_KEYS);
	els.master.checked = !!data.extensionEnabled;
	els.strip.checked = !!data.ignoreQueryStrings;
	els.anchors.checked = !!data.ignoreAnchorTags;
	els.switchOriginal.checked = !!data.switchToOriginalTab;

	const ignored = normalizeIgnored(data.ignoredWebsites);
	setExcludedCount(ignored.length);
	applyEnabledUI(els.master.checked);
	await initCurrentSite(ignored);

	wireEvents();
}

/* --- Events -------------------------------------------------------------- */

function bindToggle(el, key, after) {
	el.addEventListener("change", async () => {
		await setSettings({ [key]: el.checked });
		if (after) after(el.checked);
	});
}

function wireEvents() {
	bindToggle(els.master, "extensionEnabled", applyEnabledUI);
	bindToggle(els.strip, "ignoreQueryStrings");
	bindToggle(els.anchors, "ignoreAnchorTags");
	bindToggle(els.switchOriginal, "switchToOriginalTab");

	els.ignoreSite.addEventListener("change", async () => {
		if (!currentSite) return;
		const ignored = els.ignoreSite.checked;
		const data = await getSettings(["ignoredWebsites"]);
		let list = normalizeIgnored(data.ignoredWebsites);
		if (ignored) {
			if (!list.includes(currentSite)) list.push(currentSite);
		} else {
			list = list.filter(u => u !== currentSite);
		}
		list = Array.from(new Set(list));
		await setSettings({ ignoredWebsites: list });
		els.siteStatus.textContent = siteSubtitle(ignored);
		setExcludedCount(list.length);
	});

	els.manageBtn.addEventListener("click", () => {
		chrome.tabs.create({ url: chrome.runtime.getURL("manage.html") });
		window.close();
	});

	// Stay in sync if settings change elsewhere (manage page, context menu).
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "sync") return;

		if (changes.extensionEnabled) {
			const enabled = !!changes.extensionEnabled.newValue;
			if (els.master.checked !== enabled) {
				els.master.checked = enabled;
				applyEnabledUI(enabled);
			}
		}

		if (changes.ignoredWebsites) {
			const list = normalizeIgnored(changes.ignoredWebsites.newValue);
			setExcludedCount(list.length);
			if (currentSite && !els.ignoreSite.disabled) {
				renderSiteState(list.includes(currentSite));
			}
		}
	});
}

document.addEventListener("DOMContentLoaded", init);
