# Contributing

## Baseline and provenance

The source provenance baseline is Sites commit `cdd11a92a63f1515c3c33cda9cdd522e85219646`. The public snapshot must have a separate, clean Git history. The verified archive SHA-256 is recorded in `SOURCE_PROVENANCE.md`. Before implementation, record the exact public source commit on the issue and pull request. Do not treat this scaffold or an older review ZIP as deployable production source.

## Ticket ownership and branches

Choose one issue and comment with the intended scope before starting. Coordinate with its existing worker; one primary worker should own each ticket. Reference the issue in your branch and pull request. Use a separate branch per ticket, based on the exact public source commit recorded for that work. Public contributors should fork and submit a pull request. Repository access grants are owner actions; do not grant agents or contributors main-branch write privileges.

## Evidence and tests

Reproduce a reported defect before fixing it. Record the baseline commit, environment, steps, expected behavior, actual behavior, and sanitized evidence. Run the checks documented by the approved source and tests covering the changed behavior. Include exact commands and results in the pull request; explicitly identify anything untested or blocked. Do not invent bugs, results, credentials, or test accounts.

Authentication changes require an authenticated end-to-end check in an authorized nonproduction environment. Agent activation must use a supported native event-driven mechanism; manual checks and polling do not satisfy that requirement.

## Review and release

Keep pull requests scoped and request review before merging. No unreviewed production deployment. Merge and deployment require separate authorization. Do not change Site audience, collaborators, repository security settings, branch protections, network rules, or paid services as part of ordinary contributions.

Never commit credentials, `.env` files, runtime databases, private roster emails, callback secrets, live hosting bindings, or original private Git history. Use synthetic fixtures and placeholder configuration. Confirm that attachments and logs are sanitized before publishing.
