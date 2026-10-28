(function () {
  'use strict';

  var STATUS_LABELS = {
    new: 'New',
    contacted: 'Contacted',
    trial_booked: 'Trial booked',
    visited: 'Visited',
    joined: 'Joined',
    not_interested: 'Not interested'
  };

  var els = {
    loginView: document.getElementById('loginView'),
    appView: document.getElementById('appView'),
    loginForm: document.getElementById('loginForm'),
    password: document.getElementById('password'),
    loginError: document.getElementById('loginError'),
    logoutBtn: document.getElementById('logoutBtn'),
    filters: document.getElementById('filters'),
    search: document.getElementById('search'),
    status: document.getElementById('status'),
    rows: document.getElementById('rows'),
    empty: document.getElementById('empty')
  };

  var state = { status: '', q: '', statuses: [], counts: {} };
  var searchTimer = null;

  function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', credentials: 'same-origin', headers: {} };
    if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && path !== '/api/admin/login') showLogin();
        if (!res.ok) throw new Error(data.error || 'Request failed.');
        return data;
      });
    });
  }

  function showLogin() {
    els.appView.hidden = true;
    els.loginView.hidden = false;
    els.password.focus();
  }
  function showApp() {
    els.loginView.hidden = true;
    els.appView.hidden = false;
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') node.textContent = props[k];
      else if (k === 'class') node.className = props[k];
      else node.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function formatTime(iso) {
    var d = new Date(iso);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
    });
  }

  function renderFilters() {
    els.filters.textContent = '';
    var total = state.statuses.reduce(function (sum, s) { return sum + (state.counts[s] || 0); }, 0);
    var all = [{ key: '', label: 'All', n: total }].concat(state.statuses.map(function (s) {
      return { key: s, label: STATUS_LABELS[s] || s, n: state.counts[s] || 0 };
    }));
    all.forEach(function (f) {
      var btn = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.status === f.key) }, [
        document.createTextNode(f.label),
        el('b', { text: String(f.n) })
      ]);
      btn.addEventListener('click', function () { state.status = f.key; load(); });
      els.filters.appendChild(btn);
    });
  }

  function renderRows(trials) {
    els.rows.textContent = '';
    trials.forEach(function (t) {
      var tr = el('tr', { class: t.status === 'new' ? 'row-new' : '' });

      tr.appendChild(el('td', { class: 'when', text: formatTime(t.created_at) }));
      tr.appendChild(el('td', { class: 'name', text: t.name }));

      var phoneCell = el('td', { class: 'phone' });
      phoneCell.appendChild(document.createTextNode('+91 ' + t.phone.slice(0, 5) + ' ' + t.phone.slice(5)));
      var links = el('div', { class: 'links' }, [
        el('a', { href: 'tel:+91' + t.phone, text: 'Call' }),
        el('a', { href: 'https://wa.me/91' + t.phone, target: '_blank', rel: 'noopener', text: 'WhatsApp' })
      ]);
      phoneCell.appendChild(links);
      tr.appendChild(phoneCell);

      tr.appendChild(el('td', { text: t.goal }));
      tr.appendChild(el('td', { text: t.batch }));

      var statusCell = el('td');
      var select = el('select', { 'aria-label': 'Status for ' + t.name });
      state.statuses.forEach(function (s) {
        var opt = el('option', { value: s, text: STATUS_LABELS[s] || s });
        if (s === t.status) opt.selected = true;
        select.appendChild(opt);
      });
      var statusSaved = el('div', { class: 'saved' });
      select.addEventListener('change', function () {
        save(t.id, { status: select.value }, statusSaved).then(load);
      });
      statusCell.appendChild(select);
      statusCell.appendChild(statusSaved);
      tr.appendChild(statusCell);

      var notesCell = el('td');
      var notes = el('textarea', { maxlength: '1000', 'aria-label': 'Notes for ' + t.name, placeholder: 'Add a note' });
      notes.value = t.notes || '';
      var notesSaved = el('div', { class: 'saved' });
      notes.addEventListener('blur', function () {
        if (notes.value === (t.notes || '')) return;
        save(t.id, { notes: notes.value }, notesSaved).then(function (trial) { if (trial) t.notes = trial.notes; });
      });
      notesCell.appendChild(notes);
      notesCell.appendChild(notesSaved);
      tr.appendChild(notesCell);

      var actionCell = el('td');
      var del = el('button', { type: 'button', class: 'btn danger', text: 'Delete' });
      del.addEventListener('click', function () {
        if (!window.confirm('Delete the enquiry from ' + t.name + '? This cannot be undone.')) return;
        api('/api/admin/trials/' + t.id, { method: 'DELETE' }).then(load).catch(showError);
      });
      actionCell.appendChild(del);
      tr.appendChild(actionCell);

      els.rows.appendChild(tr);
    });
    els.empty.hidden = trials.length > 0;
  }

  function save(id, body, indicator) {
    indicator.textContent = 'Saving...';
    return api('/api/admin/trials/' + id, { method: 'PATCH', body: body }).then(function (data) {
      indicator.textContent = 'Saved';
      setTimeout(function () { indicator.textContent = ''; }, 1500);
      return data.trial;
    }).catch(function (err) {
      indicator.textContent = '';
      showError(err);
    });
  }

  function showError(err) {
    els.status.textContent = err.message || 'Something went wrong.';
  }

  function load() {
    var params = new URLSearchParams();
    if (state.status) params.set('status', state.status);
    if (state.q) params.set('q', state.q);
    return api('/api/admin/trials?' + params.toString()).then(function (data) {
      state.statuses = data.statuses;
      state.counts = data.counts;
      showApp();
      renderFilters();
      renderRows(data.trials);
      els.status.textContent = data.trials.length + (data.trials.length === 1 ? ' enquiry shown.' : ' enquiries shown.');
    }).catch(function (err) {
      if (err.message !== 'Please log in.') showError(err);
    });
  }

  els.loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    els.loginError.textContent = '';
    api('/api/admin/login', { method: 'POST', body: { password: els.password.value } }).then(function () {
      els.password.value = '';
      load();
    }).catch(function (err) {
      els.loginError.textContent = err.message;
    });
  });

  els.logoutBtn.addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).then(showLogin);
  });

  els.search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.q = els.search.value.trim(); load(); }, 250);
  });

  // Show the enquiries if a session cookie is already valid, otherwise the login form.
  api('/api/admin/me').then(load).catch(function () { showLogin(); });
})();
