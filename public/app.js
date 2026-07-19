(function () {
  'use strict';

  const PAGE_SIZE = 50;
  let currentPage = 1;
  let totalRows = 0;
  let editingId = null;
  let volunteers = [];
  let searchTimer = null;
  let lastRows = [];

  function splitName(full) {
    const parts = (full || '').trim().split(/\s+/);
    if (parts.length === 0) return { first: '', last: '' };
    if (parts.length === 1) return { first: parts[0], last: '' };
    return { first: parts[0], last: parts.slice(1).join(' ') };
  }

  function combineName(first, last) {
    return [first, last].filter(Boolean).join(' ').trim() || null;
  }

  /** Registry columns in registry.xlsx order → MongoDB/API snake_case keys */
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

  const TABLE_COLSPAN = 1 + REGISTRY_COLUMNS.length + 1; // # + registry + Actions

  function displayCell(row, key) {
    const v = row[key];
    if (v == null || v === '') return '—';
    if (key === 'population_2025' && typeof v === 'number') {
      return escapeHtml(v.toLocaleString());
    }
    return escapeHtml(String(v));
  }

  function hasResponded(r) {
    return r.responded === 'Yes' || (r.response_date && r.response_date.trim()) ||
      (r.responded && r.responded !== 'No' && String(r.responded).trim());
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
    }, 5000);
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

  function buildAssignFilter() {
    const filter = {};
    const search = document.getElementById('search').value.trim();
    if (search) filter.search = search;
    const survey = document.getElementById('filterSurvey').value;
    if (survey) filter.survey_sent = survey;
    const responded = document.getElementById('filterResponded').value;
    if (responded) filter.responded = responded;
    return filter;
  }

  function parseResearcherNames(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function openAssignModal() {
    document.getElementById('assignOverlay').classList.add('open');
  }

  function closeAssignModal() {
    document.getElementById('assignOverlay').classList.remove('open');
  }

  function formatAssignSummary(result) {
    const lines = Object.entries(result.by_researcher || {})
      .map(([name, count]) => `${name}: ${count}`)
      .join('; ');
    return [
      `Assigned ${result.assigned} towns to ${result.researchers} researcher(s).`,
      lines,
      `${result.remaining_unassigned_total.toLocaleString()} unassigned remaining overall.`,
    ].filter(Boolean).join(' ');
  }

  async function runBulkAssign() {
    const researchers = parseResearcherNames(document.getElementById('aaResearchers').value);
    const townsPerResearcher = parseInt(document.getElementById('aaTownsPerResearcher').value, 10) || 60;
    const scope = document.getElementById('aaScopeFiltered').checked ? 'filtered' : 'all';

    if (!researchers.length) {
      showError('Enter at least one researcher name.');
      return;
    }

    const previewBody = {
      researchers,
      townsPerResearcher,
      scope,
      dryRun: true,
    };
    if (scope === 'filtered') previewBody.filter = buildAssignFilter();

    try {
      const previewRes = await fetch('/api/bulk-assign-researchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewBody),
      });
      if (!previewRes.ok) {
        const err = await previewRes.json().catch(() => ({}));
        throw new Error(err.error || await previewRes.text());
      }
      const preview = await previewRes.json();
      const researcherList = researchers.join(', ');
      const scopeLabel = scope === 'filtered' ? 'matching current filters' : 'all unassigned';
      const confirmMsg = [
        `Assign up to ${townsPerResearcher} towns each to:`,
        researcherList,
        '',
        `Scope: ${scopeLabel}`,
        `Pool available: ${preview.pool_available}`,
        `Will assign: ${preview.assigned}`,
        '',
        'Continue?',
      ].join('\n');

      if (!confirm(confirmMsg)) return;

      const runBody = { ...previewBody, dryRun: false };
      const runRes = await fetch('/api/bulk-assign-researchers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runBody),
      });
      if (!runRes.ok) {
        const err = await runRes.json().catch(() => ({}));
        throw new Error(err.error || await runRes.text());
      }
      const result = await runRes.json();
      closeAssignModal();
      await loadVolunteers();
      await refresh();
      showSuccess(formatAssignSummary(result));
    } catch (e) {
      showError('Auto assign failed: ' + e.message);
    }
  }

  async function loadVolunteers() {
    const res = await fetch('/api/volunteers');
    if (!res.ok) throw new Error(await res.text());
    volunteers = await res.json();
    populateResearcherSelects();
  }

  function populateResearcherSelects() {
    const filterSel = document.getElementById('filterResearcher');
    const modalSel = document.getElementById('fAssignedResearcher');
    const filterVal = filterSel.value;
    const modalVal = modalSel.value;

    filterSel.innerHTML = '<option value="">Researcher: All</option>';
    modalSel.innerHTML = '<option value="">Unassigned</option>';

    volunteers.filter((v) => v.active).forEach((v) => {
      const fOpt = document.createElement('option');
      fOpt.value = v.name;
      fOpt.textContent = 'Researcher: ' + v.name;
      filterSel.appendChild(fOpt);

      const mOpt = document.createElement('option');
      mOpt.value = v.name;
      mOpt.textContent = v.name;
      modalSel.appendChild(mOpt);
    });

    if (filterVal) filterSel.value = filterVal;
    if (modalVal) modalSel.value = modalVal;
  }

  async function loadTable() {
    const res = await fetch('/api/municipalities?' + buildQuery());
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    totalRows = data.total;
    renderTable(data.rows, data.page, data.pageSize, data.total);
  }

  function renderTable(rows, page, pageSize, total) {
    lastRows = rows;
    const tbody = document.getElementById('tableBody');
    const startNum = (page - 1) * pageSize;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td class="table-empty" colspan="${TABLE_COLSPAN}">No contacts match your filters.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((r, i) => {
        const cells = REGISTRY_COLUMNS.map((col) => `<td>${displayCell(r, col.key)}</td>`).join('');
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

  function openModal(row) {
    editingId = row ? row.sovtown_id : null;
    document.getElementById('modalTitle').textContent = row ? 'Edit Contact' : 'Add Contact';

    const names = splitName(row?.primary_contact || '');
    document.getElementById('fFirstName').value = names.first;
    document.getElementById('fSurname').value = names.last;
    document.getElementById('fCity').value = row?.municipality || '';
    document.getElementById('fState').value = row?.state || row?.state_abbr || '';
    document.getElementById('fRole').value = row?.legal_designation || '';
    document.getElementById('fAffiliation').value = row?.enrichment_status || '';
    document.getElementById('fEmail').value = row?.contact_email || '';
    document.getElementById('fPhone').value = row?.contact_phone || '';
    document.getElementById('fSurveySent').value = row?.survey_sent || 'No';
    document.getElementById('fResponded').value =
      (row?.responded && row.responded !== 'Yes' && row.responded !== 'No') ? row.responded : '';
    document.getElementById('fDateSent').value = row?.date_sent || '';
    document.getElementById('fResponseReceived').value = row?.response_received || 'No';
    document.getElementById('fResponseDate').value = row?.response_date || '';
    document.getElementById('fAssignedResearcher').value = row?.assigned_researcher || '';
    document.getElementById('fPriority').value = row?.priority || 'Medium';
    document.getElementById('fContactMethod').value = row?.contact_method || 'Email';
    document.getElementById('fFollowupDate').value = row?.follow_up_date || '';
    document.getElementById('fNote').value = row?.note || '';

    populateResearcherSelects();
    if (row?.assigned_researcher) {
      document.getElementById('fAssignedResearcher').value = row.assigned_researcher;
    }

    document.getElementById('overlay').classList.add('open');
  }

  function closeModal() {
    document.getElementById('overlay').classList.remove('open');
    editingId = null;
  }

  async function fetchRow(id) {
    const res = await fetch('/api/municipalities?search=' + encodeURIComponent(id) + '&pageSize=1');
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    return data.rows.find((r) => r.sovtown_id === id) || data.rows[0];
  }

  async function saveContact() {
    const respondedInput = document.getElementById('fResponded').value.trim();
    const body = {
      municipality: document.getElementById('fCity').value.trim() || null,
      state: document.getElementById('fState').value.trim() || null,
      primary_contact: combineName(
        document.getElementById('fFirstName').value.trim(),
        document.getElementById('fSurname').value.trim()
      ),
      legal_designation: document.getElementById('fRole').value.trim() || null,
      enrichment_status: document.getElementById('fAffiliation').value.trim() || null,
      contact_email: document.getElementById('fEmail').value.trim() || null,
      contact_phone: document.getElementById('fPhone').value.trim() || null,
      survey_sent: document.getElementById('fSurveySent').value,
      responded: respondedInput || (document.getElementById('fResponseReceived').value === 'Yes' ? 'Yes' : 'No'),
      date_sent: document.getElementById('fDateSent').value.trim() || null,
      response_received: document.getElementById('fResponseReceived').value,
      response_date: document.getElementById('fResponseDate').value.trim() || null,
      assigned_researcher: document.getElementById('fAssignedResearcher').value || null,
      priority: document.getElementById('fPriority').value,
      contact_method: document.getElementById('fContactMethod').value,
      follow_up_date: document.getElementById('fFollowupDate').value.trim() || null,
      note: document.getElementById('fNote').value.trim() || null,
    };

    try {
      const url = editingId ? `/api/municipalities/${editingId}` : '/api/municipalities';
      const method = editingId ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  async function deleteContact(id, name) {
    if (!confirm(`Delete ${name}?`)) return;
    try {
      const res = await fetch(`/api/municipalities/${id}`, { method: 'DELETE' });
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
  document.getElementById('btnBulkAssign').addEventListener('click', openAssignModal);
  document.getElementById('btnAssignCancel').addEventListener('click', closeAssignModal);
  document.getElementById('btnAssignRun').addEventListener('click', runBulkAssign);
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
  document.getElementById('assignOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('assignOverlay')) closeAssignModal();
  });
  document.getElementById('tableBody').addEventListener('click', async (e) => {
    const editId = e.target.dataset.edit;
    const deleteId = e.target.dataset.delete;
    if (editId) {
      try {
        const row = await fetchRow(editId);
        if (row) openModal(row);
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
