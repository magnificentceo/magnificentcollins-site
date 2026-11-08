(function () {
  "use strict";

  var data = window.SITE_DATA;
  if (!data) return;

  // Accent color (set in data/releases.js to match the featured cover)
  if (data.accent) document.documentElement.style.setProperty("--accent", data.accent);

  var SECONDARY = ["All platforms", "Buy on Amazon"];

  // Brand colors for each service. A service not listed here gets a plain gray button.
  var BRAND = {
    "Spotify": "#1ED760",
    "Apple Music": "#FA243C",
    "YouTube": "#FF0000",
    "YouTube Music": "#FF0000",
    "Amazon Music": "#25D1DA",
    "Deezer": "#A238FF",
    "TIDAL": "#FFFFFF",
    "Audiomack": "#FFA200",
    "Pandora": "#3668FF",
    "Boomplay": "#00FFFF",
    "Anghami": "#7E4BD8",
    "iHeart": "#F0284A",
    "Instagram": "#E4405F",
    "TikTok": "#25F4EE",
    "Facebook": "#0866FF"
  };
  // Platform icons in assets/icons/ (Font Awesome Free, CC BY 4.0; Simple Icons, CC0; Arcticons, CC BY-SA 4.0).
  // Services without an icon show a colored dot instead.
  var ICONS = {
    "Spotify": "spotify.svg",
    "Apple Music": "apple-music.svg",
    "YouTube": "youtube.svg",
    "YouTube Music": "youtube-music.svg",
    "Amazon Music": "amazon-music.svg",
    "Deezer": "deezer.svg",
    "TIDAL": "tidal.svg",
    "Audiomack": "audiomack.svg",
    "Pandora": "pandora.svg",
    "iHeart": "iheart.svg",
    "Boomplay": "boomplay.svg",
    "Anghami": "anghami.svg",
    "Instagram": "instagram.svg",
    "TikTok": "tiktok.svg",
    "Facebook": "facebook.svg"
  };
  function brandAttrs(service, attrs) {
    if (BRAND[service]) {
      var style = "--brand:" + BRAND[service];
      attrs.className += " btn-brand";
      if (ICONS[service]) {
        style += ";--icon:url('assets/icons/" + ICONS[service] + "')";
        attrs.className += " has-icon";
      }
      attrs.style = style;
    }
    return attrs;
  }
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") node.textContent = attrs[k];
        else if (k === "className") node.className = attrs[k];
        else if (k === "style") node.style.cssText = attrs[k]; // set through CSSOM so the security policy allows it
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // Dates are written as YYYY-MM-DD and read without time zones, so they never shift a day.
  function parts(iso) {
    var p = iso.split("-");
    return { y: +p[0], m: +p[1], d: +p[2] };
  }
  function formatDate(iso) {
    var p = parts(iso);
    return MONTHS[p.m - 1] + " " + p.d + ", " + p.y;
  }

  function visible(links) {
    return links.filter(function (l) { return !l.hidden && l.url; });
  }

  function coverImg(release, className, eager) {
    var img = el("img", {
      className: className,
      src: release.cover,
      alt: "Cover art for " + release.title,
      width: "600", height: "600",
      decoding: "async"
    });
    if (!eager) img.setAttribute("loading", "lazy");
    return img;
  }

  function linkButtons(release, solidFirst) {
    var links = visible(release.links);
    var main = links.filter(function (l) { return SECONDARY.indexOf(l.service) === -1; });
    var extra = links.filter(function (l) { return SECONDARY.indexOf(l.service) !== -1; });

    var frag = document.createDocumentFragment();
    var grid = el("ul", { className: "btn-grid", "aria-label": "Listen to " + release.title });
    main.forEach(function (l, i) {
      var a = el("a", brandAttrs(l.service, {
        className: "btn" + (solidFirst && i === 0 ? " btn-primary" : ""),
        href: l.url, target: "_blank", rel: "noopener",
        "aria-label": "Listen to " + release.title + " on " + l.service + " (opens in a new tab)"
      }), [el("span", { className: "btn-label", text: l.service })]);
      grid.appendChild(el("li", null, [a]));
    });
    frag.appendChild(grid);

    if (extra.length) {
      var ul = el("ul", { className: "extra-links" });
      extra.forEach(function (l) {
        var label = l.service === "All platforms" ? "More platforms" : l.service;
        ul.appendChild(el("li", null, [el("a", {
          href: l.url, target: "_blank", rel: "noopener",
          "aria-label": label + " for " + release.title + " (opens in a new tab)", text: label
        })]));
      });
      frag.appendChild(ul);
    }
    return frag;
  }

  // Lyrics: a panel that opens under the buttons. Only shown when lyrics are filled in.
  function lyricsPanel(r) {
    var text = (r.lyrics || "").trim();
    if (!text) return null;
    return el("details", { className: "sub-panel lyrics", id: "lyrics-" + r.id }, [
      el("summary", { className: "sub-toggle" }, [el("span", { text: "Lyrics" }), el("span", { className: "sub-icon", "aria-hidden": "true" })]),
      el("div", { className: "lyrics-text", text: text })
    ]);
  }

  // Comments and reviews (Cusdis). Cusdis shows one comment box per page, so each song
  // has a button that moves the box to that song. Nothing loads until someone taps it.
  var cfg = data.comments || {};
  var commentsOn = cfg.provider === "cusdis" && !!cfg.appId;
  var openCommentBox = null;
  var cusdisLoading = null;

  function loadCusdis() {
    if (window.CUSDIS && window.CUSDIS.renderTo) return Promise.resolve();
    if (cusdisLoading) return cusdisLoading;
    window.CUSDIS_PREVENT_INITIAL_RENDER = true;
    cusdisLoading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = (cfg.host || "https://cusdis.com") + "/js/cusdis.es.js";
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { cusdisLoading = null; reject(); };
      document.head.appendChild(s);
    });
    return cusdisLoading;
  }

  function commentsPanel(r) {
    if (!commentsOn) return null;
    var box = el("div", { className: "comment-box", id: "comments-" + r.id });
    box.setAttribute("data-host", cfg.host || "https://cusdis.com");
    box.setAttribute("data-app-id", cfg.appId);
    box.setAttribute("data-page-id", "song-" + r.id);
    box.setAttribute("data-page-title", r.title + " by Magnificent Collins");
    box.setAttribute("data-page-url", location.origin + location.pathname + "#song-" + r.id);
    box.setAttribute("data-theme", "dark");
    var status = el("p", { className: "comment-status", role: "status", "aria-live": "polite" });
    var btn = el("button", {
      type: "button", className: "btn comment-toggle", "aria-expanded": "false",
      "aria-controls": "comments-" + r.id
    }, [el("span", { className: "btn-label", text: "Comments & reviews" })]);

    btn.addEventListener("click", function () {
      if (openCommentBox && openCommentBox.box === box) { closeComments(); return; }
      closeComments();
      status.textContent = "Loading comments…";
      loadCusdis().then(function () {
        status.textContent = "";
        window.CUSDIS.renderTo(box);
        box.hidden = false;
        btn.setAttribute("aria-expanded", "true");
        btn.querySelector(".btn-label").textContent = "Hide comments";
        openCommentBox = { box: box, btn: btn };
      }, function () {
        status.textContent = "Comments could not load. Please try again in a moment.";
      });
    });
    box.hidden = true;
    return el("div", { className: "sub-panel comments" }, [
      btn, status, box,
      el("p", { className: "comment-note", text: "Comments appear after they are approved." })
    ]);
  }

  function closeComments() {
    if (!openCommentBox) return;
    openCommentBox.box.hidden = true;
    openCommentBox.box.innerHTML = "";
    openCommentBox.btn.setAttribute("aria-expanded", "false");
    openCommentBox.btn.querySelector(".btn-label").textContent = "Comments & reviews";
    openCommentBox = null;
  }

  var releases = data.releases.slice().sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });
  var featured = releases.filter(function (r) { return r.id === data.featured; })[0] || releases[0];

  // Latest release
  var latest = document.getElementById("latest");
  latest.appendChild(coverImg(featured, "latest-cover", true));
  latest.appendChild(el("div", null, [
    el("p", { className: "eyebrow", text: "Latest release" }),
    el("h2", { id: "latest-title", text: featured.title }),
    el("p", { className: "date", text: "Released " + formatDate(featured.date) }),
    linkButtons(featured, true),
    (featured.lyrics || commentsOn) ? el("p", { className: "more-link" }, [el("a", {
      href: "#song-" + featured.id, id: "featured-more",
      text: (featured.lyrics && commentsOn) ? "Lyrics & comments" : (featured.lyrics ? "Lyrics" : "Comments & reviews")
    })]) : null
  ]));

  // Catalogue grouped by year, newest first
  var catalogue = document.getElementById("catalogue");
  var years = {};
  var order = [];
  releases.forEach(function (r) {
    var y = parts(r.date).y;
    if (!years[y]) { years[y] = []; order.push(y); }
    years[y].push(r);
  });
  order.forEach(function (y) {
    var list = el("ul", { className: "release-list" });
    years[y].forEach(function (r) {
      var info = el("div", null, [
        el("h4", { text: r.title }),
        el("p", { className: "date", text: formatDate(r.date) }),
        r.id === featured.id ? el("span", { className: "badge-latest", text: "Latest" }) : null
      ]);
      var toggle = el("span", { className: "toggle", "aria-hidden": "true" }, [
        el("span", { className: "label-open", text: "Listen" }),
        el("span", { className: "label-close", text: "Close" })
      ]);
      var details = el("details", { className: "release glass", id: "song-" + r.id }, [
        el("summary", { "aria-label": r.title + ", released " + formatDate(r.date) + ". Show streaming links." },
          [coverImg(r, "release-cover", false), info, toggle]),
        el("div", { className: "release-body" }, [linkButtons(r, false), lyricsPanel(r), commentsPanel(r)])
      ]);
      list.appendChild(el("li", null, [details]));
    });
    catalogue.appendChild(el("div", { className: "year-group" }, [
      el("h3", { className: "year", text: String(y) }), list
    ]));
  });

  // Open a song directly when the address ends with #song-<id>
  function openSongFromHash() {
    if (location.hash.indexOf("#song-") !== 0) return;
    var target = document.getElementById(location.hash.slice(1));
    if (target) { target.open = true; target.scrollIntoView(); }
  }
  openSongFromHash();
  window.addEventListener("hashchange", openSongFromHash);
  var moreLink = document.getElementById("featured-more");
  if (moreLink) moreLink.addEventListener("click", function () {
    var song = document.getElementById("song-" + featured.id);
    if (song) song.open = true;
    var lyr = document.getElementById("lyrics-" + featured.id);
    if (lyr) lyr.open = true;
  });

  // About
  var about = document.getElementById("about-text");
  var aboutLines = data.artist.about || [];
  if (aboutLines.length) {
    aboutLines.forEach(function (t) { about.appendChild(el("p", { text: t })); });
  } else {
    document.getElementById("about").hidden = true;
    var aboutNav = document.querySelector('.nav a[href="#about"]');
    if (aboutNav) aboutNav.parentNode.hidden = true;
  }

  // Artist profiles and social media
  function profileList(listId, items) {
    var list = document.getElementById(listId);
    items.filter(function (p) { return p.url && !p.hidden; }).forEach(function (p) {
      list.appendChild(el("li", null, [el("a", brandAttrs(p.service, {
        className: "btn", href: p.url, target: "_blank", rel: "noopener",
        "aria-label": "Magnificent Collins on " + p.service + " (opens in a new tab)"
      }), [el("span", { className: "btn-label", text: p.service })])]));
    });
    return list.children.length;
  }
  profileList("profiles", data.artist.profiles);
  if (profileList("socials", data.artist.socials || [])) {
    document.getElementById("socials-block").hidden = false;
  }

  // Optional artist photo (only shown when a real photo path is set in the data file)
  if (data.artist.photo) {
    var photo = document.getElementById("artist-photo");
    photo.src = data.artist.photo;
    photo.alt = "Magnificent Collins";
    photo.hidden = false;
  }

  // Share
  var pageUrl = location.origin && location.origin !== "null"
    ? location.origin + location.pathname.replace(/index\.html$/, "")
    : location.href;
  var urlBox = document.getElementById("share-url");
  var status = document.getElementById("share-status");
  var shareBtn = document.getElementById("share-btn");
  urlBox.value = pageUrl;

  function copy() {
    function done() { status.textContent = "Link copied."; }
    function fallback() {
      urlBox.focus();
      urlBox.select();
      try {
        if (document.execCommand("copy")) { done(); return; }
      } catch (e) { /* ignore */ }
      status.textContent = "Press and hold the address above to copy it.";
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(pageUrl).then(done, fallback);
    } else {
      fallback();
    }
  }

  if (navigator.share) {
    shareBtn.addEventListener("click", function () {
      navigator.share({
        title: "Magnificent Collins",
        text: "Listen to Magnificent Collins. Get edified.",
        url: pageUrl
      }).catch(function () { /* closed by user */ });
    });
  } else {
    shareBtn.hidden = true;
  }
  document.getElementById("copy-btn").addEventListener("click", copy);

  document.getElementById("year").textContent = new Date().getFullYear();

  // Gloss on touch and hover: buttons and song rows get a highlight that follows the
  // pointer and a sheen that sweeps across when tapped.
  document.querySelectorAll(".btn, .release > summary, .sub-toggle").forEach(function (n) {
    n.classList.add("gloss");
  });
  function glossPoint(target, e) {
    var r = target.getBoundingClientRect();
    target.style.setProperty("--gx", (e.clientX - r.left) + "px");
    target.style.setProperty("--gy", (e.clientY - r.top) + "px");
  }
  document.addEventListener("pointermove", function (e) {
    var t = e.target.closest && e.target.closest(".gloss");
    if (t && e.pointerType === "mouse") glossPoint(t, e);
  }, { passive: true });
  document.addEventListener("pointerdown", function (e) {
    var t = e.target.closest && e.target.closest(".gloss");
    if (!t) return;
    glossPoint(t, e);
    t.classList.remove("is-pressed");
    void t.offsetWidth; // restart the sweep if tapped again quickly
    t.classList.add("is-pressed");
    clearTimeout(t._glossTimer);
    t._glossTimer = setTimeout(function () { t.classList.remove("is-pressed"); }, 600);
  }, { passive: true });
})();
