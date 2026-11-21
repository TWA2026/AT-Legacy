// The standard page. The list is already written into the page. This swaps in the list the owner
// keeps in the dashboard, in case it has changed since the page was built. If the hub can't be
// reached, the page stays as it is.
(function () {
  var must = document.getElementById("standard-must");
  if (!must || !window.fetch) return;
  var api = String(window.ATL_API || "").replace(/\/+$/, "");

  function list(target, labels) {
    while (target.firstChild) target.removeChild(target.firstChild);
    labels.forEach(function (label) {
      var item = document.createElement("li");
      item.textContent = label;
      target.appendChild(item);
    });
  }

  fetch(api + "/api/standard").then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (standard) {
    if (!standard || !Array.isArray(standard.must) || !standard.must.length) return;
    list(must, standard.must);
    var more = document.getElementById("standard-more");
    var card = document.getElementById("standard-more-card");
    if (more && Array.isArray(standard.more)) {
      list(more, standard.more);
      card.hidden = !standard.more.length;
    }
    if (standard.months) {
      document.getElementById("standard-months").textContent = "We plan another visit to each company every " +
        (standard.months === 12 ? "year" : standard.months + " months") + " to keep it current.";
    }
  }).catch(function () {});
})();
