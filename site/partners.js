(function () {
  var form = document.getElementById("partner-form");
  var done = document.getElementById("partner-done");
  var errorBox = document.getElementById("form-error");
  var submitButton = form.querySelector('button[type="submit"]');

  form.addEventListener("input", function () {
    errorBox.hidden = true;
  });

  function fail(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    var missing = form.querySelector("input:invalid, select:invalid, textarea:invalid");
    if (missing) {
      missing.focus();
      return fail(missing.type === "email" && missing.value ? "Enter a valid email address." : "Fill in every field that isn’t marked optional.");
    }

    var body = {};
    Array.prototype.forEach.call(form.elements, function (field) {
      if (field.name) body[field.name] = field.value.trim();
    });

    submitButton.disabled = true;
    submitButton.textContent = "Sending…";
    fetch(String(window.ATL_API || "").replace(/\/+$/, "") + "/api/partners", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || "That didn’t work. Try again in a moment.");
      });
    }, function () {
      throw new Error("We couldn’t reach the server. Check your connection and try again.");
    }).then(function () {
      form.hidden = true;
      done.hidden = false;
      done.focus();
      window.scrollTo(0, 0);
    }, function (error) {
      fail(error.message);
      submitButton.disabled = false;
      submitButton.textContent = "Send my application";
    });
  });
})();
