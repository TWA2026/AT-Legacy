// Copy buttons: <button data-copy="id-of-input"> copies a field, <button data-copy-text="..."> copies that text.
// Share buttons: <button data-share-url data-share-text>. Shown only where the phone or browser can share.
// Send tracking: inside an element with data-track, a click on anything with data-track-event is reported
// to the dashboard, so it can show when each private link was copied, texted, emailed, or shared.
// An invoice on the Fees page is tracked the same way, with data-track-invoice.
// Print buttons: <button data-print> opens the print dialog, where the page can also be saved as a PDF.

function reportSend(element, how) {
  var row = element.closest("[data-track], [data-track-invoice]");
  if (!row || !navigator.sendBeacon) return;
  var data = new URLSearchParams();
  data.set("csrf", row.getAttribute("data-csrf") || "");
  data.set("request", row.getAttribute("data-track") || "");
  data.set("invoice", row.getAttribute("data-track-invoice") || "");
  data.set("quote", row.getAttribute("data-track-quote") || "");
  data.set("event", how);
  navigator.sendBeacon("/admin/link-events", data);
}

document.addEventListener("click", function (event) {
  var sent = event.target.closest("[data-track-event]");
  if (sent) reportSend(sent, sent.getAttribute("data-track-event"));

  if (event.target.closest("[data-print]")) {
    window.print();
    return;
  }

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
    // Closing the share sheet without sending is not an error, and is not a send.
    navigator.share(message).then(function () {
      reportSend(share, "shared");
    }, function () {});
  }
});

if (navigator.share) {
  Array.prototype.forEach.call(document.querySelectorAll("[data-share-url]"), function (button) {
    if (button.parentNode.hidden) button.parentNode.hidden = false;
  });
}
