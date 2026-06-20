# Tabify — Store Listing & Permission Justifications

Reference copy of the answers used for the Chrome Web Store / Edge Add-ons
developer submission. Keep this in sync with `manifest.json` whenever
permissions change.

## Single purpose description

Tabify has one purpose: to prevent duplicate browser tabs. When you open a page
that is already open in another tab, Tabify closes the duplicate and (optionally)
switches you back to the original tab, keeping your tab strip clean. Every feature
in the extension — its settings, matching rules, and per-site exclusions — exists
solely to support this single duplicate-prevention function.

## Permission justifications

### `storage`

Tabify uses storage to save the user's preferences: whether the extension is
enabled, whether to ignore query strings or anchor fragments when comparing pages,
whether to switch to the original tab, and the user's list of excluded sites. These
settings are stored with `chrome.storage.sync` so they persist between sessions and
follow the user across their signed-in devices. No browsing history or personal data
is collected or transmitted.

### `tabs`

Tabify needs the tabs permission to read the URL of open tabs so it can determine
whether a newly opened or navigated page already exists in another tab. Comparing
these URLs is the core mechanism of the extension. When a match is found, the
permission is also used to close the duplicate tab and, if the user enables it, to
activate the original tab. URLs are only compared in memory and are never stored or
sent anywhere.

### `activeTab`

The activeTab permission lets Tabify read the URL of the current tab when the user
interacts with the extension — for example, when they click "Ignore this site" in
the popup or use the right-click menu on the current page. This allows the extension
to add the exact site the user is currently viewing to their exclusion list without
requiring broad, persistent access driven by user action.

### `contextMenus`

Tabify adds right-click menu items so users can manage duplicate prevention directly
from any page. The menu provides a quick "Ignore/Unignore this site" toggle for
adding or removing the current site from the exclusion list, and a "Close duplicate
tabs now" action to clean up existing duplicates on demand. The contextMenus
permission is required to create and update these menu entries.

### Host permissions (`http://*/*`, `https://*/*`)

Tabify requests host access to `http://*/*` and `https://*/*` because duplicate tabs
can occur on any website, so the extension must be able to read and compare the URLs
of tabs across all sites the user visits. This access is used only to detect and
close duplicate pages; Tabify does not read page content, inject scripts, or transmit
any URL or browsing data off the device.
