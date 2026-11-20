// Pictures and files for a request: the "add" buttons, the previews, and sending.
//
// Every picture is redrawn in the browser as a JPEG no wider or taller than 1600 pixels. That keeps
// it small enough to send from a phone, and it leaves behind everything the camera wrote into the
// original, including where it was taken. PDFs are sent as they are.
//
// Two pages use this. The request form (quote.js) holds the files until the request is sent.
// The customer's own request page sends each file as soon as it is added.
(function () {
  var MAX_FILES = 10;
  var MAX_EDGE = 1600;
  var JPEG_BYTES = 1400000;
  var PDF_BYTES = 3 * 1024 * 1024;
  // Set in config.js. Empty when this page and the API share one address.
  var api = String(window.ATL_API || "").replace(/\/+$/, "");

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error("unreadable")); };
      reader.readAsDataURL(file);
    });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error("unreadable")); };
      image.src = url;
    });
  }

  // Draws the picture onto a white sheet no larger than `edge` on its long side.
  function draw(image, edge) {
    var width = image.naturalWidth || image.width;
    var height = image.naturalHeight || image.height;
    var scale = Math.min(1, edge / Math.max(width, height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    var context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function toJpeg(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("unreadable"));
      }, "image/jpeg", quality);
    });
  }

  // Tries smaller and plainer versions until the picture is small enough to send.
  function shrink(image) {
    var tries = [[MAX_EDGE, 0.8], [MAX_EDGE, 0.65], [1280, 0.7], [1024, 0.65]];
    function attempt(index) {
      return toJpeg(draw(image, tries[index][0]), tries[index][1]).then(function (blob) {
        if (blob.size <= JPEG_BYTES || index === tries.length - 1) return blob;
        return attempt(index + 1);
      });
    }
    return attempt(0);
  }

  function baseName(name) {
    return String(name || "").replace(/\.[A-Za-z0-9]{1,5}$/, "") || "picture";
  }

  // Gets one chosen file ready to send. Rejects with a sentence that says what to do instead.
  function prepare(file, kind) {
    var isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      if (kind !== "document") return Promise.reject(new Error("Add PDF files under Plans or documents."));
      if (file.size > PDF_BYTES) return Promise.reject(new Error(file.name + " is over 3 MB. Take pictures of its pages instead."));
      return Promise.resolve({ kind: kind, name: file.name, type: "application/pdf", blob: file, thumb: "" });
    }
    var looksLikeImage = /^image\//.test(file.type) || /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i.test(file.name);
    if (!looksLikeImage) return Promise.reject(new Error("We can take pictures and PDF files. " + file.name + " is neither."));
    return readAsDataUrl(file).then(loadImage).then(function (image) {
      return shrink(image).then(function (blob) {
        if (blob.size > JPEG_BYTES) throw new Error("unreadable");
        return { kind: kind, name: baseName(file.name) + ".jpg", type: "image/jpeg", blob: blob, thumb: draw(image, 160).toDataURL("image/jpeg", 0.7) };
      });
    }).catch(function () {
      throw new Error("This browser couldn’t read " + file.name + ". Take a screenshot of the picture and add that instead.");
    });
  }

  // Sends one prepared file to a request. Resolves with what the server stored.
  function send(token, item) {
    var address = api + "/api/requests/" + encodeURIComponent(token) + "/files?kind=" + encodeURIComponent(item.kind) + "&name=" + encodeURIComponent(item.name);
    return fetch(address, { method: "POST", headers: { "content-type": item.type }, body: item.blob }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(data.error || "That file didn’t upload. Try again in a moment.");
        return data;
      });
    }, function () {
      throw new Error("We couldn’t reach the server. Check your connection and try again.");
    });
  }

  // Runs the "add" buttons inside `root`.
  //   room    how many files may still be added
  //   onAdd   when given, each file is handed over as soon as it is ready instead of being listed here.
  //           It returns a promise; a rejection is shown as the error.
  //   onDone  called after a batch of chosen files has been handled, with how many were handed over
  function mount(root, options) {
    options = options || {};
    var items = [];
    var room = typeof options.room === "number" ? options.room : MAX_FILES;
    var status = root.querySelector("[data-upload-status]");
    var errorBox = root.querySelector("[data-upload-error]");
    var groups = Array.prototype.slice.call(root.querySelectorAll(".file-group"));
    var inputs = groups.map(function (group) { return group.querySelector('input[type="file"]'); });

    function say(text) {
      status.textContent = text;
      status.hidden = !text;
    }

    function complain(text) {
      errorBox.textContent = text;
      errorBox.hidden = !text;
    }

    function render() {
      groups.forEach(function (group) {
        var kind = group.getAttribute("data-kind");
        var list = group.querySelector(".file-list");
        list.textContent = "";
        items.filter(function (item) { return item.kind === kind; }).forEach(function (item) {
          var row = document.createElement("li");
          var thumb;
          var name = document.createElement("span");
          var remove = document.createElement("button");
          row.className = "file-item";
          if (item.thumb) {
            thumb = document.createElement("img");
            thumb.src = item.thumb;
            thumb.alt = "";
          } else {
            thumb = document.createElement("span");
            thumb.textContent = "PDF";
            thumb.setAttribute("aria-hidden", "true");
          }
          thumb.className = item.thumb ? "file-thumb" : "file-thumb file-thumb-doc";
          name.className = "file-name";
          name.textContent = item.name;
          remove.type = "button";
          remove.className = "text-button";
          remove.textContent = "Remove";
          remove.setAttribute("aria-label", "Remove " + item.name);
          remove.addEventListener("click", function () {
            items.splice(items.indexOf(item), 1);
            complain("");
            render();
            if (options.onChange) options.onChange(items);
          });
          row.appendChild(thumb);
          row.appendChild(name);
          row.appendChild(remove);
          list.appendChild(row);
        });
        list.hidden = !list.children.length;
      });
    }

    function handle(files, kind) {
      var problems = [];
      var handed = 0;
      var index = 0;
      inputs.forEach(function (input) { input.disabled = true; });
      complain("");

      function next() {
        if (index >= files.length) return Promise.resolve();
        var file = files[index];
        index += 1;
        if (items.length + handed >= room) {
          problems.push("A request can hold " + MAX_FILES + " files. " + file.name + " wasn’t added.");
          return next();
        }
        say((options.onAdd ? "Sending " : "Getting ready: ") + index + " of " + files.length);
        return prepare(file, kind).then(function (item) {
          if (!options.onAdd) {
            items.push(item);
            render();
            return null;
          }
          return options.onAdd(item).then(function () { handed += 1; });
        }).catch(function (error) {
          problems.push(error.message);
        }).then(next);
      }

      return next().then(function () {
        inputs.forEach(function (input) { input.disabled = false; });
        say("");
        if (problems.length) complain(problems.join(" "));
        if (options.onChange) options.onChange(items);
        if (options.onDone) options.onDone(handed, problems);
      });
    }

    inputs.forEach(function (input, at) {
      input.addEventListener("change", function () {
        var files = Array.prototype.slice.call(input.files || []);
        // Clear the field so the same file can be chosen again after it is removed.
        input.value = "";
        if (files.length) handle(files, groups[at].getAttribute("data-kind"));
      });
    });

    return {
      items: function () { return items.slice(); },
      summary: function () {
        var pictures = items.filter(function (item) { return item.type === "image/jpeg"; }).length;
        var documents = items.length - pictures;
        var parts = [];
        if (pictures) parts.push(pictures + (pictures === 1 ? " picture" : " pictures"));
        if (documents) parts.push(documents + (documents === 1 ? " PDF" : " PDFs"));
        return parts.join(", ");
      }
    };
  }

  window.ATLUploads = { mount: mount, send: send, prepare: prepare };

  // The customer's own request page: each file goes up as soon as it is added, then the page reloads to show it.
  var adder = document.querySelector("[data-upload-to]");
  if (adder) {
    var token = adder.getAttribute("data-upload-to");
    mount(adder.querySelector("[data-uploads]"), {
      room: Number(adder.getAttribute("data-upload-room")) || 0,
      onAdd: function (item) { return send(token, item); },
      onDone: function (sent, problems) {
        if (sent && !problems.length) {
          window.location.hash = "files";
          window.location.reload();
        } else if (sent) {
          var errorBox = adder.querySelector("[data-upload-error]");
          errorBox.textContent += " The other files were added. Reload this page to see them.";
        }
      }
    });
  }
})();
