function updateCache(setting, newValue) {
	chrome.runtime.sendMessage({ action: "updateCache", setting, value: newValue });
}

const rowsEl = document.getElementById("rows");
const countLabel = document.getElementById("countLabel");
const clearAllBtn = document.getElementById("clearAllBtn");
const addBtn = document.getElementById("addBtn");

let list = [];

// Simple title from hostname: second-to-last label, title-cased.
function guessTitle(url) {
	try {
		const host = new URL(url).hostname.replace(/^www\./i, "");
		const labels = host.split(".");
		const core = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
		return core.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
	} catch {
		return "(unknown)";
	}
}

// Turn loose input into canonical origin. I.E. https://www.example.com/
function canonicalize(raw) {
	if (!raw) return null;
	let s = raw.trim();
	if (!s) return null;

	const isLocal = h => h === "localhost" || h.endsWith(".localhost");
	const isIp = h => /^[0-9.]+$/.test(h) || h.includes(":"); // ipv4/ipv6
	const addWwwIfSingleDot = h => {
		const dotCount = (h.match(/\./g) || []).length;
		return (!h.startsWith("www.") && dotCount === 1) ? ("www." + h) : h;
	};

	try {
		if (s.includes("://")) {
			const u = new URL(s);
			if (u.protocol !== "http:" && u.protocol !== "https:") return null;

			let host = u.hostname.toLowerCase();
			if (!host.includes(".") && !isLocal(host) && !isIp(host)) host += ".com";
			host = addWwwIfSingleDot(host);
			const scheme = (isLocal(host) || isIp(host)) ? "http" : "https";
			return `${scheme}://${host}/`;
		}
	} catch { }

	// Loose input (no scheme)
	s = s.replace(/^https?:\/\//i, "").replace(/^\/+/, "");
	s = s.split(/[\/?#]/)[0].toLowerCase().replace(/:.*/, ""); // strip port if present

	if (!s) return null;
	if (!s.includes(".") && !isLocal(s) && !isIp(s)) s += ".com";
	s = addWwwIfSingleDot(s);
	const scheme = (isLocal(s) || isIp(s)) ? "http" : "https";
	return `${scheme}://${s}/`;
}


function setCount(n) {
	countLabel.textContent = `${n} total`;
}

function render() {
	rowsEl.innerHTML = "";
	if (!list.length) {
		rowsEl.innerHTML = `<tr><td colspan="4" class="empty">No excluded websites.</td></tr>`;
		setCount(0);
		return;
	}
	setCount(list.length);
	list.forEach((url, i) => {
		const tr = document.createElement("tr");
		tr.innerHTML = `
			<td class="muted">${i + 1}</td>
			<td class="title">${guessTitle(url)}</td>
			<td class="url">${url}</td>
			<td>
				<button class="btn" data-open="${encodeURIComponent(url)}" title="Open ${url}" aria-label="Open ${url}">Open</button>
				<button class="btn danger" data-remove="${encodeURIComponent(url)}" title="Unignore ${url}" aria-label="Unignore ${url}">Unignore</button>
			</td>
		`;
		rowsEl.appendChild(tr);
	});
}

function loadIgnoredAndRender() {
	chrome.storage.sync.get(["ignoredWebsites"], function (result) {
		const ignoredWebsites = result.ignoredWebsites || [];
		list = Array.isArray(ignoredWebsites) ? ignoredWebsites : [];
		render();
	});
}

async function saveList(next) {
	const unique = Array.from(new Set(next));
	await new Promise(r => chrome.storage.sync.set({ ignoredWebsites: unique }, r));
	updateCache("ignoreWebsite", unique);
	list = unique;
	render();
}

rowsEl.addEventListener("click", (e) => {
	const btn = e.target.closest("button");
	if (!btn) return;

	if (btn.hasAttribute("data-open")) {
		const url = decodeURIComponent(btn.getAttribute("data-open"));
		if (url) chrome.tabs.create({ url });
	}

	if (btn.hasAttribute("data-remove")) {
		const url = decodeURIComponent(btn.getAttribute("data-remove"));
		const next = list.filter(u => u !== url);
		saveList(next);
	}
});

// Add new ignored site via prompt
addBtn.addEventListener("click", async () => {
	const input = prompt("Enter a website to ignore (e.g., youtube or youtube.com):");
	if (input === null) return; // Cancelled
	const url = canonicalize(input);
	if (!url) { alert("Please enter a valid website."); return; }
	if (list.includes(url)) { alert("That site is already excluded."); return; }
	await saveList([...list, url]);
});

// Confirm before clearing all
clearAllBtn.addEventListener("click", async () => {
	const ok = confirm("Clear all excluded websites?");
	if (!ok) return;
	await saveList([]);
	clearAllBtn.textContent = "Cleared!";
	clearAllBtn.disabled = true;
	setTimeout(() => { clearAllBtn.textContent = "Clear All"; clearAllBtn.disabled = false; }, 1200);
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "sync" && changes.ignoredWebsites) {
		list = changes.ignoredWebsites.newValue || [];
		render();
	}
});

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", loadIgnoredAndRender);
} else {
	loadIgnoredAndRender();
}
