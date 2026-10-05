# Authorisation and Helper permissions

Every account owns exactly one **record**. The owner can see and change everything in it. Other
people only see a record when the owner invites them as a **Helper** and gives them one or more
**access grants**.

All rules on this page are enforced on the server, in SQL, by
`src/server/domain/access.ts`. The web interface only reflects them.

## Roles

| Role              | What they can do                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**         | Everything in their own record, including sharing, deletion, restoring, merging and export                                                                                |
| **Helper**        | The union of their active grants on someone else's record (described below)                                                                                               |
| **Administrator** | An owner who also manages the installation: users, registration mode, Event types and system checks. Being an administrator gives **no** access to anybody else's record. |

## Grants: Who, Scope, Time, Capabilities

Each grant answers four questions.

1. **Who.** The Helper is the person who accepted a one-time invitation.
2. **Scope.** This says which Events the grant covers.
   - `all`: every Event in the record.
   - `actors`: Events linked to at least one of the chosen Actors.
   - `incidents`: Events belonging to at least one of the chosen Incidents (which must not be
     deleted).
3. **Time (optional).** The Event's date must be on or after `dateFrom` and on or before
   `dateTo`. Dates are compared in the **owner's** time zone, so "until 31 March" means the end
   of 31 March where the owner lives.
4. **Capabilities.**
   - **View** is always included.
   - **Add** lets the Helper record new Events, Actors and attachments within the grant.
   - **Export** lets them download what the grant covers.

A Helper may hold several grants on the same record. They see the **union** of what their
grants cover. Add and Export only apply to the grants that carry them, so an Event visible only
through a view-only grant cannot be exported.

## Several Actors on one Event

An Event is often linked to more than one Actor, for example a letter from a council copied to
a housing association. A Helper whose grant covers only the council will see that Event. What
they see of the _other_ Actors depends on the grant's **co-Actor visibility**:

| Setting    | Default for            | Effect                                                                                      |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `redacted` | Actor-scoped grants    | Other Actors are counted ("1 other Actor not shared with you") but have no name, id or link |
| `name`     | Incident-scoped grants | Other Actors' names are shown                                                               |

`all` grants show every Actor. Seeing a co-Actor's **name** never gives access to that Actor's
page, details, contact information or other Events.

The same redaction applies everywhere:

- Event lists and timelines;
- search results and snippets (a redacted Actor's name cannot be found by searching);
- "did you mean" suggestions;
- autocomplete;
- OCR Actor suggestions;
- exports (`{"redacted": true}`);
- MCP responses.

Revision snapshots can contain names outside a Helper's scope, so revision **contents**
(canonical JSON) are shown to the owner only. Helpers see that a revision exists, when it was
made and its hash.

## What each capability allows

| Action                                                              | Owner | Helper (View) | Helper (Add)                                                                                                     |
| ------------------------------------------------------------------- | :---: | :-----------: | ---------------------------------------------------------------------------------------------------------------- |
| See Events, Actors, Incidents in scope                              |   ✓   |       ✓       | ✓                                                                                                                |
| See attachment details and open attachments                         |   ✓   |       ✓       | ✓                                                                                                                |
| Create an Event                                                     |   ✓   |               | ✓ (it must fall inside an Add grant: e.g. linked to a granted Actor, or in a granted Incident, within the dates) |
| Edit an Event                                                       |   ✓   |               | Only Events they created, while still in an Add grant                                                            |
| Create an Actor                                                     |   ✓   |               | ✓ (they have full access to Actors they created)                                                                 |
| Add attachments to an Event                                         |   ✓   |               | ✓ on Events inside an Add grant                                                                                  |
| Add a visible Event to a visible Incident                           |   ✓   |               | ✓                                                                                                                |
| Remove from Incidents, relate Events, merge Actors, delete, restore |   ✓   |               |                                                                                                                  |
| Change sharing, invite Helpers                                      |   ✓   |               |                                                                                                                  |
| Export                                                              |   ✓   |               | Only with the Export capability, and only what those grants cover                                                |

Every change a Helper makes appears in the revision history and timeline with their name
("added by Sam Helper").

## Invitations

1. The owner chooses the grants and creates an invitation. The server generates a random,
   single-use token. Only its HMAC is stored. It expires after `INVITATION_TTL_HOURS`
   (72 hours by default).
2. The owner shares the link, or OpenRampart emails it when mail is configured.
3. The invitee opens the link and signs in or creates an account. Invitation links work even
   when public registration is closed. Accepting uses up the token.
4. The owner can reissue a link, which invalidates the old one, or cancel the invitation.

Invitations, acceptance, grant changes and revocations are written to the owner's Audit Log.

## Changing and ending access

- **Editing a grant** revokes it and creates a replacement, so the history of exactly what was
  shared, and when, is kept.
- **Revoking a grant** or **ending a Helper** takes effect on the next request. Grants are
  loaded per request and never cached in the session.
- A Helper can **leave** a record at any time.
- MCP connections a Helper made to the owner's record are listed in the owner's MCP
  Connections settings, and the owner can revoke them.
- Sharing cannot be changed over MCP.

## Merging Actors

When Actor B is merged into Actor A, every link is moved to A, but each link keeps its
`origin_actor_id` (B). Grant scope is evaluated on `origin_actor_id`. So:

- a Helper who could see B's Events still sees exactly those Events, and no more of A's;
- a Helper who could see A's Events does not gain B's history.

If the owner wants Helpers to follow the merged Actor, they can tick the option to extend
Helper access in the merge dialog. Every grant that named any of the merged Actors is then
given all of them explicitly, and the change is recorded in the Audit Log.

Merged Actors are archived with `merged_into_id` rather than deleted, so old links, audit
history and exports still resolve. Their names become aliases of the target Actor.

## Not revealing what you cannot see

- A Helper who requests an Event, Actor, Incident or attachment outside their grants gets
  **404 Not Found**, never 403, so the existence of the item is not confirmed.
- A person with no grant on a record gets 404 for that record.
- Counts, pagination totals, filters, Actor pickers and Incident lists are all computed from
  visible rows only.

## OAuth / MCP

An MCP connection acts as a particular person on a particular record. Each request is limited
by **both**:

- the person's own permissions on that record (owner, or Helper grants); and
- the OAuth scopes approved on the consent screen.

A token can never do more than its person could do in the web interface. See
[oauth.md](oauth.md).

## Tests

`tests/integration/permissions.test.ts` covers more than 30 leakage cases. These include
timelines, search, did-you-mean, autocomplete, OCR suggestions, attachments, exports, MCP
tools, dates at time-zone boundaries, merges, revocation, Add post-checks and ID guessing.
`tests/e2e/helpers-access.spec.ts` covers the same journeys through the browser.
