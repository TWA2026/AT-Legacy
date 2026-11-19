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
})();
