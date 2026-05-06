// ════════════════════════════════════════════════════════════════
//  VOTIFY — Full Application Script
//  Auth: localStorage-based user & admin authentication
//  Voting: Blockchain + simulation fallback
// ════════════════════════════════════════════════════════════════

// ─── Configuration ───────────────────────────────────────────────────────────
// ─── Configuration ───────────────────────────────────────────────────────────
// Detect if running locally or on Vercel
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? 'http://localhost:5000' 
  : ''; 

// ─── Auth Storage Keys ────────────────────────────────────────────────────────
const KEY_USERS      = 'votify_users';      // array of voter accounts
const KEY_ADMIN      = 'votify_admin';      // admin credentials object
const KEY_SESSION    = 'votify_session';    // current logged-in session
const KEY_CANDIDATES = 'votify_candidates'; // persisted candidates array
const KEY_VOTES      = 'votify_votes';      // persisted vote counts { candidateId: count }

// ─── Global State ───────────────────────────────────────────────────────────
let currentAccount = null;
let provider       = null;
let signer         = null;
let resultsChart   = null;
let customContractAddress = null;
let currentSession = null;  // { name, email, role: 'voter'|'admin' }

// ─── Smart Contract ABI ─────────────────────────────────────────────────────
const CONTRACT_ABI = [
  "function vote(uint256 _candidateId) public",
  "function registerVoter(address _voter) public",
  "function registerCandidate(string memory _name, string memory _party) public",
  "function getAllCandidates() public view returns (tuple(uint256 id, string memory name, string memory party, uint256 voteCount)[])"
];

// ─── Avatar helper ───────────────────────────────────────────────────────────
const AVATAR_COLORS = ['#5e5ce6','#30d158','#a259ff','#ff6b6b','#ffd93d'];
function getAvatarStyle(idx) {
  return `background:${AVATAR_COLORS[idx % AVATAR_COLORS.length]};`;
}

// ─── Initial Candidates (Indian parties with symbols) ──────────────────────────
const INITIAL_CANDIDATES = [
  { id: 1, name: "Narendra Singh",   party: "Bharatiya Janata Party",      symbol: "🪷", voteCount: 0 },
  { id: 2, name: "Rahul Verma",      party: "Indian National Congress",    symbol: "✋", voteCount: 0 },
  { id: 3, name: "Arvind Sharma",    party: "Aam Aadmi Party",            symbol: "🧹", voteCount: 0 }
];

let mockCandidates = [...INITIAL_CANDIDATES];

/** Data Persistence Layer */
function saveData() {
  localStorage.setItem(KEY_CANDIDATES, JSON.stringify(mockCandidates));
  const votesMap = {};
  mockCandidates.forEach(c => { votesMap[c.id] = c.voteCount; });
  localStorage.setItem(KEY_VOTES, JSON.stringify(votesMap));
}

function loadData() {
  const savedCands = localStorage.getItem(KEY_CANDIDATES);
  const savedVotes = JSON.parse(localStorage.getItem(KEY_VOTES) || '{}');

  if (savedCands) {
    mockCandidates = JSON.parse(savedCands);
  } else {
    mockCandidates = [...INITIAL_CANDIDATES];
  }

  // Ensure vote counts are synced from the votes map
  mockCandidates.forEach(c => {
    c.voteCount = savedVotes[c.id] || 0;
  });
  console.log('📦 Data loaded:', mockCandidates.length, 'candidates');
}

/** Initialize data on script load */
loadData();

// ─── One-Vote-Per-User (per email, simulation) ────────────────────────────────
function getVotedCandidateId() {
  if (!currentSession) return null;
  const val = localStorage.getItem(`voted_${currentSession.email.toLowerCase()}`);
  return val ? Number(val) : null;
}
function recordVoteLocally(candidateId) {
  if (!currentSession) return;
  localStorage.setItem(`voted_${currentSession.email.toLowerCase()}`, String(candidateId));
}

// ─── Vote Count Persistence (Legacy Helpers - maintained for compatibility) ───────
function loadVoteCounts() { loadData(); }
function saveVoteCounts() { saveData(); }

/** Admin: reset ALL votes and allow all users to vote again */
function adminResetVotes() {
  if (!confirm('⚠️ Reset ALL votes? This will clear every vote and allow all users to vote again.')) return;
  
  // Clear vote counts but keep candidates
  mockCandidates.forEach(c => { c.voteCount = 0; });
  saveData();

  // Clear every user's voted flag in localStorage
  const users = JSON.parse(localStorage.getItem(KEY_USERS) || '[]');
  users.forEach(u => localStorage.removeItem(`voted_${u.email.toLowerCase()}`));
  
  // Also clear admin's own voted flag
  const admin = JSON.parse(localStorage.getItem(KEY_ADMIN) || '{}');
  if (admin.email) localStorage.removeItem(`voted_${admin.email.toLowerCase()}`);
  
  // Reset all simulation vote markers in localStorage
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith('voted_')) {
      localStorage.removeItem(key);
      i--; // Adjust index after removal
    }
  }

  fetchCandidates();
  fetchResults();
  showToast('🔄 All votes reset successfully.', 'success');
}

// ─── Election status ──────────────────────────────────────────────────────────
let electionClosed = false;

// ════════════════════════════════════════════════════════════════
//  AUTH SYSTEM
// ════════════════════════════════════════════════════════════════

/** Bootstrap: set up default admin if not already stored */
function initAuth() {
  if (!localStorage.getItem(KEY_ADMIN)) {
    localStorage.setItem(KEY_ADMIN, JSON.stringify({
      email: 'admin@votify.com',
      password: 'admin123',
      name: 'Administrator'
    }));
  }
  if (!localStorage.getItem(KEY_USERS)) {
    localStorage.setItem(KEY_USERS, JSON.stringify([]));
  }
}

/** Show login or register form inside the auth overlay */
function showAuthForm(which) {
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.getElementById(`auth-${which}`).classList.add('active');
  // Clear errors
  ['login-error','reg-error'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

/** Show an error inside an auth form */
function setAuthError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.innerText = msg; el.style.display = 'flex'; }
}

/** Handle login submission */
async function handleLogin() {
  const email    = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;

  if (!email || !password) {
    setAuthError('login-error', '⚠️ Please fill in all fields.');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (data.success) {
      startSession(data.user);
    } else {
      setAuthError('login-error', `❌ ${data.error || 'Invalid credentials'}`);
    }
  } catch (error) {
    setAuthError('login-error', '❌ Backend unreachable. Please try again later.');
  }
}

/** Handle voter registration */
async function handleRegister() {
  const name     = document.getElementById('reg-name').value.trim();
  const email    = document.getElementById('reg-email').value.trim().toLowerCase();
  const password = document.getElementById('reg-password').value;

  if (!name || !email || !password) {
    setAuthError('reg-error', '⚠️ Please fill in all fields.'); return;
  }
  if (password.length < 6) {
    setAuthError('reg-error', '⚠️ Password must be at least 6 characters.'); return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, role: 'voter' })
    });
    const data = await res.json();

    if (data.success) {
      showToast(`✅ Welcome, ${name}! Your account has been created.`, 'success');
      startSession(data.user);
    } else {
      setAuthError('reg-error', `❌ ${data.error || 'Registration failed'}`);
    }
  } catch (error) {
    setAuthError('reg-error', '❌ Backend unreachable.');
  }
}

/** Start a session (save to localStorage, update UI) */
async function startSession(session) {
  currentSession = session;
  localStorage.setItem(KEY_SESSION, JSON.stringify(session));

  // Hide auth overlay, show app
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('app-shell').style.display    = 'block';

  // Update navbar user pill
  const initials = session.name.split(' ').map(w => w[0]).join('').toUpperCase().substring(0,2);
  document.getElementById('user-pill-avatar').innerText = initials;
  document.getElementById('user-pill-name').innerText   = session.name;
  const roleEl = document.getElementById('user-pill-role');
  if (roleEl) roleEl.innerText = session.role === 'admin' ? 'Administrator' : 'Voter';
  const userPill = document.getElementById('user-pill');
  if (userPill) userPill.style.display = 'flex';

  // Show/hide Admin nav link
  const adminLink = document.getElementById('nav-admin');
  if (adminLink) adminLink.style.display = session.role === 'admin' ? 'inline-block' : 'none';

  // Guard: always hide admin tab content for non-admin users
  const adminTab = document.getElementById('tab-admin');
  if (adminTab) adminTab.style.display = session.role === 'admin' ? '' : 'none';

  // Always navigate to the Home tab on every login
  switchTab('landing');

  // Init app data
  await fetchCandidates();
  await fetchResults();
  await checkVoterStatus();

  // Admin-only: populate users table
  if (session.role === 'admin') {
    renderUsersTable();
  }

  // Auto-connect wallet
  await syncGlobalSettings();
  autoConnectWallet();

  console.log(`✅ Session started: ${session.name} (${session.role})`);
}


/** Logout — clears session but KEEPS wallet connection intact for the next user */
function handleLogout() {
  currentSession = null;
  // Note: do NOT clear currentAccount/provider/signer here.
  // The wallet stays authorised so the next user can vote without reconnecting.
  localStorage.removeItem(KEY_SESSION);

  // Hide user pill
  const userPill = document.getElementById('user-pill');
  if (userPill) userPill.style.display = 'none';

  document.getElementById('app-shell').style.display  = 'none';
  document.getElementById('auth-overlay').style.display = 'flex';

  // Clear input fields
  document.getElementById('login-email').value    = '';
  document.getElementById('login-password').value = '';
  showAuthForm('login');
  showToast('👋 Signed out successfully.', 'info');
}

/** Handle admin password change */
async function handleChangePassword(event) {
  event.preventDefault();
  const current  = document.getElementById('cp-current').value;
  const newPass  = document.getElementById('cp-new').value;
  const confirm  = document.getElementById('cp-confirm').value;
  const errEl    = document.getElementById('cp-error');

  if (newPass.length < 6) {
    errEl.innerText = '⚠️ New password must be at least 6 characters.';
    errEl.style.display = 'flex'; return;
  }
  if (newPass !== confirm) {
    errEl.innerText = '❌ New passwords do not match.';
    errEl.style.display = 'flex'; return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        email: currentSession.email, 
        currentPassword: current, 
        newPassword: newPass 
      })
    });
    const data = await res.json();

    if (data.success) {
      errEl.style.display = 'none';
      document.getElementById('form-change-password').reset();
      showToast('✅ Password updated successfully!', 'success');
    } else {
      errEl.innerText = `❌ ${data.error}`;
      errEl.style.display = 'flex';
    }
  } catch (error) {
    showToast('❌ Backend unreachable.', 'error');
  }
}

/** Admin: show registered voter accounts table */
async function renderUsersTable() {
  const el = document.getElementById('users-table');
  if (!el) return;

  try {
    const res = await fetch(`${BACKEND_URL}/api/users`);
    const data = await res.json();

    if (!data.success || data.users.length === 0) {
      el.innerHTML = '<p class="desc" style="text-align:center;padding:1rem">No voter accounts registered yet.</p>';
      return;
    }

    el.innerHTML = `
      <table class="lb-table">
        <thead>
          <tr><th>#</th><th>Name</th><th>Email</th><th>Role</th><th>Has Voted</th></tr>
        </thead>
        <tbody>
          ${data.users.map((u, i) => `
            <tr>
              <td>${i + 1}</td>
              <td><strong>${u.name}</strong></td>
              <td>${u.email}</td>
              <td><span class="badge">${u.role}</span></td>
              <td>${u.hasVoted ? '<span class="badge-win">✅ Yes</span>' : '<span class="badge-loss">No</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  } catch (error) {
    el.innerHTML = '<p class="desc" style="color:var(--red);text-align:center">Error loading users.</p>';
  }
}

/** Toggle password eye icon */
function toggleEye(inputId, btn) {
  const input = document.getElementById(inputId);
  const icon  = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fa-solid fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fa-solid fa-eye';
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initAuth();

  // Support ?logout=true in URL to force show auth screen
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('logout') === 'true') {
    localStorage.removeItem(KEY_SESSION);
    // Clean URL without reload
    window.history.replaceState({}, '', window.location.pathname);
  }

  // Restore session if user was previously logged in
  const saved = localStorage.getItem(KEY_SESSION);
  if (saved) {
    try {
      const session = JSON.parse(saved);
      // Validate session has required fields
      if (session && session.email && session.role) {
        startSession(session);
      } else {
        throw new Error('Invalid session');
      }
    } catch {
      localStorage.removeItem(KEY_SESSION);
      document.getElementById('auth-overlay').style.display = 'flex';
      document.getElementById('app-shell').style.display    = 'none';
    }
  } else {
    // Show auth overlay
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('app-shell').style.display    = 'none';
  }
});

// Allow pressing Enter on login / register inputs
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const loginActive = document.getElementById('auth-login')?.classList.contains('active');
  const regActive   = document.getElementById('auth-register')?.classList.contains('active');
  if (loginActive) handleLogin();
  if (regActive)   handleRegister();
});


// ─── Contract address input handler ──────────────────────────────────────────
function updateCustomContractAddress() {
  const input = document.getElementById('custom-contract-address');
  if (input) {
    customContractAddress = input.value.trim();
    fetchCandidates();
    fetchResults();
  }
}

// ─── Tab Switcher ─────────────────────────────────────────────────────────────
async function switchTab(tabId) {
  document.querySelectorAll('.nav-link').forEach(l  => l.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

  const link = document.getElementById(`nav-${tabId}`);
  const tab  = document.getElementById(`tab-${tabId}`);
  if (tab) tab.classList.add('active');
  if (link) link.classList.add('active');

  if (tabId === 'results' || tabId === 'winner') await fetchResults();
  if (tabId === 'vote')    { await fetchCandidates(); await checkVoterStatus(); }
  if (tabId === 'admin')   { await syncGlobalSettings(); renderUsersTable(); renderAdminCandidates(); }

  // Auto-close mobile menu if open
  document.body.classList.remove('mobile-nav-active');
  const icon = document.querySelector('.mobile-menu-btn i');
  if (icon) icon.className = 'fa-solid fa-bars';
}

/** Toggle Mobile Menu Overlay (Responsive) */
function toggleMobileMenu() {
  const isActive = document.body.classList.toggle('mobile-nav-active');
  const icon = document.querySelector('.mobile-menu-btn i');
  if (icon) {
    icon.className = isActive ? 'fa-solid fa-xmark' : 'fa-solid fa-bars';
  }
}

/** Admin: Refresh candidates list in admin panel */
function renderAdminCandidates() {
  const el = document.getElementById('admin-candidates-list');
  if (!el) return;

  if (mockCandidates.length === 0) {
    el.innerHTML = '<p class="desc" style="text-align:center;padding:1rem">No candidates registered.</p>';
    return;
  }

  el.innerHTML = mockCandidates.map((c, idx) => `
    <div class="admin-mini-card">
      <div class="amc-avatar" style="${getAvatarStyle(idx)}">${c.name[0]}</div>
      <div class="amc-info">
        <div class="amc-name">${c.symbol || ''} ${c.name}</div>
        <div class="amc-party">${c.party}</div>
      </div>
      <div class="amc-votes">${c.voteCount} votes</div>
    </div>
  `).join('');
}

// ─── Connect Wallet ───────────────────────────────────────────────────────────
async function connectWallet() {
  if (window.ethereum) {
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      currentAccount = accounts[0];
      const short = `${currentAccount.slice(0,6)}...${currentAccount.slice(-4)}`;
      provider = new ethers.BrowserProvider(window.ethereum);
      signer   = await provider.getSigner();
      updatePanelWallet(short, true);
      checkVoterStatus();
      fetchCandidates();
      showToast(`🔗 Wallet connected: ${short}`, 'success');
    } catch (err) {
      showToast('Could not connect MetaMask. Ensure it is unlocked.', 'error');
    }
  } else {
    // Simulation / fallback mode — no MetaMask
    currentAccount = '0x71C065161D21A3B18F95eB98C291533B038a834F';
    const short = '0x71C0...834F';
    updatePanelWallet(short, true);
    checkVoterStatus();
    fetchCandidates();
    showToast('🔗 Simulation wallet connected: ' + short, 'info');
  }

  // Sync with backend if admin
  if (currentSession?.role === 'admin' && currentAccount) {
    try {
      await fetch(`${BACKEND_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'adminWalletAddress', value: currentAccount })
      });
    } catch (e) { console.warn('Failed to sync wallet to backend'); }
  }
}

/** Silent auto-connect — uses already-authorised accounts (no MetaMask popup) */
async function autoConnectWallet() {
  if (!window.ethereum) return;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts.length > 0) {
      currentAccount = accounts[0];
      const short = `${currentAccount.slice(0,6)}...${currentAccount.slice(-4)}`;
      provider = new ethers.BrowserProvider(window.ethereum);
      signer   = await provider.getSigner();
      updatePanelWallet(short, true);
      checkVoterStatus();
      fetchCandidates();
      showToast(`🔗 Wallet auto-connected: ${short}`, 'success');
    }
  } catch (e) { console.warn('Auto-connect skipped:', e); }
}

/** Disconnect wallet (admin can turn off) */
async function disconnectWallet() {
  currentAccount = null;
  signer   = null;
  provider = null;
  updatePanelWallet('Not connected', false);
  checkVoterStatus();
  fetchCandidates();
  showToast('🔌 Wallet disconnected.', 'info');

  // Clear backend setting if admin
  if (currentSession?.role === 'admin') {
    try {
      await fetch(`${BACKEND_URL}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'adminWalletAddress', value: null })
      });
    } catch (e) { console.warn('Failed to clear wallet on backend'); }
  }
}

/** Sync global settings from backend */
async function syncGlobalSettings() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/settings`);
    const data = await res.json();
    if (data.success && data.settings) {
      const globalAddress = data.settings.adminWalletAddress;
      if (globalAddress && !currentAccount) {
        currentAccount = globalAddress;
        const short = `${currentAccount.slice(0,6)}...${currentAccount.slice(-4)}`;
        updatePanelWallet(short, true);
        checkVoterStatus();
        fetchCandidates();
        console.log('🔄 Synced wallet from backend:', globalAddress);
      }
    }
  } catch (e) { console.warn('Settings sync failed'); }
}

/** Update the wallet status display inside the Election Control panel */
function updatePanelWallet(addressText, connected) {
  const dot  = document.querySelector('#wallet-status-panel .wallet-dot');
  const text = document.getElementById('wallet-panel-text');
  const btnC = document.getElementById('btn-panel-connect');
  const btnD = document.getElementById('btn-panel-disconnect');
  if (dot)  dot.className   = connected ? 'wallet-dot connected-dot' : 'wallet-dot disconnected-dot';
  if (text) { text.innerText = addressText; text.style.color = connected ? 'var(--green)' : 'var(--text-secondary)'; }
  if (btnC) btnC.style.display = connected ? 'none'        : 'inline-flex';
  if (btnD) btnD.style.display = connected ? 'inline-flex' : 'none';
}


// ─── Voter Status Card ────────────────────────────────────────────────────────
async function checkVoterStatus() {
  const title = document.getElementById('voter-status-title');
  const desc  = document.getElementById('voter-status-desc');
  const btn   = document.getElementById('btn-self-register');

  if (!currentAccount) {
    if (title) title.innerText = 'Wallet Not Connected';
    if (desc) desc.innerText  = 'No wallet is currently connected. Please ask the administrator to connect the blockchain wallet, then try again.';
    if (btn) btn.style.display = 'none';
    return;
  }

  // Fetch real status from backend if logged in
  let votedId = null;
  if (currentSession) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/user-status?email=${currentSession.email}`);
      const data = await res.json();
      if (data.success && data.hasVoted) {
        votedId = data.votedFor;
      }
    } catch(e) {
      console.warn("Status fetch failed, using local fallback");
    }
  }

  if (votedId !== null) {
    title.innerText = "✅ You Have Already Voted";
    desc.innerText  = `Your vote has been permanently recorded in the database. You cannot vote again.`;
    if (btn) btn.style.display = "none";

    const banner = document.getElementById('voted-banner');
    if (banner) banner.style.display = 'flex';
    
    // Refresh cards to show 'Voted' state
    await fetchCandidates();
    return;
  }

  const banner = document.getElementById('voted-banner');
  if (banner) banner.style.display = 'none';

  title.innerText = "✅ Wallet Connected — Ready to Vote";
  const shortAddr = currentAccount.length > 15 ? `${currentAccount.substring(0, 10)}...${currentAccount.substring(currentAccount.length - 8)}` : currentAccount;
  desc.innerText  = `Address: ${shortAddr}. Cast your vote below — each wallet can vote only once.`;
  if (btn) btn.style.display = "none";
}

// ─── Register Voter (Admin API) ───────────────────────────────────────────────
async function registerMeAsVoter() {
  if (!currentAccount) { alert("Connect your wallet first."); return; }
  try {
    const res  = await fetch(`${BACKEND_URL}/api/register-voter`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ voterAddress: currentAccount })
    });
    const data = await res.json();
    data.success ? alert("Registered on Blockchain!") : alert(`Error: ${data.error}`);
  } catch {
    alert("Backend unreachable. Running in simulation mode.");
  }
}

// ─── Fetch & Render Candidates ────────────────────────────────────────────────
async function fetchCandidates() {
  // 1. Try direct smart contract read
  if (customContractAddress && provider) {
    try {
      const contract = new ethers.Contract(customContractAddress, CONTRACT_ABI, provider);
      const raw = await contract.getAllCandidates();
      renderCandidateCards(raw.map(c => ({
        id: Number(c.id), name: c.name, party: c.party, voteCount: Number(c.voteCount)
      })));
      return;
    } catch(e) { console.error("Contract read failed:", e); }
  }
  // 2. Try backend
  try {
    const res  = await fetch(`${BACKEND_URL}/api/candidates`);
    const data = await res.json();
    if (data.success && data.candidates && data.candidates.length > 0) { 
      // Map candidateId to id for frontend consistency
      const mapped = data.candidates.map(c => ({
        ...c,
        id: c.candidateId || c.id
      }));
      mockCandidates = mapped; // Sync local state
      renderCandidateCards(mapped); 
      return; 
    }
  } catch(err) {
    console.warn("Backend candidates fetch failed, using simulation:", err);
  }

  // 3. Simulation fallback (if backend is empty or unreachable)
  loadVoteCounts();
  renderCandidateCards(mockCandidates);
}

function renderCandidateCards(candidates) {
  const container = document.getElementById('candidates-container');
  container.innerHTML = '';

  const isAdmin    = currentSession?.role === 'admin';
  const totalVotes = candidates.reduce((s, c) => s + c.voteCount, 0);
  const votedId    = isAdmin ? null : getVotedCandidateId();
  const maxVotes   = Math.max(...candidates.map(c => c.voteCount), 1);
  const leaderId   = candidates.reduce((a, c) => c.voteCount > (a ? a.voteCount : -1) ? c : a, null)?.id;


  candidates.forEach((cand, idx) => {
    const pct      = totalVotes > 0 ? Math.round((cand.voteCount / totalVotes) * 100) : 0;
    const initials = cand.name.split(' ').map(w => w[0]).join('').substring(0,2).toUpperCase();
    const symbol   = cand.symbol || '';
    const isVoted  = !isAdmin && (votedId === cand.id);
    const hasVoted = !isAdmin && (votedId !== null);
    const isLeader = cand.id === leaderId && totalVotes > 0;

    const card = document.createElement('div');
    card.className = `glass-card candidate-card${isVoted ? ' card-voted' : ''}${isLeader ? ' card-leading' : ''}`;

    card.innerHTML = `
      ${isLeader && totalVotes > 0 ? '<div class="leading-badge"><i class="fa-solid fa-crown"></i> Leading</div>' : ''}
      ${isVoted ? '<div class="voted-tag"><i class="fa-solid fa-circle-check"></i> Your Vote</div>' : ''}

      <div class="cand-avatar-wrap">
        <div class="cand-avatar" style="${getAvatarStyle(idx)}">${initials}</div>
        ${symbol ? `<div class="party-symbol-badge">${symbol}</div>` : ''}
      </div>

      <div class="cand-info">
        <span class="party-badge">${symbol ? symbol + ' ' : ''}${cand.party}</span>
        <h4 class="cand-name">${cand.name}</h4>
      </div>

      <div class="cand-stats">
        <div class="vote-progress-wrap">
          <div class="vote-progress-bar" style="width:${Math.round((cand.voteCount/maxVotes)*100)}%"></div>
        </div>
        <div class="vote-meta">
          <span class="vote-count-sm">${cand.voteCount} votes</span>
          <span class="vote-pct">${pct}%</span>
        </div>
      </div>

      ${isAdmin
        ? `<div class="btn btn-admin-view btn-full" style="pointer-events:none">
             <i class="fa-solid fa-eye"></i> View Only
           </div>`
        : `<button
             class="btn ${isVoted ? 'btn-voted' : 'btn-primary'} btn-full vote-btn"
             onclick="castVote(${cand.id})"
             ${hasVoted || electionClosed ? 'disabled' : ''}
             id="vote-btn-${cand.id}"
           >
             ${isVoted
               ? '<i class="fa-solid fa-check-double"></i> Voted'
               : electionClosed
                 ? '<i class="fa-solid fa-lock"></i> Election Closed'
                 : '<i class="fa-solid fa-square-check"></i> Vote for this Candidate'}
           </button>`
      }
    `;
    container.appendChild(card);
  });
}

// ─── Cast Vote ────────────────────────────────────────────────────────────────
async function castVote(candidateId) {
  // Admin cannot vote
  if (currentSession?.role === 'admin') {
    showToast("🚫 Admins cannot vote. This is a view-only role.", "error");
    return;
  }

  // Prevent double voting
  const alreadyVoted = getVotedCandidateId();
  if (alreadyVoted !== null) {
    showToast("❌ You have already voted. Each account can only vote once.", "error");
    return;
  }

  if (electionClosed) {
    showToast("🔒 The election has been closed. No more votes accepted.", "error");
    return;
  }

  // Show inline modal confirmation
  const cand = mockCandidates.find(c => c.id === candidateId);
  const candName = cand ? `${cand.symbol || ''} ${cand.name}` : `Candidate #${candidateId}`;
  showConfirmModal(candName, () => executeVote(candidateId, cand));
}

// ─── Vote execution (after confirmation) ─────────────────────────────────────
async function executeVote(candidateId, cand) {
  // Direct blockchain
  if (customContractAddress && signer) {
    try {
      const contract = new ethers.Contract(customContractAddress, CONTRACT_ABI, signer);
      const tx = await contract.vote(candidateId);
      showToast(`📡 Transaction submitted. Hash: ${tx.hash.slice(0,12)}...`, "info");
      await tx.wait();
      
      // Also notify backend to update MongoDB
      await fetch(`${BACKEND_URL}/api/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentSession.email, candidateId })
      });

      showToast("✅ Vote recorded on the Ethereum blockchain!", "success");
      await fetchCandidates();
      await fetchResults();
      await checkVoterStatus();
      return;
    } catch (err) {
      showToast(`Contract error: ${err.reason || err.message}`, "error");
      return;
    }
  }

  // Simulation mode (MongoDB only)
  try {
    const res = await fetch(`${BACKEND_URL}/api/vote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentSession.email, candidateId })
    });
    const data = await res.json();

    if (data.success) {
      showToast(`✅ Vote for "${cand ? cand.name : 'Candidate'}" recorded successfully!`, "success");
      await fetchCandidates();
      await fetchResults();
      await checkVoterStatus();
    } else {
      showToast(`❌ ${data.error}`, 'error');
    }
  } catch (error) {
    showToast('❌ Backend unreachable.', 'error');
  }
}

// ─── Inline Confirm Modal (replaces browser confirm) ─────────────────────────
function showConfirmModal(candidateName, onConfirm) {
  // Remove any existing modal
  const existing = document.getElementById('confirm-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'confirm-modal';
  modal.className = 'confirm-modal-overlay';
  modal.innerHTML = `
    <div class="confirm-modal-box glass-card">
      <div class="confirm-modal-icon"><i class="fa-solid fa-shield-check"></i></div>
      <h3>Confirm Your Vote</h3>
      <p>You are about to cast your vote for:</p>
      <div class="confirm-candidate-name">${candidateName}</div>
      <p class="confirm-warning">⚠️ This action is permanent and cannot be undone. Each wallet may only vote once.</p>
      <div class="confirm-actions">
        <button class="btn btn-outline" onclick="document.getElementById('confirm-modal').remove()">
          <i class="fa-solid fa-xmark"></i> Cancel
        </button>
        <button class="btn btn-primary" id="btn-confirm-vote">
          <i class="fa-solid fa-square-check"></i> Confirm Vote
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById('btn-confirm-vote').addEventListener('click', () => {
    modal.remove();
    onConfirm();
  });

  // Close on backdrop click
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ─── Fetch Results & Render Dashboard ────────────────────────────────────────
async function fetchResults() {
  let candidates  = [...mockCandidates];
  let totalVoters = 0;

  if (customContractAddress && provider) {
    try {
      const contract = new ethers.Contract(customContractAddress, CONTRACT_ABI, provider);
      const raw = await contract.getAllCandidates();
      candidates  = raw.map(c => ({ id:Number(c.id), name:c.name, party:c.party, voteCount:Number(c.voteCount) }));
      totalVoters = candidates.reduce((s,c) => s + c.voteCount, 0) + 5;
    } catch(e) { console.error("Contract results error:", e); }
  } else {
    try {
      const res  = await fetch(`${BACKEND_URL}/api/results`);
      const data = await res.json();
      if (data.success) {
        // Map candidateId to id for frontend consistency
        candidates  = data.candidates.map(c => ({
          ...c,
          id: c.candidateId || c.id
        }));
        totalVoters = data.votersCount;
      }
    } catch {}
  }

  const totalVotes = candidates.reduce((s,c) => s + c.voteCount, 0);

  // Update stat cards
  document.getElementById('stat-voters').innerText = totalVoters || candidates.length;
  document.getElementById('stat-votes').innerText  = totalVotes;

  // Render leaderboard table below chart
  renderLeaderboard(candidates, totalVotes);

  // Render chart
  renderResultsChart(candidates);

  // Announce winner if election is closed or votes > 0
  if (electionClosed || totalVotes > 0) announceWinner(candidates);

  // Update admin view if active
  renderAdminCandidates();
}

// ─── Winner Announcement ──────────────────────────────────────────────────────
function announceWinner(candidates) {
  const box = document.getElementById('winner-box');
  if (!box || candidates.length === 0) return;

  const totalVotes = candidates.reduce((s,c) => s + c.voteCount, 0);
  if (totalVotes === 0) { box.style.display = 'none'; return; }

  const sorted = [...candidates].sort((a,b) => b.voteCount - a.voteCount);
  const winner = sorted[0];
  const pct    = Math.round((winner.voteCount / totalVotes) * 100);
  const tied   = sorted.filter(c => c.voteCount === winner.voteCount).length > 1;

  box.style.display = 'flex';

  const announceContainer = document.getElementById('winner-announcement-container');

  if (tied) {
    const html = `
      <div class="winner-icon"><i class="fa-solid fa-scale-balanced"></i></div>
      <div class="winner-text">
        <span class="winner-label">Currently Tied</span>
        <h2 class="winner-name">No clear leader yet</h2>
        <p class="winner-desc">Multiple candidates share the top spot. More votes may break the tie.</p>
      </div>`;
    box.innerHTML = html;
    if (announceContainer) {
        announceContainer.innerHTML = `
          <div class="glass-card text-center py-5">
            <div class="winner-icon mx-auto mb-4" style="font-size:3rem;background:rgba(162,89,255,0.1);color:var(--purple);width:80px;height:80px;display:flex;align-items:center;justify-content:center;border-radius:50%">
                <i class="fa-solid fa-scale-balanced"></i>
            </div>
            <h3>Election is Tied</h3>
            <p class="desc">No single candidate has secured the majority yet.</p>
            <button class="btn btn-primary mt-4" onclick="switchTab('results')">View Full Dashboard</button>
          </div>`;
    }
  } else {
    const html = `
      <div class="winner-icon winner-gold"><i class="fa-solid fa-crown"></i></div>
      <div class="winner-text">
        <span class="winner-label">${electionClosed ? '🏆 Election Winner' : '📊 Current Leader'}</span>
        <h2 class="winner-name">${winner.name}</h2>
        <p class="winner-desc">${winner.party} · <strong>${winner.voteCount} votes</strong> · ${pct}% of total</p>
      </div>`;
    box.innerHTML = html;
    if (announceContainer) {
        announceContainer.innerHTML = `
          <div class="glass-card text-center py-5 winner-announcement-card">
            <div class="winner-badge-float">${electionClosed ? 'WINNER' : 'LEADING'}</div>
            <div class="winner-icon winner-gold mx-auto mb-4 animate-bounce" style="font-size:4rem; width:100px; height:100px; display:flex; align-items:center; justify-content:center; border-radius:50%; background:linear-gradient(135deg, #FFD700 0%, #FFA500 100%); color:#fff; box-shadow:0 10px 30px rgba(255,215,0,0.4)">
                <i class="fa-solid fa-crown"></i>
            </div>
            <span class="badge" style="background:rgba(16,185,129,0.1); color:var(--green); border-color:rgba(16,185,129,0.2)">
                ${electionClosed ? 'Official Result' : 'Live Lead'}
            </span>
            <h1 class="winner-name-large mt-3" style="font-size:2.8rem; font-weight:800; color:var(--text-primary)">${winner.name}</h1>
            <p class="winner-party-large" style="font-size:1.2rem; font-weight:600; color:var(--accent); margin-bottom:1.5rem">${winner.party}</p>
            
            <div class="winner-stats-grid" style="display:flex; justify-content:center; gap:3rem; margin:2rem 0">
                <div class="winner-stat">
                    <span class="stat-label" style="display:block; font-size:.85rem; color:var(--text-secondary)">Total Votes</span>
                    <span class="stat-value" style="font-size:1.8rem; font-weight:800">${winner.voteCount}</span>
                </div>
                <div class="winner-stat">
                    <span class="stat-label" style="display:block; font-size:.85rem; color:var(--text-secondary)">Vote Share</span>
                    <span class="stat-value" style="font-size:1.8rem; font-weight:800">${pct}%</span>
                </div>
            </div>
            
            <p class="desc" style="max-width:500px; margin:0 auto 2rem">
                ${electionClosed 
                    ? `Congratulations to <strong>${winner.name}</strong> for winning the election. This result has been permanently verified on the blockchain.`
                    : `<strong>${winner.name}</strong> is currently leading the election. These results are live and subject to change as more votes are cast.`
                }
            </p>
            
            <div style="display:flex; gap:1rem; justify-content:center">
                <button class="btn btn-primary" onclick="switchTab('results')">View Detailed Analytics</button>
                <button class="btn btn-outline" onclick="window.print()"><i class="fa-solid fa-print"></i> Print Report</button>
            </div>
          </div>`;
    }
  }
}

// ─── Leaderboard Table ────────────────────────────────────────────────────────
function renderLeaderboard(candidates, totalVotes) {
  const el = document.getElementById('leaderboard');
  if (!el) return;

  const sorted = [...candidates].sort((a,b) => b.voteCount - a.voteCount);

  el.innerHTML = `
    <table class="lb-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Candidate</th>
          <th>Party</th>
          <th>Votes</th>
          <th>Share</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map((c, i) => {
          const pct = totalVotes > 0 ? Math.round((c.voteCount / totalVotes)*100) : 0;
          const medal = i===0 ? '🥇' : i===1 ? '🥈' : i===2 ? '🥉' : `${i+1}`;
          const isWinner = i === 0 && totalVotes > 0;
          return `<tr class="${isWinner ? 'lb-winner-row' : ''}">
            <td class="lb-rank">${medal}</td>
            <td class="lb-name">${c.name}</td>
            <td class="lb-party">${c.party}</td>
            <td class="lb-votes">${c.voteCount}</td>
            <td>
              <div class="lb-bar-wrap">
                <div class="lb-bar" style="width:${pct}%"></div>
                <span class="lb-pct">${pct}%</span>
              </div>
            </td>
            <td>${isWinner ? '<span class="badge-win">Leading</span>' : '<span class="badge-loss">Behind</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ─── Chart.js Results Chart ───────────────────────────────────────────────────
function renderResultsChart(candidates) {
  const ctx = document.getElementById('electionChart').getContext('2d');
  if (resultsChart) resultsChart.destroy();

  const sorted = [...candidates].sort((a,b) => b.voteCount - a.voteCount);

  resultsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(c => c.name),
      datasets: [{
        label: 'Votes Received',
        data: sorted.map(c => c.voteCount),
        backgroundColor: sorted.map((_,i) =>
          i===0 ? 'rgba(94,92,230,0.75)' : i===1 ? 'rgba(22,163,74,0.6)' : 'rgba(124,58,237,0.55)'
        ),
        borderColor: sorted.map((_,i) =>
          i===0 ? '#5e5ce6' : i===1 ? '#16a34a' : '#7c3aed'
        ),
        borderWidth: 2,
        borderRadius: 10
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color:'#1a1d2e', font:{ family:'Outfit', size:12, weight:600 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
              const pct = total > 0 ? Math.round(ctx.parsed.y/total*100) : 0;
              return ` ${ctx.parsed.y} votes (${pct}%)`;
            }
          }
        }
      },
      scales: {
        x: { grid:{ color:'rgba(94,92,230,0.06)' }, ticks:{ color:'#6b7280', font:{family:'Outfit'} } },
        y: { grid:{ color:'rgba(94,92,230,0.06)' }, ticks:{ color:'#6b7280', font:{family:'Outfit'}, stepSize:1 }, beginAtZero:true }
      }
    }
  });
}

// ─── Toast Notification ───────────────────────────────────────────────────────
function showToast(msg, type='info') {
  const container = document.getElementById('toast-container');
  if (!container) { alert(msg); return; }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = msg;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-show'), 10);
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}

// ─── Admin: Register Candidate ────────────────────────────────────────────────
async function handleRegisterCandidate(event) {
  event.preventDefault();
  const name   = document.getElementById('cand-name').value.trim();
  const party  = document.getElementById('cand-party').value.trim();
  const symbol = document.getElementById('cand-symbol').value.trim();

  try {
    const res  = await fetch(`${BACKEND_URL}/api/register-candidate`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, party, symbol })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Candidate "${name}" added on blockchain!`, 'success');
      document.getElementById('form-register-candidate').reset();
      clearSymbolSelection();
      await fetchCandidates(); 
      await fetchResults();
      renderAdminCandidates(); // Update the sidebar list
    } else { showToast(`Error: ${data.error}`, 'error'); }
  } catch {
    const newId = mockCandidates.length > 0 ? Math.max(...mockCandidates.map(c => c.id)) + 1 : 1;
    mockCandidates.push({ id: newId, name, party, symbol, voteCount: 0 });
    saveData(); // Persist newly added candidate
    showToast(`${symbol} "${name}" (${party}) added!`, 'success');
    document.getElementById('form-register-candidate').reset();
    clearSymbolSelection();
    renderAdminCandidates(); // Update admin list immediately
    fetchCandidates(); fetchResults();
  }
}

/** Pick a party symbol from the quick-select buttons */
function pickSymbol(emoji, btn) {
  document.getElementById('cand-symbol').value = emoji;
  document.querySelectorAll('.symbol-pick-btn').forEach(b => b.classList.remove('picked'));
  btn.classList.add('picked');
}

/** Reset symbol selection state */
function clearSymbolSelection() {
  document.querySelectorAll('.symbol-pick-btn').forEach(b => b.classList.remove('picked'));
  const si = document.getElementById('cand-symbol');
  if (si) si.value = '';
}

// ─── Admin: Register Voter ────────────────────────────────────────────────────
async function handleRegisterVoter(event) {
  event.preventDefault();
  const address = document.getElementById('voter-address').value.trim();

  try {
    const res  = await fetch(`${BACKEND_URL}/api/register-voter`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ voterAddress: address })
    });
    const data = await res.json();
    data.success
      ? showToast(`Voter ${address.slice(0,8)}... authorized!`, 'success')
      : showToast(`Error: ${data.error}`, 'error');
  } catch {
    showToast(`Voter ${address.slice(0,8)}... added to simulation whitelist.`, 'success');
  }
  document.getElementById('form-register-voter').reset();
}

// ─── Admin: Toggle Election Status ───────────────────────────────────────────
function toggleElection() {
  electionClosed = !electionClosed;

  // Update toggle button
  const btn = document.getElementById('btn-toggle-election');
  if (btn) {
    btn.innerHTML = electionClosed
      ? '<i class="fa-solid fa-play"></i> Reopen Election'
      : '<i class="fa-solid fa-stop"></i> Close Election';
    btn.className = electionClosed ? 'btn btn-primary' : 'btn btn-danger';
  }

  // Update results tab status text
  const statStatus = document.getElementById('stat-status');
  if (statStatus) {
    statStatus.innerText  = electionClosed ? 'Closed' : 'Active';
    statStatus.className  = electionClosed ? 'stat-value text-red' : 'stat-value text-green';
  }

  // Update election status indicator in admin panel
  const indicator = document.getElementById('election-indicator');
  const statusTxt = document.getElementById('election-status-text');
  if (indicator && statusTxt) {
    const dot = indicator.querySelector('.indicator-dot');
    if (dot) {
      dot.className = electionClosed ? 'indicator-dot closed-dot' : 'indicator-dot active-dot';
    }
    statusTxt.innerHTML = electionClosed
      ? 'Election is <strong style="color:var(--red)">Closed</strong>'
      : 'Election is <strong style="color:var(--green)">Active</strong>';
  }
  // Update description text inside the panel
  const descEl = indicator?.closest('.election-status-display')?.querySelector('.desc');
  if (descEl) {
    descEl.innerText = electionClosed
      ? 'Voting is currently locked. No new votes will be accepted.'
      : 'Voters can currently cast their votes on the blockchain.';
  }

  showToast(electionClosed ? '🔒 Election has been closed.' : '🟢 Election is now open.', electionClosed ? 'warn' : 'success');
  fetchCandidates();
  fetchResults();
}

// ─── Admin: Switch Feature Panel ─────────────────────────────────────────────
function switchAdminPanel(panelId) {
  const PANELS = ['election', 'candidate', 'voter', 'users', 'password'];

  // Hide all panels
  PANELS.forEach(id => {
    const panel = document.getElementById(`panel-${id}`);
    if (panel) panel.style.display = 'none';
  });

  // Deactivate all sidebar buttons
  document.querySelectorAll('.admin-nav-btn').forEach(btn => btn.classList.remove('active'));

  // Show selected panel
  const target = document.getElementById(`panel-${panelId}`);
  if (target) {
    target.style.display = 'block';
    target.style.animation = 'fade-in .28s ease';
  }

  // Activate selected sidebar button
  const activeBtn = document.getElementById(`anb-${panelId}`);
  if (activeBtn) activeBtn.classList.add('active');

  // Refresh users/candidates table when that panel opens
  if (panelId === 'users')     renderUsersTable();
  if (panelId === 'candidate') renderAdminCandidates();
}


// ─── Admin: Reset All Votes ──────────────────────────────────────────────────
async function adminResetVotes() {
  if (!confirm("⚠️ WARNING: This will permanently delete ALL cast votes and allow all users to vote again. Proceed?")) return;

  try {
    const res = await fetch(`${BACKEND_URL}/api/reset-votes`, { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      showToast("🔄 All votes have been reset successfully!", "success");
      
      // Update UI
      fetchCandidates();
      fetchResults();
      
      // If the current user was a voter, refresh their status
      if (currentSession?.role === 'voter') {
        checkVoterStatus();
      }
    } else {
      showToast(`Error: ${data.error}`, "error");
    }
  } catch (error) {
    // Simulation fallback
    mockCandidates.forEach(c => c.voteCount = 0);
    saveData();
    showToast("🔄 Simulation data reset locally.", "success");
    fetchCandidates();
    fetchResults();
  }
}
