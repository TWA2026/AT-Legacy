// The standard page: shows the list the owner keeps in the dashboard, so the page never drifts from it.
(function () {
  var must = document.getElementById("standard-must");
  if (!must) return;
  var api = String(window.ATL_API || "").replace(/\/+$/, "");
  var more = document.getElementById("standard-more");
  var status = document.getElementById("standard-status");

  function list(target, labels) {
    labels.forEach(function (label) {
      var item = document.createElement("li");
      item.textContent = label;
      target.appendChild(item);
    });
  }

  fetch(api + "/api/standard").then(function (response) {
    if (!response.ok) throw new Error("unavailable");
    return response.json();
  }).then(function (standard) {
    list(must, standard.must || []);
    if (standard.more && standard.more.length) {
      list(more, standard.more);
      document.getElementById("standard-more-title").hidden = false;
      document.getElementById("standard-more-note").hidden = false;
    }
    if (standard.months) {
      document.getElementById("standard-months").textContent = "We plan another visit to each company every " +
        (standard.months === 12 ? "year" : standard.months + " months") + " to keep it current.";
    }
    status.hidden = true;
  }).catch(function () {
    status.textContent = "We couldn’t load the list just now. Try again in a minute, or ask us for a copy.";
  });
})();
