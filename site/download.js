// Points the download buttons at the newest published release's files, and highlights the visitor's platform.
// Without the GitHub API (offline, rate-limited) the buttons keep their link to the releases page.
(function () {
  "use strict";
  var REPO = "college-things/Microsim";
  var note = document.getElementById("release-note");
  var ua = navigator.userAgent;
  var platform = /Windows/i.test(ua) ? "windows" : /Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua) ? "mac" : /Linux/i.test(ua) && !/Android/i.test(ua) ? "linux" : "web";
  var mine = document.querySelector('[data-platform="' + platform + '"]');
  if (mine) mine.classList.add("yours");

  var patterns = { exe: /-setup\.exe$/i, msi: /\.msi$/i, dmg: /\.dmg$/i, AppImage: /\.AppImage$/i, deb: /\.deb$/i, rpm: /\.rpm$/i };

  fetch("https://api.github.com/repos/" + REPO + "/releases?per_page=10", { headers: { Accept: "application/vnd.github+json" } })
    .then(function (response) { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
    .then(function (releases) {
      var release = releases.filter(function (r) { return !r.draft; })[0];
      if (!release) { note.textContent = "No release has been published yet. Use the browser version meanwhile."; return; }
      var version = release.tag_name.replace(/^v/, "");
      document.getElementById("version").textContent = version + (release.prerelease ? " beta" : "");
      note.textContent = "Latest: " + release.name + (release.prerelease ? " (beta)" : "") + ", published " + new Date(release.published_at).toLocaleDateString() + ".";
      Array.prototype.forEach.call(document.querySelectorAll("[data-asset]"), function (link) {
        var pattern = patterns[link.getAttribute("data-asset")];
        var asset = release.assets.filter(function (a) { return pattern.test(a.name); })[0];
        if (asset) {
          link.href = asset.browser_download_url;
          link.title = asset.name + ", " + (asset.size / 1048576).toFixed(1) + " MB";
        } else {
          link.classList.add("missing");
          link.title = "Not in this release yet";
          link.href = release.html_url;
        }
      });
      var primary = document.getElementById("primary-download");
      var mainLink = mine && mine.querySelector(".button.primary");
      if (mainLink && !mainLink.classList.contains("missing")) {
        primary.href = mainLink.href;
        primary.textContent = "Download for " + { windows: "Windows", mac: "macOS", linux: "Linux", web: "your browser" }[platform];
      }
    })
    .catch(function () { note.textContent = "Couldn't reach GitHub to find the latest files. The releases page has them all."; });
})();
