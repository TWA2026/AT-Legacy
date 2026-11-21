// The services and tiers the hub offers. The request form, the partner form,
// and the admin screens all read from here.

const OWN_CREW_SERVICE = "Home repairs and upkeep";
const OWN_CREW_TIER = "Our crew";

// `group` is the heading the service sits under, on the request form and in the dashboard.
const SERVICES = [
  { name: "Pool", group: "Outdoor projects", check: "DBPR pool contractor license" },
  { name: "Pavers or patio", group: "Outdoor projects", check: "" },
  { name: "Fence", group: "Outdoor projects", check: "County license where required" },
  { name: "Outdoor lighting", group: "Outdoor projects", check: "DBPR electrical license for wired systems" },
  { name: "Electrical work", group: "Home systems", check: "DBPR electrical contractor license" },
  { name: "Water softener", group: "Home systems", check: "DBPR plumbing license" },
  { name: "House cleaning", group: "Regular service", check: "" },
  { name: "Lawn mowing", group: "Regular service", check: "" },
  { name: "Lawn care and fertilizing", group: "Regular service", check: "FDACS fertilizer certification" },
  { name: "Lawn pest control", group: "Regular service", check: "FDACS pest control license" },
  { name: OWN_CREW_SERVICE, group: "Done by your own crew", check: "" },
  { name: "Something else", group: "Other", check: "" }
];

const TIERS = ["Affordable", "Mid-range", "Premium"];

const SERVICE_NAMES = SERVICES.map((service) => service.name);

function licenseCheck(serviceName) {
  const service = SERVICES.find((item) => item.name === serviceName);
  return service ? service.check : "";
}

module.exports = { SERVICES, SERVICE_NAMES, TIERS, OWN_CREW_SERVICE, OWN_CREW_TIER, licenseCheck };
