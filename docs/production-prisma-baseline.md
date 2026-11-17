# Production Prisma baseline procedure

The Circle migration adds a Prisma migration history to a database that was
created before this repository used checked-in migrations. Do not deploy the
new container command to an existing production database until this one-time
baseline step is complete.

## Before changing production

1. Take and verify a restorable production database backup.
2. Confirm the production schema matches the pre-Circle schema on `main`.
3. Confirm the production `DATABASE_URL` points to the intended production
   database. Never print or commit the URL.
4. Use a maintenance window and ensure no other deployment or migration is
   running.

## One-time baseline

Run the following with the production `DATABASE_URL` supplied securely in
the environment, using the exact application revision that contains this
migration directory:

```sh
npx prisma migrate resolve --applied 20261117000000_baseline
```

This records the pre-existing schema as already present; it does not create,
drop, or alter application tables.

Then deploy the application revision. Its startup command runs
`npx prisma migrate deploy`, which applies the subsequent Circle migration.

## Verification

After deployment, run:

```sh
npx prisma migrate status
```

Confirm the baseline and Circle migration are applied, then run the Circle
owner-approval smoke tests. If the schema does not match the pre-Circle
`main` schema, stop and reconcile it before baselining. Never use
`prisma db push` against production as a substitute for this procedure.

The baseline marker is not an initial schema creation migration. Fresh
databases must be provisioned from the project's approved initial schema
before this baseline procedure can be used.
