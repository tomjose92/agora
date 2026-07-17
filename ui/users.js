/* People pane (instance admins only): workspace users — disable/enable,
   promote/demote — and email invites. Inviting sends no mail: the invitee
   signs in with Google/Apple using the invited address and the account is
   created on the spot. */

let _usersOpen = false;
let _usersData = [];    // [{username, display_name, email, instance_role, disabled, created_at}]
let _invitesData = [];  // [{email, invited_by, instance_role, created_at, accepted_at}]

function usersToggle() {
  _usersOpen = !_usersOpen;
  const overlay = document.getElementById("users-overlay");
  overlay.style.display = _usersOpen ? "" : "none";
  if (_usersOpen) usersLoad().catch(console.error);
}

async function usersLoad() {
  const [users, invites] = await Promise.all([
    api("/api/users"),
    api("/api/invites"),
  ]);
  _usersData = users.users || [];
  _invitesData = invites.invites || [];
  usersDraw();
}

function usersDraw() {
  const panel = document.getElementById("users-panel");
  if (!panel || !_usersOpen) return;
  const me = CURRENT_USER ? CURRENT_USER.username : "";
  const rows = _usersData.map(u => {
    const self = u.username === me;
    const admin = u.instance_role === "admin";
    return `
    <div class="conn-row ${u.disabled ? "disabled" : ""}">
      <span class="conn-dot ${u.disabled ? "err" : "on"}"></span>
      <div class="conn-row-main">
        <div class="conn-name">${esc(u.display_name || u.username)}
          <span class="dim">@${esc(u.username)}${self ? " · you" : ""}</span></div>
        <div class="conn-url">${esc(u.email || "no email — admin-key bootstrap")}
          · ${esc(u.instance_role)}${u.disabled ? " · disabled" : ""}</div>
      </div>
      ${self ? "" : `
      <button class="btn sm" title="${admin ? "Remove instance-admin powers" : "Make instance admin"}"
        onclick="userSetRole('${esc(u.username)}','${admin ? "member" : "admin"}')">
        ${admin ? "Demote" : "Make admin"}</button>
      <button class="btn sm ${u.disabled ? "" : "danger"}"
        title="${u.disabled ? "Let this person sign in again" : "Block sign-in and revoke their sessions"}"
        onclick="userSetDisabled('${esc(u.username)}', ${!u.disabled})">
        ${u.disabled ? "Enable" : "Disable"}</button>`}
    </div>`;
  }).join("");
  const inviteRows = _invitesData.map(i => `
    <div class="conn-row">
      <span class="conn-dot ${i.accepted_at ? "on" : "off"}"></span>
      <div class="conn-row-main">
        <div class="conn-name">${esc(i.email)}</div>
        <div class="conn-url">${esc(i.instance_role)}
          · ${i.accepted_at ? "accepted" : "pending"}${i.invited_by ? " · invited by " + esc(i.invited_by) : ""}</div>
      </div>
      ${i.accepted_at ? "" : `<button class="btn sm danger"
        onclick="inviteRevoke('${esc(i.email)}')">Revoke</button>`}
    </div>`).join("");
  panel.innerHTML = `
    <div class="conn-head">
      <b>People</b>
      <button class="btn sm" onclick="usersToggle()">${icon("x")}</button>
    </div>
    <div class="conn-body">
      <h4>Users <span class="dim">— everyone with an account on this Agora</span></h4>
      ${rows || '<div class="dim conn-empty">No users yet.</div>'}
      <h4>Invites <span class="dim">— sign in with Google/Apple using the invited email to join</span></h4>
      ${inviteRows || '<div class="dim conn-empty">No invites.</div>'}
      <div class="conn-add">
        <input id="invite-email" type="email" placeholder="person@example.com">
        <select id="invite-role">
          <option value="member">member</option>
          <option value="admin">instance admin</option>
        </select>
        <button class="btn sm primary" onclick="inviteCreate()">Invite</button>
      </div>
      <p class="conn-hint">No email is sent — share the address of this Agora yourself.
        The account is created when they first sign in; add them to groups from each
        group's <b>Members</b> panel.</p>
    </div>`;
}

async function userSetRole(username, role) {
  try {
    await apiPost(`/api/users/${encodeURIComponent(username)}`, { instance_role: role }, "PATCH");
    await usersLoad();
  } catch (e) { toast("Update failed: " + e.message, { variant: "warn" }); }
}

async function userSetDisabled(username, disabled) {
  try {
    await apiPost(`/api/users/${encodeURIComponent(username)}`, { disabled }, "PATCH");
    await usersLoad();
    if (disabled) toast(`${username} disabled — their sessions are revoked`, { variant: "ok" });
  } catch (e) { toast("Update failed: " + e.message, { variant: "warn" }); }
}

async function inviteCreate() {
  const email = (document.getElementById("invite-email").value || "").trim();
  const role = document.getElementById("invite-role").value || "member";
  if (!email) { toast("Email required", { variant: "warn" }); return; }
  try {
    await apiPost("/api/invites", { email, instance_role: role });
    await usersLoad();
    toast(`Invited ${email} — they can sign in now`, { variant: "ok" });
  } catch (e) { toast("Couldn't invite: " + e.message, { variant: "warn" }); }
}

async function inviteRevoke(email) {
  try {
    await apiPost(`/api/invites/${encodeURIComponent(email)}`, {}, "DELETE");
    await usersLoad();
  } catch (e) { toast("Revoke failed: " + e.message, { variant: "warn" }); }
}
