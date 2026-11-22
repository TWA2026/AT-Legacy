// The finder's fee rule is written into the page. This swaps in the rule the owner keeps in the
// dashboard, in case it has changed since the page was built. If the hub can't be reached, the
// page stays as it is.
(function () {
  var spots = document.querySelectorAll("[data-fee]");
  if (!spots.length || !window.fetch) return;
  var api = String(window.ATL_API || "").replace(/\/+$/, "");
  fetch(api + "/api/fee").then(function (response) {
    return response.ok ? response.json() : null;
  }).then(function (fee) {
    if (!fee || !fee.percent || !fee.rule) return;
    Array.prototype.forEach.call(spots, function (spot) {
      var value = fee[spot.getAttribute("data-fee")];
      if (value !== undefined && value !== null) spot.textContent = String(value);
    });
  }).catch(function () {});
})();
