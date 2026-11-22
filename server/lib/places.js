// ZIP codes and the city each belongs to, for the request form.
//
// site/zips.json holds Florida's ZIP codes. The request page reads it to fill in the city as the
// customer types, and the hub reads it here so a request that arrives with a ZIP and no city
// still gets one. A ZIP that isn't in the list is not turned away: the customer types the city.

const cities = require("../../site/zips.json");

function cityOf(zip) {
  return Object.prototype.hasOwnProperty.call(cities, zip) ? cities[zip] : "";
}

module.exports = { cityOf };
