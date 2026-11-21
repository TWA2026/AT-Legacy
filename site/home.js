(function () {
  // On phones, keep the request button within reach once the first one scrolls away.
  var bar = document.getElementById("quote-bar");
  var actions = document.getElementById("hero-actions");
  var contact = document.getElementById("contact");
  if (!("IntersectionObserver" in window)) return;
  var seen = { actions: true, contact: false };
  function update() {
    bar.hidden = seen.actions || seen.contact;
  }
  new IntersectionObserver(function (entries) {
    seen.actions = entries[0].isIntersecting;
    update();
  }).observe(actions);
  new IntersectionObserver(function (entries) {
    seen.contact = entries[0].isIntersecting;
    update();
  }).observe(contact);

  // The site plan draws itself once. Hold the drawing until it is on screen.
  var plan = document.querySelector(".plan");
  if (plan) {
    var planSeen = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) {
        plan.classList.remove("plan-hold");
        planSeen.disconnect();
      } else {
        plan.classList.add("plan-hold");
      }
    }, { threshold: 0.25 });
    planSeen.observe(plan);
  }
})();

// Customer ratings. The section stays hidden until there is at least one the customer agreed to share.
(function () {
  var section = document.getElementById("reviews");
  if (!section || !window.fetch) return;
  var api = String(window.ATL_API || "").replace(/\/+$/, "");
  fetch(api + "/api/reviews").then(function (response) {
    return response.ok ? response.json() : [];
  }).then(function (reviews) {
    if (!reviews.length) return;
    var list = document.getElementById("review-list");
    reviews.forEach(function (review) {
      var item = document.createElement("li");
      var stars = document.createElement("p");
      var words = document.createElement("p");
      var who = document.createElement("p");
      stars.className = "review-stars";
      stars.textContent = "★★★★★".slice(0, review.stars) + "☆☆☆☆☆".slice(0, 5 - review.stars);
      stars.setAttribute("role", "img");
      stars.setAttribute("aria-label", review.stars + " out of 5 stars");
      words.className = "review-words";
      words.textContent = review.comment;
      who.className = "review-who";
      who.textContent = review.name + ", " + review.service.toLowerCase() + " by " + review.company + ", " + review.when;
      item.appendChild(stars);
      if (review.comment) item.appendChild(words);
      item.appendChild(who);
      list.appendChild(item);
    });
    section.hidden = false;
  }).catch(function () {});
})();
