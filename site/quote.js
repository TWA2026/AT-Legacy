(function () {
  var form = document.getElementById("quote-form");
  var done = document.getElementById("quote-done");
  var openEmail = document.getElementById("open-email");
  var copyButton = document.getElementById("copy-request");
  var copyStatus = document.getElementById("copy-status");
  var editButton = document.getElementById("edit-request");
  var address = form.dataset.email;
  var requestText = "";

  document.getElementById("quote-address").textContent = address;

  function value(name) {
    return form.elements[name].value.trim();
  }

  function buildBody() {
    return [
      "Service: " + value("service"),
      "Property type: " + value("property"),
      "County: " + value("county"),
      "City or ZIP code: " + value("location"),
      "Timing: " + value("timing"),
      "Budget: " + (value("budget") || "Not provided"),
      "",
      "Job details:",
      value("details"),
      "",
      "Name: " + value("name"),
      "Phone: " + value("phone"),
      "Best way to reach me: " + value("contact")
    ].join("\r\n");
  }

  function buildLink(subject, body) {
    return "mailto:" + address +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var subject = "Quote request: " + value("service") + " (" + value("county") + ")";
    var link;

    requestText = buildBody();
    link = buildLink(subject, requestText);
    openEmail.href = link;
    copyStatus.textContent = "";
    form.hidden = true;
    done.hidden = false;
    done.focus();
    window.scrollTo(0, 0);
    window.location.href = link;
  });

  copyButton.addEventListener("click", function () {
    if (!navigator.clipboard) {
      copyStatus.textContent = "Copy isn't available in this browser. Use Open email again.";
      return;
    }

    navigator.clipboard.writeText(requestText).then(function () {
      copyStatus.textContent = "Request copied.";
    }, function () {
      copyStatus.textContent = "Copy didn't work. Use Open email again.";
    });
  });

  editButton.addEventListener("click", function () {
    done.hidden = true;
    form.hidden = false;
    form.elements.service.focus();
  });
})();
