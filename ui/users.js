/* People pane (instance admins only): workspace users — disable/enable,
   promote/demote — email invites, and shareable invite links. Inviting by
   email sends no mail: the invitee signs in with Google/Apple using the
   invited address and the account is created on the spot. A link invite is
   a single-use URL (7-day expiry) that admits whoever opens it and signs in. */

let _usersOpen = false;
let _usersData = [];    // [{username, display_name, email, instance_role, disabled, created_at}]
let _invitesData = [];  // [{email, invited_by, instance_role, created_at, accepted_at}]
let _inviteLinks = [];  // [{token, url, invited_by, instance_role, created_at, expires_at, used_by}]

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
  _inviteLinks = invites.links || [];
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
  const now = Date.now() / 1000;
  const linkRows = _inviteLinks.map(l => {
    const state = l.used_by ? `used by @${esc(l.used_by)}`
      : l.expires_at < now ? "expired"
      : `expires ${new Date(l.expires_at * 1000).toLocaleDateString()}`;
    const live = !l.used_by && l.expires_at >= now;
    return `
    <div class="conn-row">
      <span class="conn-dot ${l.used_by ? "on" : live ? "off" : "err"}"></span>
      <div class="conn-row-main">
        <div class="conn-name">${esc(l.token.slice(0, 8))}…
          <span class="dim">${esc(l.instance_role)}</span></div>
        <div class="conn-url">${state}${l.invited_by ? " · created by " + esc(l.invited_by) : ""}</div>
      </div>
      ${live ? `<button class="btn sm" title="Copy the invite URL"
        onclick="inviteLinkCopy('${esc(l.url)}')">Copy link</button>
      <button class="btn sm danger" onclick="inviteRevoke('${esc(l.token)}')">Revoke</button>` : ""}
    </div>`;
  }).join("");
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
      <h4>Invite links <span class="dim">— single-use URLs, valid 7 days</span></h4>
      ${linkRows || '<div class="dim conn-empty">No invite links.</div>'}
      <div class="conn-add">
        <select id="invite-link-role">
          <option value="member">member</option>
          <option value="admin">instance admin</option>
        </select>
        <button class="btn sm primary" onclick="inviteLinkCreate()">Create invite link</button>
      </div>
      <p class="conn-hint">Anyone who opens the link and signs in with Google/Apple
        joins with the chosen role — hand it out over any channel you trust.</p>
    </div>`;
}

async function inviteLinkCreate() {
  const role = document.getElementById("invite-link-role").value || "member";
  try {
    const link = await apiPost("/api/invites", { link: true, instance_role: role });
    await usersLoad();
    // Absolute URL for the clipboard even when the server has no public_url.
    const url = link.url && link.url.startsWith("/")
      ? window.location.origin + link.url : link.url;
    await inviteLinkCopy(url);
  } catch (e) { toast("Couldn't create link: " + e.message, { variant: "warn" }); }
}

async function inviteLinkCopy(url) {
  const abs = url.startsWith("/") ? window.location.origin + url : url;
  try {
    await navigator.clipboard.writeText(abs);
    toast("Invite link copied to the clipboard", { variant: "ok" });
  } catch (e) {
    window.prompt("Copy the invite link:", abs);
  }
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
