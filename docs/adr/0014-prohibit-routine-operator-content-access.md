# Prohibit routine operator access to message content

Do not build an admin inbox or grant support and engineering roles routine decryption access. Production database, observability, and support tooling expose ciphertext and metadata only. A break-glass content path exists solely for scoped incidents and requires two-person approval, a recorded reason and account boundary, short-lived least-privilege credentials, immutable audit, and User notification unless legally prohibited; AWS KMS and deployment roles must enforce separation between normal operation and break-glass administration.
