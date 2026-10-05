@plugin
Feature: Watching and aborting a running BackWPup job over WP-CLI

  `wp backwpup status` follows a running job until it ends, and `wp backwpup kill` aborts one. Each
  only means something while a job is really running — and a database backup of these sites takes
  about a second, less than one WP-CLI round trip. So every scenario here starts from a backup that is
  running, and sends it one command while it still is: paced as below, it outlasts one round trip
  with seconds to spare, and not two.

  Two of BackWPup's own settings arrange that, set as a user would set them under Advanced Settings →
  Jobs. "Reduce server load" at maximum makes the job pause every time it updates its progress, which
  stretches the same database backup to several seconds. A maximum script execution time of 0 keeps
  the whole run in one request: otherwise the plugin hands a long run over to a fresh request midway,
  and for that moment the job has no process of its own — an abort landing then has nothing to stop,
  and may never be recorded.

  A database backup updates its progress once per table, so how long the paced one runs is the site's
  table count: a site with 18 tables ran it in 3.5 s, barely longer than a command takes to land once
  the job is seen running. The site's database is padded with empty tables of the scenario's own, to
  100, so the paced backup runs about 11 s on every site; they are removed afterwards.

  Background:
    Given BackWPup is set up to back up the "database" on a schedule
    And BackWPup's "Reduce server load" setting is "maximum"
    And BackWPup's "Maximum number script execution time (in seconds)" setting is "0"
    And the site's database holds at least 100 tables
    And the scheduled job is running in the background

  # The command checks for a running job before it looks at its arguments, so both forms are refused
  # alike — and the run already going must come out of it untouched, as the only run recorded. The
  # refusal lands about 3 s into the paced backup's 11 s (measured on both cells).
  Scenario: Running a job in the foreground while a backup is running is refused, and the backup in progress still completes
    When I run the BackWPup command "run {job}"
    Then the command fails
    And it reports the error "A job is already running."
    When the scheduled job's run has ended
    Then the backup history holds 1 completed run of the scheduled job, started by "backup_now_job"
    And the scheduled job's newest log reports no errors and no warnings

  Scenario: Starting a job in the background while a backup is running is refused, and the backup in progress still completes
    When I run the BackWPup command "run {job} --background"
    Then the command fails
    And it reports the error "A job is already running."
    When the scheduled job's run has ended
    Then the backup history holds 1 completed run of the scheduled job, started by "backup_now_job"
    And the scheduled job's newest log reports no errors and no warnings

  # Watched to its natural end on purpose. When a run is aborted under it, the command stops waiting
  # the moment the job's running marker goes — before the job has logged the abort — and reports
  # "Job finished." for a run that was aborted.
  Scenario: Watching a running backup waits for it to finish, then reports that it finished cleanly
    When I watch the running backup with the BackWPup command "status"
    Then the command succeeds
    And it reports the success "Job finished."
    And it watched the scheduled job's run through to its end
    And the backup history holds 1 completed run of the scheduled job, started by "backup_now_job"
    And the scheduled job's newest log reports no errors and no warnings

  Scenario: Aborting a running backup stops it without keeping an archive, and the history shows it aborted
    When I run the BackWPup command "kill"
    Then the command succeeds
    And it reports the success "Job will be terminated."
    When the scheduled job's run has ended
    Then the backup history holds 1 aborted run of the scheduled job, started by "backup_now_job"
    And the scheduled job's newest log reports warnings but no errors
    When I run the BackWPup command "backup --format=count"
    Then it prints "0"
    When I open the BackWPup dashboard
    Then the backup history shows the run as aborted by the user
