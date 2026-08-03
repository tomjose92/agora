/* Progressive enhancement for the generated docs pages: mobile drawer,
   copy buttons, TOC scroll-spy, and client-side search over the
   build-time search-index.json. Pages stay fully readable without JS. */

(() => {
  "use strict";

  // ----- mobile drawer -----
  const menuBtn = document.getElementById("menu-btn");
  const scrim = document.getElementById("scrim");
  const closeNav = () => document.body.classList.remove("nav-open");
  menuBtn?.addEventListener("click", () => document.body.classList.toggle("nav-open"));
  scrim?.addEventListener("click", closeNav);

  // ----- copy buttons on code blocks -----
  document.querySelectorAll(".code-block").forEach((block) => {
    const pre = block.querySelector("pre");
    if (!pre) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.textContent = "Copied";
        btn.classList.add("ok");
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("ok");
      }, 1400);
    });
    block.appendChild(btn);
  });

  // ----- TOC scroll-spy -----
  const tocLinks = Array.from(document.querySelectorAll(".toc a"));
  if (tocLinks.length) {
    const pairs = tocLinks
      .map((link) => {
        const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)));
        return heading ? { heading, link } : null;
      })
      .filter(Boolean);
    const spy = () => {
      let current = pairs[0];
      for (const pair of pairs) {
        if (pair.heading.getBoundingClientRect().top <= 90) current = pair;
        else break;
      }
      tocLinks.forEach((l) => l.classList.toggle("active", l === current?.link));
    };
    let ticking = false;
    document.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          ticking = false;
          spy();
        });
      },
      { passive: true },
    );
    spy();
  }

  // ----- search -----
  const input = document.getElementById("search-input");
  const resultsEl = document.getElementById("search-results");
  if (input && resultsEl) {
    let index = null;
    let selected = -1;

    const closeSearch = () => {
      resultsEl.hidden = true;
      selected = -1;
    };

    const loadIndex = async () => {
      if (index) return;
      try {
        const res = await fetch("search-index.json");
        index = await res.json();
      } catch {
        index = [];
      }
    };

    const escapeHtml = (value) =>
      String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[ch]);

    const highlight = (text, query) => {
      const at = text.toLowerCase().indexOf(query.toLowerCase());
      if (at === -1) return escapeHtml(text);
      return (
        escapeHtml(text.slice(0, at)) +
        "<mark>" + escapeHtml(text.slice(at, at + query.length)) + "</mark>" +
        escapeHtml(text.slice(at + query.length))
      );
    };

    const render = (query) => {
      const q = query.trim().toLowerCase();
      if (!q || !index) {
        closeSearch();
        return;
      }
      const scored = [];
      for (const entry of index) {
        const heading = entry.h || entry.t;
        const hay = heading.toLowerCase();
        const inTitle = entry.t.toLowerCase().includes(q);
        if (!hay.includes(q) && !inTitle) continue;
        let score = 0;
        if (hay.startsWith(q)) score += 3;
        if (hay.includes(q)) score += 2;
        if (!entry.h) score += 1; // page titles above section hits
        scored.push({ entry, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 12);
      if (!top.length) {
        resultsEl.innerHTML = '<span class="r-empty">No matches</span>';
        resultsEl.hidden = false;
        selected = -1;
        return;
      }
      resultsEl.innerHTML = top
        .map(({ entry }) => {
          const href = entry.p + (entry.id ? "#" + entry.id : "");
          const main = highlight(entry.h || entry.t, q);
          const context = entry.h ? escapeHtml(entry.t) : "Guide";
          return `<a href="${href}"><span class="r-h">${main}</span><span class="r-p">${context}</span></a>`;
        })
        .join("");
      resultsEl.hidden = false;
      selected = -1;
    };

    const move = (delta) => {
      const items = Array.from(resultsEl.querySelectorAll("a"));
      if (!items.length) return;
      selected = (selected + delta + items.length) % items.length;
      items.forEach((item, i) => item.classList.toggle("active", i === selected));
      items[selected].scrollIntoView({ block: "nearest" });
    };

    input.addEventListener("focus", loadIndex);
    input.addEventListener("input", async () => {
      await loadIndex();
      render(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "Enter") {
        const active = resultsEl.querySelector("a.active") || resultsEl.querySelector("a");
        if (active && !resultsEl.hidden) {
          event.preventDefault();
          window.location.href = active.getAttribute("href");
        }
      } else if (event.key === "Escape") {
        closeSearch();
        input.blur();
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".search")) closeSearch();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeNav();
        closeSearch();
      } else if (
        event.key === "/" &&
        !event.metaKey && !event.ctrlKey && !event.altKey &&
        !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || "")
      ) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });
  }
})();
