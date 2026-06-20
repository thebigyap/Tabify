/* Tabify welcome screen — just stamps the current version. */
document.addEventListener("DOMContentLoaded", () => {
	const el = document.getElementById("welcomeVersion");
	if (el && chrome?.runtime?.getManifest) {
		el.textContent = "Version " + chrome.runtime.getManifest().version;
	}
});
