// The contact page: sends a message to the dashboard's Messages tab.
(function () {
  var form = document.getElementById("contact-form");
  if (!form) return;
  var api = String(window.ATL_API || "").replace(/\/+$/, "");
  var errorBox = document.getElementById("contact-error");
  var button = document.getElementById("contact-send");
  var done = document.getElementById("contact-done");

  function fail(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = "Send my message";
  }

  form.addEventListener("input", function () { errorBox.hidden = true; });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var body = {
      name: form.elements.name.value,
      reach: form.elements.reach.value,
      message: form.elements.message.value,
      company_url: form.elements.company_url.value
    };
    button.disabled = true;
    button.textContent = "Sending…";
    fetch(api + "/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) return fail(data.error || "Your message didn’t send. Try again in a moment.");
        form.hidden = true;
        done.hidden = false;
        done.focus();
      });
    }, function () {
      fail("We couldn’t reach the server. Check your connection and try again.");
    });
  });
})();
