(function () {
  'use strict';

  const PAGE_SIZE = 50;
  let currentPage = 1;
  let totalRows = 0;
  let editingId = null;
  let volunteers = [];
  let searchTimer = null;
  let lastRows = [];
  let activeInlineCell = null;

  const REGISTRY_COLUMNS = [
    { header: 'SOVTOWN ID', key: 'sovtown_id' },
    { header: 'Municipality', key: 'municipality' },
    { header: 'Legal Designation', key: 'legal_designation' },
    { header: 'Official Census Name', key: 'official_census_name' },
    { header: 'State', key: 'state' },
    { header: 'State Abbr.', key: 'state_abbr' },
    { header: 'State FIPS', key: 'state_fips' },
    { header: 'Place FIPS', key: 'place_fips' },
    { header: 'Census GEOID', key: 'census_geoid' },
    { header: '2025 Population', key: 'population_2025' },
    { header: 'Under 10,000?', key: 'under_10000' },
    { header: 'Population Band', key: 'population_band' },
    { header: 'Enrichment Status', key: 'enrichment_status' },
    { header: 'Assigned Researcher', key: 'assigned_researcher' },
    { header: 'Official Website', key: 'official_website' },
    { header: 'Primary Contact', key: 'primary_contact' },
    { header: 'Contact Email', key: 'contact_email' },
    { header: 'Contact Phone', key: 'contact_phone' },
    { header: 'Research Notes', key: 'research_notes' },
    { header: 'Census Functional Status', key: 'census_functional_status' },
    { header: 'Source URL', key: 'source_url' },
  ];

  const TRACKER_COLUMNS = [
    { header: 'Priority', key: 'priority' },
    { header: 'Contact Method', key: 'contact_method' },
    { header: 'Follow-up Date', key: 'follow_up_date' },
    { header: 'Survey Sent', key: 'survey_sent' },
    { header: 'Date Sent', key: 'date_sent' },
    { header: 'Response Received', key: 'response_received' },
  ];

  const TABLE_COLUMNS = [...REGISTRY_COLUMNS, ...TRACKER_COLUMNS];

  const INLINE_EDITABLE = new Set([
    'assigned_researcher',
    'priority',
    'contact_method',
    'follow_up_date',
    'survey_sent',
    'date_sent',
    'response_received',
    'contact_email',
    'contact_phone',
  ]);

  const TABLE_COLSPAN = 1 + TABLE_COLUMNS.length + 1;

  const SELECT_OPTIONS = {
    priority: ['High', 'Medium', 'Low'],
    contact_method: ['Email', 'LinkedIn', 'Web Portal', 'Phone'],
    survey_sent: ['No', 'Yes'],
    response_received: ['No', 'Yes'],
  };

  function displayCell(row, key) {
    const v = row[key];
    if (v == null || v === '') return '—';
    if (key === 'population_2025' && typeof v === 'number') {
      return escapeHtml(v.toLocaleString());
    }
    return escapeHtml(String(v));
  }

  function showError(msg) {
    const b = document.getElementById('errorBanner');
    b.textContent = msg;
    b.style.display = 'block';
    b.style.background = '#ffebee';
    b.style.color = '#c62828';
    b.style.borderBottomColor = '#c62828';
    setTimeout(() => { b.style.display = 'none'; }, 6000);
  }

  function showSuccess(msg) {
    const b = document.getElementById('errorBanner');
    b.textContent = '✓ ' + msg;
    b.style.display = 'block';
    b.style.background = '#e8f5e9';
    b.style.color = '#1b5e20';
    b.style.borderBottomColor = '#2e7d32';
    setTimeout(() => {
      b.style.display = 'none';
      b.style.background = '#ffebee';
      b.style.color = '#c62828';
      b.style.borderBottomColor = '#c62828';
    }, 4000);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildQuery() {
    const params = new URLSearchParams({
      page: currentPage,
      pageSize: PAGE_SIZE,
    });
    const search = document.getElementById('search').value.trim();
    if (search) params.set('search', search);
    const survey = document.getElementById('filterSurvey').value;
    if (survey) params.set('survey_sent', survey);
    const responded = document.getElementById('filterResponded').value;
    if (responded) params.set('responded', responded);
    const researcher = document.getElementById('filterResearcher').value;
    if (researcher) params.set('assigned_researcher', researcher);
    return params.toString();
  }

  async function loadResearcherNames() {
    const res = await fetch('/api/researcher-names');
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function loadVolunteers() {
    const [volRes, names] = await Promise.all([
      fetch('/api/volunteers'),
      loadResearcherNames(),
    ]);
    if (!volRes.ok) throw new Error(await volRes.text());
    volunteers = await volRes.json();
    populateResearcherSelects(names);
  }

  function populateResearcherSelects(researcherNames) {
    const filterSel = document.getElementById('filterResearcher');
    const suggestions = document.getElementById('researcherSuggestions');
    const filterVal = filterSel.value;

    filterSel.innerHTML = '<option value="">Researcher: All</option>';

    researcherNames.forEach((name) => {
      const fOpt = document.createElement('option');
      fOpt.value = name;
      fOpt.textContent = 'Researcher: ' + name;
      filterSel.appendChild(fOpt);
    });

    if (filterVal) filterSel.value = filterVal;

    suggestions.innerHTML = '';
    const suggestionSet = new Set(researcherNames);
    volunteers.filter((v) => v.active).forEach((v) => suggestionSet.add(v.name));
    [...suggestionSet].sort((a, b) => a.localeCompare(b)).forEach((name) => {
      const sOpt = document.createElement('option');
      sOpt.value = name;
      suggestions.appendChild(sOpt);
    });
  }

  async function loadTable() {
    const res = await fetch('/api/municipalities?' + buildQuery());
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    totalRows = data.total;
    renderTable(data.rows, data.page, data.pageSize, data.total);
  }

  function renderTableCell(row, col) {
    const { key } = col;
    const display = displayCell(row, key);
    if (!INLINE_EDITABLE.has(key)) {
      return `<td>${display}</td>`;
    }
    return `<td class="editable-cell" data-sovtown-id="${escapeHtml(row.sovtown_id)}" data-field="${key}" title="Click to edit">${display}</td>`;
  }

  function renderTable(rows, page, pageSize, total) {
    lastRows = rows;
    const tbody = document.getElementById('tableBody');
    const startNum = (page - 1) * pageSize;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td class="table-empty" colspan="${TABLE_COLSPAN}">No contacts match your filters.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((r, i) => {
        const cells = TABLE_COLUMNS.map((col) => renderTableCell(r, col)).join('');
        const safeId = escapeHtml(r.sovtown_id || '');

        return `
          <tr>
            <td>${startNum + i + 1}</td>
            ${cells}
            <td class="actions-cell">
              <button class="btn-edit" type="button" data-edit="${safeId}">✎ Edit</button>
              <button class="btn-delete" type="button" data-delete="${safeId}">🗑 Delete</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    document.getElementById('pageInfo').textContent =
      `Page ${page} of ${totalPages} (${total.toLocaleString()} total)`;
    document.getElementById('btnPrev').disabled = page <= 1;
    document.getElementById('btnNext').disabled = page >= totalPages;
  }

  function setFormValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value == null || value === '' ? '' : value;
  }

  function openModal(row) {
    editingId = row ? row.sovtown_id : null;
    document.getElementById('modalTitle').textContent = row ? 'Edit Contact' : 'Add Contact';

    const sovtownInput = document.getElementById('fSovtownId');
    sovtownInput.value = row?.sovtown_id || '';
    sovtownInput.readOnly = !!row;

    setFormValue('fMunicipality', row?.municipality);
    setFormValue('fLegalDesignation', row?.legal_designation);
    setFormValue('fOfficialCensusName', row?.official_census_name);
    setFormValue('fState', row?.state);
    setFormValue('fStateAbbr', row?.state_abbr);
    setFormValue('fPopulation2025', row?.population_2025);
    setFormValue('fAssignedResearcher', row?.assigned_researcher);
    setFormValue('fPrimaryContact', row?.primary_contact);
    setFormValue('fContactEmail', row?.contact_email);
    setFormValue('fContactPhone', row?.contact_phone);
    setFormValue('fOfficialWebsite', row?.official_website);
    setFormValue('fPriority', row?.priority || 'Medium');
    setFormValue('fContactMethod', row?.contact_method || 'Email');
    setFormValue('fFollowupDate', row?.follow_up_date);
    setFormValue('fSurveySent', row?.survey_sent || 'No');
    setFormValue('fDateSent', row?.date_sent);
    setFormValue('fResponseReceived', row?.response_received || 'No');
    setFormValue('fResearchNotes', row?.research_notes);

    document.getElementById('overlay').classList.add('open');
  }

  function closeModal() {
    document.getElementById('overlay').classList.remove('open');
    editingId = null;
    document.getElementById('fSovtownId').readOnly = false;
  }

  function readFormBody() {
    return {
      sovtown_id: document.getElementById('fSovtownId').value.trim(),
      municipality: document.getElementById('fMunicipality').value.trim() || null,
      legal_designation: document.getElementById('fLegalDesignation').value.trim() || null,
      official_census_name: document.getElementById('fOfficialCensusName').value.trim() || null,
      state: document.getElementById('fState').value.trim() || null,
      state_abbr: document.getElementById('fStateAbbr').value.trim() || null,
      population_2025: document.getElementById('fPopulation2025').value.trim() || null,
      assigned_researcher: document.getElementById('fAssignedResearcher').value.trim() || null,
      primary_contact: document.getElementById('fPrimaryContact').value.trim() || null,
      contact_email: document.getElementById('fContactEmail').value.trim() || null,
      contact_phone: document.getElementById('fContactPhone').value.trim() || null,
      official_website: document.getElementById('fOfficialWebsite').value.trim() || null,
      priority: document.getElementById('fPriority').value,
      contact_method: document.getElementById('fContactMethod').value,
      follow_up_date: document.getElementById('fFollowupDate').value.trim() || null,
      survey_sent: document.getElementById('fSurveySent').value,
      date_sent: document.getElementById('fDateSent').value.trim() || null,
      response_received: document.getElementById('fResponseReceived').value,
      research_notes: document.getElementById('fResearchNotes').value.trim() || null,
    };
  }

  async function fetchRow(id) {
    const res = await fetch('/api/municipalities/' + encodeURIComponent(id));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || await res.text());
    }
    return res.json();
  }

  async function saveContact() {
    const body = readFormBody();

    if (!editingId && !body.sovtown_id) {
      showError('SOVTOWN ID is required.');
      return;
    }

    try {
      if (!editingId) {
        const check = await fetch('/api/municipalities/' + encodeURIComponent(body.sovtown_id));
        if (check.ok) {
          showError('SOVTOWN ID already exists — choose a unique ID.');
          return;
        }
        if (check.status !== 404) {
          throw new Error(await check.text());
        }
      }

      const url = editingId
        ? `/api/municipalities/${encodeURIComponent(editingId)}`
        : '/api/municipalities';
      const method = editingId ? 'PATCH' : 'POST';
      const payload = editingId ? { ...body, sovtown_id: undefined } : body;

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || await res.text());
      }
      closeModal();
      await refresh();
      showSuccess(editingId ? 'Contact updated' : 'Contact added');
    } catch (e) {
      showError('Save failed: ' + e.message);
    }
  }

  async function patchField(sovtownId, field, value) {
    const res = await fetch(`/api/municipalities/${encodeURIComponent(sovtownId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value === '' ? null : value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || await res.text());
    }
    return res.json();
  }

  function finishInlineCell(td, row, field) {
    td.classList.remove('is-editing');
    td.innerHTML = displayCell(row, field);
    td.dataset.field = field;
    td.dataset.sovtownId = row.sovtown_id;
    activeInlineCell = null;
  }

  function createInlineEditor(field, currentValue) {
    const options = SELECT_OPTIONS[field];
    if (options) {
      const select = document.createElement('select');
      select.className = 'inline-select';
      options.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === (currentValue || (field === 'priority' ? 'Medium' : 'No'))) o.selected = true;
        select.appendChild(o);
      });
      return select;
    }

    const input = document.createElement('input');
    input.className = 'inline-input';
    input.type = field === 'contact_email' ? 'email' : 'text';
    input.value = currentValue || '';
    if (field === 'assigned_researcher') {
      input.setAttribute('list', 'researcherSuggestions');
      input.placeholder = 'Unassigned';
    }
    return input;
  }

  function startInlineEdit(td) {
    if (activeInlineCell) return;

    const sovtownId = td.dataset.sovtownId;
    const field = td.dataset.field;
    const row = lastRows.find((r) => r.sovtown_id === sovtownId);
    if (!row) return;

    activeInlineCell = td;
    td.classList.add('is-editing');
    const currentValue = row[field] == null ? '' : String(row[field]);
    const editor = createInlineEditor(field, currentValue);
    td.textContent = '';
    td.appendChild(editor);
    editor.focus();
    if (editor.select) editor.select();

    let saving = false;

    async function commit() {
      if (saving) return;
      saving = true;
      const newValue = editor.value.trim();
      const oldValue = currentValue.trim();

      if (newValue === oldValue) {
        finishInlineCell(td, row, field);
        return;
      }

      try {
        const updated = await patchField(sovtownId, field, newValue);
        Object.assign(row, updated);
        finishInlineCell(td, row, field);
        td.classList.add('cell-saved');
        setTimeout(() => td.classList.remove('cell-saved'), 1500);
        showSuccess('Saved');
        if (field === 'assigned_researcher') {
          loadResearcherNames()
            .then((names) => populateResearcherSelects(names))
            .catch(() => {});
        }
      } catch (e) {
        showError('Save failed: ' + e.message);
        finishInlineCell(td, row, field);
      }
    }

    editor.addEventListener('blur', () => { commit(); });
    editor.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        editor.blur();
      }
      if (ev.key === 'Escape') {
        saving = true;
        finishInlineCell(td, row, field);
      }
    });
  }

  async function deleteContact(id, name) {
    if (!confirm(`Delete ${name}?`)) return;
    try {
      const res = await fetch(`/api/municipalities/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || await res.text());
      }
      await refresh();
      showSuccess('Contact deleted');
    } catch (e) {
      showError('Delete failed: ' + e.message);
    }
  }

  async function refresh() {
    await loadTable();
  }

  function onFilterChange() {
    currentPage = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadTable().catch((e) => showError(e.message));
    }, 300);
  }

  document.getElementById('btnAdd').addEventListener('click', () => openModal(null));
  document.getElementById('btnCancel').addEventListener('click', closeModal);
  document.getElementById('btnSave').addEventListener('click', saveContact);
  document.getElementById('search').addEventListener('input', onFilterChange);
  document.getElementById('filterSurvey').addEventListener('change', onFilterChange);
  document.getElementById('filterResponded').addEventListener('change', onFilterChange);
  document.getElementById('filterResearcher').addEventListener('change', onFilterChange);
  document.getElementById('btnPrev').addEventListener('click', () => {
    if (currentPage > 1) { currentPage--; loadTable().catch((e) => showError(e.message)); }
  });
  document.getElementById('btnNext').addEventListener('click', () => {
    currentPage++;
    loadTable().catch((e) => showError(e.message));
  });
  document.getElementById('overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('overlay')) closeModal();
  });
  document.getElementById('tableBody').addEventListener('click', async (e) => {
    const editableCell = e.target.closest('.editable-cell');
    if (editableCell && !editableCell.classList.contains('is-editing')) {
      startInlineEdit(editableCell);
      return;
    }

    const editId = e.target.dataset.edit;
    const deleteId = e.target.dataset.delete;
    if (editId) {
      try {
        const row = lastRows.find((r) => r.sovtown_id === editId) || await fetchRow(editId);
        openModal(row);
      } catch (err) {
        showError(err.message);
      }
    }
    if (deleteId) {
      const row = lastRows.find((r) => r.sovtown_id === deleteId);
      deleteContact(deleteId, row ? (row.municipality || row.sovtown_id) : deleteId);
    }
  });

  loadVolunteers()
    .then(refresh)
    .catch((e) => showError('Failed to load: ' + e.message));
})();
