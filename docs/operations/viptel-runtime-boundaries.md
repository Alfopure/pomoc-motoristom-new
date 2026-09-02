# VIPTel runtime boundaries

VIPTel REST accepts traffic only from the allowlisted Hetzner host. Vercel must
not call VIPTel REST directly.

- Interactive reads in the app use the audited `provider.snapshot` command.
  The Hetzner listener reads extensions, active calls and exact queues
  `601`–`603`, removes raw provider fields, and stores a bounded short-lived
  response for the requesting organization.
- A live call, webphone credential issue, queue availability change, extension
  assignment, or dispatch routing change fails closed unless this listener
  handshake returns a fresh snapshot.
- `/api/telephony/viptel/cdr/probe` and
  `/api/telephony/recordings/sync` remain authenticated compatibility routes,
  but deliberately return `503`. CDR downloads are not part of the bounded
  snapshot bridge.
- Run the CDR probe on the allowlisted host with `pnpm viptel:cdr-probe --
  --json`. Run recording synchronization through the checksum-bound Hetzner
  one-shot job `telephony.recordings.sync` and retain its receipt; do not invoke
  the Vercel route.

The snapshot bridge has authority independent from live provider mutations:
`VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED=true` and a private
`VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN` of at least 32 characters must contain
the same private value in the web and listener runtimes. It authenticates every
response with a command-, organization-, request- and snapshot-bound
HMAC-SHA256, preventing a database row from impersonating the listener.
Preview remains blocked because it uses production data. The token itself is
never sent to VIPTel or placed in the snapshot payload.

Administrative takeover of an occupied shared workplace has a second,
independent kill switch: `VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED=true`.
Keep it disabled until a read-only preflight confirms that every occupied seat
in scope has an immutable `workplace_claim` lifecycle. A registered extension,
active call, pending command, routing change, or ambiguous provider snapshot
still blocks takeover even when both mutation gates are enabled.

To disable this feature safely, first turn off the workplace takeover flag,
but keep the broader live-mutation gate enabled. An admin or manager can then
repeat the original `takeover_seat` or `release_occupied_seat` request for the
affected extension: an existing transition is recovered before the dedicated
flag is checked, while a new transition remains blocked. Recover every active
`workplace_takeover` or targeted-release transition with the currently deployed
parser. Revert application code only after extension ownership, both profile
reservations, lifecycle audit, and transition state are consistent. The
assignment generation revokes old application authorization; it does not rotate
a SIP password already disclosed to a previous browser.
