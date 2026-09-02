-- The result is sensitive and must be streamed only into the encrypted snapshot.
-- format(%L) produces SQL literals without exposing values to shell arguments.
select pg_catalog.format(
  'select vault.create_secret(%L, %L, %L);',
  secrets.decrypted_secret,
  secrets.name,
  secrets.description
)
from vault.decrypted_secrets as secrets
order by secrets.id;
