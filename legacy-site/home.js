(function () {
  var picks = {
    paint: {
      name: "Painting and caulking",
      text: "Paint touch-ups on walls, ceilings, and trim, plus fresh caulk along tubs and counters.",
      service: "Interior paint touch-up"
    },
    doors: {
      name: "Doors and small fixes",
      text: "Doors that stick, rub, or won’t latch, plus loose hinges, trim, and hardware.",
      service: "Interior door adjustment"
    },
    mounting: {
      name: "Mounting and assembly",
      text: "TVs, shelves, and mirrors mounted level, and furniture put together.",
      service: "TV or shelf mounting"
    },
    exterior: {
      name: "Exterior upkeep",
      text: "Pressure washing for driveways and walkways, gutter cleaning, and yard cleanups.",
      service: "Pressure washing"
    },
    rentals: {
      name: "Rental turnovers",
      text: "Move-out touch-ups and the whole punch list in one visit, ready for the next tenant.",
      service: "Rental move-out touch-ups"
    }
  };

  var picker = document.getElementById("picker");
  var nameEl = document.getElementById("pick-name");
  var textEl = document.getElementById("pick-text");
  var quoteEl = document.getElementById("pick-quote");
  var moreEl = document.getElementById("pick-more");

  function select(id) {
    var pick = picks[id];
    if (!pick) return;
    nameEl.textContent = pick.name;
    textEl.textContent = pick.text;
    quoteEl.href = "quote.html?service=" + encodeURIComponent(pick.service);
    moreEl.href = "#svc-" + id;
    picker.querySelectorAll("[data-part]").forEach(function (part) {
      part.classList.toggle("on", part.getAttribute("data-part") === id);
    });
    picker.querySelectorAll(".spot").forEach(function (spot) {
      spot.classList.toggle("on", spot.getAttribute("data-pick") === id);
    });
    picker.querySelectorAll(".chip").forEach(function (chip) {
      chip.setAttribute("aria-pressed", String(chip.getAttribute("data-pick") === id));
    });
  }

  picker.addEventListener("click", function (event) {
    var button = event.target.closest("[data-pick]");
    if (button) select(button.getAttribute("data-pick"));
  });
  picker.classList.add("ready");
  select("paint");

  // A link to a service opens that service's dropdown.
  function openTarget() {
    var target = location.hash && document.getElementById(location.hash.slice(1));
    if (target && target.tagName === "DETAILS") target.open = true;
  }
  window.addEventListener("hashchange", openTarget);
  document.addEventListener("click", function (event) {
    var link = event.target.closest('a[href^="#svc-"]');
    if (!link) return;
    var target = document.getElementById(link.getAttribute("href").slice(1));
    if (target) target.open = true;
  });
  openTarget();

  // On phones, keep the quote button within reach once the first one scrolls away.
  var bar = document.getElementById("quote-bar");
  var actions = document.getElementById("hero-actions");
  var contact = document.getElementById("contact");
  if ("IntersectionObserver" in window) {
    var seen = { actions: true, contact: false };
    var update = function () {
      bar.hidden = seen.actions || seen.contact;
    };
    new IntersectionObserver(function (entries) {
      seen.actions = entries[0].isIntersecting;
      update();
    }).observe(actions);
    new IntersectionObserver(function (entries) {
      seen.contact = entries[0].isIntersecting;
      update();
    }).observe(contact);
  }
})();
