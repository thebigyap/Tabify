/* Tabify — Manage excluded sites.
   Writes to chrome.storage.sync; the background worker reacts on its own.
   No native prompt()/alert()/confirm() — everything is inline, with Undo. */

const state = { list: [], filter: "" };
let undoTimer = null;

const els = {};

/* --- URL helpers --------------------------------------------------------- */

// Accepts loose input ("youtube", "youtube.com", "https://youtube.com/x") and
// returns a canonical origin, e.g. https://www.youtube.com/
function canonicalize(raw) {
	if (!raw) return null;
	let s = String(raw).trim();
	if (!s) return null;

	const isLocal = h => h === "localhost" || h.endsWith(".localhost");
	const isIp = h => /^[0-9.]+$/.test(h) || h.includes(":");
	const addWww = h => {
		const dots = (h.match(/\./g) || []).length;
		return (!h.startsWith("www.") && dots === 1) ? "www." + h : h;
	};

	try {
		if (s.includes("://")) {
			const u = new URL(s);
			if (u.protocol !== "http:" && u.protocol !== "https:") return null;
			let host = u.hostname.toLowerCase();
			if (!host.includes(".") && !isLocal(host) && !isIp(host)) host += ".com";
			host = addWww(host);
			const scheme = (isLocal(host) || isIp(host)) ? "http" : "https";
			return `${scheme}://${host}/`;
		}
	} catch { /* fall through to loose parsing */ }

	s = s.replace(/^https?:\/\//i, "").replace(/^\/+/, "");
	s = s.split(/[/?#]/)[0].toLowerCase().replace(/:.*/, "");
	if (!s) return null;
	if (!s.includes(".") && !isLocal(s) && !isIp(s)) s += ".com";
	s = addWww(s);
	const scheme = (isLocal(s) || isIp(s)) ? "http" : "https";
	return `${scheme}://${s}/`;
}

function normalizeIgnored(values) {
	const next = new Set();
	for (const value of Array.isArray(values) ? values : []) {
		if (typeof value !== "string") continue;
		next.add(canonicalize(value) || value);
	}
	return Array.from(next);
}

function hostLabel(url) {
	try { return new URL(url).hostname.replace(/^www\./, ""); }
	catch { return url; }
}

function monogram(url) {
	const core = hostLabel(url).split(".")[0] || hostLabel(url);
	return (core[0] || "?").toUpperCase();
}

// Deterministic, pleasant color per domain — no network favicon lookups.
function colorFor(url) {
	const s = hostLabel(url);
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return `hsl(${h % 360} 58% 47%)`;
}

/* --- Storage ------------------------------------------------------------- */

function load() {
	chrome.storage.sync.get(["ignoredWebsites"]).then(r => {
		state.list = normalizeIgnored(r.ignoredWebsites);
		render();
	});
}

function save(next) {
	const unique = Array.from(new Set(next));
	return chrome.storage.sync.set({ ignoredWebsites: unique }).then(() => {
		state.list = unique;
		render();
	});
}

/* --- Render -------------------------------------------------------------- */

function setCount() {
	const n = state.list.length;
	els.count.textContent = n === 0 ? "No sites" : `${n} site${n === 1 ? "" : "s"}`;
	els.clearAll.disabled = n === 0;
}

function showEmpty(title, sub) {
	els.empty.hidden = false;
	els.emptyTitle.textContent = title;
	els.emptySub.textContent = sub;
}

function render() {
	setCount();
	els.rows.replaceChildren();

	const filter = state.filter.trim().toLowerCase();
	const filtered = filter
		? state.list.filter(u => hostLabel(u).includes(filter) || u.toLowerCase().includes(filter))
		: state.list;

	if (state.list.length === 0) {
		showEmpty("No excluded sites", "Add a site above, or open Tabify on any page and turn on “Ignore this site”.");
		return;
	}
	if (filtered.length === 0) {
		showEmpty(`No matches for “${state.filter.trim()}”`, "Try a different search.");
		return;
	}
	els.empty.hidden = true;

	for (const url of filtered) {
		const row = document.createElement("div");
		row.className = "row has-icon site-row";
		row.setAttribute("role", "listitem");

		const icon = document.createElement("span");
		icon.className = "row-icon mono";
		icon.style.background = colorFor(url);
		icon.textContent = monogram(url);

		const text = document.createElement("span");
		text.className = "row-text";
		const title = document.createElement("span");
		title.className = "row-title truncate";
		title.textContent = hostLabel(url);
		const sub = document.createElement("span");
		sub.className = "row-subtitle truncate";
		sub.textContent = url;
		text.append(title, sub);

		const actions = document.createElement("span");
		actions.className = "row-actions";
		actions.append(
			actionButton("open", url, "Open in new tab",
				'<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>'),
			actionButton("remove", url, `Remove ${hostLabel(url)}`,
				'<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>', true),
		);

		row.append(icon, text, actions);
		els.rows.appendChild(row);
	}
}

function actionButton(kind, url, label, paths, danger = false) {
	const btn = document.createElement("button");
	btn.className = "icon-action" + (danger ? " danger" : "");
	btn.dataset[kind] = url;
	btn.title = label;
	btn.setAttribute("aria-label", label);
	btn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
	return btn;
}

/* --- Toast / Undo -------------------------------------------------------- */

function showToast(message, previousList) {
	els.toastMsg.textContent = message;
	els.toast.hidden = false;
	if (undoTimer) clearTimeout(undoTimer);

	els.toastUndo.onclick = () => {
		if (undoTimer) clearTimeout(undoTimer);
		els.toast.hidden = true;
		save(previousList);
	};
	undoTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
}

/* --- Add form ------------------------------------------------------------ */

function openAddForm() {
	els.addForm.hidden = false;
	els.addError.textContent = "";
	els.addInput.value = "";
	els.addInput.focus();
}

function closeAddForm() {
	els.addForm.hidden = true;
	els.addError.textContent = "";
}

function submitAdd(event) {
	event.preventDefault();
	const url = canonicalize(els.addInput.value);
	if (!url) {
		els.addError.textContent = "Please enter a valid site, like example.com";
		return;
	}
	if (state.list.includes(url)) {
		els.addError.textContent = `${hostLabel(url)} is already excluded.`;
		return;
	}
	save([...state.list, url]).then(closeAddForm);
}

/* --- Wire up ------------------------------------------------------------- */

function init() {
	els.rows = document.getElementById("rows");
	els.empty = document.getElementById("empty");
	els.emptyTitle = els.empty.querySelector(".empty-title");
	els.emptySub = els.empty.querySelector(".empty-sub");
	els.count = document.getElementById("countLabel");
	els.clearAll = document.getElementById("clearAllBtn");
	els.addBtn = document.getElementById("addBtn");
	els.addForm = document.getElementById("addForm");
	els.addInput = document.getElementById("addInput");
	els.addCancel = document.getElementById("addCancel");
	els.addError = document.getElementById("addError");
	els.search = document.getElementById("search");
	els.toast = document.getElementById("toast");
	els.toastMsg = document.getElementById("toastMsg");
	els.toastUndo = document.getElementById("toastUndo");

	els.rows.addEventListener("click", e => {
		const btn = e.target.closest("button");
		if (!btn) return;
		if (btn.dataset.open) {
			chrome.tabs.create({ url: btn.dataset.open });
		} else if (btn.dataset.remove) {
			const url = btn.dataset.remove;
			const previous = state.list.slice();
			save(state.list.filter(u => u !== url));
			showToast(`Removed ${hostLabel(url)}`, previous);
		}
	});

	els.addBtn.addEventListener("click", openAddForm);
	els.addCancel.addEventListener("click", closeAddForm);
	els.addForm.addEventListener("submit", submitAdd);
	els.addInput.addEventListener("keydown", e => { if (e.key === "Escape") closeAddForm(); });

	els.search.addEventListener("input", () => { state.filter = els.search.value; render(); });

	els.clearAll.addEventListener("click", () => {
		if (state.list.length === 0) return;
		const previous = state.list.slice();
		const n = previous.length;
		save([]);
		showToast(`Cleared ${n} site${n === 1 ? "" : "s"}`, previous);
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "sync" && changes.ignoredWebsites) {
			state.list = normalizeIgnored(changes.ignoredWebsites.newValue);
			render();
		}
	});

	load();
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", init);
} else {
	init();
}
