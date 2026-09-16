package main

import (
	"crypto/sha256"
	"encoding/base64"
)

// User names are assigned only through textContent and percent-encoded URL
// segments. No user file is rendered as HTML or interpolated into this page.
const fileBrowserScript = `
"use strict";
const base = new URL("./", window.location.href);
const rows = document.getElementById("rows");
const status = document.getElementById("status");
const picker = document.getElementById("picker");
const upload = document.getElementById("upload");
let current = "";
function size(n) {
  if (n < 1024) return n + " B";
  const units = ["KiB", "MiB", "GiB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(1) + " " + units[i];
}
function notice(message, error) {
  status.textContent = message;
  status.classList.toggle("error", Boolean(error));
}
function fileURL(path) {
  return new URL("files/" + path.split("/").map(encodeURIComponent).join("/"), base);
}
async function checked(response) {
  if (!response.ok) {
    let message = "Request failed (" + response.status + ").";
    try { const body = await response.json(); if (body.error) message = body.error; } catch (_) {}
    throw new Error(message);
  }
  return response;
}
async function list(path) {
  notice("Loading folder…", false);
  const endpoint = new URL("api/files", base);
  endpoint.searchParams.set("path", path);
  const response = await checked(await fetch(endpoint, {cache: "no-store", credentials: "same-origin"}));
  const data = await response.json();
  current = data.path;
  document.getElementById("path").textContent = "/" + current;
  document.getElementById("limit").textContent = "Upload limit: " + size(data.maxUploadBytes);
  document.getElementById("up").disabled = current === "";
  rows.replaceChildren();
  for (const entry of data.entries) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const link = document.createElement(entry.type === "directory" ? "button" : "a");
    link.textContent = entry.name + (entry.type === "directory" ? "/" : "");
    link.className = "filename";
    if (entry.type === "directory") {
      link.type = "button";
      link.addEventListener("click", () => list(entry.path).catch(showError));
    } else {
      link.href = fileURL(entry.path).href;
      link.download = entry.name;
    }
    name.append(link);
    const bytes = document.createElement("td");
    bytes.textContent = entry.type === "directory" ? "Folder" : size(entry.size);
    const modified = document.createElement("td");
    modified.textContent = new Date(entry.modifiedAt).toLocaleString();
    row.append(name, bytes, modified);
    rows.append(row);
  }
  notice(data.entries.length ? data.entries.length + " items" : "No files in this folder.", false);
}
function showError(error) { notice(error.message || "File operation failed.", true); }
picker.addEventListener("change", () => { upload.disabled = picker.files.length === 0; });
document.getElementById("refresh").addEventListener("click", () => list(current).catch(showError));
document.getElementById("up").addEventListener("click", () => {
  const parts = current.split("/"); parts.pop();
  list(parts.join("/")).catch(showError);
});
document.getElementById("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  const files = Array.from(picker.files);
  if (!files.length) return;
  const folder = current;
  upload.disabled = true;
  picker.disabled = true;
  try {
    for (const file of files) {
      notice("Uploading " + file.name + "…", false);
      const path = folder ? folder + "/" + file.name : file.name;
      await checked(await fetch(fileURL(path), {method: "PUT", body: file, credentials: "same-origin"}));
    }
    picker.value = "";
    await list(folder);
    notice(files.length + " file(s) uploaded.", false);
  } catch (error) { showError(error); }
  finally { picker.disabled = false; upload.disabled = picker.files.length === 0; }
});
list(new URLSearchParams(window.location.search).get("path") || "").catch(showError);
`

func fileBrowserCSP() string {
	sum := sha256.Sum256([]byte(fileBrowserScript))
	return "default-src 'none'; script-src 'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
}

func fileBrowserHTML() string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Output workspace</title><style>
:root{color-scheme:light;--ink:#202830;--muted:#64717a;--line:#d8dedf;--accent:#ad4e16}
*{box-sizing:border-box}body{margin:0;background:#f6f5f0;color:var(--ink);font:14px/1.55 Menlo,Consolas,monospace}
main{max-width:1120px;margin:0 auto;padding:48px 24px}header{border-top:4px solid var(--accent);padding-top:22px}
.eyebrow{font-size:11px;letter-spacing:.15em;color:var(--accent)}h1{font:normal 38px/1.1 Georgia,serif;margin:12px 0}
header p{color:var(--muted);margin:0 0 32px}.toolbar,form{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.toolbar{padding:16px 0;border-top:1px solid var(--line)}#path{flex:1;overflow-wrap:anywhere;font-weight:bold}
button,input{font:inherit}button{min-height:40px;padding:8px 14px;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer}
button:hover{border-color:var(--accent)}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #d38e53;outline-offset:3px}
form{padding:18px;background:#ebece5;border:1px solid var(--line)}form label{font-weight:bold}input{max-width:100%}
#upload{background:var(--ink);color:#fff;border-color:var(--ink);margin-left:auto}#limit{width:100%;font-size:11px;color:var(--muted)}
.table-wrap{overflow:auto;margin-top:22px;background:#fff;border:1px solid var(--line)}table{width:100%;border-collapse:collapse;text-align:left}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:13px 18px;background:#f0f1eb}
td{padding:12px 18px;border-top:1px solid var(--line)}td:first-child{width:60%;min-width:200px;overflow-wrap:anywhere}td:not(:first-child){white-space:nowrap}
.filename{background:none;border:0;padding:0;min-height:30px;text-decoration:none;color:var(--accent);text-align:left}.filename:hover{text-decoration:underline}
#status{min-height:24px;color:var(--muted);padding:12px 0}#status.error{color:#a12828}
@media(max-width:600px){main{padding:24px 14px}h1{font-size:30px}form{align-items:flex-start}#upload{margin-left:0}}
</style></head><body><main>
<header><div class="eyebrow">WORKLOAD FILES</div><h1>Output workspace</h1><p>Browse and transfer files for this running task.</p></header>
<nav class="toolbar" aria-label="Folder navigation"><button id="up" type="button" disabled>Parent folder</button><span id="path">/</span><button id="refresh" type="button">Refresh</button></nav>
<form id="upload-form"><label for="picker">Add files</label><input id="picker" type="file" multiple><button id="upload" type="submit" disabled>Upload</button><span id="limit"></span></form>
<div class="table-wrap"><table><thead><tr><th scope="col">Name</th><th scope="col">Size</th><th scope="col">Modified</th></tr></thead><tbody id="rows"></tbody></table></div>
<p id="status" role="status" aria-live="polite"></p>
</main><script>` + fileBrowserScript + `</script></body></html>`
}
