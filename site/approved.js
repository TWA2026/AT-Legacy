// The approved companies page. With no ?id= it shows the list and the numbers.
// With ?id=AV-1003 it shows that one company's record.
(function () {
  var listPart = document.getElementById("approved-list-part");
  if (!listPart || !window.fetch) return;
  var api = String(window.ATL_API || "").replace(/\/+$/, "");
  var status = document.getElementById("approved-status");
  var wanted = new URLSearchParams(window.location.search).get("id");

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function fill(target, lines) {
    lines.forEach(function (line) {
      target.appendChild(el("li", line));
    });
  }

  function stars(count) {
    return "★★★★★".slice(0, count) + "☆☆☆☆☆".slice(0, 5 - count);
  }

  function showList(data) {
    var list = document.getElementById("approved-list");
    var companies = data.companies || [];
    companies.forEach(function (company) {
      var item = el("li");
      var link = el("a", company.company);
      link.href = "/approved?id=" + encodeURIComponent(company.no);
      item.appendChild(link);
      item.appendChild(el("span", company.service + ". " + company.tier + " tier."));
      item.appendChild(el("span", "Approved vendor " + company.no + ", since " + company.since));
      list.appendChild(item);
    });
    if (companies.length) {
      status.hidden = true;
    } else {
      status.textContent = "No companies are named here yet. We’re signing up and visiting our first ones now. Each appears here once it passes and agrees to be listed.";
    }
    var numbers = data.numbers;
    if (!numbers) return;
    document.getElementById("n-approved").textContent = numbers.approved;
    document.getElementById("n-working").textContent = numbers.working;
    document.getElementById("n-not").textContent = numbers.notApproved;
    document.getElementById("n-removed").textContent = numbers.removed;
    document.getElementById("approved-numbers").hidden = false;
    var unnamed = numbers.approved - companies.length;
    if (unnamed > 0 && companies.length) {
      var note = document.getElementById("approved-unnamed");
      note.textContent = unnamed + (unnamed === 1 ? " more approved company isn’t" : " more approved companies aren’t") + " named here.";
      note.hidden = false;
    }
  }

  function showRecord(company) {
    document.title = company.company + ", approved vendor " + company.no + " | AT Legacy Services";
    // The number stays on one line: "AV-1004" never breaks at its hyphen.
    var title = document.getElementById("approved-title");
    title.textContent = "Approved vendor ";
    title.appendChild(el("span", company.no, "keep-together"));
    document.getElementById("approved-lead").textContent = "What we have on file about this company. Every line is something we checked or saw ourselves.";
    document.getElementById("record-name").textContent = company.company;
    document.getElementById("record-line").textContent = company.service + ". " + company.tier + " tier.";
    fill(document.getElementById("record-items"), company.items || []);
    if (company.shown && company.shown.length) {
      document.getElementById("record-shown-title").hidden = false;
      fill(document.getElementById("record-shown"), company.shown);
    }
    document.getElementById("record-license").hidden = !company.stateLicense;
    if (company.ratings) {
      var rated = document.getElementById("record-ratings");
      rated.textContent = "Rated " + Number(company.ratings.average).toFixed(1) + " out of 5 by " + company.ratings.count +
        " customers who hired this company through us. Every rating counts, not only the good ones.";
      rated.hidden = false;
    }
    if (company.reviews && company.reviews.length) {
      var reviews = document.getElementById("record-reviews");
      company.reviews.forEach(function (review) {
        var item = el("li");
        var mark = el("p", stars(review.stars), "review-stars");
        mark.setAttribute("role", "img");
        mark.setAttribute("aria-label", review.stars + " out of 5 stars");
        item.appendChild(mark);
        if (review.comment) item.appendChild(el("p", review.comment, "review-words"));
        item.appendChild(el("p", review.name + ", " + review.when, "review-who"));
        reviews.appendChild(item);
      });
      reviews.hidden = false;
    }
    document.getElementById("record-request").href = "/quote?service=" + encodeURIComponent(company.service) + "&tier=" + encodeURIComponent(company.tier);
    document.getElementById("approved-record").hidden = false;
  }

  function failed() {
    status.textContent = "We couldn’t load this just now. Try again in a minute.";
    listPart.hidden = false;
  }

  if (wanted) {
    listPart.hidden = true;
    fetch(api + "/api/approved/" + encodeURIComponent(wanted)).then(function (response) {
      if (response.status === 404) {
        document.getElementById("approved-missing").hidden = false;
        return null;
      }
      if (!response.ok) throw new Error("unavailable");
      return response.json();
    }).then(function (company) {
      if (company) showRecord(company);
    }).catch(failed);
  } else {
    fetch(api + "/api/approved").then(function (response) {
      if (!response.ok) throw new Error("unavailable");
      return response.json();
    }).then(showList).catch(failed);
  }
})();
