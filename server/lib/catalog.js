// The services and tiers the hub offers. The request form, the partner form,
// and the admin screens all read from here.

const OWN_CREW_SERVICE = "Home repairs and upkeep";
const OWN_CREW_TIER = "Our crew";

const SERVICES = [
  { name: "Pool", check: "DBPR pool contractor license" },
  { name: "Pavers or patio", check: "" },
  { name: "Fence", check: "County license where required" },
  { name: "Outdoor lighting", check: "DBPR electrical license for wired systems" },
  { name: "Electrical work", check: "DBPR electrical contractor license" },
  { name: "Water softener", check: "DBPR plumbing license" },
  { name: "House cleaning", check: "" },
  { name: "Lawn mowing", check: "" },
  { name: "Lawn care and fertilizing", check: "FDACS fertilizer certification" },
  { name: "Lawn pest control", check: "FDACS pest control license" },
  { name: OWN_CREW_SERVICE, check: "" },
  { name: "Something else", check: "" }
];

const TIERS = ["Affordable", "Mid-range", "Premium"];

const SERVICE_NAMES = SERVICES.map((service) => service.name);

function licenseCheck(serviceName) {
  const service = SERVICES.find((item) => item.name === serviceName);
  return service ? service.check : "";
}

module.exports = { SERVICES, SERVICE_NAMES, TIERS, OWN_CREW_SERVICE, OWN_CREW_TIER, licenseCheck };
