// Copy buttons: <button data-copy="id-of-input"> copies a field, <button data-copy-text="..."> copies that text.
// Share buttons: <button data-share-url data-share-text>. Shown only where the phone or browser can share.
document.addEventListener("click", function (event) {
  var copy = event.target.closest("[data-copy], [data-copy-text]");
  if (copy) {
    var field = copy.hasAttribute("data-copy") ? document.getElementById(copy.getAttribute("data-copy")) : null;
    var text = field ? field.value : copy.getAttribute("data-copy-text");
    if (!text) return;
    if (field) field.select();
    var failed = field ? "Press Ctrl+C" : "Couldn’t copy";
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        copy.textContent = "Copied";
      }, function () {
        copy.textContent = failed;
      });
    } else {
      copy.textContent = failed;
    }
    return;
  }
  var share = event.target.closest("[data-share-url]");
  if (share && navigator.share) {
    var message = { url: share.getAttribute("data-share-url") };
    var text = share.getAttribute("data-share-text");
    if (text) message.text = text;
    // Closing the share sheet without sending is not an error.
    navigator.share(message).catch(function () {});
  }
});

if (navigator.share) {
  Array.prototype.forEach.call(document.querySelectorAll("[data-share-url]"), function (button) {
    if (button.parentNode.hidden) button.parentNode.hidden = false;
  });
}
