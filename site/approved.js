// The approved companies page. With no ?id= it shows the list and the numbers.
// With ?id=AV-1003 it shows that one company's record.
// The record, the numbers, and the "not on the list" note are built here, so the page's own HTML
// never holds an empty heading or a blank count.
(function () {
  var listPart = document.getElementById("approved-list-part");
  if (!listPart || !window.fetch) return;
  var api = String(window.ATL_API || "").replace(/\/+$/, "");
  var status = document.getElementById("approved-status");
  var detail = document.getElementById("approved-detail");
  var wanted = new URLSearchParams(window.location.search).get("id");

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function link(text, href, className) {
    var node = el("a", text, className);
    node.href = href;
    return node;
  }

  function part(title) {
    var section = el("section", "", "read-part");
    section.appendChild(el("h2", title));
    detail.appendChild(section);
    return section;
  }

  function listOf(lines) {
    var list = el("ul");
    lines.forEach(function (line) {
      list.appendChild(el("li", line));
    });
    return list;
  }

  function stars(count) {
    return "★★★★★".slice(0, count) + "☆☆☆☆☆".slice(0, 5 - count);
  }

  function showNumbers(numbers) {
    var section = part("Our numbers");
    var table = el("dl", "", "numbers");
    [["Approved today", numbers.approved], ["Working toward approval", numbers.working],
      ["Applied and not approved", numbers.notApproved], ["Taken off the list", numbers.removed]].forEach(function (pair) {
      var row = el("div");
      row.appendChild(el("dt", pair[0]));
      row.appendChild(el("dd", String(pair[1])));
      table.appendChild(row);
    });
    section.appendChild(table);
    section.appendChild(el("p", "Counted from our own records each time this page loads.", "form-note"));
  }

  function showList(data) {
    var list = document.getElementById("approved-list");
    var companies = data.companies || [];
    companies.forEach(function (company) {
      var item = el("li");
      item.appendChild(link(company.company, "/approved?id=" + encodeURIComponent(company.no)));
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
    showNumbers(numbers);
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

    var section = part(company.company);
    section.appendChild(el("p", company.service + ". " + company.tier + " tier."));
    var record = el("div", "", "quote-record record-page");
    record.appendChild(listOf(company.items || []));
    if (company.shown && company.shown.length) {
      record.appendChild(el("p", "Shown at our visit", "record-shown"));
      record.appendChild(listOf(company.shown));
    }
    section.appendChild(record);
    if (company.stateLicense) {
      var license = el("p", "You can look up a Florida contractor’s license yourself at ", "form-note");
      var state = link("myfloridalicense.com", "https://www.myfloridalicense.com");
      state.rel = "noopener";
      license.appendChild(state);
      license.appendChild(document.createTextNode("."));
      section.appendChild(license);
    }
    if (company.ratings) {
      section.appendChild(el("p", "Rated " + Number(company.ratings.average).toFixed(1) + " out of 5 by " + company.ratings.count +
        " customers who hired this company through us. Every rating counts, not only the good ones."));
    }
    if (company.reviews && company.reviews.length) {
      var reviews = el("ul", "", "review-list");
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
      section.appendChild(reviews);
    }
    var actions = el("p", "", "done-actions");
    actions.appendChild(link("Start a request", "/quote?service=" + encodeURIComponent(company.service) + "&tier=" + encodeURIComponent(company.tier), "secondary"));
    actions.appendChild(link("See the whole list", "/approved", "secondary"));
    section.appendChild(actions);
  }

  function showMissing() {
    var section = part("Not on the list");
    section.appendChild(el("p", "No company with that number is on our public list today. A company comes off when it stops meeting our standard, and some approved companies aren’t named here."));
    var actions = el("p", "", "done-actions");
    actions.appendChild(link("See the whole list", "/approved", "secondary"));
    actions.appendChild(link("Ask us about a company", "/contact", "secondary"));
    section.appendChild(actions);
  }

  function failed() {
    status.textContent = "We couldn’t load this just now. Try again in a minute.";
    listPart.hidden = false;
  }

  status.textContent = "Loading the list.";
  if (wanted) {
    listPart.hidden = true;
    fetch(api + "/api/approved/" + encodeURIComponent(wanted)).then(function (response) {
      if (response.status === 404) {
        showMissing();
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
