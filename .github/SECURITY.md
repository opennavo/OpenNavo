# Security policy

## Reporting a vulnerability

Please do not report vulnerabilities in public issues or discussions.

Email **admin@opennavo.com** with a description, affected version or commit,
reproduction steps, expected impact, and any suggested mitigation. Remove personal
data and credentials from logs and attachments.

Once private vulnerability reporting is enabled on the public repository, you can
also use [Report a vulnerability](https://github.com/opennavo/opennavo/security/advisories/new).
Email remains available if that form is unavailable.

## Supported versions

During the initial release period, security fixes target the latest code on `main`
and the latest stable release, when one exists. Older releases and forks are not
maintained separately. Please include whether you use the hosted service, a
self-hosted server, the macOS app, or the MCP service.

## Scope

Reports about server authorization, Agent/MCP permissions, credentials, desktop
command execution, deep links, and update signature verification are welcome.
Test on your own instance and devices, using synthetic data. Do not access other
users' data, disrupt the hosted service, or execute unapproved software installs.

We will investigate reports and coordinate fixes and disclosure with the reporter.

## Dependency review

See [DEPENDENCY_SECURITY.md](../docs/security/DEPENDENCY_SECURITY.md) for the dated release-preparation audit, remaining findings, and reachability limits.
