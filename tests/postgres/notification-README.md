# Notification privacy and reminder contracts

Run only on a disposable local PostgreSQL database. These scripts never connect
by URL and must not be pointed at the shared Supabase project.

```
createdb -h 127.0.0.1 -p 55432 -U postgres notification_contract
psql -X -h 127.0.0.1 -p 55432 -U postgres -d notification_contract -f tests/postgres/notification-contract.sql
createdb -h 127.0.0.1 -p 55432 -U postgres task_reminder_combined
psql -X -h 127.0.0.1 -p 55432 -U postgres -d task_reminder_combined -f tests/postgres/task-reminder-combined-contract.sql
```

Each database must be empty. `notification-contract.sql` applies the actual
historical reminder/notification table DDL and the new privacy migration; it
checks recipient RLS, administrator denial, disabled organization denial against the historical membership helper, column/actor forgery, snooze ACL,
case deletion, generation retry/reopen, channel preservation, atomic rollback,
and rejection of stale deliveries before external handoff. An optional
`reminderAt` overrides the due date for reminder scheduling; clearing it returns
to the due date, or removes the schedule when both dates are absent.

`task-reminder-combined-contract.sql` applies both new task and notification
migrations together. Its local activation record represents only the isolated
test writer. It proves that old delete workflows fail at preliminary reminder
cancellation/notification archival, while the current actor RPC supports task
creation, completion, same-deadline reopening, reassignment, channels-only updates without a duplicate generation, rescheduling and
case deletion without duplicates or lost private state. This test record is
not a verified inventory of any deployed writer and cannot authorize rollout.

Browser/API test doubles and these SQL fixtures send no email, push, or live
telephony. Physical delivery remains a separate opt-in verification.

`task-assignment-contract.sql` builds the same combined schema and checks the
immediate assignment bell/push outbox separately from future due reminders. It
covers no-deadline senior assignees, senior team reminder recipients, stable
legacy-helper dedupe, reassignment cancellation, late transaction rollback,
service-only lease ACLs, failed-delivery retries and stale-worker rejection.
Run it in another empty disposable local database, for example:

```
createdb -h 127.0.0.1 -p 55432 -U postgres task_assignment_contract
psql -X -h 127.0.0.1 -p 55432 -U postgres -d task_assignment_contract -f tests/postgres/task-assignment-contract.sql
```
