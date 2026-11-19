// Copy buttons on the dashboard: <button data-copy="id-of-input">.
document.addEventListener("click", function (event) {
  var button = event.target.closest("[data-copy]");
  if (!button) return;
  var field = document.getElementById(button.getAttribute("data-copy"));
  if (!field) return;
  field.select();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(field.value).then(function () {
      button.textContent = "Copied";
    }, function () {
      button.textContent = "Press Ctrl+C";
    });
  } else {
    button.textContent = "Press Ctrl+C";
  }
});
