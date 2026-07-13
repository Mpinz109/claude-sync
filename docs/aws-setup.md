# Cloud vault on your own S3 bucket

`claude-sync cloud` mirrors your vault to a private S3 bucket you own. That makes
sync **store-and-forward**: machines never need to be online at the same time, and
the daily scheduled push always lands somewhere durable. Cost for a typical vault
(~100 MB) is under a cent per month.

No AWS SDK or CLI is needed — the client is built in. You need a bucket and one
scoped access key, created once in the AWS Console (about 5 minutes):

## 1. Create the bucket

S3 → **Create bucket** → name it (e.g. `claude-sync-vault-<your-account-id>`),
pick a region (e.g. `eu-west-1`), leave all defaults (private, encrypted). Done.

## 2. Create a scoped IAM user

IAM → Users → **Create user** → name `claude-sync-vault`, no console access.
→ **Attach policies directly** → **Create policy** → JSON → paste
[aws-policy.json](aws-policy.json) with `YOUR_BUCKET_NAME` replaced. This key can
touch that one bucket and nothing else in your account.

## 3. Create an access key

The new user → Security credentials → **Create access key** ("Other"). Put the two
values in `~/.aws/credentials` yourself (create the file if needed):

```ini
[default]
aws_access_key_id = AKIA...
aws_secret_access_key = ...
```

(Or set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in the environment — env
vars win. A non-default profile works via the `awsProfile` setting.)

## 4. Point claude-sync at it

```bash
claude-sync cloud set <bucket> <region>
claude-sync cloud info      # verifies credentials are found
claude-sync cloud sync      # first mirror
```

Repeat steps 3–4 on each machine (same bucket, its own copy of the key — or a
separate key per machine so you can revoke one machine later).

## Optional: client-side encryption

Set a passphrase and the bucket only ever holds ciphertext (AES-256-GCM, scrypt
key derivation; the same passphrase must be set on every machine):

```bash
claude-sync config vaultPassphrase "your long passphrase"
```

Honest framing: your conversations already live with Anthropic, so the threat
model here is "don't add careless copies," not absolute secrecy. Encryption
covers the bucket-compromise case.

## Daily flow

```
claude-sync cloud pull      # grab what other machines published
claude-sync pull --yes      # merge it into Claude (Claude closed)
claude-sync push            # publish local sessions to the local vault
claude-sync cloud push      # mirror the vault up
```

`claude-sync cloud sync` does the pull+push mirror halves in one command.

## Key rotation and revocation

Three separate keys, three procedures:

**Vault passphrase** (fully in-app): GUI Settings → Security → type the new
passphrase → Rotate, or `claude-sync cloud rekey "<new passphrase>"`. The whole
bucket is decrypted with the old key and re-encrypted under a fresh salt; a wrong
old passphrase fails before anything is rewritten. Then set the same passphrase on
every other machine (`claude-sync config vaultPassphrase "..."`). Use `--disable`
(CLI) or a blank passphrase (GUI) to remove encryption.

**AWS access key** (console + app): the app's key is deliberately scoped so it
cannot manage IAM, so revocation happens in the AWS Console:
1. IAM → user `claude-sync-vault` → Security credentials → create a SECOND key.
2. Paste it into `~/.aws/credentials` (replacing the old values).
3. Verify: GUI Settings → Security → "Verify key", or `claude-sync cloud creds`.
4. Back in the console: deactivate, then delete the old key.
Zero downtime, and a leaked old key dies at step 4.

**Syncthing device identity** (per machine): GUI Devices → "Reset identity…", or
`claude-sync device reset-identity --yes` (close the app first for the CLI path).
The machine gets a brand-new Device ID; the old identity is dead immediately and
every other computer must re-pair with the new code. Conversations and the vault
are untouched.
