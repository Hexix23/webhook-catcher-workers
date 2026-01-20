"use strict";
(function () {
    // --- JSON Viewer Logic ---
    function buildJsonTree(data, isLast) {
        if (data === null) return '<span class="jv-null">null</span>';
        if (typeof data === 'boolean') return '<span class="jv-bool">' + data + '</span>';
        if (typeof data === 'number') return '<span class="jv-num">' + data + '</span>';
        if (typeof data === 'string') return '<span class="jv-str">"' + escapeHtml(data) + '"</span>';

        if (Array.isArray(data)) {
            if (data.length === 0) return '[]';
            var html = '<span class="jv-toggle">[</span><span class="jv-open">';
            for (var i = 0; i < data.length; i++) {
                html += '<div class="jv-node">' + buildJsonTree(data[i], i === data.length - 1) + (i < data.length - 1 ? ',' : '') + '</div>';
            }
            return html + '</span><span class="jv-closing">]</span><span class="jv-ellipsis jv-hidden">...</span>';
        }

        if (typeof data === 'object') {
            var keys = Object.keys(data);
            if (keys.length === 0) return '{}';
            var html = '<span class="jv-toggle">{</span><span class="jv-open">';
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                html += '<div class="jv-node"><span class="jv-key">"' + escapeHtml(k) + '":</span>' + buildJsonTree(data[k], i === keys.length - 1) + (i < keys.length - 1 ? ',' : '') + '</div>';
            }
            return html + '</span><span class="jv-closing">}</span><span class="jv-ellipsis jv-hidden">...</span>';
        }
        return String(data);
    }

    function escapeHtml(str) {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    document.addEventListener('click', function (e) {
        // Toggle expand/collapse
        if (e.target.classList.contains('jv-toggle') || e.target.classList.contains('jv-ellipsis')) {
            var toggle = e.target.classList.contains('jv-toggle') ? e.target : e.target.previousElementSibling.previousElementSibling; // toggle is before open and closing
            var parent = toggle.parentNode;
            // DOM structure: toggle, open, closing, ellipsis
            // Actually my structure returned above: toggle, open(divs), closing, ellipsis
            // Wait, toggle and ellipsis are siblings of open/closing? No.
            // Flattened string: span.jv-toggle, span.jv-open, span.jv-closing, span.jv-ellipsis
            // Let's rely on siblings relative to the toggle.
            var open = toggle.nextElementSibling;
            var closing = open.nextElementSibling;
            var ellipsis = closing.nextElementSibling;

            var isCollapsed = toggle.classList.toggle('collapsed');
            if (isCollapsed) {
                open.classList.add('jv-hidden');
                closing.classList.add('jv-hidden');
                ellipsis.classList.remove('jv-hidden');
            } else {
                open.classList.remove('jv-hidden');
                closing.classList.remove('jv-hidden');
                ellipsis.classList.add('jv-hidden');
            }
        }

        // Copy button
        if (e.target.classList.contains('jv-copy')) {
            var txt = e.target.getAttribute('data-copy');
            navigator.clipboard.writeText(txt).then(function () {
                var original = e.target.textContent;
                e.target.textContent = 'Copied!';
                setTimeout(function () { e.target.textContent = original; }, 1500);
            });
        }
    });

    // --- Main Logic ---
    async function load() {
        var limitSel = document.querySelector('select[name="limit"]');
        var limit = limitSel ? limitSel.value : '50';
        var sel = document.getElementById('keySelect');
        var selectedKey = sel ? sel.value : '';
        var el = document.getElementById('events');
        try {
            var url = '/api/events?limit=' + encodeURIComponent(limit) + (selectedKey ? ('&key=' + encodeURIComponent(selectedKey)) : '');
            var res = await fetch(url);
            if (!res.ok) {
                var text = await res.text();
                el.innerHTML = '<div class="error">Failed to load events: ' + (text || res.status) + '</div>';
                document.getElementById('countChip').textContent = '0 events';
                window.__events = [];
                return;
            }
            var data = await res.json();
            window.__events = data.events || [];
            render();
        } catch (e) {
            el.innerHTML = '<div class="error">Network error loading events</div>';
            document.getElementById('countChip').textContent = '0 events';
            window.__events = [];
        }
    }

    function render() {
        var events = window.__events || [];
        var q = (document.getElementById('search').value || '').toLowerCase();
        var el = document.getElementById('events');

        var filtered = !q ? events : events.filter(function (e) {
            try {
                var s = JSON.stringify(e.body).toLowerCase();
                return s.includes(q) || (e.id || '').toLowerCase().includes(q);
            } catch (_) { return true; }
        });

        document.getElementById('countChip').textContent = filtered.length + ' events';

        el.innerHTML = filtered.map(function (e) {
            var jsonHtml = buildJsonTree(e.body);
            var rawJson = escapeHtml(JSON.stringify(e.body, null, 2)); // For copy attribute

            return '<div class="event">'
                + '<div class="event__meta">'
                + '<label><input type="checkbox" class="chk" data-id="' + e.id + '"> </label>'
                + '<span class="event__id">' + e.id + '</span>'
                + '<span class="spacer"></span>'
                + '<span class="event__time">' + new Date(e.receivedAt).toLocaleString() + '</span>'
                + '</div>'
                + '<div class="event__json jv-container">'
                + '<button class="jv-copy" data-copy="' + rawJson + '">Copy JSON</button>'
                + jsonHtml
                + '</div>'
                + '</div>'
        }).join('') || '<div class="hint">No events found</div>';
    }

    async function populateKeys() {
        try {
            var res = await fetch('/api/keys');
            var data = await res.json();
            var keys = (data && data.keys) ? data.keys : [];
            var sel = document.getElementById('keySelect');
            if (!sel) return;
            var current = localStorage.getItem('panel_key') || '';
            var opts = keys.map(function (k) { return '<option value="' + k + '">' + k + '</option>'; }).join('');
            sel.innerHTML = '<option value="">NO-KEY</option>' + opts;
            sel.value = current || '';
            sel.addEventListener('change', function () { localStorage.setItem('panel_key', this.value); load(); });
        } catch (e) { }
    }

    // Bindings
    document.getElementById('reloadBtn').addEventListener('click', function (ev) { ev.preventDefault(); setTimeout(load, 0); });
    (function () {
        var form = document.querySelector('form[action="/panel"]');
        if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); load(); });
    })();
    document.getElementById('search').addEventListener('input', render);

    // Select All
    var btnSelectAll = document.getElementById('selectAll');
    if (btnSelectAll) btnSelectAll.addEventListener('click', function () {
        var checkboxes = Array.from(document.querySelectorAll('.chk'));
        var allChecked = checkboxes.length > 0 && checkboxes.every(function (c) { return c.checked; });
        checkboxes.forEach(function (c) { c.checked = !allChecked; });
        btnSelectAll.textContent = allChecked ? 'Select All' : 'Deselect All';
    });

    // Batch delete
    var btnDel = document.getElementById('deleteSelected');
    if (btnDel) btnDel.addEventListener('click', async function (ev) {
        ev.preventDefault();
        var sel = document.getElementById('keySelect');
        var selectedKey = sel ? sel.value : '';
        var ids = Array.from(document.querySelectorAll('.chk:checked')).map(function (c) { return c.getAttribute('data-id'); }).filter(Boolean);
        if (!ids.length) { alert('No events selected to delete'); return; }
        if (!confirm('Delete ' + ids.length + ' event(s)? This cannot be undone.')) return;
        try {
            var res = await fetch('/api/events', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: selectedKey, ids: ids }) });
            if (!res.ok) { alert('Delete failed: ' + (await res.text())); return; }
            load();
        } catch (e) { alert('Network error'); }
    });

    // Auto refresh
    var timer = null;
    function setAutoRefresh(on) {
        if (timer) { clearInterval(timer); timer = null; }
        if (on) { timer = setInterval(load, 5000); }
        var btn = document.getElementById('autoRefresh');
        if (btn) btn.textContent = 'Auto refresh: ' + (on ? 'ON' : 'OFF');
        localStorage.setItem('auto_refresh', on ? '1' : '0');
    }
    var btnAuto = document.getElementById('autoRefresh');
    if (btnAuto) btnAuto.addEventListener('click', function () {
        var current = localStorage.getItem('auto_refresh') === '1';
        setAutoRefresh(!current);
        if (!current) load();
    });

    // Init
    var saved = localStorage.getItem('auto_refresh');
    if (saved !== '1') { localStorage.setItem('auto_refresh', '0'); }
    setAutoRefresh(saved === '1');
    populateKeys();
    load();

})();
