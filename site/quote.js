(function () {
  var form = document.getElementById("quote-form");
  var briefView = document.getElementById("quote-brief");
  var briefList = document.getElementById("brief");
  var followUps = document.getElementById("follow-ups");
  var followUpFields = document.getElementById("follow-up-fields");
  var sendButton = document.getElementById("send-request");
  var editButton = document.getElementById("edit-request");
  var reviewButton = form.querySelector('button[type="submit"]');
  var errorBox = document.getElementById("form-error");
  var sendError = document.getElementById("send-error");
  var tierPicks = document.querySelector(".tier-picks");
  var tierHelp = document.getElementById("tier-help");
  var ownCrew = document.getElementById("own-crew");
  var ownCrewService = "Home repairs and upkeep";
  var reviewed = null;

  // Links from the home page can name a service or a tier.
  var params = new URLSearchParams(window.location.search);
  var requested = params.get("service");
  if (requested) {
    Array.prototype.forEach.call(form.elements.service.options, function (option) {
      if (option.text === requested) form.elements.service.value = option.text;
    });
  }
  var tierBoxes = Array.prototype.slice.call(form.querySelectorAll('input[name="tier"]'));
  var requestedTier = params.get("tier");
  if (requestedTier && tierBoxes.some(function (box) { return box.value === requestedTier; })) {
    tierBoxes.forEach(function (box) {
      box.checked = box.value === requestedTier;
    });
  }

  function value(name) {
    return form.elements[name].value.trim();
  }

  function isOwnCrew() {
    return value("service") === ownCrewService;
  }

  function chosenTiers() {
    return tierBoxes.filter(function (box) { return box.checked; }).map(function (box) { return box.value; });
  }

  function showTiers() {
    var own = isOwnCrew();
    tierPicks.hidden = own;
    tierHelp.hidden = own;
    ownCrew.hidden = !own;
  }
  form.elements.service.addEventListener("change", showTiers);
  showTiers();

  form.addEventListener("input", function () {
    errorBox.hidden = true;
  });

  function job() {
    return {
      service: value("service"),
      property: value("property"),
      location: value("location"),
      timing: value("timing"),
      size: value("size"),
      details: value("details"),
      tiers: chosenTiers()
    };
  }

  function firstProblem() {
    var missing = form.querySelector("input:invalid, select:invalid, textarea:invalid");
    if (missing) {
      missing.focus();
      return missing.type === "email" && missing.value ? "Enter a valid email address." : "Fill in every field that isn’t marked optional.";
    }
    if (value("contact") === "Email" && !value("email")) {
      form.elements.email.focus();
      return "Add your email address, or choose Call or Text.";
    }
    if (!isOwnCrew() && chosenTiers().length === 0) {
      tierBoxes[0].focus();
      return "Choose at least one tier.";
    }
    return "";
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || "That didn’t work. Try again in a moment.");
        return data;
      });
    }, function () {
      throw new Error("We couldn’t reach the server. Check your connection and try again.");
    });
  }

  function row(label, content) {
    var term = document.createElement("dt");
    var detail = document.createElement("dd");
    term.textContent = label;
    if (typeof content === "string") detail.textContent = content;
    else detail.appendChild(content);
    briefList.appendChild(term);
    briefList.appendChild(detail);
  }

  function showBrief(data) {
    var brief = data.brief;
    var theJob = document.createElement("div");
    var summary = document.createElement("span");
    var scope = document.createElement("ul");
    summary.textContent = brief.summary;
    scope.className = "scope";
    brief.scope.forEach(function (point) {
      var item = document.createElement("li");
      item.textContent = point;
      scope.appendChild(item);
    });
    theJob.appendChild(summary);
    if (brief.scope.length) theJob.appendChild(scope);

    briefList.textContent = "";
    row("Service", value("service"));
    row("Where", value("location"));
    row("Timing", value("timing"));
    if (value("size")) row("Size or how often", value("size"));
    row("The job", theJob);
    row("Quotes wanted", isOwnCrew() ? "One quote from AT Legacy Services" : chosenTiers().join(", "));

    followUpFields.textContent = "";
    brief.questions.forEach(function (question, index) {
      var field = document.createElement("div");
      var label = document.createElement("label");
      var input = document.createElement("input");
      field.className = "field wide";
      label.textContent = question;
      label.htmlFor = "follow-up-" + index;
      input.id = "follow-up-" + index;
      input.type = "text";
      input.maxLength = 300;
      field.appendChild(label);
      field.appendChild(input);
      followUpFields.appendChild(field);
    });
    followUps.hidden = brief.questions.length === 0;

    sendError.hidden = true;
    form.hidden = true;
    briefView.hidden = false;
    briefView.focus();
    window.scrollTo(0, 0);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var problem = firstProblem();
    errorBox.textContent = problem;
    errorBox.hidden = !problem;
    if (problem) return;

    reviewButton.disabled = true;
    reviewButton.textContent = "Writing your brief…";
    post("/api/brief", job()).then(function (data) {
      reviewed = data;
      showBrief(data);
    }, function (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }).then(function () {
      reviewButton.disabled = false;
      reviewButton.textContent = "Review my job brief";
    });
  });

  sendButton.addEventListener("click", function () {
    var body = job();
    body.name = value("name");
    body.phone = value("phone");
    body.email = value("email");
    body.contact = value("contact");
    body.company_url = value("company_url");
    body.brief = reviewed.brief;
    body.signature = reviewed.signature;
    body.answers = Array.prototype.map.call(followUpFields.querySelectorAll("input"), function (input) {
      return input.value.trim();
    });

    sendError.hidden = true;
    sendButton.disabled = true;
    sendButton.textContent = "Sending…";
    post("/api/requests", body).then(function (data) {
      window.location.href = data.url;
    }, function (error) {
      sendError.textContent = error.message;
      sendError.hidden = false;
      sendButton.disabled = false;
      sendButton.textContent = "Send my request";
    });
  });

  editButton.addEventListener("click", function () {
    briefView.hidden = true;
    form.hidden = false;
    form.elements.service.focus();
  });
})();
