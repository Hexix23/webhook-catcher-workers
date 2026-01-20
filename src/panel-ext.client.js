"use strict";
(function () {
    function getSelectedIds() { return Array.from(document.querySelectorAll('.chk:checked')).map(function (c) { return c.getAttribute('data-id'); }).filter(Boolean); }
    function getSelectedOrAll() { var ids = getSelectedIds(); var ev = window.__events || []; if (!ids.length) return ev; var s = new Set(ids); return ev.filter(function (e) { return s.has(e.id); }); }
    function download(fn, content, type) { var b = new Blob([content], { type: type }); var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = fn; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500); }
    var btnJson = document.getElementById('exportJson'); if (btnJson) btnJson.addEventListener('click', function () { try { var list = getSelectedOrAll(); download('events.json', JSON.stringify(list, null, 2), 'application/json'); } catch (_) { } });
    var btnCsv = document.getElementById('exportCsv'); if (btnCsv) btnCsv.addEventListener('click', function () { try { var list = getSelectedOrAll(); var header = ['id', 'receivedAt', 'keyValues']; var rows = list.map(function (e) { var kv = Object.entries(e.body || {}).map(function (pair) { return pair[0] + '=' + String(pair[1]).replaceAll('\\n', ' '); }).join('; '); return [e.id, e.receivedAt, '"' + kv.replaceAll('"', '""') + '"']; }); var csv = [header.join(',')].concat(rows.map(function (r) { return r.join(','); })).join('\\n'); download('events.csv', csv, 'text/csv'); } catch (_) { } });
    try { var saved = localStorage.getItem('theme') || 'dark'; if (saved === 'light') document.body.classList.add('theme-light'); } catch (_) { }
    var tbtn = document.getElementById('themeToggle'); if (tbtn) tbtn.addEventListener('click', function () { document.body.classList.toggle('theme-light'); try { localStorage.setItem('theme', document.body.classList.contains('theme-light') ? 'light' : 'dark'); } catch (_) { } });
})();
