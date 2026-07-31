ALTER TABLE app.mcp_authorizations
ADD COLUMN public_id text,
ADD COLUMN client_name text CHECK (
  client_name IS NULL
  OR (
    length(client_name) BETWEEN 1 AND 128
    AND client_name = btrim(client_name)
  )
);

UPDATE app.mcp_authorizations
SET public_id = 'mca_' || translate(
  substring(
    encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
    FROM 1 FOR 21
  ),
  '+/',
  '-_'
);

ALTER TABLE app.mcp_authorizations
ALTER COLUMN public_id SET NOT NULL,
ALTER COLUMN public_id SET DEFAULT (
  'mca_' || translate(
    substring(
      encode(decode(md5(gen_random_uuid()::text), 'hex'), 'base64')
      FROM 1 FOR 21
    ),
    '+/',
    '-_'
  )
);

ALTER TABLE app.mcp_authorizations
ADD CONSTRAINT mcp_authorizations_public_id_unique UNIQUE (public_id),
ADD CONSTRAINT mcp_authorizations_public_id_format CHECK (
  public_id ~ '^mca_[A-Za-z0-9_-]{21}$'
);
